const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { createGame } = require('./game');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TICK_MS = 120;
const GAME_MS = 90000;
const MIN_PLAYERS = 2;
const MAX_LIMIT = 10;
const ROOM_TTL_MS = 3600000;
const MIN_SIZE = 20;
const MAX_SIZE = 150;

const rooms = new Map();

function makeRoom({ id, max, size, wins, lastActive }) {
  return {
    id,
    max,
    size,
    members: [],
    game: null,
    timer: null,
    endsAt: 0,
    wins: wins || new Map(),
    lastActive: lastActive || Date.now()
  };
}

function sendFile(res, name, type) {
  fs.readFile(path.join(PUBLIC_DIR, name), (err, data) => {
    if (err) {
      res.writeHead(500);
      return res.end('error');
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (url.pathname === '/') return sendFile(res, 'index.html', 'text/html; charset=utf-8');

  if (url.pathname === '/create') {
    const n = Math.min(MAX_LIMIT, Math.max(MIN_PLAYERS, parseInt(url.searchParams.get('n'), 10) || 4));
    const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, parseInt(url.searchParams.get('size'), 10) || 50));
    const id = crypto.randomBytes(4).toString('hex');
    const room = makeRoom({ id, max: n, size });
    rooms.set(id, room);
    db.saveRoom(room);
    res.writeHead(302, { Location: `/room/${id}` });
    return res.end();
  }

  if (/^\/room\/[a-f0-9]{8}$/.test(url.pathname)) {
    return sendFile(res, 'room.html', 'text/html; charset=utf-8');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(room, payload) {
  const data = JSON.stringify(payload);
  for (const m of room.members) {
    if (m.ws.readyState === WebSocket.OPEN) m.ws.send(data);
  }
}

function lobbyInfo(room) {
  return {
    type: 'lobby',
    max: room.max,
    min: MIN_PLAYERS,
    host: room.members.length ? room.members[0].name : null,
    players: room.members.map((m) => m.name),
    running: !!room.game,
    wins: [...room.wins].map(([name, wins]) => ({ name, wins })).sort((a, b) => b.wins - a.wins)
  };
}

function finish(room, reason) {
  clearInterval(room.timer);
  room.timer = null;
  const scores = room.game.scores();
  const total = room.size * room.size;
  const results = room.members
    .map((m) => ({
      name: m.name,
      color: m.id,
      percent: Math.round((scores[m.id - 1] / total) * 1000) / 10
    }))
    .sort((a, b) => b.percent - a.percent);
  room.game = null;
  const best = results.length ? results[0].percent : 0;
  if (best > 0) {
    for (const r of results) {
      if (r.percent === best) {
        room.wins.set(r.name, (room.wins.get(r.name) || 0) + 1);
        db.addWin(room.id, r.name);
      }
    }
  }
  broadcast(room, { type: 'end', reason, results });
  room.members = room.members.filter((m) => m.ws.readyState === WebSocket.OPEN);
  room.members.forEach((m) => {
    m.id = 0;
  });
  room.lastActive = Date.now();
  db.touchRoom(room.id);
  broadcast(room, lobbyInfo(room));
}

function tick(room) {
  const game = room.game;
  game.step();
  const remaining = Math.max(0, room.endsAt - Date.now());
  const snap = game.snapshot();
  snap.type = 'state';
  snap.remaining = remaining;
  broadcast(room, snap);
  if (game.aliveCount() <= 1) return finish(room, 'last');
  if (remaining === 0) finish(room, 'time');
}

function startGame(room) {
  room.members.forEach((m, k) => {
    m.id = k + 1;
  });
  room.game = createGame(room.members.length, room.size);
  room.endsAt = Date.now() + GAME_MS;
  broadcast(room, {
    type: 'start',
    w: room.size,
    h: room.size,
    players: room.members.map((m) => ({ id: m.id, name: m.name }))
  });
  room.members.forEach((m) => send(m.ws, { type: 'you', id: m.id }));
  room.timer = setInterval(() => tick(room), TICK_MS);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const room = rooms.get(url.searchParams.get('room'));
  if (!room) return ws.close(4004, 'no room');
  if (room.game) return ws.close(4005, 'in progress');
  if (room.members.length >= room.max) return ws.close(4006, 'full');

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const member = { ws, id: 0, name: '' };
  let base = (url.searchParams.get('nick') || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!base) base = 'Игрок';
  let name = base;
  let num = 1;
  while (room.members.some((m) => m.name === name)) {
    num++;
    name = `${base} (${num})`;
  }
  member.name = name;
  room.members.push(member);

  broadcast(room, lobbyInfo(room));
  send(ws, { type: 'name', name: member.name });

  if (room.members.length === room.max) startGame(room);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'start') {
      if (!room.game && room.members[0] === member && room.members.length >= MIN_PLAYERS) startGame(room);
    } else if (msg.type === 'dir' && room.game && member.id) {
      room.game.setDir(member.id, Number(msg.dx) || 0, Number(msg.dy) || 0);
    }
  });

  ws.on('close', () => {
    const idx = room.members.indexOf(member);
    if (idx === -1) return;
    if (room.game) {
      room.game.kill(member.id);
      return;
    }
    room.members.splice(idx, 1);
    room.lastActive = Date.now();
    db.touchRoom(room.id);
    broadcast(room, lobbyInfo(room));
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.game && room.members.length === 0 && Date.now() - room.lastActive > ROOM_TTL_MS) {
      rooms.delete(room.id);
      db.deleteRoom(room.id);
    }
  }
}, 600000);

async function start() {
  try {
    await db.init();
    for (const r of await db.loadRooms()) rooms.set(r.id, makeRoom(r));
    console.log(db.enabled ? `Restored ${rooms.size} rooms from database` : 'No DATABASE_URL, running in memory');
  } catch (err) {
    console.error('Database unavailable:', err.message);
    process.exit(1);
  }
  server.listen(PORT, () => console.log(`Listening on :${PORT}`));
}

start();
