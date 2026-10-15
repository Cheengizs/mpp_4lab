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
const MAX_MESSAGE_BYTES = 1024;
const TOKEN_PATTERN = /^[a-f0-9]{32,64}$/;

const rooms = new Map();

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
});

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

server.on('error', (err) => {
  console.error('http server error:', err);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

wss.on('error', (err) => {
  console.error('websocket server error:', err);
});

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(room, payload) {
  const data = JSON.stringify(payload);
  for (const m of room.members) {
    if (m.ws.readyState === WebSocket.OPEN) m.ws.send(data);
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function lobbyInfo(room) {
  return {
    type: 'lobby',
    max: room.max,
    min: MIN_PLAYERS,
    host: room.members.length ? room.members[0].name : null,
    players: room.members.map((m) => m.name),
    running: !!room.game,
    wins: [...room.wins.values()].map((w) => ({ name: w.name, wins: w.wins })).sort((a, b) => b.wins - a.wins)
  };
}

function startPayload(room) {
  return {
    type: 'start',
    w: room.size,
    h: room.size,
    players: room.members.map((m) => ({ id: m.id, name: m.name }))
  };
}

function nameTaken(room, name, hash) {
  const lower = name.toLowerCase();
  if (room.members.some((m) => m.hash !== hash && m.name.toLowerCase() === lower)) return true;
  for (const [ownerHash, w] of room.wins) {
    if (ownerHash !== hash && w.name.toLowerCase() === lower) return true;
  }
  return false;
}

function pickName(room, nick, hash) {
  let base = String(nick || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!base) base = 'Игрок';
  let name = base;
  let num = 1;
  while (nameTaken(room, name, hash)) {
    num++;
    name = `${base} (${num})`;
  }
  return name;
}

function recordWin(room, member) {
  const entry = room.wins.get(member.hash) || { name: member.name, wins: 0 };
  entry.name = member.name;
  entry.wins++;
  room.wins.set(member.hash, entry);
  db.addWin(room.id, member.hash, member.name);
}

function stopGame(room) {
  clearInterval(room.timer);
  room.timer = null;
  room.game = null;
  room.members = room.members.filter((m) => m.ws.readyState === WebSocket.OPEN);
  room.members.forEach((m) => {
    m.id = 0;
  });
  room.lastActive = Date.now();
  db.touchRoom(room.id);
}

function finish(room, reason) {
  const scores = room.game.scores();
  const total = room.size * room.size;
  const ranked = room.members
    .map((m) => ({
      member: m,
      name: m.name,
      color: m.id,
      percent: Math.round((scores[m.id - 1] / total) * 1000) / 10
    }))
    .sort((a, b) => b.percent - a.percent);
  const best = ranked.length ? ranked[0].percent : 0;
  if (best > 0) {
    for (const r of ranked) {
      if (r.percent === best) recordWin(room, r.member);
    }
  }
  const results = ranked.map(({ name, color, percent }) => ({ name, color, percent }));
  broadcast(room, { type: 'end', reason, results });
  stopGame(room);
  if (room.members.length === 0) return;
  broadcast(room, lobbyInfo(room));
}

function abort(room, err) {
  console.error(`game in room ${room.id} aborted:`, err);
  broadcast(room, { type: 'aborted' });
  stopGame(room);
  broadcast(room, lobbyInfo(room));
}

function tick(room) {
  try {
    const game = room.game;
    game.step();
    const remaining = Math.max(0, room.endsAt - Date.now());
    const snap = game.snapshot();
    snap.type = 'state';
    snap.remaining = remaining;
    broadcast(room, snap);
    if (game.aliveCount() <= 1) return finish(room, 'last');
    if (remaining === 0) finish(room, 'time');
  } catch (err) {
    abort(room, err);
  }
}

function startGame(room) {
  room.members.forEach((m, k) => {
    m.id = k + 1;
  });
  room.game = createGame(room.members.length, room.size);
  room.endsAt = Date.now() + GAME_MS;
  broadcast(room, startPayload(room));
  room.members.forEach((m) => send(m.ws, { type: 'you', id: m.id }));
  room.timer = setInterval(() => tick(room), TICK_MS);
}

wss.on('connection', (ws, req) => {
  ws.on('error', (err) => {
    console.error('websocket error:', err.message);
  });

  const url = new URL(req.url, 'http://localhost');
  const room = rooms.get(url.searchParams.get('room'));
  if (!room) return ws.close(4004, 'no room');

  const token = url.searchParams.get('token') || '';
  if (!TOKEN_PATTERN.test(token)) return ws.close(4008, 'bad token');
  const hash = hashToken(token);

  let member = room.members.find((m) => m.hash === hash);
  if (member) {
    const old = member.ws;
    member.ws = ws;
    if (old !== ws && (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING)) {
      old.close(4007, 'replaced');
    }
  } else {
    if (room.game) return ws.close(4005, 'in progress');
    if (room.members.length >= room.max) return ws.close(4006, 'full');
    member = { ws, hash, id: 0, name: pickName(room, url.searchParams.get('nick'), hash) };
    room.members.push(member);
  }

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  send(ws, { type: 'name', name: member.name });
  broadcast(room, lobbyInfo(room));

  if (room.game) {
    send(ws, startPayload(room));
    send(ws, { type: 'you', id: member.id });
  } else if (room.members.length === room.max) {
    startGame(room);
  }

  ws.on('message', (raw) => {
    if (member.ws !== ws) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'start') {
      if (!room.game && room.members[0] === member && room.members.length >= MIN_PLAYERS) startGame(room);
    } else if (msg.type === 'dir' && room.game && member.id) {
      room.game.setDir(member.id, Number(msg.dx) || 0, Number(msg.dy) || 0);
    }
  });

  ws.on('close', () => {
    if (member.ws !== ws) return;
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
