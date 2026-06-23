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

const INACTIVITY_MS = 2 * 60 * 60 * 1000; // 2 Stunden
const MAX_CLIENTS   = 2;
const MAX_MSG_LEN   = 6000;

function createRoom(id) {
  const createdAt = Date.now();
  const timer = setTimeout(() => deleteRoom(id, 'inactivity'), INACTIVITY_MS);
  rooms.set(id, { clients: new Set(), timer, createdAt });
}

function deleteRoom(id, reason) {
  const room = rooms.get(id);
  if (!room) return;
  clearTimeout(room.timer);
  for (const client of room.clients) {
    try { client.send(JSON.stringify({ type: 'room_closed', reason })); } catch {}
    try { client.close(); } catch {}
  }
  rooms.delete(id);
  console.log(`[room] ${id.slice(0, 8)}… closed (${reason})`);
}

function resetTimer(id) {
  const room = rooms.get(id);
  if (!room) return;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => deleteRoom(id, 'inactivity'), INACTIVITY_MS);
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

// ── Statische Dateien ─────────────────────────────────────────────────────────
app.use(express.static(__dirname, { etag: false }));

// ── REST: Raum erstellen ──────────────────────────────────────────────────────
app.post('/api/room', (req, res) => {
  const id = crypto.randomBytes(16).toString('hex');
  createRoom(id);
  res.json({ roomId: id });
});

// ── REST: Raum-Info (createdAt für Countdown) ─────────────────────────────────
app.get('/api/room/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'not_found' });
  res.json({ createdAt: room.createdAt });
});

// ── SPA-Fallback /r/:id ───────────────────────────────────────────────────────
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

  room.clients.add(ws);
  resetTimer(roomId);
  broadcast(room, { type: 'participant_count', count: room.clients.size });

  ws.on('message', (raw) => {
    if (raw.length > MAX_MSG_LEN) {
      ws.send(JSON.stringify({ type: 'error', code: 'msg_too_long' }));
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    resetTimer(roomId);

    if (msg.type === 'chat') {
      if (typeof msg.payload !== 'string' || typeof msg.id !== 'string') return;
      broadcastExcept(room, ws, { type: 'chat', payload: msg.payload, id: msg.id });

    } else if (msg.type === 'read') {
      // Gelesen-Bestätigung weiterleiten
      broadcastExcept(room, ws, { type: 'read', id: msg.id });

    } else if (msg.type === 'typing') {
      broadcastExcept(room, ws, { type: 'typing', active: msg.active });

    } else if (msg.type === 'retract') {
      // Nachricht zurückziehen
      if (typeof msg.id !== 'string') return;
      broadcastExcept(room, ws, { type: 'retract', id: msg.id });

    } else if (msg.type === 'end') {
      deleteRoom(roomId, 'user_ended');
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    const remaining = rooms.get(roomId);
    if (remaining) {
      broadcast(remaining, { type: 'participant_count', count: remaining.clients.size });
      if (remaining.clients.size === 0) deleteRoom(roomId, 'all_left');
    }
  });

  ws.on('error', () => { room.clients.delete(ws); });
});

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
