const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// roomId -> Set<ws>
const rooms = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // "/" -> create a unique room and redirect to it
  if (url.pathname === '/') {
    const id = crypto.randomBytes(6).toString('hex');
    res.writeHead(302, { Location: `/room/${id}` });
    return res.end();
  }

  // "/room/<id>" -> the chat page
  if (/^\/room\/[a-zA-Z0-9_-]{1,64}$/.test(url.pathname)) {
    return fs.createReadStream(path.join(PUBLIC_DIR, 'index.html'))
      .on('error', () => { res.writeHead(500); res.end('error'); })
      .once('open', () => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }))
      .pipe(res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(roomId, payload) {
  const data = JSON.stringify(payload);
  for (const client of rooms.get(roomId) || []) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = (url.searchParams.get('room') || '').slice(0, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) return ws.close(1008, 'bad room');

  const name = 'user-' + crypto.randomBytes(2).toString('hex');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(ws);

  ws.send(JSON.stringify({ type: 'welcome', name }));
  broadcast(roomId, { type: 'system', text: `${name} joined`, online: rooms.get(roomId).size });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const text = String(msg.text || '').trim().slice(0, 1000);
    if (!text) return;
    broadcast(roomId, { type: 'message', name, text, time: Date.now() });
  });

  ws.on('close', () => {
    const room = rooms.get(roomId);
    room.delete(ws);
    if (room.size === 0) rooms.delete(roomId);
    else broadcast(roomId, { type: 'system', text: `${name} left`, online: room.size });
  });
});

// Keep-alive: hosting proxies drop idle connections, and this prunes dead clients.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`Listening on :${PORT}`));
