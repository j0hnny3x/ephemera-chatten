'use strict';

const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');
const crypto  = require('crypto');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ── In-Memory-Räume ───────────────────────────────────────────────────────────
const rooms = new Map();

const ROOM_LIFETIME  = 2 * 60 * 60 * 1000; // 2 h Gesamt-Lifetime
const GRACE_MS       = 5 * 60 * 1000;       // 5 Min. Kulanz wenn alle weg
const MAX_CLIENTS    = 2;
const MAX_MSG_LEN    = 6000;
const MAX_PENDING    = 50;
const PING_INTERVAL  = 25 * 1000;           // Server-Ping alle 25 Sek.

function createRoom(id, pwHash) {
  // Haupt-Timer: Raum stirbt spätestens nach ROOM_LIFETIME
  const hardTimer  = setTimeout(() => deleteRoom(id, 'inactivity'), ROOM_LIFETIME);
  rooms.set(id, {
    clients:    new Set(),
    hardTimer,
    graceTimer: null,
    createdAt:  Date.now(),
    pwHash:     pwHash || null,
    pending:    [],
  });
}

function deleteRoom(id, reason) {
  const room = rooms.get(id);
  if (!room) return;
  clearTimeout(room.hardTimer);
  clearTimeout(room.graceTimer);
  for (const client of room.clients) {
    try { client.send(JSON.stringify({ type: 'room_closed', reason })); } catch {}
    try { client.close(); } catch {}
  }
  rooms.delete(id);
  console.log(`[room] ${id.slice(0, 8)}… closed (${reason})`);
}

// Startet/resettet den Kulanz-Timer wenn alle Clients weg sind
function startGrace(id) {
  const room = rooms.get(id);
  if (!room) return;
  clearTimeout(room.graceTimer);
  room.graceTimer = setTimeout(() => deleteRoom(id, 'all_left'), GRACE_MS);
  console.log(`[room] ${id.slice(0, 8)}… grace period started (${GRACE_MS / 1000}s)`);
}

function cancelGrace(id) {
  const room = rooms.get(id);
  if (!room) return;
  clearTimeout(room.graceTimer);
  room.graceTimer = null;
}

// ── Security-Header ───────────────────────────────────────────────────────────
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
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});

app.use(express.static(__dirname, { etag: false }));
app.use(express.json({ limit: '8kb' }));

// ── REST ──────────────────────────────────────────────────────────────────────
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
  res.json({ createdAt: room.createdAt, hasPassword: !!room.pwHash });
});

app.get('/r/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const match = req.url.match(/^\/ws\/([a-f0-9]{32})$/);
  if (!match) { ws.close(4000, 'invalid_room'); return; }

  const roomId = match[1];
  const room   = rooms.get(roomId);

  if (!room)                            { ws.close(4001, 'room_not_found'); return; }
  if (room.clients.size >= MAX_CLIENTS) { ws.close(4002, 'room_full');      return; }

  let authenticated = !room.pwHash;
  let authTimer     = room.pwHash ? setTimeout(() => ws.close(4003, 'auth_timeout'), 5000) : null;
  let isAlive       = true;

  room.clients.add(ws);
  cancelGrace(roomId); // Jemand ist zurück → Kulanz stoppen
  broadcastCount(room);

  // Gepufferte Nachrichten ausliefern wenn 2. Person kommt
  function flushPending() {
    if (room.pending.length === 0) return;
    const toFlush = [...room.pending];
    room.pending  = [];
    for (const p of toFlush) {
      try { ws.send(JSON.stringify({ type: 'chat', payload: p.payload, id: p.id, ts: p.ts, pending: true })); } catch {}
    }
  }

  if (room.clients.size === 2 && authenticated) flushPending();

  // ── Server-seitiger Ping/Pong ─────────────────────────────────────────────
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    ws.isAlive = true; // Jede eingehende Nachricht = noch lebendig

    if (raw.length > MAX_MSG_LEN) {
      ws.send(JSON.stringify({ type: 'error', code: 'msg_too_long' }));
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Client-seitiger Keepalive-Ping
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

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

    if (msg.type === 'chat') {
      if (typeof msg.payload !== 'string' || typeof msg.id !== 'string') return;
      const ts = Date.now();
      if (room.clients.size === 2) {
        broadcastExcept(room, ws, { type: 'chat', payload: msg.payload, id: msg.id, ts });
      } else {
        if (room.pending.length < MAX_PENDING) room.pending.push({ payload: msg.payload, id: msg.id, ts });
        ws.send(JSON.stringify({ type: 'buffered', id: msg.id }));
      }
    } else if (msg.type === 'read') {
      broadcastExcept(room, ws, { type: 'read', id: msg.id });
    } else if (msg.type === 'typing') {
      broadcastExcept(room, ws, { type: 'typing', active: msg.active });
    } else if (msg.type === 'retract') {
      if (typeof msg.id !== 'string') return;
      room.pending = room.pending.filter(p => p.id !== msg.id);
      broadcastExcept(room, ws, { type: 'retract', id: msg.id });
    } else if (msg.type === 'end') {
      deleteRoom(roomId, 'user_ended');
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    room.clients.delete(ws);
    const remaining = rooms.get(roomId);
    if (!remaining) return;
    broadcastCount(remaining);
    if (remaining.clients.size === 0) {
      startGrace(roomId); // Nicht sofort löschen — 5 Min. Kulanz
    }
  });

  ws.on('error', () => {
    clearTimeout(authTimer);
    room.clients.delete(ws);
  });
});

// ── Ping-Loop: tote Verbindungen aufräumen ────────────────────────────────────
const pingInterval = setInterval(() => {
  for (const [id, room] of rooms) {
    for (const ws of room.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
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
