function createGame(count, size) {
  const owner = new Uint8Array(size * size);
  const trail = new Uint8Array(size * size);
  const inside = (x, y) => x >= 0 && y >= 0 && x < size && y < size;
  const encode = (cells) => Array.from(cells, (v) => String.fromCharCode(48 + v)).join('');
  let events = [];
  let lastCapturer = 0;

  const players = Array.from({ length: count }, (_, k) => {
    const angle = (2 * Math.PI * k) / count;
    const radius = size / 2 - 6;
    const x = Math.round(size / 2 + Math.cos(angle) * radius);
    const y = Math.round(size / 2 + Math.sin(angle) * radius);
    const toCenterX = size / 2 - x;
    const toCenterY = size / 2 - y;
    const horizontal = Math.abs(toCenterX) >= Math.abs(toCenterY);
    const dx = horizontal ? Math.sign(toCenterX) : 0;
    const dy = horizontal ? 0 : Math.sign(toCenterY);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) owner[(y + oy) * size + x + ox] = k + 1;
    }
    return { id: k + 1, x, y, dx, dy, pdx: dx, pdy: dy, alive: true, trailLen: 0 };
  });

  function kill(p, killerId = 0, reason = 'dead') {
    if (!p.alive) return;
    p.alive = false;
    p.trailLen = 0;
    events.push({ victim: p.id, killer: killerId, reason });
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

    const outside = new Uint8Array(owner.length);
    const stack = [];
    const visit = (x, y) => {
      if (!inside(x, y)) return;
      const i = y * size + x;
      if (outside[i] || owner[i] === p.id) return;
      outside[i] = 1;
      stack.push(i);
    };
    for (let k = 0; k < size; k++) {
      visit(k, 0);
      visit(k, size - 1);
      visit(0, k);
      visit(size - 1, k);
    }
    while (stack.length) {
      const i = stack.pop();
      const x = i % size;
      const y = (i - x) / size;
      visit(x + 1, y);
      visit(x - 1, y);
      visit(x, y + 1);
      visit(x, y - 1);
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

  function killCollisions(movers, next) {
    const doomed = new Map();
    for (let a = 0; a < movers.length; a++) {
      for (let b = a + 1; b < movers.length; b++) {
        const p = movers[a];
        const q = movers[b];
        const np = next.get(p);
        const nq = next.get(q);
        const sameCell = np.x === nq.x && np.y === nq.y;
        const swapped = np.x === q.x && np.y === q.y && nq.x === p.x && nq.y === p.y;
        if (sameCell || swapped) {
          if (!doomed.has(p)) doomed.set(p, q.id);
          if (!doomed.has(q)) doomed.set(q, p.id);
        }
      }
    }
    for (const [p, otherId] of doomed) kill(p, otherId, 'collision');
  }

  function move(p, next) {
    const { x, y } = next;
    if (!inside(x, y)) return kill(p, 0, 'wall');

    const i = y * size + x;
    const t = trail[i];
    if (t === p.id) kill(p, p.id, 'self');
    else if (t) kill(players[t - 1], p.id, 'trail');
    if (!p.alive) return;

    p.x = x;
    p.y = y;
    if (owner[i] !== p.id) {
      trail[i] = p.id;
      p.trailLen++;
    } else if (p.trailLen > 0) {
      capture(p);
    }
  }

  function step() {
    lastCapturer = 0;
    const movers = players.filter((p) => p.alive);
    for (const p of movers) {
      p.dx = p.pdx;
      p.dy = p.pdy;
    }
    const next = new Map(movers.map((p) => [p, { x: p.x + p.dx, y: p.y + p.dy }]));

    killCollisions(movers, next);
    for (const p of movers) {
      if (p.alive) move(p, next.get(p));
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
    for (const o of owner) if (o) counts[o - 1]++;
    return counts;
  }

  function snapshot() {
    const counts = scores();
    const emitted = events;
    events = [];
    return {
      owner: encode(owner),
      trail: encode(trail),
      events: emitted,
      players: players.map((p, k) => ({ id: p.id, x: p.x, y: p.y, alive: p.alive, score: counts[k] }))
    };
  }

  return {
    step,
    setDir,
    scores,
    snapshot,
    kill: (id) => kill(players[id - 1], 0, 'left'),
    aliveCount: () => players.filter((p) => p.alive).length
  };
}

module.exports = { createGame };
