"use strict";
/* ============================================================================
   dev/dxf-standin.js  (drafting agent, dev only - never shipped)
   ----------------------------------------------------------------------------
   Stand-ins for the modules the drafting code depends on but does not own,
   used ONLY while the real ones do not exist yet:

     HP.analyze(plan)  - the parts of CONTRACT.md section 5 that drawing.js
                         reads: rooms, walls.loops (openings cut out),
                         footprint, yard, openings (+ geometry), roomOpenings,
                         bbox, access.entrances. Rectilinear booleans on a
                         compressed grid - exact for rooms on a 5 cm grid.
     HP.furniture      - two tiny blocks so INSERT/BLOCK can be exercised.

   Each is installed only if the real one is missing: once src/analyze.js and
   src/furniture.js exist, loading this file changes nothing.
============================================================================ */
(function (HP) {
  // ---------------------------------------------------------------- grid booleans
  function cellsToLoops(xs, ys, filled) {
    const nx = xs.length - 1, ny = ys.length - 1;
    const F = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && filled[j * nx + i];
    const edges = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!F(i, j)) continue;
      const x0 = xs[i], x1 = xs[i + 1], y0 = ys[j], y1 = ys[j + 1];
      if (!F(i, j - 1)) edges.push([[x0, y0], [x1, y0]]);
      if (!F(i + 1, j)) edges.push([[x1, y0], [x1, y1]]);
      if (!F(i, j + 1)) edges.push([[x1, y1], [x0, y1]]);
      if (!F(i - 1, j)) edges.push([[x0, y1], [x0, y0]]);
    }
    const key = p => p[0] + "," + p[1];
    const from = new Map();
    edges.forEach((e, k) => { const s = key(e[0]); if (!from.has(s)) from.set(s, []); from.get(s).push(k); });
    const used = new Uint8Array(edges.length), loops = [];
    for (let k0 = 0; k0 < edges.length; k0++) {
      if (used[k0]) continue;
      const loop = [];
      let k = k0;
      while (k != null && !used[k]) {
        used[k] = 1;
        const e = edges[k];
        loop.push(e[0]);
        const cands = (from.get(key(e[1])) || []).filter(c => !used[c]);
        if (!cands.length) break;
        if (cands.length === 1) { k = cands[0]; continue; }
        // pinch vertex: take the sharpest left turn so touching loops stay apart
        const d0 = [e[1][0] - e[0][0], e[1][1] - e[0][1]];
        let best = null, bestT = -Infinity;
        for (const c of cands) {
          const f = edges[c], d1 = [f[1][0] - f[0][0], f[1][1] - f[0][1]];
          const t = Math.atan2(d0[0] * d1[1] - d0[1] * d1[0], d0[0] * d1[0] + d0[1] * d1[1]);
          if (t > bestT) { bestT = t; best = c; }
        }
        k = best;
      }
      // drop collinear points
      const out = [];
      for (let i = 0; i < loop.length; i++) {
        const a = loop[(i - 1 + loop.length) % loop.length], b = loop[i], c = loop[(i + 1) % loop.length];
        if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b);
      }
      if (out.length >= 3) loops.push(out);
    }
    return loops;
  }
  function gridOf(rects) {
    const xs = new Set(), ys = new Set();
    for (const r of rects) { xs.add(r.x); xs.add(r.x + r.w); ys.add(r.y); ys.add(r.y + r.h); }
    return { xs: [...xs].sort((a, b) => a - b), ys: [...ys].sort((a, b) => a - b) };
  }
  function fill(xs, ys, test) {
    const nx = xs.length - 1, ny = ys.length - 1, f = new Uint8Array(Math.max(0, nx * ny));
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
      f[j * nx + i] = test((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2) ? 1 : 0;
    return f;
  }
  const inR = (r, x, y) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;

  // ---------------------------------------------------------------- analyze
  function analyze(plan) {
    const ext = plan.walls.ext, int = plan.walls.int;
    const rooms = plan.rooms.map(r => Object.assign({}, r, {
      area: r.w * r.h, roofed: HP.ROOM_TYPES[r.type] ? HP.ROOM_TYPES[r.type].roofed : true,
      cx: r.x + r.w / 2, cy: r.y + r.h / 2,
    }));
    const byId = {}; rooms.forEach(r => byId[r.id] = r);
    const grown = rooms.map(r => HP.grow(r, ext));
    const plotPts = plan.plot.pts;

    // the room on the far side of a shared wall along `side` of r over [s0,s1]
    function across(r, side, s0, s1) {
      for (const o of rooms) {
        if (o === r) continue;
        if (side === "N" && o.y - (r.y + r.h) === int && HP.spanOverlap(o.x, o.x + o.w, s0, s1) === s1 - s0) return o;
        if (side === "S" && r.y - (o.y + o.h) === int && HP.spanOverlap(o.x, o.x + o.w, s0, s1) === s1 - s0) return o;
        if (side === "E" && o.x - (r.x + r.w) === int && HP.spanOverlap(o.y, o.y + o.h, s0, s1) === s1 - s0) return o;
        if (side === "W" && r.x - (o.x + o.w) === int && HP.spanOverlap(o.y, o.y + o.h, s0, s1) === s1 - s0) return o;
      }
      return null;
    }
    function plotFacing(p, n) {          // ray from p along n: distance and edge
      let best = Infinity, edge = -1;
      for (let i = 0; i < plotPts.length; i++) {
        const a = plotPts[i], b = plotPts[(i + 1) % plotPts.length];
        const ex = b[0] - a[0], ey = b[1] - a[1];
        const den = n[0] * ey - n[1] * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
        const u = ((a[0] - p[0]) * n[1] - (a[1] - p[1]) * n[0]) / den;
        if (t >= -1e-9 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) { best = t; edge = i; }
      }
      return { d: best, edge };
    }
    const openings = [];
    const roomOpenings = {}; rooms.forEach(r => roomOpenings[r.id] = []);
    for (const o of plan.openings) {
      const r = byId[o.room]; if (!r) continue;
      const si = HP.sideInfo(r, o.side);
      const s0 = si.s0 + o.at, s1 = s0 + o.w;
      const other = across(r, o.side, s0, s1);
      const thick = other ? int : ext;
      const nq = si.axis === "x" ? si.n[1] : si.n[0];
      const far = si.fixed + nq * thick;
      let facing, otherId = null;
      if (other) { facing = other.roofed ? "room" : "open"; otherId = other.id; }
      else {
        const mid = (s0 + s1) / 2;
        const p = si.axis === "x" ? [mid, far] : [far, mid];
        const hit = plotFacing(p, si.n);
        if (hit.d < HP.RULES.minOpenDepth) { facing = plan.plot.edges[hit.edge] || "neighbour"; otherId = hit.edge; }
        else facing = "yard";
      }
      const g = Object.assign({}, o, { axis: si.axis, s0, s1, fixed: si.fixed, thick, far, n: si.n, facing, other: otherId, ok: true, reason: "" });
      openings.push(g);
      const hingeAt = o.hinge === "end" ? "s1" : "s0";
      roomOpenings[r.id].push({ id: o.id, kind: o.kind, side: o.side, s0, s1, w: o.w, swingInto: o.kind === "door" && o.swing !== "out", hingeAt });
      if (other) roomOpenings[other.id].push({ id: o.id, kind: o.kind, side: HP.opposite(o.side), s0, s1, w: o.w, swingInto: o.kind === "door" && o.swing === "out", hingeAt });
    }
    const opRects = openings.map(g => g.axis === "x"
      ? { x: g.s0, y: Math.min(g.fixed, g.far), w: g.s1 - g.s0, h: Math.abs(g.far - g.fixed) }
      : { x: Math.min(g.fixed, g.far), y: g.s0, w: Math.abs(g.far - g.fixed), h: g.s1 - g.s0 });

    const { xs, ys } = gridOf(grown.concat(rooms, opRects));
    const foot = fill(xs, ys, (x, y) => grown.some(g => inR(g, x, y)));
    const poche = fill(xs, ys, (x, y) => grown.some(g => inR(g, x, y)) && !rooms.some(r => inR(r, x, y)) && !opRects.some(r => inR(r, x, y)));
    const footLoops = cellsToLoops(xs, ys, foot);
    const wallLoops = cellsToLoops(xs, ys, poche);
    let bbox = null;
    if (grown.length) bbox = {
      x0: Math.min(...grown.map(g => g.x)), y0: Math.min(...grown.map(g => g.y)),
      x1: Math.max(...grown.map(g => g.x + g.w)), y1: Math.max(...grown.map(g => g.y + g.h)),
    };
    const entrances = openings.filter(g => g.kind === "door" && (g.facing === "yard" || g.facing === "street")).map(g => g.id);
    return {
      rooms, sides: {}, walls: { loops: wallLoops }, footprint: { loops: footLoops },
      yard: { loops: [plotPts.map(p => p.slice())].concat(footLoops) },
      openings, roomOpenings, handles: [], bbox, rules: [], issues: {},
      access: { reachable: rooms.map(r => r.id), entrances },
      stats: {}, standin: true,
    };
  }

  // ---------------------------------------------------------------- furniture
  const BLOCKS = {
    HP_STANDIN_BED: { layer: "A-FURN", w: 160, h: 200, items: [
      { kind: "pline", pts: [[0, 0], [160, 0], [160, 200], [0, 200]], closed: true },
      { kind: "pline", pts: [[15, 160], [75, 160], [75, 190], [15, 190]], closed: true },
      { kind: "pline", pts: [[85, 160], [145, 160], [145, 190], [85, 190]], closed: true },
      { kind: "line", a: [0, 150], b: [160, 150] },
    ] },
    HP_STANDIN_WC: { layer: "A-FIXT", w: 40, h: 70, items: [
      { kind: "pline", pts: [[0, 50], [40, 50], [40, 70], [0, 70]], closed: true },
      { kind: "circle", c: [20, 25], r: 18 },
      { kind: "arc", c: [20, 25], r: 12, a0: 200, a1: 340 },
      { kind: "hatch", pattern: "SOLID", scale: 1, angle: 0, loops: [[[15, 55], [25, 55], [25, 65], [15, 65]]] },
    ] },
  };
  function layout(room, ops, furn) {
    const inserts = [];
    if (room.type === "bedroom") inserts.push({ block: "HP_STANDIN_BED", x: room.x + room.w / 2 - 80, y: room.y + room.h - 200, rot: 0, sx: 1 });
    if (room.type === "wc") inserts.push({ block: "HP_STANDIN_WC", x: room.x + room.w - 10, y: room.y + room.h - 60, rot: 90, sx: -1 });
    return { inserts, used: furn | 0 };
  }

  if (!HP.analyze) { HP.analyze = analyze; HP.analyze.standin = true; }
  if (!HP.furniture) HP.furniture = { BLOCKS, layout, variants: () => [{ key: "auto", label: "Automatic" }], standin: true };
  HP.standin = { analyze, cellsToLoops };
})(globalThis.HP = globalThis.HP || {});

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.HP;
