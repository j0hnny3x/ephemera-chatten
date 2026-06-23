'use strict';

// ── Konstanten ────────────────────────────────────────────────────────────────
const MAX_MSG_LEN = 4000;
const WS_PROTO    = location.protocol === 'https:' ? 'wss:' : 'ws:';

// ── State ─────────────────────────────────────────────────────────────────────
let cryptoKey  = null;   // CryptoKey (AES-GCM)
let ws         = null;   // WebSocket
let roomId     = null;
let partnerConnected = false;

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  home:   $('screen-home'),
  share:  $('screen-share'),
  chat:   $('screen-chat'),
  closed: $('screen-closed'),
};

function showScreen(name) {
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle('active', k === name);
  }
}

// ── Krypto-Helfer (Web Crypto API / AES-GCM-256) ─────────────────────────────

/** Erzeugt einen neuen zufälligen AES-GCM-Schlüssel und gibt ihn als base64url zurück. */
async function generateKey() {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const raw    = await crypto.subtle.exportKey('raw', key);
  const b64    = btoa(String.fromCharCode(...new Uint8Array(raw)));
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return { key, b64url };
}

/** Importiert einen base64url-kodierten AES-GCM-Schlüssel. */
async function importKey(b64url) {
  const b64  = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'raw', raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Verschlüsselt einen String → base64-kodierter Ciphertext (IV vorangestellt). */
async function encrypt(plaintext) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc);
  // IV (12 Byte) + Ciphertext zusammenführen
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv, 0);
  buf.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...buf));
}

/** Entschlüsselt einen base64-kodierten Ciphertext → Klartext-String. */
async function decrypt(b64) {
  const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const iv  = buf.slice(0, 12);
  const ct  = buf.slice(12);
  const pt  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
  return new TextDecoder().decode(pt);
}

// ── UI-Helfer ─────────────────────────────────────────────────────────────────

function setStatus(state, text) {
  const dot = $('status-dot');
  dot.className = '';
  dot.classList.add(state);            // 'connected' | 'waiting' | 'disconnected'
  $('status-text').textContent = text;
}

function addMessage(text, role) {
  // role: 'self' | 'other' | 'system'
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  // Niemals innerHTML – nur textContent
  el.textContent = text;
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function enableInput(yes) {
  $('msg-input').disabled = !yes;
  $('btn-send').disabled  = !yes;
}

// ── Raum erstellen (Startseite) ───────────────────────────────────────────────
$('btn-create').addEventListener('click', async () => {
  $('btn-create').disabled = true;
  $('btn-create').textContent = '…';

  try {
    // 1. Schlüssel erzeugen (bleibt im Browser)
    const { key, b64url } = await generateKey();
    cryptoKey = key;

    // 2. Raum beim Server anlegen
    const res  = await fetch('/api/room', { method: 'POST' });
    if (!res.ok) throw new Error('Server-Fehler');
    const data = await res.json();
    roomId     = data.roomId;

    // 3. Link bauen: roomId im Pfad, Schlüssel im Fragment (#)
    const link = `${location.origin}/r/${roomId}#${b64url}`;
    $('share-link').textContent = link;

    showScreen('share');
    openWebSocket();        // Ersteller verbindet sich sofort

  } catch (err) {
    console.error(err);
    $('btn-create').disabled = false;
    $('btn-create').textContent = '+ Privaten Chat erstellen';
    alert('Raum konnte nicht erstellt werden. Bitte erneut versuchen.');
  }
});

$('btn-copy').addEventListener('click', async () => {
  const link = $('share-link').textContent;
  try {
    await navigator.clipboard.writeText(link);
    $('btn-copy').textContent = '✓ Kopiert';
    setTimeout(() => ($('btn-copy').textContent = 'Kopieren'), 2000);
  } catch {
    // Fallback: markieren
    const range = document.createRange();
    range.selectNode($('share-link'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
});

// ── Eingehender Link (zweite Person) ─────────────────────────────────────────
async function initFromFragment() {
  // URL-Muster: /r/<roomId>#<key>
  const match = location.pathname.match(/^\/r\/([a-f0-9]{32})$/);
  if (!match) return false;

  const fragment = location.hash.slice(1);   // '#' entfernen
  if (!fragment) {
    showClosed('Ungültiger Link – kein Schlüssel im Fragment.');
    return true;
  }

  roomId = match[1];

  try {
    cryptoKey = await importKey(fragment);
  } catch {
    showClosed('Schlüssel im Link ist ungültig oder beschädigt.');
    return true;
  }

  // Fragment aus der URL entfernen, ohne Seite neu zu laden
  // (damit der Schlüssel nicht im Verlauf bleibt)
  history.replaceState(null, '', location.pathname);

  showScreen('chat');
  openWebSocket();
  return true;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function openWebSocket() {
  const url = `${WS_PROTO}//${location.host}/ws/${roomId}`;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    setStatus('waiting', 'Warte auf Gesprächspartner …');
    // Wenn wir aus dem Share-Screen kommen, Ansicht wechseln
    if (screens.share.classList.contains('active')) {
      showScreen('chat');
    }
    addMessage('Verbunden. Warte auf Gesprächspartner …', 'system');
  });

  ws.addEventListener('message', async (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    switch (msg.type) {

      case 'participant_count':
        partnerConnected = msg.count >= 2;
        if (partnerConnected) {
          setStatus('connected', 'Verbunden · Ende-zu-Ende-verschlüsselt');
          enableInput(true);
          addMessage('Gesprächspartner verbunden.', 'system');
        } else {
          setStatus('waiting', 'Warte auf Gesprächspartner …');
          enableInput(false);
        }
        break;

      case 'chat':
        try {
          const plain = await decrypt(msg.payload);
          addMessage(plain, 'other');
        } catch {
          addMessage('[Nachricht konnte nicht entschlüsselt werden]', 'system');
        }
        break;

      case 'room_closed':
        showClosed(closedReason(msg.reason));
        break;

      case 'error':
        addMessage(`[Fehler: ${msg.code}]`, 'system');
        break;
    }
  });

  ws.addEventListener('close', (evt) => {
    // Nur schließen wenn wir nicht schon im closed-Screen sind
    if (!screens.closed.classList.contains('active')) {
      if (evt.code === 4001) {
        showClosed('Dieser Raum existiert nicht oder wurde bereits gelöscht.');
      } else if (evt.code === 4002) {
        showClosed('Raum ist bereits voll (max. 2 Teilnehmer).');
      } else if (evt.code === 4000) {
        showClosed('Ungültiger Raum-Link.');
      } else {
        showClosed('Verbindung getrennt.');
      }
    }
  });

  ws.addEventListener('error', () => {
    setStatus('disconnected', 'Verbindungsfehler');
  });
}

// ── Nachricht senden ──────────────────────────────────────────────────────────
async function sendMessage() {
  const input = $('msg-input');
  const text  = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (text.length > MAX_MSG_LEN) {
    addMessage(`[Nachricht zu lang – max. ${MAX_MSG_LEN} Zeichen]`, 'system');
    return;
  }

  input.value = '';
  input.style.height = '';

  try {
    const payload = await encrypt(text);
    ws.send(JSON.stringify({ type: 'chat', payload }));
    addMessage(text, 'self');
  } catch (err) {
    console.error('Verschlüsselung fehlgeschlagen:', err);
    addMessage('[Nachricht konnte nicht verschlüsselt werden]', 'system');
  }
}

$('btn-send').addEventListener('click', sendMessage);

$('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-Resize Textarea
$('msg-input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// ── Chat beenden ──────────────────────────────────────────────────────────────
$('btn-end').addEventListener('click', () => {
  if (!confirm('Chat wirklich beenden? Alle Nachrichten werden gelöscht.')) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'end' }));
  }
  showClosed('Du hast den Chat beendet. Alle Nachrichten wurden gelöscht.');
});

// ── Neuen Chat starten ────────────────────────────────────────────────────────
$('btn-new').addEventListener('click', () => {
  // Sauberer Neustart – State zurücksetzen
  cryptoKey = null;
  roomId    = null;
  ws        = null;
  partnerConnected = false;
  $('messages').innerHTML = '';
  enableInput(false);
  history.replaceState(null, '', '/');
  showScreen('home');
  $('btn-create').disabled = false;
  $('btn-create').textContent = '+ Privaten Chat erstellen';
});

// ── Geschlossen-Screen ────────────────────────────────────────────────────────
function showClosed(reason) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.close(); } catch {}
  }
  ws = null;
  $('closed-reason').textContent = reason || 'Dieser Raum wurde gelöscht.';
  showScreen('closed');
}

function closedReason(code) {
  const map = {
    user_ended: 'Der Gesprächspartner hat den Chat beendet.',
    inactivity: 'Raum wegen Inaktivität (30 Min.) automatisch geschlossen.',
    all_left:   'Alle Teilnehmer haben den Raum verlassen.',
  };
  return map[code] || 'Raum wurde geschlossen.';
}

// ── Initialisierung ───────────────────────────────────────────────────────────
(async () => {
  const handled = await initFromFragment();
  if (!handled) {
    showScreen('home');
  }
})();
