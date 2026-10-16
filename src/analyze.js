"use strict";
/* ============================================================================
   House Planner - analyze.js   (model agent)
   ----------------------------------------------------------------------------
   HP.analyze(plan) -> A : everything the other modules need to know about a
   plan, worked out from scratch every time (HP.store.analysis caches it per
   plan object). Plain data only. All lengths integer cm (x right, y up).

     A.rooms        clear rooms with area, roofed flag, centre
     A.sides        what lies beyond every part of every room side
     A.walls        the wall poche with every door/window cut out (even-odd loops)
     A.footprint    outer outline of the house (union of rooms grown by walls.ext)
     A.yard         the plot minus the footprint
     A.openings     each door/window with its geometry and whether it is allowed
     A.roomOpenings per room: the openings on its walls, both faces of a shared wall
     A.handles      the wall lines a user can drag
     A.rules        the checklist, A.issues per id, A.access, A.bbox, A.stats

   HOW THE POCHE IS MADE. Every x and y where something starts or stops
   (rooms, rooms grown by walls.ext, opening cuts) cuts the plane into a grid
   of cells. A cell is wall when it is inside some grown room, inside no
   room's clear rectangle and inside no opening cut. The boundary between wall
   and non-wall cells is traced into closed loops (wall on the left, so outer
   loops run counter-clockwise and holes clockwise) and collinear points are
   dropped. Because every breakpoint is a grid line, even-odd filling of the
   loops is the poche EXACTLY - no tolerance anywhere.

   WHAT LIES BEYOND A SIDE (A.sides). Each side is sampled at the middle of
   every 5 cm step. A room exactly walls.int away across the side = shared
   wall ('room' / 'open'). Otherwise a ray goes out from the wall's OUTER face
   (inner face + walls.ext) to the first thing it meets: another room grown by
   walls.ext, or the plot boundary (any polygon, slanted edges included).
   Equal samples are merged into runs.

   Helpers for model.js are attached to the function itself:
   HP.analyze.handles(plan), HP.analyze.sidesOf(plan), HP.analyze.slots(...),
   HP.analyze.openingGeom(...), HP.analyze.ALLOW, HP.analyze.reasonFor(...).
============================================================================ */
(function (HP) {
  const SIGN = { N: 1, E: 1, S: -1, W: -1 };
  const OPP = { N: "S", S: "N", E: "W", W: "E" };
  const SIDE_NAMES = ["N", "E", "S", "W"];
  const STEP = 5;

  /* Openings allowed by what the wall faces (CONTRACT section 5). */
  const ALLOW = {
    room:      { door: true,  window: false },
    open:      { door: true,  window: true },
    yard:      { door: true,  window: true },
    street:    { door: true,  window: true },
    neighbour: { door: false, window: false },
    blocked:   { door: false, window: false },
  };

  const typeOf = r => HP.ROOM_TYPES[r.type] || null;
  const isRoofed = r => { const T = typeOf(r); return T ? T.roofed !== false : true; };
  const labelOf = r => { const T = typeOf(r); return T ? T.label : String(r.type || "Room"); };
  const word = k => (k === "door" ? "door" : "window");
  const Word = k => (k === "door" ? "Door" : "Window");
  const words = k => (k === "door" ? "Doors" : "Windows");
  const m2 = cm => HP.fmtM(cm);
  const sizeTxt = (w, h) => m2(w) + " x " + m2(h) + " m";
  function listTxt(names) {
    if (names.length <= 1) return names.join("");
    return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  }
  function rangeTxt(win) {
    return win[0] === win[1] ? m2(win[0]) + " m" : m2(win[0]) + " to " + m2(win[1]) + " m";
  }

  /* The plain-English reason an opening may not sit on a wall facing `facing`. */
  function reasonFor(facing, kind) {
    switch (facing) {
      case "neighbour": return words(kind) + " can't go on a wall shared with the neighbours.";
      case "room":      return "Windows only go on walls that face an open area, the yard or the street.";
      case "blocked":   return "This wall is too close to another wall for a " + word(kind) + ".";
      default:          return "A " + word(kind) + " can't go here.";
    }
  }

  // ---------------------------------------------------------------- plot rays
  /* First hit of a ray with the plot boundary. The ray runs along the normal
     of a side: `along` = 'x' means the SIDE runs along x, so the ray moves in
     y at x = m, starting at o, direction sgn. Returns {t, edge} or null.
     Samples sit at x.5 and plot corners on the 5 cm grid, so a ray never
     passes through a corner; the half-open test keeps odd plots consistent. */
  function rayPlot(pts, along, m, o, sgn) {
    let best = Infinity, edge = -1;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      let hit;
      if (along === "x") {
        if ((a[0] <= m) === (b[0] <= m)) continue;
        hit = a[1] + (m - a[0]) * (b[1] - a[1]) / (b[0] - a[0]);
      } else {
        if ((a[1] <= m) === (b[1] <= m)) continue;
        hit = a[0] + (m - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
      }
      const t = (hit - o) * sgn;
      if (t >= -1e-6 && t < best) { best = t; edge = i; }
    }
    return edge < 0 ? null : { t: Math.max(0, best), edge };
  }

  // ---------------------------------------------------------------- sides
  /* A.sides for every room. */
  function sidesOf(plan) {
    const ext = plan.walls.ext, int = plan.walls.int;
    const minOpen = HP.RULES.minOpenDepth;
    const pts = plan.plot.pts, kinds = plan.plot.edges || [];
    const rooms = plan.rooms;
    const G = rooms.map(r => ({ r, x0: r.x - ext, y0: r.y - ext, x1: r.x + r.w + ext, y1: r.y + r.h + ext,
                                roofed: isRoofed(r) }));
    const out = {};
    for (let ia = 0; ia < rooms.length; ia++) {
      const a = rooms[ia];
      const res = {};
      for (const side of SIDE_NAMES) {
        const si = HP.sideInfo(a, side), sgn = SIGN[side], along = si.axis;
        const o = si.fixed + sgn * ext;                       // outer face
        // rooms across a shared wall
        const shared = [];
        // rooms that can stand in front of the outer face
        const obst = [];
        for (let ib = 0; ib < G.length; ib++) {
          if (ib === ia) continue;
          const g = G[ib], b = g.r;
          const b0 = along === "x" ? b.x : b.y, b1 = along === "x" ? b.x + b.w : b.y + b.h;
          if (HP.spanOverlap(si.s0, si.s1, b0, b1) > 0) {
            const face = HP.sideInfo(b, OPP[side]).fixed;
            if (face === si.fixed + sgn * int) shared.push({ s0: b0, s1: b1, id: b.id, roofed: g.roofed });
          }
          const g0 = along === "x" ? g.x0 : g.y0, g1 = along === "x" ? g.x1 : g.y1;
          if (HP.spanOverlap(si.s0, si.s1, g0, g1) <= 0) continue;
          const n0 = along === "x" ? g.y0 : g.x0, n1 = along === "x" ? g.y1 : g.x1;
          if (sgn > 0 ? n1 > o : n0 < o) obst.push({ s0: g0, s1: g1, d0: sgn > 0 ? n0 - o : o - n1, id: b.id });
        }
        const runs = [];
        let cur = null;
        for (let s = si.s0; s < si.s1; s += STEP) {
          const e = Math.min(s + STEP, si.s1), m = (s + e) / 2;
          let kind = null, other = null, depth = 0;
          for (let k = 0; k < shared.length; k++) {
            const q = shared[k];
            if (q.s0 < m && m < q.s1) { kind = q.roofed ? "room" : "open"; other = q.id; break; }
          }
          if (!kind) {
            let rd = Infinity, rid = null;
            for (let k = 0; k < obst.length; k++) {
              const q = obst[k];
              if (q.s0 < m && m < q.s1) {
                const d = Math.max(0, q.d0);
                if (d < rd) { rd = d; rid = q.id; }
              }
            }
            const hit = rayPlot(pts, along, m, o, sgn);
            const pd = hit ? hit.t : Infinity;
            if (rd < pd) {
              depth = rd;
              if (rd < minOpen) { kind = "blocked"; other = rid; } else kind = "yard";
            } else if (hit) {
              depth = pd;
              if (pd < minOpen) { kind = kinds[hit.edge] === "street" ? "street" : "neighbour"; other = hit.edge; }
              else kind = "yard";
            } else {                                      // the wall stands outside the land
              kind = "neighbour"; other = null; depth = 0;
            }
          }
          if (cur && cur.kind === kind && cur.other === other) {
            cur.s1 = e; if (depth < cur.depth) cur.depth = depth;
          } else {
            cur = { s0: s, s1: e, kind, other, depth };
            runs.push(cur);
          }
        }
        runs.forEach(rn => { rn.depth = Math.round(rn.depth); });
        res[side] = runs;
      }
      out[a.id] = res;
    }
    return out;
  }

  // ---------------------------------------------------------------- openings
  const thickOf = (kind, ext, int) => (kind === "room" || kind === "open" ? int : ext);

  /* Geometry of one opening on its host. `sides` = A.sides. Returns the
     A.openings record without the pairwise (openingGap) check. */
  function openingGeom(plan, host, sides, o) {
    const ext = plan.walls.ext, int = plan.walls.int, endClear = HP.RULES.endClear;
    const si = HP.sideInfo(host, o.side), sgn = SIGN[o.side];
    const s0 = si.s0 + o.at, s1 = s0 + o.w;
    const runs = (sides[host.id] || {})[o.side] || [];
    const over = runs.filter(r => r.s1 > s0 && r.s0 < s1);
    const mid = (s0 + s1) / 2;
    const main = over.find(r => r.s0 <= mid && mid < r.s1) || over[0] || null;
    let thick = ext;
    if (over.length) thick = Math.max.apply(null, over.map(r => thickOf(r.kind, ext, int)));
    const g = {
      id: o.id, kind: o.kind, room: o.room, side: o.side, at: o.at, w: o.w,
      hinge: o.kind === "door" ? (o.hinge === "end" ? "end" : "start") : undefined,
      swing: o.kind === "door" ? (o.swing === "out" ? "out" : "in") : undefined,
      axis: si.axis, s0, s1, fixed: si.fixed, thick, far: si.fixed + sgn * thick,
      n: si.n.slice(), facing: main ? main.kind : "blocked", other: main ? main.other : null,
      ok: true, reason: "",
    };
    if (g.kind !== "door") { delete g.hinge; delete g.swing; }
    const k = o.kind;
    const inSpan = s0 >= si.s0 && s1 <= si.s1 && o.w > 0;
    if (k === "window" && !isRoofed(host)) { g.ok = false; g.reason = "Windows go in rooms, not in an open area."; }
    else if (!inSpan) { g.ok = false; g.reason = "This " + word(k) + " does not fit on its wall."; }
    else if (over.length !== 1) { g.ok = false; g.reason = "This " + word(k) + " runs past a corner or a wall joint. Move it along the wall."; }
    else if (!(ALLOW[g.facing] || {})[k]) { g.ok = false; g.reason = reasonFor(g.facing, k); }
    else if (s0 - main.s0 < endClear || main.s1 - s1 < endClear) {
      g.ok = false; g.reason = "Keep at least " + m2(endClear) + " m of wall between a " + word(k) + " and a corner.";
    }
    return g;
  }

  const band = g => (g.far < g.fixed ? [g.far, g.fixed] : [g.fixed, g.far]);

  /* Do two opening records sit on the same wall closer than RULES.openingGap? */
  function tooClose(p, q) {
    if (p.axis !== q.axis) return false;
    const bp = band(p), bq = band(q);
    if (HP.spanOverlap(bp[0], bp[1], bq[0], bq[1]) <= 0) return false;
    const gap = HP.RULES.openingGap;
    return p.s0 < q.s1 + gap && q.s0 < p.s1 + gap;
  }

  /* Where an opening of `kind` and width `w` may go on room `rid`'s `side`:
     a list of { a0, a1, facing, other, thick } ranges of `at` (inclusive, on
     the 5 cm grid). Exactly the conditions openingGeom + tooClose check, so a
     placement taken from here is always reported ok by analyze().
     A = an analysis of the plan (only A.sides and A.openings are read). */
  function slots(plan, A, rid, side, kind, w, excludeId) {
    const room = plan.rooms.find(r => r.id === rid);
    if (!room) return [];
    if (kind === "window" && !isRoofed(room)) return [];
    const ext = plan.walls.ext, int = plan.walls.int;
    const endClear = HP.RULES.endClear, gap = HP.RULES.openingGap;
    const si = HP.sideInfo(room, side), sgn = SIGN[side];
    const runs = (A.sides[rid] || {})[side] || [];
    const out = [];
    for (const run of runs) {
      if (!(ALLOW[run.kind] || {})[kind]) continue;
      const lo = run.s0 + endClear, hi = run.s1 - endClear - w;
      if (lo > hi) continue;
      const thick = thickOf(run.kind, ext, int);
      const b0 = Math.min(si.fixed, si.fixed + sgn * thick), b1 = Math.max(si.fixed, si.fixed + sgn * thick);
      let iv = [[lo, hi]];
      for (const p of A.openings) {
        if (p.id === excludeId || p.axis !== si.axis) continue;
        const bp = band(p);
        if (HP.spanOverlap(b0, b1, bp[0], bp[1]) <= 0) continue;
        const f0 = p.s0 - gap - w, f1 = p.s1 + gap;      // forbidden: f0 < s0 < f1
        const next = [];
        for (const [a, b] of iv) {
          if (b <= f0 || a >= f1) { next.push([a, b]); continue; }
          if (a <= f0) next.push([a, f0]);
          if (b >= f1) next.push([f1, b]);
        }
        iv = next;
        if (!iv.length) break;
      }
      for (const [a, b] of iv) {
        const a0 = HP.snapUp(a - si.s0), a1 = HP.snapDown(b - si.s0);
        if (a0 <= a1) out.push({ a0, a1, facing: run.kind, other: run.other, thick });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- cells
  /* Trace the boundary of the filled cells into closed loops: filled on the
     left (outer loops CCW, holes CW), collinear points merged, first point not
     repeated. At a vertex where two filled cells touch only at a corner the
     trace turns left, so such cells give separate loops. */
  function traceCells(fill, nx, ny, xs, ys) {
    const VW = nx + 1, nV = VW * (ny + 1);
    const out0 = new Int32Array(nV).fill(-1), out1 = new Int32Array(nV).fill(-1);
    const eTo = [], eDir = [], eFrom = [];
    const add = (f, t, d) => {
      const e = eTo.length;
      eTo.push(t); eDir.push(d); eFrom.push(f);
      if (out0[f] < 0) out0[f] = e; else out1[f] = e;
    };
    const filled = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && fill[j * nx + i] === 1;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (fill[j * nx + i] !== 1) continue;
      if (!filled(i, j - 1)) add(j * VW + i, j * VW + i + 1, 0);                  // bottom, +x
      if (!filled(i + 1, j)) add(j * VW + i + 1, (j + 1) * VW + i + 1, 1);        // right, +y
      if (!filled(i, j + 1)) add((j + 1) * VW + i + 1, (j + 1) * VW + i, 2);      // top, -x
      if (!filled(i - 1, j)) add((j + 1) * VW + i, j * VW + i, 3);                // left, -y
    }
    const used = new Uint8Array(eTo.length);
    const loops = [];
    for (let e0 = 0; e0 < eTo.length; e0++) {
      if (used[e0]) continue;
      const chain = [];
      let e = e0, guard = eTo.length + 1;
      while (guard-- > 0) {
        used[e] = 1; chain.push(e);
        const v = eTo[e], d = eDir[e], a = out0[v], b = out1[v];
        let nxt = a;
        if (b >= 0) {
          const left = (d + 1) & 3, right = (d + 3) & 3;
          if (eDir[a] === left || eDir[b] === left) nxt = eDir[a] === left ? a : b;
          else if (eDir[a] === d || eDir[b] === d) nxt = eDir[a] === d ? a : b;
          else nxt = eDir[a] === right ? a : b;
        }
        if (nxt === e0 || nxt < 0 || used[nxt]) break;
        e = nxt;
      }
      const pts = [];
      const L = chain.length;
      for (let k = 0; k < L; k++) {
        const ek = chain[k], ep = chain[(k - 1 + L) % L];
        if (eDir[ek] !== eDir[ep]) {
          const v = eFrom[ek];
          pts.push([xs[v % VW], ys[(v / VW) | 0]]);
        }
      }
      if (pts.length >= 4) loops.push(pts);
    }
    return loops;
  }

  /* Wall poche and footprint on one breakpoint grid. */
  function poche(plan, openingGeoms) {
    const ext = plan.walls.ext;
    const rooms = plan.rooms.filter(r => r.w > 0 && r.h > 0);
    const xsSet = new Set(), ysSet = new Set();
    const grown = rooms.map(r => [r.x - ext, r.y - ext, r.x + r.w + ext, r.y + r.h + ext]);
    const clear = rooms.map(r => [r.x, r.y, r.x + r.w, r.y + r.h]);
    const cuts = openingGeoms.map(g => {
      const b = band(g);
      return g.axis === "x" ? [g.s0, b[0], g.s1, b[1]] : [b[0], g.s0, b[1], g.s1];
    }).filter(c => c[2] > c[0] && c[3] > c[1]);
    for (const list of [grown, clear, cuts]) for (const c of list) {
      xsSet.add(c[0]); xsSet.add(c[2]); ysSet.add(c[1]); ysSet.add(c[3]);
    }
    const xs = Array.from(xsSet).sort((a, b) => a - b), ys = Array.from(ysSet).sort((a, b) => a - b);
    const nx = Math.max(0, xs.length - 1), ny = Math.max(0, ys.length - 1);
    const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
    const foot = new Uint8Array(nx * ny);
    const paint = (arr, c, val) => {
      const i0 = xi.get(c[0]), i1 = xi.get(c[2]), j0 = yi.get(c[1]), j1 = yi.get(c[3]);
      for (let j = j0; j < j1; j++) { const row = j * nx; for (let i = i0; i < i1; i++) arr[row + i] = val; }
    };
    grown.forEach(c => paint(foot, c, 1));
    const wall = foot.slice();
    clear.forEach(c => paint(wall, c, 0));
    cuts.forEach(c => paint(wall, c, 0));
    let footArea = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
      if (foot[j * nx + i]) footArea += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
    return {
      walls: nx && ny ? traceCells(wall, nx, ny, xs, ys) : [],
      footprint: nx && ny ? traceCells(foot, nx, ny, xs, ys) : [],
      footArea,
    };
  }

  // ---------------------------------------------------------------- handles
  /* The wall lines a user can drag. Every room side goes on a line keyed by
     its "low" inner face: an E side at x = f is on line f, a W side at x is on
     line x - int (so the two faces of a shared wall land on one line); same
     for N (y = f) and S (y - int). On each line the sides are sorted along it
     and chained while they touch, overlap, or leave no more than the walls.int
     gap of a perpendicular wall between them. Each chain is one handle.     */
  function handles(plan) {
    const ext = plan.walls.ext, int = plan.walls.int;
    const lines = new Map();
    const put = (orient, f, m) => {
      const k = orient + f;
      let L = lines.get(k);
      if (!L) { L = { orient, f, list: [] }; lines.set(k, L); }
      L.list.push(m);
    };
    for (const r of plan.rooms) {
      if (!(r.w > 0 && r.h > 0)) continue;
      put("v", r.x + r.w, { room: r.id, side: "E", a0: r.y, a1: r.y + r.h, lo: true });
      put("v", r.x - int, { room: r.id, side: "W", a0: r.y, a1: r.y + r.h, lo: false });
      put("h", r.y + r.h, { room: r.id, side: "N", a0: r.x, a1: r.x + r.w, lo: true });
      put("h", r.y - int, { room: r.id, side: "S", a0: r.x, a1: r.x + r.w, lo: false });
    }
    const out = [];
    const keys = Array.from(lines.keys()).sort();
    for (const k of keys) {
      const L = lines.get(k);
      L.list.sort((p, q) => p.a0 - q.a0 || p.a1 - q.a1 || (p.room < q.room ? -1 : 1));
      let chain = null, end = -Infinity;
      const flush = () => {
        if (!chain) return;
        const los = chain.filter(m => m.lo), his = chain.filter(m => !m.lo);
        let shared = false;
        for (const p of los) for (const q of his) if (HP.spanOverlap(p.a0, p.a1, q.a0, q.a1) > 0) shared = true;
        const pos = los.length && his.length ? L.f + int / 2 : los.length ? L.f + ext / 2 : L.f + int - ext / 2;
        const from = Math.min.apply(null, chain.map(m => m.a0)), to = Math.max.apply(null, chain.map(m => m.a1));
        out.push({
          key: L.orient + L.f + ":" + from + ":" + to, orient: L.orient, pos, from, to,
          members: chain.map(m => ({ room: m.room, side: m.side })),
          kind: shared ? "shared" : "outer",
        });
      };
      for (const m of L.list) {
        if (chain && m.a0 <= end + int) { chain.push(m); end = Math.max(end, m.a1); }
        else { flush(); chain = [m]; end = m.a1; }
      }
      flush();
    }
    return out;
  }

  // ---------------------------------------------------------------- analyze
  function analyze(plan) {
    const ext = plan.walls.ext, int = plan.walls.int;
    const R = HP.RULES;
    const rooms = plan.rooms;
    const byId = new Map(rooms.map(r => [r.id, r]));
    const plotPts = plan.plot.pts;

    const A = {};
    A.rooms = rooms.map(r => ({
      id: r.id, type: r.type, name: r.name, x: r.x, y: r.y, w: r.w, h: r.h,
      area: r.w * r.h, roofed: isRoofed(r), cx: r.x + r.w / 2, cy: r.y + r.h / 2,
    }));
    A.sides = sidesOf(plan);

    // ---- openings
    const lost = [];
    const geoms = [];
    for (const o of plan.openings) {
      const host = byId.get(o.room);
      if (!host || !SIGN[o.side]) { lost.push(o.id); continue; }
      geoms.push(openingGeom(plan, host, A.sides, o));
    }
    for (let i = 0; i < geoms.length; i++) for (let j = i + 1; j < geoms.length; j++) {
      const p = geoms[i], q = geoms[j];
      if (!tooClose(p, q)) continue;
      const why = "Keep at least " + m2(R.openingGap) + " m of wall between two doors or windows.";
      if (p.ok) { p.ok = false; p.reason = why; }
      if (q.ok) { q.ok = false; q.reason = why; }
    }
    A.openings = geoms;

    // ---- per-room view of the openings
    A.roomOpenings = {};
    rooms.forEach(r => { A.roomOpenings[r.id] = []; });
    for (const g of geoms) {
      const isDoor = g.kind === "door";
      const base = { id: g.id, kind: g.kind, s0: g.s0, s1: g.s1, w: g.w,
                     hingeAt: isDoor ? (g.hinge === "end" ? "s1" : "s0") : null };
      A.roomOpenings[g.room].push(Object.assign({}, base, {
        side: g.side, fixed: g.fixed, host: true, swingInto: isDoor && g.swing === "in" }));
      if ((g.facing === "room" || g.facing === "open") && A.roomOpenings[g.other]) {
        A.roomOpenings[g.other].push(Object.assign({}, base, {
          side: OPP[g.side], fixed: g.far, host: false, swingInto: isDoor && g.swing === "out" }));
      }
    }

    // ---- poche, footprint, yard
    const P = poche(plan, geoms);
    A.walls = { loops: P.walls };
    A.footprint = { loops: P.footprint };
    const plotCCW = HP.polyArea(plotPts) >= 0;
    A.yard = { loops: [plotPts.map(p => [p[0], p[1]])].concat(
      P.footprint.map(l => (plotCCW ? l.slice().reverse() : l.slice()))) };

    // ---- handles, bbox
    A.handles = handles(plan);
    if (rooms.length) {
      A.bbox = {
        x0: Math.min.apply(null, rooms.map(r => r.x - ext)), y0: Math.min.apply(null, rooms.map(r => r.y - ext)),
        x1: Math.max.apply(null, rooms.map(r => r.x + r.w + ext)), y1: Math.max.apply(null, rooms.map(r => r.y + r.h + ext)),
      };
    } else A.bbox = null;

    // ---- access: doors make a graph; the outside is one node
    const OUT = "\u0000out";
    const adj = new Map();
    const link = (a, b) => {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b); adj.get(b).push(a);
    };
    const entrances = [];
    for (const g of geoms) {
      if (g.kind !== "door") continue;
      if ((g.facing === "room" || g.facing === "open") && byId.has(g.other)) link(g.room, g.other);
      else if (g.facing === "yard" || g.facing === "street") { link(g.room, OUT); entrances.push(g.id); }
    }
    const seen = new Set([OUT]), queue = [OUT];
    while (queue.length) {
      const n = queue.pop();
      for (const k of adj.get(n) || []) if (!seen.has(k)) { seen.add(k); queue.push(k); }
    }
    A.access = { reachable: rooms.filter(r => seen.has(r.id)).map(r => r.id), entrances };

    // ---- rules
    const rules = [];
    const rule = (id, title, ok, detail, refs) =>
      rules.push({ id, ok, level: "error", title, detail, refs: refs || [] });
    const ofType = t => rooms.filter(r => r.type === t);
    const opens = rooms.filter(r => !isRoofed(r));

    rule("open-area", "An open area (courtyard)", opens.length > 0,
      opens.length ? (opens.length === 1 ? "There is 1 open area." : "There are " + opens.length + " open areas.")
                   : "Add an open area - a courtyard open to the sky - so the rooms get light and air.");
    {
      const OA = R.openArea;
      const bad = opens.filter(r => Math.min(r.w, r.h) < OA.shortMin || Math.max(r.w, r.h) < OA.longMin);
      rule("open-size", "Open areas at least " + m2(OA.shortMin) + " x " + m2(OA.longMin) + " m", bad.length === 0,
        bad.length ? bad.map(r => r.name + " is " + sizeTxt(r.w, r.h) + ".").join(" ") +
                     " Make " + (bad.length > 1 ? "each" : "it") + " at least " + m2(OA.shortMin) + " x " + m2(OA.longMin) + " m."
                   : (opens.length ? "Big enough." : "No open area yet."),
        bad.map(r => r.id));
    }
    for (const [id, t, title] of [["bath", "bath", "A bathroom"], ["wc", "wc", "A toilet (WC)"], ["living", "living", "A living room"]]) {
      const n = ofType(t).length;
      rule(id, title, n > 0, n ? "Done." : "Add " + title.charAt(0).toLowerCase() + title.slice(1) + ".");
    }
    {
      const lit = new Set(geoms.filter(g => g.kind === "window" && (g.facing === "open" || g.facing === "yard" || g.facing === "street"))
                               .map(g => g.room));
      const bad = rooms.filter(r => { const T = typeOf(r); return T && T.needsWindow && !lit.has(r.id); });
      rule("windows", "A window in every room", bad.length === 0,
        bad.length ? listTxt(bad.map(r => r.name)) + (bad.length > 1 ? " need" : " needs") +
                     " a window onto an open area, the yard or the street."
                   : "Every room has a window.",
        bad.map(r => r.id));
    }
    {
      const bad = [], txt = [];
      for (const g of geoms) {
        if (g.kind !== "window") continue;
        const r = byId.get(g.room), T = typeOf(r);
        if (!T || !T.win) continue;
        if (g.w < T.win[0] || g.w > T.win[1]) {
          bad.push(g.id);
          txt.push(r.name + " window is " + m2(g.w) + " m - " + T.label + " windows are " + rangeTxt(T.win) + ".");
        }
      }
      rule("window-size", "Window sizes suit the rooms", bad.length === 0, bad.length ? txt.join(" ") : "All windows fit their rooms.", bad);
    }
    {
      const B = R.bedroom;
      const bad = ofType("bedroom").filter(r => r.w < B.min || r.w > B.max || r.h < B.min || r.h > B.max);
      rule("bedroom-size", "Bedrooms " + m2(B.min) + " to " + m2(B.max) + " m each way", bad.length === 0,
        bad.length ? bad.map(r => r.name + " is " + sizeTxt(r.w, r.h) + ".").join(" ")
                   : (ofType("bedroom").length ? "Every bedroom is a good size." : "No bedrooms yet."),
        bad.map(r => r.id));
    }
    {
      const bad = geoms.filter(g => !g.ok);
      const txt = bad.map(g => byId.get(g.room).name + " " + word(g.kind) + ": " + g.reason);
      if (lost.length) txt.push(lost.length + " door(s) or window(s) belong to a room that is gone.");
      rule("openings", "Doors and windows on the right walls", bad.length === 0 && lost.length === 0,
        txt.length ? txt.join(" ") : "Every door and window is in a good place.",
        bad.map(g => g.id).concat(lost));
    }
    {
      const roofed = rooms.filter(isRoofed);
      const cut = roofed.filter(r => !seen.has(r.id));
      let ok = true, detail = "Every room can be reached through doors.";
      if (roofed.length && !entrances.length) {
        ok = false; detail = "There is no door to the outside. Put a door on a wall that faces the yard or the street.";
      } else if (cut.length) {
        ok = false; detail = listTxt(cut.map(r => r.name)) + (cut.length > 1 ? " can't" : " can't") + " be reached through doors.";
      }
      rule("access", "Every room has a way in", ok, detail, cut.map(r => r.id));
    }
    {
      const bad = [], txt = [];
      for (const r of rooms) {
        if (!HP.rectInPoly(HP.grow(r, ext), plotPts)) { bad.push(r.id); txt.push(r.name + " goes outside the land."); }
      }
      for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
        if (HP.rectsOverlap(rooms[i], rooms[j])) {
          bad.push(rooms[i].id, rooms[j].id); txt.push(rooms[i].name + " overlaps " + rooms[j].name + ".");
        }
      }
      rule("fits", "Everything inside the land", bad.length === 0, bad.length ? txt.join(" ") : "Everything is inside the land.",
        Array.from(new Set(bad)));
    }
    A.rules = rules;
    A.issues = {};
    for (const rl of rules) {
      if (rl.ok) continue;
      for (const id of rl.refs) (A.issues[id] = A.issues[id] || []).push(rl.id);
    }

    // ---- stats (cm2). roofedArea = footprint less the open areas' clear area.
    const plotArea = Math.abs(HP.polyArea(plotPts));
    const openArea = opens.reduce((s, r) => s + r.w * r.h, 0);
    A.stats = {
      plotArea, builtArea: P.footArea, roofedArea: P.footArea - openArea,
      coverage: plotArea > 0 ? P.footArea / plotArea : 0, rooms: rooms.length,
    };
    return A;
  }

  analyze.handles = handles;
  analyze.sidesOf = sidesOf;
  analyze.openingGeom = openingGeom;
  analyze.slots = slots;
  analyze.tooClose = tooClose;
  analyze.reasonFor = reasonFor;
  analyze.traceCells = traceCells;
  analyze.ALLOW = ALLOW;
  analyze.isRoofed = isRoofed;
  analyze.labelOf = labelOf;
  HP.analyze = analyze;
})(globalThis.HP = globalThis.HP || {});

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.HP;
