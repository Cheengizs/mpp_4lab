function createGame(count, size) {
  const W = size;
  const H = size;
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
      pdx: horizontal ? Math.sign(ddx) : 0,
      pdy: horizontal ? 0 : Math.sign(ddy),
      tx: 0,
      ty: 0,
      alive: true,
      trailLen: 0
    };
    players.push(p);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) owner[(cy + oy) * W + cx + ox] = p.id;
    }
  }

  let events = [];
  let lastCapturer = 0;

  function kill(p, killerId = 0, reason = 'dead') {
    if (!p.alive) return;
    p.alive = false;
    events.push({ victim: p.id, killer: killerId, reason });
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
    lastCapturer = p.id;
    for (const id of victims) kill(players[id - 1], p.id, 'captured');
  }

  function step() {
    lastCapturer = 0;
    const movers = players.filter((p) => p.alive);
    for (const p of movers) {
      p.dx = p.pdx;
      p.dy = p.pdy;
      p.tx = p.x + p.dx;
      p.ty = p.y + p.dy;
    }

    const doomed = new Map();
    for (let a = 0; a < movers.length; a++) {
      for (let b = a + 1; b < movers.length; b++) {
        const p = movers[a];
        const q = movers[b];
        const sameCell = p.tx === q.tx && p.ty === q.ty;
        const swapped = p.tx === q.x && p.ty === q.y && q.tx === p.x && q.ty === p.y;
        if (sameCell || swapped) {
          if (!doomed.has(p)) doomed.set(p, q.id);
          if (!doomed.has(q)) doomed.set(q, p.id);
        }
      }
    }
    for (const [p, otherId] of doomed) kill(p, otherId, 'collision');

    for (const p of movers) {
      if (!p.alive) continue;
      const nx = p.tx;
      const ny = p.ty;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
        kill(p, 0, 'wall');
        continue;
      }
      const i = ny * W + nx;
      const t = trail[i];
      if (t) {
        if (t === p.id) {
          kill(p, p.id, 'self');
        } else {
          kill(players[t - 1], p.id, 'trail');
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

    const counts = scores();
    for (const p of players) {
      if (p.alive && counts[p.id - 1] === 0) kill(p, lastCapturer, 'lost');
    }
  }

  function setDir(id, dx, dy) {
    const p = players[id - 1];
    if (!p || !p.alive) return;
    if (Math.abs(dx) + Math.abs(dy) !== 1) return;
    if (dx === -p.dx && dy === -p.dy) return;
    p.pdx = dx;
    p.pdy = dy;
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
    const emitted = events;
    events = [];
    return {
      owner: Array.from(owner, (v) => String.fromCharCode(48 + v)).join(''),
      trail: Array.from(trail, (v) => String.fromCharCode(48 + v)).join(''),
      events: emitted,
      players: players.map((p, k) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        alive: p.alive,
        score: counts[k]
      }))
    };
  }

  return { step, kill: (id) => kill(players[id - 1], 0, 'left'), setDir, scores, aliveCount, snapshot };
}

module.exports = { createGame };

