'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  EINMAL-NACHRICHT — selbstzerstörende Einweg-Nachricht
//  Der Server speichert ausschließlich Ciphertext. Der AES-Schlüssel steckt im
//  URL-Fragment (#) und verlässt niemals den Browser des Absenders/Empfängers.
// ══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

// Erlaubte Deadlines in Stunden — 2h / 12h / 24h / 2T / 7T / 14T
const TTL_HOURS_ALLOWED = new Set([2, 12, 24, 48, 168, 336]);
const DEFAULT_TTL_HOURS = 48;

const MAX_PAYLOAD_CHARS = 512 * 1024;   // Ciphertext (Base64)
const MAX_NOTES         = 20000;        // harte Obergrenze gegen RAM-Flut
const RATE_MAX          = 30;           // Nachrichten pro Fenster und IP
const RATE_WINDOW_MS    = 10 * 60 * 1000;
const PURGE_INTERVAL_MS = 60 * 1000;
const SAVE_DEBOUNCE_MS  = 2000;

const DATA_DIR  = process.env.EPHEMERA_DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'notes.json');

// id → { payload, pwHash, burn, createdAt, expiresAt, reads }
const notes = new Map();

// ── Persistenz ────────────────────────────────────────────────────────────────
// Nur Ciphertext landet auf der Platte. Ohne den Schlüssel aus dem URL-Fragment
// ist der Inhalt auch mit Vollzugriff auf die Datei nicht lesbar.
let saveTimer = null;
let saving    = false;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, SAVE_DEBOUNCE_MS);
}

function saveNow() {
  if (saving) { scheduleSave(); return; }
  saving = true;
  const dump = [];
  for (const [id, n] of notes) dump.push([id, n]);
  const tmp = DATA_FILE + '.tmp';
  fs.mkdir(DATA_DIR, { recursive: true }, (mkErr) => {
    if (mkErr) { saving = false; console.error('[note] mkdir:', mkErr.message); return; }
    fs.writeFile(tmp, JSON.stringify(dump), (wErr) => {
      if (wErr) { saving = false; console.error('[note] write:', wErr.message); return; }
      fs.rename(tmp, DATA_FILE, (rErr) => {
        saving = false;
        if (rErr) console.error('[note] rename:', rErr.message);
      });
    });
  });
}

function load() {
  let raw;
  try { raw = fs.readFileSync(DATA_FILE, 'utf8'); }
  catch { return; }                       // noch keine Datei — normaler Erststart
  let parsed;
  try { parsed = JSON.parse(raw); } catch { console.error('[note] Store defekt — wird ignoriert'); return; }
  if (!Array.isArray(parsed)) return;
  const now = Date.now();
  let restored = 0;
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [id, n] = entry;
    if (typeof id !== 'string' || !n || typeof n.payload !== 'string') continue;
    if (typeof n.expiresAt !== 'number' || n.expiresAt <= now) continue;
    notes.set(id, {
      payload:   n.payload,
      pwHash:    typeof n.pwHash === 'string' ? n.pwHash : null,
      burn:      n.burn !== false,
      createdAt: typeof n.createdAt === 'number' ? n.createdAt : now,
      expiresAt: n.expiresAt,
      reads:     typeof n.reads === 'number' ? n.reads : 0,
    });
    restored++;
  }
  if (restored) console.log(`[note] ${restored} Nachricht(en) wiederhergestellt`);
}

function purge() {
  const now = Date.now();
  let gone = 0;
  for (const [id, n] of notes) if (n.expiresAt <= now) { notes.delete(id); gone++; }
  if (gone) { console.log(`[note] ${gone} abgelaufene Nachricht(en) gelöscht`); scheduleSave(); }
}

// ── Rate Limit ────────────────────────────────────────────────────────────────
// IPs werden gehasht und nur im RAM gehalten, nie gespeichert, nie geloggt.
const rate = new Map();
const RATE_SALT = crypto.randomBytes(16);

function rateKey(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return crypto.createHash('sha256').update(RATE_SALT).update(ip).digest('hex').slice(0, 16);
}

function rateExceeded(req) {
  const key = rateKey(req);
  const now = Date.now();
  const hit = rate.get(key);
  if (!hit || hit.reset <= now) { rate.set(key, { count: 1, reset: now + RATE_WINDOW_MS }); return false; }
  hit.count++;
  return hit.count > RATE_MAX;
}

function purgeRate() {
  const now = Date.now();
  for (const [k, v] of rate) if (v.reset <= now) rate.delete(k);
}

// ── Validierung ───────────────────────────────────────────────────────────────
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX64 = /^[a-f0-9]{64}$/;

// ── Link-Vorschau für /n/ ─────────────────────────────────────────────────────
// Fehlt eine Zeichenkette (weil index.html sich geändert hat), bleibt sie
// einfach stehen — die Seite funktioniert weiter.
const NOTE_META = [
  ['<title>ephemera — Privater Chat</title>',
   '<title>ephemera — Einmal-Nachricht</title>'],
  ['content="🔒 Privater verschlüsselter Chat"',
   'content="🔒 Eine verschlüsselte Nachricht für dich"'],
  ['content="Du wurdest zu einem sicheren Einmal-Chat eingeladen. Ende-zu-Ende-verschlüsselt. Kein Login. Öffne den Link um beizutreten."',
   'content="Sie lässt sich nur einmal öffnen und zerstört sich danach. Ende-zu-Ende-verschlüsselt, kein Login."'],
  ['content="Du wurdest zu einem sicheren Einmal-Chat eingeladen."',
   'content="Sie lässt sich nur einmal öffnen und zerstört sich danach."'],
];

function register(app, indexHtmlPath) {
  load();

  const timer = setInterval(() => { purge(); purgeRate(); }, PURGE_INTERVAL_MS);
  if (timer.unref) timer.unref();

  // Eigener Body-Parser — muss vor dem globalen 16kb-Parser greifen,
  // sonst schlägt der große Ciphertext dort schon mit 413 fehl.
  const noteJson = express.json({ limit: '640kb' });

  // ── Nachricht anlegen ──────────────────────────────────────────────────────
  app.post('/api/note', noteJson, (req, res) => {
    if (rateExceeded(req))  return res.status(429).json({ error: 'rate_limited' });
    if (notes.size >= MAX_NOTES) return res.status(503).json({ error: 'storage_full' });

    const b = req.body || {};

    const payload = b.payload;
    if (typeof payload !== 'string' || !payload.length || payload.length > MAX_PAYLOAD_CHARS || !B64.test(payload))
      return res.status(400).json({ error: 'bad_payload' });

    const pwHash = (typeof b.pwHash === 'string' && HEX64.test(b.pwHash)) ? b.pwHash : null;

    const ttlHours = TTL_HOURS_ALLOWED.has(b.ttlHours) ? b.ttlHours : DEFAULT_TTL_HOURS;
    const burn     = b.burn !== false;

    const id  = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    notes.set(id, {
      payload,
      pwHash,
      burn,
      createdAt: now,
      expiresAt: now + ttlHours * 60 * 60 * 1000,
      reads: 0,
    });
    scheduleSave();
    console.log(`[note] ${id.slice(0, 8)}… angelegt (${ttlHours}h, burn=${burn}, pw=${!!pwHash})`);
    res.json({ noteId: id, expiresAt: now + ttlHours * 60 * 60 * 1000, burn, hasPassword: !!pwHash });
  });

  // ── Status abfragen — verbraucht die Nachricht NICHT ───────────────────────
  // Wichtig: Link-Vorschau-Bots von WhatsApp/Telegram rufen nur GET-Routen auf.
  // Zerstört wird ausschließlich über POST /open, also nie durch eine Vorschau.
  app.get('/api/note/:id', (req, res) => {
    const n = notes.get(req.params.id);
    if (!n || n.expiresAt <= Date.now()) return res.status(404).json({ error: 'not_found' });
    res.json({ hasPassword: !!n.pwHash, burn: n.burn, expiresAt: n.expiresAt, reads: n.reads });
  });

  // ── Nachricht öffnen — hier wird zerstört ──────────────────────────────────
  app.post('/api/note/:id/open', noteJson, (req, res) => {
    const id = req.params.id;
    const n  = notes.get(id);
    if (!n || n.expiresAt <= Date.now()) return res.status(404).json({ error: 'not_found' });

    if (n.pwHash) {
      const given = req.body?.pwHash;
      if (typeof given !== 'string' || !HEX64.test(given)) return res.status(401).json({ error: 'auth_required' });
      const a = Buffer.from(given, 'hex'), c = Buffer.from(n.pwHash, 'hex');
      if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return res.status(401).json({ error: 'auth_failed' });
    }

    // Payload greifen und sofort löschen — Node ist single-threaded,
    // dazwischen kann kein zweiter Request die Nachricht ebenfalls abholen.
    const payload = n.payload;
    n.reads++;
    if (n.burn) { notes.delete(id); console.log(`[note] ${id.slice(0, 8)}… gelesen und zerstört`); }
    scheduleSave();

    res.json({ payload, burned: n.burn, expiresAt: n.expiresAt });
  });

  // ── Empfänger-Seite ────────────────────────────────────────────────────────
  // Gleiche App wie der Chat, aber mit eigener Link-Vorschau: wer den Link in
  // WhatsApp teilt, soll dort nicht "Chat" lesen. Die Nachricht selbst wird
  // dabei nicht angefasst — Vorschau-Bots rufen nur GET auf, zerstört wird
  // ausschließlich über POST /open.
  app.get('/n/:id', (req, res) => {
    fs.readFile(indexHtmlPath, 'utf8', (err, html) => {
      if (err) return res.sendFile(indexHtmlPath);
      let out = html;
      for (const [from, to] of NOTE_META) out = out.split(from).join(to);
      res.type('html').send(out);
    });
  });

  return {
    count: () => notes.size,
    flush: () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } saveNow(); },
  };
}

module.exports = { register };
