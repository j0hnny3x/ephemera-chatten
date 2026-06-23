'use strict';

// ── Konstanten ────────────────────────────────────────────────────────────────
const MAX_MSG_LEN   = 4000;
const WS_PROTO      = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ROOM_LIFETIME = 2 * 60 * 60 * 1000; // 2 Stunden in ms

// ── State ─────────────────────────────────────────────────────────────────────
let cryptoKey        = null;
let ws               = null;
let roomId           = null;
let isCreator        = false;
let partnerConnected = false;
let countdownInterval= null;
let roomCreatedAt    = null;
let typingTimer      = null;
let typingActive     = false;

// Eigene Nachrichten: id → { el, metaEl, readEl }
const myMsgs = new Map();

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  home:   $('screen-home'),
  chat:   $('screen-chat'),
  closed: $('screen-closed'),
};

function showScreen(name) {
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle('active', k === name);
  }
}

// ── Krypto ───────────────────────────────────────────────────────────────────
async function generateKey() {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw    = await crypto.subtle.exportKey('raw', key);
  const b64    = btoa(String.fromCharCode(...new Uint8Array(raw)));
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return { key, b64url };
}

async function importKey(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encrypt(plaintext) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc);
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv, 0);
  buf.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...buf));
}

async function decrypt(b64) {
  const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const iv  = buf.slice(0, 12);
  const ct  = buf.slice(12);
  const pt  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
  return new TextDecoder().decode(pt);
}

// ── Countdown ─────────────────────────────────────────────────────────────────
function startCountdown(createdAt) {
  roomCreatedAt = createdAt;
  $('countdown-wrap').style.display = 'flex';

  function tick() {
    const remaining = ROOM_LIFETIME - (Date.now() - createdAt);
    if (remaining <= 0) {
      $('countdown').textContent = '0:00:00';
      return;
    }
    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    $('countdown').textContent = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

    const el = $('countdown');
    el.className = 'countdown-val';
    if (remaining < 10 * 60 * 1000) el.classList.add('critical');
    else if (remaining < 30 * 60 * 1000) el.classList.add('warning');
  }

  tick();
  countdownInterval = setInterval(tick, 1000);
}

// ── QR-Code ───────────────────────────────────────────────────────────────────
function showQR(link) {
  $('qr-canvas').innerHTML = '';
  new QRCode($('qr-canvas'), {
    text: link,
    width: 220, height: 220,
    colorDark: '#00c9b1',
    colorLight: '#111418',
    correctLevel: QRCode.CorrectLevel.M
  });
  $('qr-overlay').style.display = 'flex';
}

$('btn-qr-close').addEventListener('click', () => {
  $('qr-overlay').style.display = 'none';
});

// ── Nachrichten-UI ────────────────────────────────────────────────────────────
function addMessage(text, role, msgId) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  if (msgId) wrap.dataset.id = msgId;

  const textNode = document.createElement('span');
  textNode.textContent = text;
  wrap.appendChild(textNode);

  // Meta-Zeile für eigene Nachrichten (Gelesen + Zurückziehen)
  if (role === 'self' && msgId) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    const readEl = document.createElement('span');
    readEl.className = 'read-status';
    readEl.textContent = '✓';
    meta.appendChild(readEl);

    const retractBtn = document.createElement('button');
    retractBtn.className = 'btn-retract';
    retractBtn.textContent = 'zurückziehen';
    retractBtn.addEventListener('click', () => retractMessage(msgId, wrap));
    meta.appendChild(retractBtn);

    wrap.appendChild(meta);
    myMsgs.set(msgId, { el: wrap, readEl });
  }

  $('messages').appendChild(wrap);
  $('messages').scrollTop = $('messages').scrollHeight;

  // Eingehende Nachrichten: Gelesen-Bestätigung senden
  if (role === 'other' && msgId && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'read', id: msgId }));
  }

  return wrap;
}

function addSystem(text) {
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

// ── Nachricht zurückziehen ────────────────────────────────────────────────────
function retractMessage(msgId, el) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'retract', id: msgId }));
  applyRetract(msgId);
}

function applyRetract(msgId) {
  // Eigene Nachricht
  const own = myMsgs.get(msgId);
  if (own) {
    own.el.classList.add('retracted');
    const span = own.el.querySelector('span');
    if (span) span.textContent = '[Nachricht zurückgezogen]';
    const meta = own.el.querySelector('.msg-meta');
    if (meta) meta.remove();
    myMsgs.delete(msgId);
    return;
  }
  // Fremde Nachricht (Partner hat zurückgezogen)
  const el = $('messages').querySelector(`[data-id="${CSS.escape(msgId)}"]`);
  if (el) {
    el.classList.add('retracted');
    const span = el.querySelector('span');
    if (span) span.textContent = '[Nachricht zurückgezogen]';
  }
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(state, text) {
  const dot = $('status-dot');
  dot.className = state;
  $('status-text').textContent = text;
}

function enableInput(yes) {
  $('msg-input').disabled = !yes;
  $('btn-send').disabled  = !yes;
  if (yes) $('msg-input').focus();
}

// ── Tipp-Indikator ────────────────────────────────────────────────────────────
function sendTyping(active) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !partnerConnected) return;
  if (active === typingActive) return;
  typingActive = active;
  ws.send(JSON.stringify({ type: 'typing', active }));
}

$('msg-input').addEventListener('input', function () {
  // Auto-resize
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';

  // Typing-Signal
  sendTyping(true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => sendTyping(false), 2000);
});

// ── Raum erstellen ────────────────────────────────────────────────────────────
$('btn-create').addEventListener('click', async () => {
  $('btn-create').disabled = true;
  $('btn-create').textContent = '…';

  try {
    const { key, b64url } = await generateKey();
    cryptoKey = key;
    isCreator = true;

    const res  = await fetch('/api/room', { method: 'POST' });
    if (!res.ok) throw new Error('Server-Fehler');
    const data = await res.json();
    roomId = data.roomId;

    const link = `${location.origin}/r/${roomId}#${b64url}`;
    $('share-link').textContent = link;

    // QR-Button
    $('btn-qr').addEventListener('click', () => showQR(link));

    // Kopieren-Button
    $('btn-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
        $('btn-copy').textContent = '✓ Kopiert';
        setTimeout(() => ($('btn-copy').textContent = 'Kopieren'), 2000);
      } catch {
        const range = document.createRange();
        range.selectNode($('share-link'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
    });

    $('link-bar').style.display = 'block';
    showScreen('chat');
    openWebSocket();

    // Countdown starten (Erstellzeit = jetzt)
    startCountdown(Date.now());

  } catch (err) {
    console.error(err);
    $('btn-create').disabled = false;
    $('btn-create').textContent = '+ Privaten Chat erstellen';
    alert('Raum konnte nicht erstellt werden. Bitte erneut versuchen.');
  }
});

// ── Eingehender Link (zweite Person) ─────────────────────────────────────────
async function initFromFragment() {
  const match = location.pathname.match(/^\/r\/([a-f0-9]{32})$/);
  if (!match) return false;

  const fragment = location.hash.slice(1);
  if (!fragment) { showClosed('Ungültiger Link – kein Schlüssel gefunden.'); return true; }

  roomId = match[1];

  try {
    cryptoKey = await importKey(fragment);
  } catch {
    showClosed('Schlüssel im Link ist ungültig.');
    return true;
  }

  history.replaceState(null, '', location.pathname);
  showScreen('chat');
  openWebSocket();

  // Countdown: Erstellzeit vom Server holen
  try {
    const res  = await fetch(`/api/room/${roomId}`);
    if (res.ok) {
      const data = await res.json();
      startCountdown(data.createdAt);
    }
  } catch {}

  return true;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function openWebSocket() {
  const url = `${WS_PROTO}//${location.host}/ws/${roomId}`;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    setStatus('waiting', 'Warte auf Gesprächspartner …');
    enableInput(true);   // Eingabe sofort freischalten — auch allein
    addSystem('Verbunden. Du kannst schon schreiben, bevor der andere kommt.');
  });

  ws.addEventListener('message', async (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    switch (msg.type) {

      case 'participant_count':
        partnerConnected = msg.count >= 2;
        if (partnerConnected) {
          setStatus('connected', 'Verbunden · E2E-verschlüsselt');
          addSystem('Gesprächspartner ist online.');
        } else if (msg.count === 1 && partnerConnected === false) {
          // Partner hat verlassen
          setStatus('waiting', 'Partner hat den Chat verlassen');
          addSystem('Gesprächspartner hat die Verbindung getrennt.');
          partnerConnected = false;
        }
        break;

      case 'chat': {
        // Nachricht entschlüsseln
        try {
          const plain = await decrypt(msg.payload);
          addMessage(plain, 'other', msg.id);
        } catch {
          addSystem('[Nachricht konnte nicht entschlüsselt werden]');
        }
        // Tipp-Indikator aus
        $('typing-indicator').style.display = 'none';
        break;
      }

      case 'read': {
        // Eigene Nachricht als gelesen markieren
        const entry = myMsgs.get(msg.id);
        if (entry) {
          entry.readEl.textContent = '✓✓';
          entry.readEl.className = 'read-status read-check';
        }
        break;
      }

      case 'typing':
        $('typing-indicator').style.display = msg.active ? 'flex' : 'none';
        break;

      case 'retract':
        applyRetract(msg.id);
        break;

      case 'room_closed':
        showClosed(closedReason(msg.reason));
        break;

      case 'error':
        addSystem(`[Fehler: ${msg.code}]`);
        break;
    }
  });

  ws.addEventListener('close', (evt) => {
    if (screens.closed.classList.contains('active')) return;
    if (evt.code === 4001) showClosed('Dieser Raum existiert nicht oder wurde bereits gelöscht.');
    else if (evt.code === 4002) showClosed('Raum ist bereits voll (max. 2 Teilnehmer).');
    else if (evt.code === 4000) showClosed('Ungültiger Raum-Link.');
    else showClosed('Verbindung getrennt.');
  });

  ws.addEventListener('error', () => setStatus('disconnected', 'Verbindungsfehler'));
}

// ── Nachricht senden ──────────────────────────────────────────────────────────
async function sendMessage() {
  const input = $('msg-input');
  const text  = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (text.length > MAX_MSG_LEN) { addSystem(`[Max. ${MAX_MSG_LEN} Zeichen]`); return; }

  input.value = '';
  input.style.height = '';
  sendTyping(false);

  // Eindeutige Nachrichten-ID
  const msgId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);

  try {
    const payload = await encrypt(text);
    ws.send(JSON.stringify({ type: 'chat', payload, id: msgId }));
    addMessage(text, 'self', msgId);
  } catch (err) {
    console.error('Verschlüsselung fehlgeschlagen:', err);
    addSystem('[Nachricht konnte nicht verschlüsselt werden]');
  }
}

$('btn-send').addEventListener('click', sendMessage);
$('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ── Chat beenden ──────────────────────────────────────────────────────────────
$('btn-end').addEventListener('click', () => {
  if (!confirm('Chat wirklich beenden? Alle Nachrichten werden gelöscht.')) return;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end' }));
  showClosed('Du hast den Chat beendet. Alle Nachrichten wurden gelöscht.');
});

// ── Neuer Chat ────────────────────────────────────────────────────────────────
$('btn-new').addEventListener('click', () => {
  cryptoKey = null; roomId = null; ws = null;
  isCreator = false; partnerConnected = false;
  typingActive = false;
  clearInterval(countdownInterval);
  $('messages').innerHTML = '';
  $('typing-indicator').style.display = 'none';
  $('countdown-wrap').style.display = 'none';
  $('link-bar').style.display = 'none';
  enableInput(false);
  history.replaceState(null, '', '/');
  showScreen('home');
  $('btn-create').disabled = false;
  $('btn-create').textContent = '+ Privaten Chat erstellen';
});

// ── Geschlossen ───────────────────────────────────────────────────────────────
function showClosed(reason) {
  clearInterval(countdownInterval);
  if (ws && ws.readyState === WebSocket.OPEN) try { ws.close(); } catch {}
  ws = null;
  $('closed-reason').textContent = reason || 'Dieser Raum wurde gelöscht.';
  showScreen('closed');
}

function closedReason(code) {
  return {
    user_ended: 'Der Gesprächspartner hat den Chat beendet.',
    inactivity: 'Raum nach 2 Stunden automatisch geschlossen.',
    all_left:   'Alle Teilnehmer haben den Raum verlassen.',
  }[code] || 'Raum wurde geschlossen.';
}

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  const handled = await initFromFragment();
  if (!handled) showScreen('home');
})();
