'use strict';

// ── Konstanten ────────────────────────────────────────────────────────────────
const MAX_MSG_LEN   = 4000;
const WS_PROTO      = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ROOM_LIFETIME = 2 * 60 * 60 * 1000;

// ── State ─────────────────────────────────────────────────────────────────────
let cryptoKey        = null;
let ws               = null;
let roomId           = null;
let isCreator        = false;
let partnerConnected = false;
let countdownInterval= null;
let typingTimer      = null;
let typingActive     = false;
let pendingPwHash    = null;   // Hash für Auth-Msg nach WS-Connect

// eigene Nachrichten: id → { el, readEl }
const myMsgs = new Map();

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  home:   $('screen-home'),
  pw:     $('screen-pw'),
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
  buf.set(iv, 0); buf.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...buf));
}

async function decrypt(b64) {
  const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const iv = buf.slice(0, 12); const ct = buf.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
  return new TextDecoder().decode(pt);
}

// SHA-256 eines Passworts → hex (läuft im Browser, nie zum Server im Klartext)
async function hashPassword(pw) {
  const enc  = new TextEncoder().encode(pw);
  const buf  = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── Passwort-Toggle ───────────────────────────────────────────────────────────
function setupEyeToggle(inputId, btnId) {
  $(btnId).addEventListener('click', () => {
    const el = $(inputId);
    el.type = el.type === 'password' ? 'text' : 'password';
  });
}
setupEyeToggle('pw-input', 'pw-toggle');
setupEyeToggle('pw-join',  'pw-join-toggle');

// ── Countdown ─────────────────────────────────────────────────────────────────
function startCountdown(createdAt) {
  $('countdown-wrap').style.display = 'flex';
  function tick() {
    const rem = ROOM_LIFETIME - (Date.now() - createdAt);
    if (rem <= 0) { $('countdown').textContent = '0:00:00'; return; }
    const h = Math.floor(rem / 3600000);
    const m = Math.floor((rem % 3600000) / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    $('countdown').textContent = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    const el = $('countdown');
    el.className = 'countdown-val';
    if (rem < 10*60*1000) el.classList.add('critical');
    else if (rem < 30*60*1000) el.classList.add('warning');
  }
  tick();
  countdownInterval = setInterval(tick, 1000);
}

// ── QR ────────────────────────────────────────────────────────────────────────
function showQR(link) {
  $('qr-canvas').innerHTML = '';
  new QRCode($('qr-canvas'), { text: link, width: 220, height: 220,
    colorDark: '#00c9b1', colorLight: '#111418', correctLevel: QRCode.CorrectLevel.M });
  $('qr-overlay').style.display = 'flex';
}
$('btn-qr-close').addEventListener('click', () => { $('qr-overlay').style.display = 'none'; });

// ── Partner-Banner ────────────────────────────────────────────────────────────
function setPartnerBanner(state) {
  // state: 'online' | 'offline' | 'hidden'
  let banner = $('partner-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'partner-banner';
    $('messages').before(banner);
  }
  banner.className = `partner-banner ${state}`;
  if (state === 'hidden') { banner.style.display = 'none'; return; }
  banner.style.display = 'block';
  banner.textContent = state === 'online'
    ? '● Gesprächspartner ist jetzt online'
    : '○ Gesprächspartner hat die Verbindung getrennt';
}

// ── Nachrichten ───────────────────────────────────────────────────────────────
function addMessage(text, role, msgId, isPending) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  if (msgId) wrap.dataset.id = msgId;

  const textNode = document.createElement('span');
  textNode.textContent = text;
  wrap.appendChild(textNode);

  if (role === 'self' && msgId) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    const readEl = document.createElement('span');
    readEl.className = isPending ? 'read-status read-pending' : 'read-status';
    readEl.textContent = isPending ? '⏳' : '✓';
    readEl.title = isPending ? 'Wird zugestellt wenn Partner beitritt' : 'Gesendet';
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

  // Eingehend: Gelesen-Bestätigung senden
  if (role === 'other' && msgId && ws?.readyState === WebSocket.OPEN) {
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

// Gepufferte Nachricht markieren als "jetzt zugestellt"
function markDelivered(msgId) {
  const entry = myMsgs.get(msgId);
  if (entry && entry.readEl.textContent === '⏳') {
    entry.readEl.textContent = '✓';
    entry.readEl.className = 'read-status';
    entry.readEl.title = 'Zugestellt';
  }
}

// ── Nachricht zurückziehen ────────────────────────────────────────────────────
function retractMessage(msgId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'retract', id: msgId }));
  applyRetract(msgId);
}

function applyRetract(msgId) {
  const own = myMsgs.get(msgId);
  if (own) {
    own.el.classList.add('retracted');
    own.el.querySelector('span').textContent = '[Nachricht zurückgezogen]';
    const meta = own.el.querySelector('.msg-meta');
    if (meta) meta.remove();
    myMsgs.delete(msgId);
    return;
  }
  const el = $('messages').querySelector(`[data-id="${CSS.escape(msgId)}"]`);
  if (el) {
    el.classList.add('retracted');
    const span = el.querySelector('span');
    if (span) span.textContent = '[Nachricht zurückgezogen]';
  }
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(state, text) {
  $('status-dot').className = state;
  $('status-text').textContent = text;
}

function enableInput(yes) {
  $('msg-input').disabled = !yes;
  $('btn-send').disabled  = !yes;
  if (yes) $('msg-input').focus();
}

// ── Typing ────────────────────────────────────────────────────────────────────
function sendTyping(active) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (active === typingActive) return;
  typingActive = active;
  ws.send(JSON.stringify({ type: 'typing', active }));
}

$('msg-input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
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

    // Optionales Passwort hashen
    const pwPlain = $('pw-input').value;
    const pwHash  = pwPlain ? await hashPassword(pwPlain) : null;

    const res  = await fetch('/api/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pwHash })
    });
    if (!res.ok) throw new Error('Server-Fehler');
    const data = await res.json();
    roomId = data.roomId;

    const link = `${location.origin}/r/${roomId}#${b64url}`;
    $('share-link').textContent = link;

    $('btn-qr').addEventListener('click', () => showQR(link));
    $('btn-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
        $('btn-copy').textContent = '✓ Kopiert';
        setTimeout(() => ($('btn-copy').textContent = 'Kopieren'), 2000);
      } catch {
        const r = document.createRange();
        r.selectNode($('share-link'));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
      }
    });

    $('link-bar').style.display = 'block';
    showScreen('chat');

    // Ersteller braucht kein Auth — er kennt das Passwort schon
    pendingPwHash = null;
    openWebSocket();
    startCountdown(Date.now());

  } catch (err) {
    console.error(err);
    $('btn-create').disabled = false;
    $('btn-create').textContent = '+ Privaten Chat erstellen';
    alert('Raum konnte nicht erstellt werden.');
  }
});

// ── Zweite Person: Join mit Passwort ─────────────────────────────────────────
$('btn-pw-join').addEventListener('click', joinWithPassword);
$('pw-join').addEventListener('keydown', e => { if (e.key === 'Enter') joinWithPassword(); });

async function joinWithPassword() {
  const pw = $('pw-join').value;
  if (!pw) { $('pw-error').textContent = 'Bitte Passwort eingeben.'; $('pw-error').style.display = 'block'; return; }
  pendingPwHash = await hashPassword(pw);
  $('pw-error').style.display = 'none';
  showScreen('chat');
  openWebSocket();
  // Countdown nachladen
  try {
    const res = await fetch(`/api/room/${roomId}`);
    if (res.ok) { const d = await res.json(); startCountdown(d.createdAt); }
  } catch {}
}

// ── Eingehender Link ──────────────────────────────────────────────────────────
async function initFromFragment() {
  const match = location.pathname.match(/^\/r\/([a-f0-9]{32})$/);
  if (!match) return false;

  const fragment = location.hash.slice(1);
  if (!fragment) { showClosed('Ungültiger Link – kein Schlüssel.'); return true; }

  roomId = match[1];
  try { cryptoKey = await importKey(fragment); }
  catch { showClosed('Schlüssel im Link ist ungültig.'); return true; }

  history.replaceState(null, '', location.pathname);

  // Prüfen ob Raum Passwort hat
  try {
    const res = await fetch(`/api/room/${roomId}`);
    if (!res.ok) { showClosed('Raum existiert nicht oder wurde bereits gelöscht.'); return true; }
    const data = await res.json();
    if (data.hasPassword) {
      // Passwort-Screen zeigen
      showScreen('pw');
      return true;
    }
    // Kein Passwort → direkt rein
    showScreen('chat');
    openWebSocket();
    startCountdown(data.createdAt);
  } catch {
    showScreen('chat');
    openWebSocket();
  }
  return true;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function openWebSocket() {
  const url = `${WS_PROTO}//${location.host}/ws/${roomId}`;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    setStatus('waiting', 'Warte auf Gesprächspartner …');
    enableInput(true);

    // Auth senden falls Passwort gesetzt
    if (pendingPwHash) {
      ws.send(JSON.stringify({ type: 'auth', pwHash: pendingPwHash }));
    }

    addSystem('Verbunden. Du kannst schon schreiben – Nachrichten werden zugestellt wenn der andere beitritt.');
  });

  ws.addEventListener('message', async (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    switch (msg.type) {

      case 'auth_ok':
        addSystem('Passwort korrekt ✓');
        break;

      case 'auth_fail':
        showClosed('Falsches Passwort. Verbindung getrennt.');
        break;

      case 'participant_count': {
        const wasConnected = partnerConnected;
        partnerConnected = msg.count >= 2;

        if (partnerConnected && !wasConnected) {
          setStatus('connected', 'Verbunden · E2E-verschlüsselt');
          setPartnerBanner('online');
          addSystem('● Gesprächspartner ist online.');
          // Alle gepufferten Nachrichten als "zugestellt" markieren
          for (const [id] of myMsgs) markDelivered(id);
        } else if (!partnerConnected && wasConnected) {
          setStatus('waiting', 'Gesprächspartner offline');
          setPartnerBanner('offline');
          addSystem('○ Gesprächspartner hat die Verbindung getrennt.');
        } else if (!partnerConnected) {
          setStatus('waiting', 'Warte auf Gesprächspartner …');
        }
        break;
      }

      case 'chat': {
        try {
          const plain = await decrypt(msg.payload);
          // pending:true = Nachricht wurde gepuffert und jetzt nachgeliefert
          const label = msg.pending ? `[war offline] ${plain}` : plain;
          addMessage(msg.pending ? plain : plain, 'other', msg.id);
          if (msg.pending) {
            addSystem('↑ Diese Nachricht wurde gesendet bevor du beigetreten bist.');
          }
        } catch {
          addSystem('[Nachricht konnte nicht entschlüsselt werden]');
        }
        $('typing-indicator').style.display = 'none';
        break;
      }

      case 'buffered':
        // Server bestätigt: Nachricht gepuffert (Partner noch nicht da)
        // readEl bleibt auf ⏳ — markDelivered() wird aufgerufen wenn Partner kommt
        break;

      case 'read': {
        const entry = myMsgs.get(msg.id);
        if (entry) {
          entry.readEl.textContent = '✓✓';
          entry.readEl.className = 'read-status read-check';
          entry.readEl.title = 'Gelesen';
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
        if (msg.code === 'not_authenticated') showClosed('Authentifizierung fehlgeschlagen.');
        else addSystem(`[Fehler: ${msg.code}]`);
        break;
    }
  });

  ws.addEventListener('close', (evt) => {
    if (screens.closed.classList.contains('active')) return;
    if (evt.code === 4001) showClosed('Raum existiert nicht oder wurde gelöscht.');
    else if (evt.code === 4002) showClosed('Raum ist voll (max. 2 Teilnehmer).');
    else if (evt.code === 4003) showClosed('Authentifizierung fehlgeschlagen.');
    else if (evt.code === 4000) showClosed('Ungültiger Link.');
    else showClosed('Verbindung getrennt.');
  });

  ws.addEventListener('error', () => setStatus('disconnected', 'Verbindungsfehler'));
}

// ── Senden ────────────────────────────────────────────────────────────────────
async function sendMessage() {
  const input = $('msg-input');
  const text  = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (text.length > MAX_MSG_LEN) { addSystem(`[Max. ${MAX_MSG_LEN} Zeichen]`); return; }

  input.value = '';
  input.style.height = '';
  sendTyping(false);

  const msgId = crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);

  try {
    const payload = await encrypt(text);
    ws.send(JSON.stringify({ type: 'chat', payload, id: msgId }));
    // isPending=true wenn Partner noch nicht da
    addMessage(text, 'self', msgId, !partnerConnected);
  } catch {
    addSystem('[Verschlüsselung fehlgeschlagen]');
  }
}

$('btn-send').addEventListener('click', sendMessage);
$('msg-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ── Beenden ───────────────────────────────────────────────────────────────────
$('btn-end').addEventListener('click', () => {
  if (!confirm('Chat wirklich beenden? Alle Nachrichten werden sofort gelöscht.')) return;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end' }));
  showClosed('Du hast den Chat beendet. Alle Nachrichten wurden gelöscht.');
});

// ── Neuer Chat ────────────────────────────────────────────────────────────────
$('btn-new').addEventListener('click', () => {
  cryptoKey = null; roomId = null; ws = null;
  isCreator = partnerConnected = typingActive = false;
  pendingPwHash = null;
  clearInterval(countdownInterval);
  $('messages').innerHTML = '';
  myMsgs.clear();
  $('typing-indicator').style.display = 'none';
  $('countdown-wrap').style.display = 'none';
  $('link-bar').style.display = 'none';
  enableInput(false);
  $('pw-input').value = '';
  const b = $('partner-banner');
  if (b) b.style.display = 'none';
  history.replaceState(null, '', '/');
  showScreen('home');
  $('btn-create').disabled = false;
  $('btn-create').textContent = '+ Privaten Chat erstellen';
});

// ── Closed ────────────────────────────────────────────────────────────────────
function showClosed(reason) {
  clearInterval(countdownInterval);
  if (ws?.readyState === WebSocket.OPEN) try { ws.close(); } catch {}
  ws = null;
  $('closed-reason').textContent = reason || 'Dieser Raum wurde gelöscht.';
  showScreen('closed');
}

function closedReason(code) {
  return {
    user_ended: 'Der Gesprächspartner hat den Chat beendet.',
    inactivity: 'Raum nach 2 Stunden Inaktivität geschlossen.',
    all_left:   'Alle Teilnehmer haben den Raum verlassen.',
  }[code] || 'Raum wurde geschlossen.';
}

// ── Schriftgröße ──────────────────────────────────────────────────────────────
const FONT_MIN = 11;
const FONT_MAX = 22;
const FONT_STEP = 1;
let fontSize = 14;

function applyFontSize(size) {
  fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, size));
  $('messages').style.fontSize = fontSize + 'px';
  $('msg-input').style.fontSize = fontSize + 'px';
  $('font-size-label').textContent = fontSize + 'px';
}

$('font-up').addEventListener('click',   () => applyFontSize(fontSize + FONT_STEP));
$('font-down').addEventListener('click', () => applyFontSize(fontSize - FONT_STEP));

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const handled = await initFromFragment();
  if (!handled) showScreen('home');
})();
