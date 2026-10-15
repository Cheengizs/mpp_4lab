const { Pool } = require('pg');

const enabled = !!process.env.DATABASE_URL;
const pool = enabled
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
    })
  : null;

function report(err) {
  console.error('db error:', err.message);
}

async function init() {
  if (!enabled) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      max INT NOT NULL,
      size INT NOT NULL,
      last_active TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('DROP TABLE IF EXISTS wins');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_wins (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      wins INT NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, token_hash)
    )
  `);
}

async function loadRooms() {
  if (!enabled) return [];
  const rooms = await pool.query('SELECT id, max, size, last_active FROM rooms');
  const wins = await pool.query('SELECT room_id, token_hash, name, wins FROM player_wins');
  const byRoom = new Map();
  for (const w of wins.rows) {
    if (!byRoom.has(w.room_id)) byRoom.set(w.room_id, new Map());
    byRoom.get(w.room_id).set(w.token_hash, { name: w.name, wins: w.wins });
  }
  return rooms.rows.map((r) => ({
    id: r.id,
    max: r.max,
    size: r.size,
    lastActive: r.last_active.getTime(),
    wins: byRoom.get(r.id) || new Map()
  }));
}

function saveRoom(room) {
  if (!enabled) return;
  pool
    .query('INSERT INTO rooms (id, max, size, last_active) VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING', [
      room.id,
      room.max,
      room.size
    ])
    .catch(report);
}

function touchRoom(id) {
  if (!enabled) return;
  pool.query('UPDATE rooms SET last_active = now() WHERE id = $1', [id]).catch(report);
}

function addWin(roomId, tokenHash, name) {
  if (!enabled) return;
  pool
    .query(
      `INSERT INTO player_wins (room_id, token_hash, name, wins) VALUES ($1, $2, $3, 1)
       ON CONFLICT (room_id, token_hash) DO UPDATE SET wins = player_wins.wins + 1, name = EXCLUDED.name`,
      [roomId, tokenHash, name]
    )
    .catch(report);
}

function deleteRoom(id) {
  if (!enabled) return;
  pool.query('DELETE FROM rooms WHERE id = $1', [id]).catch(report);
}

module.exports = { enabled, init, loadRooms, saveRoom, touchRoom, addWin, deleteRoom };
