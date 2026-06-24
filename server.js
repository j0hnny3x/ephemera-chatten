'use strict';

const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');
const crypto  = require('crypto');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024 });

const rooms = new Map();

const ROOM_LIFETIME  = 2 * 60 * 60 * 1000; // 2h fix — kein Grace-Timer mehr
const MAX_CLIENTS    = 2;
const MAX_MSG_LEN    = 32 * 1024 * 1024;
const MAX_PENDING    = 100;
const PING_INTERVAL  = 25 * 1000;

function createRoom(id, pwHash) {
  // Raum läuft immer 2h ab Erstellung — egal ob jemand drin ist
  const hardTimer = setTimeout(() => deleteRoom(id, 'inactivity'), ROOM_LIFETIME);
  rooms.set(id, {
    clients:        new Set(),
    hardTimer,
    createdAt:      Date.now(),
    pwHash:         pwHash || null,
    pending:        [],
    sealed:         false,
    extensionCount: 0,
    // Letzter Verbindungszeitpunkt pro Client-ID (für Reconnect-Erkennung)
    lastSeen:       new Map(),
  });
}

function deleteRoom(id, reason) {
  const room = rooms.get(id);
  if (!room) return;
  clearTimeout(room.hardTimer);
  for (const c of room.clients) {
    try { c.send(JSON.stringify({ type: 'room_closed', reason })); } catch {}
    try { c.close(); } catch {}
  }
  rooms.delete(id);
  console.log(`[room] ${id.slice(0,8)}… closed (${reason})`);
}

// Security Headers
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'interest-cohort=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' ws: wss:",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});

app.use(express.static(__dirname, { etag: false }));
app.use(express.json({ limit: '16kb' }));

app.post('/api/room', (req, res) => {
  const id     = crypto.randomBytes(16).toString('hex');
  const pwHash = (typeof req.body?.pwHash === 'string' && req.body.pwHash.length === 64)
    ? req.body.pwHash : null;
  createRoom(id, pwHash);
  res.json({ roomId: id, hasPassword: !!pwHash });
});

app.get('/api/room/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'not_found' });
  res.json({
    createdAt:   room.createdAt,
    hasPassword: !!room.pwHash,
    sealed:      room.sealed,
    clientCount: room.clients.size,
  });
});

app.get('/r/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

wss.on('connection', (ws, req) => {
  const match = req.url.match(/^\/ws\/([a-f0-9]{32})$/);
  if (!match) { ws.close(4000, 'invalid_room'); return; }

  const roomId = match[1];
  const room   = rooms.get(roomId);

  if (!room)                            { ws.close(4001, 'room_not_found'); return; }
  if (room.clients.size >= MAX_CLIENTS) { ws.close(4002, 'room_full');      return; }

  let authenticated = !room.pwHash;
  let authTimer = room.pwHash
    ? setTimeout(() => ws.close(4003, 'auth_timeout'), 8000) // 8s statt 5s
    : null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  room.clients.add(ws);

  // Raum versiegeln wenn beide drin
  if (room.clients.size === 2) {
    room.sealed = true;
    broadcast(room, { type: 'room_sealed' });
  }

  broadcastCount(room);

  // Gepufferte Nachrichten ausliefern
  function flushPending() {
    if (!room.pending.length) return;
    const toFlush  = [...room.pending];
    room.pending   = [];
    for (const p of toFlush) {
      try { ws.send(JSON.stringify({ ...p, pending: true })); } catch {}
    }
  }
  if (room.clients.size === 2 && authenticated) flushPending();

  ws.on('message', (raw) => {
    ws.isAlive = true;
    if (raw.length > MAX_MSG_LEN) {
      ws.send(JSON.stringify({ type: 'error', code: 'msg_too_long' }));
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Keepalive
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }

    // Auth
    if (msg.type === 'auth') {
      if (!room.pwHash) { authenticated = true; return; }
      clearTimeout(authTimer);
      if (typeof msg.pwHash === 'string' && msg.pwHash === room.pwHash) {
        authenticated = true;
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        if (room.clients.size === 2) flushPending();
      } else {
        ws.send(JSON.stringify({ type: 'auth_fail' }));
        ws.close(4003, 'auth_failed');
      }
      return;
    }

    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'error', code: 'not_authenticated' }));
      return;
    }

    const ts = Date.now();
    const forwardTypes = ['chat', 'reply', 'image', 'audio', 'video', 'file', 'reaction'];

    if (forwardTypes.includes(msg.type)) {
      if (typeof msg.id !== 'string') return;
      const fwd = { type: msg.type, id: msg.id, ts };

      if (['chat','reply','image','audio','video','file'].includes(msg.type)) {
        if (typeof msg.payload !== 'string') return;
        fwd.payload = msg.payload;
      }
      if (msg.type === 'reply')    { fwd.quoteId = msg.quoteId; fwd.quoteText = msg.quoteText; }
      if (msg.type === 'image')    { fwd.mime = msg.mime; }
      if (msg.type === 'file')     { fwd.filename = msg.filename; fwd.filesize = msg.filesize; }
      if (msg.type === 'reaction') { fwd.msgId = msg.msgId; fwd.emoji = msg.emoji; }
      if (msg.sdSeconds)           { fwd.sdSeconds = msg.sdSeconds; }

      if (room.clients.size === 2) {
        broadcastExcept(room, ws, fwd);
      } else {
        if (room.pending.length < MAX_PENDING) room.pending.push(fwd);
        ws.send(JSON.stringify({ type: 'buffered', id: msg.id }));
      }

    } else if (msg.type === 'read') {
      const readAt = new Date(ts).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
      broadcastExcept(room, ws, { type: 'read', id: msg.id, readAt });

    } else if (msg.type === 'typing') {
      broadcastExcept(room, ws, { type: 'typing', active: msg.active });

    } else if (msg.type === 'retract') {
      if (typeof msg.id !== 'string') return;
      room.pending = room.pending.filter(p => p.id !== msg.id);
      broadcastExcept(room, ws, { type: 'retract', id: msg.id });

    } else if (msg.type === 'edit') {
      if (typeof msg.payload !== 'string') return;
      broadcastExcept(room, ws, { type: 'edit', id: msg.id, payload: msg.payload });

    } else if (msg.type === 'extend') {
      if (room.extensionCount >= 3) {
        ws.send(JSON.stringify({ type: 'error', code: 'max_extensions' })); return;
      }
      room.extensionCount++;
      clearTimeout(room.hardTimer);
      room.hardTimer = setTimeout(() => deleteRoom(roomId, 'inactivity'), 60 * 60 * 1000);
      broadcast(room, { type: 'extended', newExpiry: Date.now() + 60*60*1000, extensionsLeft: 3 - room.extensionCount });

    } else if (msg.type === 'self_destruct_ack') {
      broadcastExcept(room, ws, { type: 'self_destruct_ack', id: msg.id });

    } else if (msg.type === 'end') {
      // Nur wenn explizit beendet → Raum löschen
      deleteRoom(roomId, 'user_ended');
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    room.clients.delete(ws);
    const remaining = rooms.get(roomId);
    if (!remaining) return;

    // Raum NICHT löschen wenn alle weg — er läuft einfach weiter bis 2h
    remaining.sealed = remaining.clients.size >= 2;
    broadcastCount(remaining);
    // Kein Grace-Timer, kein sofortiges Löschen
  });

  ws.on('error', () => {
    clearTimeout(authTimer);
    room.clients.delete(ws);
  });
});

// Ping-Loop für tote Verbindungen
const pingInterval = setInterval(() => {
  for (const [, room] of rooms) {
    for (const ws of room.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, PING_INTERVAL);

server.on('close', () => clearInterval(pingInterval));

function broadcastCount(room) {
  broadcast(room, { type: 'participant_count', count: room.clients.size });
}
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) if (c.readyState === 1) c.send(data);
}
function broadcastExcept(room, sender, msg) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) if (c !== sender && c.readyState === 1) c.send(data);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ephemera läuft auf http://localhost:${PORT}`));
