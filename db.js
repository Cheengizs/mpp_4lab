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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wins (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      wins INT NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, name)
    )
  `);
}

async function loadRooms() {
  if (!enabled) return [];
  const rooms = await pool.query('SELECT id, max, size, last_active FROM rooms');
  const wins = await pool.query('SELECT room_id, name, wins FROM wins');
  const byRoom = new Map();
  for (const w of wins.rows) {
    if (!byRoom.has(w.room_id)) byRoom.set(w.room_id, new Map());
    byRoom.get(w.room_id).set(w.name, w.wins);
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

function addWin(roomId, name) {
  if (!enabled) return;
  pool
    .query(
      `INSERT INTO wins (room_id, name, wins) VALUES ($1, $2, 1)
       ON CONFLICT (room_id, name) DO UPDATE SET wins = wins.wins + 1`,
      [roomId, name]
    )
    .catch(report);
}

function deleteRoom(id) {
  if (!enabled) return;
  pool.query('DELETE FROM rooms WHERE id = $1', [id]).catch(report);
}

module.exports = { enabled, init, loadRooms, saveRoom, touchRoom, addWin, deleteRoom };
