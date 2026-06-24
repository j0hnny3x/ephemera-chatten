'use strict';

const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024 });

const rooms = new Map();

const ROOM_LIFETIME = 2 * 60 * 60 * 1000;
const MAX_CLIENTS   = 2;
const MAX_MSG_LEN   = 32 * 1024 * 1024;
const MAX_PENDING   = 100;
const PING_INTERVAL = 25 * 1000;

function createRoom(id, pwHash) {
  const hardTimer = setTimeout(() => deleteRoom(id, 'inactivity'), ROOM_LIFETIME);
  rooms.set(id, {
    clients:        new Map(),   // token → ws (statt Set)
    hardTimer,
    createdAt:      Date.now(),
    pwHash:         pwHash || null,
    pending:        [],
    sealed:         false,
    extensionCount: 0,
  });
}

function deleteRoom(id, reason) {
  const room = rooms.get(id);
  if (!room) return;
  clearTimeout(room.hardTimer);
  for (const ws of room.clients.values()) {
    try { ws.send(JSON.stringify({ type: 'room_closed', reason })); } catch {}
    try { ws.close(); } catch {}
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
    "connect-src 'self' ws: wss: https://open-relay.metered.ca",
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
  res.json({ createdAt: room.createdAt, hasPassword: !!room.pwHash, sealed: room.sealed, clientCount: room.clients.size });
});

app.get('/api/turn', (req, res) => {
  res.json({ iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443',username: 'openrelayproject', credential: 'openrelayproject' },
  ]});
});

app.get('/r/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/og-image.png', (req, res) => {
  const svgPath = path.join(__dirname, 'og-image.svg');
  if (fs.existsSync(svgPath)) { res.setHeader('Content-Type', 'image/svg+xml'); res.sendFile(svgPath); }
  else res.status(404).end();
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  // URL: /ws/<roomId>?token=<sessionToken>
  const match = req.url.match(/^\/ws\/([a-f0-9]{32})/);
  if (!match) { ws.close(4000, 'invalid_room'); return; }

  const roomId = match[1];
  const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
  const token = urlParams.get('token') || crypto.randomBytes(8).toString('hex');

  const room = rooms.get(roomId);
  if (!room) { ws.close(4001, 'room_not_found'); return; }

  // ── Session-Token: Reconnect des gleichen Clients erkennen ─────────────────
  const existingWs = room.clients.get(token);
  if (existingWs && existingWs !== ws) {
    // Gleicher Token → alte Verbindung ersetzen (Reconnect)
    console.log(`[room] ${roomId.slice(0,8)}… reconnect token=${token.slice(0,6)}`);
    try { existingWs.close(1000, 'replaced'); } catch {}
    room.clients.delete(token);
  }

  // Maximal 2 verschiedene Tokens (= 2 echte Teilnehmer)
  if (!room.clients.has(token) && room.clients.size >= MAX_CLIENTS) {
    ws.close(4002, 'room_full'); return;
  }

  let authenticated = !room.pwHash;
  let authTimer = room.pwHash ? setTimeout(() => ws.close(4003, 'auth_timeout'), 8000) : null;
  ws.isAlive = true;
  ws.sessionToken = token;
  ws.on('pong', () => { ws.isAlive = true; });

  room.clients.set(token, ws);

  // Versiegeln wenn 2 verschiedene Tokens
  if (room.clients.size === 2) {
    room.sealed = true;
    broadcastAll(room, { type: 'room_sealed' });
  }

  broadcastCount(room);

  function flushPending() {
    if (!room.pending.length) return;
    const toFlush = [...room.pending]; room.pending = [];
    for (const p of toFlush) try { ws.send(JSON.stringify({ ...p, pending: true })); } catch {}
  }
  if (room.clients.size === 2 && authenticated) flushPending();

  ws.on('message', (raw) => {
    ws.isAlive = true;
    if (raw.length > MAX_MSG_LEN) { ws.send(JSON.stringify({ type: 'error', code: 'msg_too_long' })); return; }
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }

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

    if (!authenticated) { ws.send(JSON.stringify({ type: 'error', code: 'not_authenticated' })); return; }

    const ts = Date.now();

    // Nachrichten-Typen
    const dataTypes = ['chat','reply','image','audio','video','file','reaction'];
    const rtcTypes  = ['webrtc_call','webrtc_ready','webrtc_offer','webrtc_answer','webrtc_ice','webrtc_hangup'];

    if (dataTypes.includes(msg.type)) {
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

      if (room.clients.size === 2) broadcastExcept(room, ws, fwd);
      else { if (room.pending.length < MAX_PENDING) room.pending.push(fwd); ws.send(JSON.stringify({ type: 'buffered', id: msg.id })); }

    } else if (rtcTypes.includes(msg.type)) {
      // WebRTC Signaling blind weiterleiten
      const fwd = { type: msg.type };
      if (msg.sdp)       fwd.sdp       = msg.sdp;
      if (msg.candidate) fwd.candidate = msg.candidate;
      broadcastExcept(room, ws, fwd);

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
      if (room.extensionCount >= 3) { ws.send(JSON.stringify({ type: 'error', code: 'max_extensions' })); return; }
      room.extensionCount++;
      clearTimeout(room.hardTimer);
      room.hardTimer = setTimeout(() => deleteRoom(roomId, 'inactivity'), 60 * 60 * 1000);
      broadcastAll(room, { type: 'extended', newExpiry: Date.now() + 60*60*1000, extensionsLeft: 3 - room.extensionCount });
    } else if (msg.type === 'self_destruct_ack') {
      broadcastExcept(room, ws, { type: 'self_destruct_ack', id: msg.id });
    } else if (msg.type === 'end') {
      deleteRoom(roomId, 'user_ended');
    }
  });

  ws.on('close', (code) => {
    clearTimeout(authTimer);
    // Nur entfernen wenn das aktuelle WS noch der Eintrag für diesen Token ist
    // (nicht wenn es schon durch Reconnect ersetzt wurde)
    if (room.clients.get(token) === ws) {
      room.clients.delete(token);
      const remaining = rooms.get(roomId);
      if (!remaining) return;
      remaining.sealed = remaining.clients.size >= 2;
      broadcastCount(remaining);
    }
  });

  ws.on('error', () => {
    clearTimeout(authTimer);
    if (room.clients.get(token) === ws) room.clients.delete(token);
  });
});

// Ping-Loop
const pingInterval = setInterval(() => {
  for (const [, room] of rooms) {
    for (const ws of room.clients.values()) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }
}, PING_INTERVAL);
server.on('close', () => clearInterval(pingInterval));

function broadcastCount(room) {
  broadcastAll(room, { type: 'participant_count', count: room.clients.size });
}
function broadcastAll(room, msg) {
  const data = JSON.stringify(msg);
  for (const ws of room.clients.values()) if (ws.readyState === 1) ws.send(data);
}
function broadcastExcept(room, sender, msg) {
  const data = JSON.stringify(msg);
  for (const ws of room.clients.values()) if (ws !== sender && ws.readyState === 1) ws.send(data);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ephemera läuft auf http://localhost:${PORT}`));
