const W = 50;
const H = 50;

function createGame(count) {
  const owner = new Uint8Array(W * H);
  const trail = new Uint8Array(W * H);
  const players = [];

  for (let k = 0; k < count; k++) {
    const angle = (2 * Math.PI * k) / count;
    const cx = Math.round(W / 2 + Math.cos(angle) * (W / 2 - 6));
    const cy = Math.round(H / 2 + Math.sin(angle) * (H / 2 - 6));
    const ddx = W / 2 - cx;
    const ddy = H / 2 - cy;
    const horizontal = Math.abs(ddx) >= Math.abs(ddy);
    const p = {
      id: k + 1,
      x: cx,
      y: cy,
      dx: horizontal ? Math.sign(ddx) : 0,
      dy: horizontal ? 0 : Math.sign(ddy),
      alive: true,
      trailLen: 0
    };
    players.push(p);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) owner[(cy + oy) * W + cx + ox] = p.id;
    }
  }

  function kill(p) {
    if (!p.alive) return;
    p.alive = false;
    p.trailLen = 0;
    for (let i = 0; i < owner.length; i++) {
      if (trail[i] === p.id) trail[i] = 0;
      if (owner[i] === p.id) owner[i] = 0;
    }
  }

  function capture(p) {
    for (let i = 0; i < trail.length; i++) {
      if (trail[i] === p.id) {
        trail[i] = 0;
        owner[i] = p.id;
      }
    }
    p.trailLen = 0;

    const outside = new Uint8Array(W * H);
    const stack = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = y * W + x;
      if (outside[i] || owner[i] === p.id) return;
      outside[i] = 1;
      stack.push(i);
    };
    for (let x = 0; x < W; x++) {
      push(x, 0);
      push(x, H - 1);
    }
    for (let y = 0; y < H; y++) {
      push(0, y);
      push(W - 1, y);
    }
    while (stack.length) {
      const i = stack.pop();
      const x = i % W;
      const y = (i - x) / W;
      push(x + 1, y);
      push(x - 1, y);
      push(x, y + 1);
      push(x, y - 1);
    }

    const victims = new Set();
    for (let i = 0; i < owner.length; i++) {
      if (!outside[i] && owner[i] !== p.id) {
        if (trail[i] && trail[i] !== p.id) victims.add(trail[i]);
        owner[i] = p.id;
      }
    }
    for (const id of victims) kill(players[id - 1]);
  }

  function step() {
    for (const p of players) {
      if (!p.alive) continue;
      const nx = p.x + p.dx;
      const ny = p.y + p.dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
        kill(p);
        continue;
      }
      const i = ny * W + nx;
      const t = trail[i];
      if (t) {
        if (t === p.id) {
          kill(p);
        } else {
          kill(players[t - 1]);
        }
        if (!p.alive) continue;
      }
      p.x = nx;
      p.y = ny;
      if (owner[i] === p.id) {
        if (p.trailLen > 0) capture(p);
      } else {
        trail[i] = p.id;
        p.trailLen++;
      }
    }
  }

  function setDir(id, dx, dy) {
    const p = players[id - 1];
    if (!p || !p.alive) return;
    if (Math.abs(dx) + Math.abs(dy) !== 1) return;
    if (dx === -p.dx && dy === -p.dy) return;
    p.dx = dx;
    p.dy = dy;
  }

  function scores() {
    const counts = new Array(count).fill(0);
    for (let i = 0; i < owner.length; i++) if (owner[i]) counts[owner[i] - 1]++;
    return counts;
  }

  function aliveCount() {
    return players.filter((p) => p.alive).length;
  }

  function snapshot() {
    const counts = scores();
    return {
      owner: Array.from(owner, (v) => String.fromCharCode(48 + v)).join(''),
      trail: Array.from(trail, (v) => String.fromCharCode(48 + v)).join(''),
      players: players.map((p, k) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        alive: p.alive,
        score: counts[k]
      }))
    };
  }

  return { step, kill: (id) => kill(players[id - 1]), setDir, scores, aliveCount, snapshot };
}

module.exports = { createGame, W, H };
