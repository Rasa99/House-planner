"use strict";
/* House Planner - furniture tests (furniture agent).
   node --test "Web Projects/houseplan/planner/test/"

   The rules are re-implemented here from CONTRACT.md s.7 and the brief, NOT
   taken from furniture.js, so a bug in the module's own checks cannot hide:
     - every insert's block box (DXF INSERT transform written out again here)
       inside the room's clear rect;
     - no two pieces overlap (footprint parts for the L-shaped sofa);
     - nothing in a door's swing square (w x w, swing side) or in the 60 cm
       in front of any door, either face;
     - tall pieces not within 60 cm in front of a window;
     - same input -> same output (with and without the cache);
     - the time per layout.
   Sizes: hardMin, then every 25 cm up to 650, both ways. By default each size
   pair gets a rotating quarter of the 20 door/window arrangements (every
   arrangement still meets every width and every height); FURN_SWEEP=full runs
   the complete cross product (~30 s), FURN_SWEEP=quick every 3rd size only. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const SRC = path.join(__dirname, "..", "src");
require(path.join(SRC, "core.js"));
let haveAnalyze = false;
if (fs.existsSync(path.join(SRC, "analyze.js"))) { require(path.join(SRC, "analyze.js")); haveAnalyze = typeof globalThis.HP.analyze === "function"; }
require(path.join(SRC, "furniture.js"));
const HP = globalThis.HP;
const F = HP.furniture;

const EPS = 1e-6;
const DOOR_CLEAR = 60, WIN_DEPTH = 60;
const ROT = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };   // [cos, sin]

// ---------------------------------------------------------------- independent geometry
function worldRect(ins, r) {          // T(x,y) * R(rot) * S(sx,1) applied to local rect r
  const [c, s] = ROT[ins.rot];
  const pts = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]].map(([u, v]) => {
    const U = ins.sx * u;
    return [ins.x + c * U - s * v, ins.y + s * U + c * v];
  });
  return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
}
const overlap = (a, b) => a[0] < b[2] - EPS && b[0] < a[2] - EPS && a[1] < b[3] - EPS && b[1] < a[3] - EPS;
function band(room, side, s0, s1, depth) {     // s0,s1 absolute along the side
  switch (side) {
    case "N": return [s0, room.y + room.h - depth, s1, room.y + room.h];
    case "S": return [s0, room.y, s1, room.y + depth];
    case "E": return [room.x + room.w - depth, s0, room.x + room.w, s1];
    case "W": return [room.x, s0, room.x + depth, s1];
  }
}
function zones(room, ops) {
  const doors = [], wins = [];
  for (const o of ops) {
    if (o.kind === "door") doors.push(band(room, o.side, o.s0, o.s1, o.swingInto ? Math.max(o.w, DOOR_CLEAR) : DOOR_CLEAR));
    else wins.push(band(room, o.side, o.s0, o.s1, WIN_DEPTH));
  }
  return { doors, wins };
}
// returns a list of rule breaks (empty = good)
function check(room, ops, L) {
  const bad = [];
  const { doors, wins } = zones(room, ops);
  const R = [room.x, room.y, room.x + room.w, room.y + room.h];
  const pieces = L.inserts.map((ins, i) => {
    const B = F.BLOCKS[ins.block];
    if (!B) { bad.push("unknown block " + ins.block); return null; }
    if (!(ins.rot in ROT)) bad.push("bad rot " + ins.rot);
    if (ins.sx !== 1 && ins.sx !== -1) bad.push("bad sx " + ins.sx);
    const box = worldRect(ins, [0, 0, B.w, B.h]);
    const parts = (B.parts || [[0, 0, B.w, B.h]]).map(r => worldRect(ins, r));
    return { i, ins, B, box, parts };
  }).filter(Boolean);
  for (const p of pieces) {
    if (p.box[0] < R[0] - EPS || p.box[1] < R[1] - EPS || p.box[2] > R[2] + EPS || p.box[3] > R[3] + EPS) bad.push(p.ins.block + " outside the room");
    for (const q of p.parts) {
      if (doors.some(z => overlap(q, z))) bad.push(p.ins.block + " in a door zone");
      if (p.B.tall && wins.some(z => overlap(q, z))) bad.push(p.ins.block + " (tall) across a window");
    }
  }
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++)
    if (pieces[i].parts.some(a => pieces[j].parts.some(b => overlap(a, b)))) bad.push(pieces[i].ins.block + " overlaps " + pieces[j].ins.block);
  return bad;
}

// ---------------------------------------------------------------- arrangements
const SIDES = ["N", "E", "S", "W"];
const sideLen = (room, s) => (s === "N" || s === "S" ? room.w : room.h);
const sideStart = (room, s) => (s === "N" || s === "S" ? room.x : room.y);
// an arrangement = list of { kind, side, at|centre|endAt, w, swingInto, hinge }; openings that do not fit are left out
function arrangements(type) {
  const T = HP.ROOM_TYPES[type];
  const dw = type === "living" || type === "reception" ? 100 : 80;
  const ww = T.win ? T.winDef : 120;
  const out = [];
  SIDES.forEach((d, k) => {
    for (const hinge of ["start", "end"]) for (const swingInto of [true, false]) {
      const winSide = SIDES[(k + (swingInto ? 2 : 1) + (hinge === "end" ? 1 : 0)) % 4];
      out.push([{ kind: "door", side: d, pos: hinge === "start" ? "start" : "end", w: dw, swingInto, hinge },
                { kind: "window", side: winSide, pos: "centre", w: ww }]);
    }
  });
  // door in the middle of a wall, window beside it on the same wall
  out.push([{ kind: "door", side: "S", pos: "centre", w: dw, swingInto: true, hinge: "start" },
            { kind: "window", side: "S", pos: "end", w: ww }]);
  // two doors (one from the far face of a shared wall), window opposite
  out.push([{ kind: "door", side: "W", pos: "centre", w: dw, swingInto: true, hinge: "end" },
            { kind: "door", side: "E", pos: "start", w: 80, swingInto: false, hinge: "start" },
            { kind: "window", side: "N", pos: "centre", w: ww }]);
  // windows on two sides, door in a corner
  out.push([{ kind: "door", side: "N", pos: "end", w: dw, swingInto: true, hinge: "end" },
            { kind: "window", side: "S", pos: "centre", w: ww }, { kind: "window", side: "E", pos: "centre", w: ww }]);
  // no window at all
  out.push([{ kind: "door", side: "E", pos: "centre", w: dw, swingInto: true, hinge: "start" }]);
  return out;
}
function realise(room, arr) {
  const ops = [], used = {};
  arr.forEach((o, i) => {
    const L = sideLen(room, o.side);
    if (o.w + 20 > L) return;
    let at = o.pos === "start" ? 20 : o.pos === "end" ? L - 20 - o.w : Math.round((L - o.w) / 2 / 5) * 5;
    at = Math.max(10, Math.min(L - 10 - o.w, at));
    const s0 = sideStart(room, o.side) + at, s1 = s0 + o.w;
    if ((used[o.side] || []).some(([a, b]) => s0 < b + 10 && a < s1 + 10)) return;
    (used[o.side] = used[o.side] || []).push([s0, s1]);
    ops.push({ id: "o" + i, kind: o.kind, side: o.side, s0, s1, w: o.w,
      swingInto: o.kind === "door" && o.swingInto, hingeAt: o.kind === "door" ? (o.hinge === "end" ? "s1" : "s0") : null });
  });
  return ops;
}
function sizes(type, quick) {
  const min = HP.ROOM_TYPES[type].hardMin, out = [min];
  for (let v = Math.ceil((min + 1) / 25) * 25; v <= 650; v += 25) out.push(v);
  return quick ? out.filter((v, i) => i % 3 === 0 || v === 650) : out;
}

// ---------------------------------------------------------------- tests
test("blocks are clean CAD data inside their own box", () => {
  const KINDS = new Set(["pline", "line", "arc", "circle"]);
  const names = Object.keys(F.BLOCKS);
  assert.ok(names.length >= 30, "expected a full library, got " + names.length);
  for (const n of names) {
    const B = F.BLOCKS[n];
    assert.ok(B.layer === "A-FURN" || B.layer === "A-FIXT", n + " layer");
    assert.ok(B.w > 0 && B.h > 0 && B.items.length > 0, n + " size/items");
    assert.ok(/^[A-Z0-9_]+$/.test(n), n + " is a plain DXF block name");
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const P = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const it of B.items) {
      assert.ok(KINDS.has(it.kind), n + " item kind " + it.kind);
      assert.equal(it.layer, B.layer, n + " item layer");
      if (it.kind === "line") { P(...it.a); P(...it.b); }
      else if (it.kind === "circle") { assert.ok(it.r > 0); P(it.c[0] - it.r, it.c[1] - it.r); P(it.c[0] + it.r, it.c[1] + it.r); }
      else if (it.kind === "arc") { for (let t = 0; t <= 64; t++) { const a = (it.a0 + (((it.a1 - it.a0) % 360 + 360) % 360) * t / 64) * Math.PI / 180; P(it.c[0] + it.r * Math.cos(a), it.c[1] + it.r * Math.sin(a)); } }
      else {
        const pts = it.pts, nb = it.bulges;
        assert.ok(pts.length >= 2, n + " pline points");
        if (nb) assert.equal(nb.length, pts.length, n + " bulges per vertex");
        const segs = it.closed ? pts.length : pts.length - 1;
        for (let i = 0; i < segs; i++) {
          const p = pts[i], q = pts[(i + 1) % pts.length], b = nb ? nb[i] : 0;
          P(...p); P(...q);
          if (Math.abs(b) > 1e-12) {                  // sample the bulge arc
            const th = 4 * Math.atan(b), c = Math.hypot(q[0] - p[0], q[1] - p[1]);
            const r = c / (2 * Math.sin(th / 2));
            const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2, nx = -(q[1] - p[1]) / c, ny = (q[0] - p[0]) / c;
            const d = r * Math.cos(th / 2), cx = mx + nx * d, cy = my + ny * d;
            const a0 = Math.atan2(p[1] - cy, p[0] - cx);
            for (let t = 0; t <= 32; t++) { const a = a0 + th * t / 32; P(cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a)); }
            const e = Math.hypot(cx + Math.abs(r) * Math.cos(a0 + th) - q[0], cy + Math.abs(r) * Math.sin(a0 + th) - q[1]);
            assert.ok(e < 1e-3, n + " bulge arc lands on its end point (" + e + ")");
          }
        }
      }
    }
    assert.ok(x0 >= -1e-3 && y0 >= -1e-3 && x1 <= B.w + 1e-3 && y1 <= B.h + 1e-3,
      n + " drawing " + [x0, y0, x1, y1].map(v => v.toFixed(2)) + " outside its box " + B.w + " x " + B.h);
    assert.ok(x0 < 1 && y0 < 1 && x1 > B.w - 1 && y1 > B.h - 1, n + " drawing does not fill its box");
    if (B.parts) for (const r of B.parts) assert.ok(r[0] >= 0 && r[1] >= 0 && r[2] <= B.w && r[3] <= B.h, n + " parts");
  }
});

test("variants: Automatic first, real choices after", () => {
  for (const type of HP.ROOM_ORDER) {
    const v = F.variants(type);
    assert.deepEqual(v[0], { key: "auto", label: "Automatic" }, type);
    assert.ok(v.length >= 3, type + " has choices");
    assert.equal(new Set(v.map(x => x.key)).size, v.length, type + " keys unique");
    v.forEach(x => assert.ok(x.label && typeof x.label === "string"));
    v[0].label = "changed";                          // callers get copies
    assert.equal(F.variants(type)[0].label, "Automatic");
  }
  assert.deepEqual(F.variants("nonsense"), [{ key: "auto", label: "Automatic" }]);
  const L = F.layout({ id: "x", type: "nonsense", x: 0, y: 0, w: 300, h: 300 }, [], 0);
  assert.deepEqual(L.inserts, []);
});

test("insert transform is exactly the DXF INSERT one", () => {
  for (const rot of [0, 90, 180, 270]) for (const sx of [1, -1]) {
    const ins = { block: "SOFA_L", x: 123, y: -45, rot, sx };
    assert.deepEqual(F.blockBox(ins), worldRect(ins, [0, 0, 250, 170]));
    const p = F.transform(ins, 10, 20), [c, s] = ROT[rot];
    assert.deepEqual(p, [123 + c * sx * 10 - s * 20, -45 + s * sx * 10 + c * 20]);
  }
});

test("sweep: every type x variant x size x door/window arrangement keeps every rule", t => {
  const mode = process.env.FURN_SWEEP || "default", quick = mode === "quick", full = mode === "full";
  F.setCache(false);
  const stats = {};
  let n = 0, ms = 0, autoN = 0, autoMs = 0, failures = [];
  for (const type of HP.ROOM_ORDER) {
    const vars = F.variants(type), arrs = arrangements(type);
    for (let vi = 0; vi < vars.length; vi++) {
      const st = stats[type + " / " + vars[vi].label] = { layouts: 0, withDrops: 0, drops: {}, skips: {}, pieces: 0, ms: 0, used: {} };
      const S = sizes(type, quick);
      for (let iw = 0; iw < S.length; iw++) for (let ih = 0; ih < S.length; ih++) for (let k = 0; k < arrs.length; k++) {
        if (!full && (iw + 2 * ih + k) % 4) continue;
        const w = S[iw], h = S[ih], arr = arrs[k];
        const room = { id: "r1", type, name: type, x: 135, y: 260, w, h };
        const ops = realise(room, arr);
        const t0 = process.hrtime.bigint();
        const L = F.layout(room, ops, vi);
        const dt = Number(process.hrtime.bigint() - t0) / 1e6;
        n++; ms += dt; st.ms += dt; st.layouts++; st.pieces += L.inserts.length;
        if (vi === 0) { autoN++; autoMs += dt; st.used[L.label] = (st.used[L.label] || 0) + 1; }
        if (L.dropped.length) st.withDrops++;
        for (const d of L.dropped) st.drops[d] = (st.drops[d] || 0) + 1;
        for (const d of L.skipped) st.skips[d] = (st.skips[d] || 0) + 1;
        const bad = check(room, ops, L);
        if (bad.length && failures.length < 20) failures.push(type + " " + vars[vi].key + " " + w + "x" + h + " " + JSON.stringify(ops) + ": " + bad.join("; "));
        // deterministic
        if ((n % 7) === 0) assert.deepEqual(F.layout(room, ops, vi), L, "same input, same output");
      }
    }
  }
  F.setCache(true);
  for (const [k, st] of Object.entries(stats)) {
    const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([a, b]) => a + " " + b).join(", ");
    t.diagnostic(k.padEnd(40) + " layouts " + String(st.layouts).padStart(6) +
      "  with drops " + (100 * st.withDrops / st.layouts).toFixed(1).padStart(5) + "%" +
      "  avg pieces " + (st.pieces / st.layouts).toFixed(1) + "  avg " + (st.ms / st.layouts).toFixed(3) + " ms" +
      (Object.keys(st.drops).length ? "  dropped: " + top(st.drops) : "") +
      (Object.keys(st.skips).length ? "  extras left out: " + top(st.skips) : "") +
      (Object.keys(st.used).length ? "  auto chose: " + top(st.used) : ""));
  }
  t.diagnostic("sweep mode " + mode + ": TOTAL layouts " + n + ", rule breaks " + failures.length + (failures.length >= 20 ? "+" : "") +
    ", average " + (ms / n).toFixed(3) + " ms per layout (no cache), Automatic " + (autoMs / autoN).toFixed(3) + " ms");
  assert.deepEqual(failures, []);
  assert.ok(ms / n < 1, "average time per layout " + (ms / n).toFixed(3) + " ms should be under 1 ms");
});

test("cache: same answer, moved room gets moved furniture", () => {
  const room = { id: "r", type: "bedroom", x: 0, y: 0, w: 360, h: 400 };
  const ops = realise(room, arrangements("bedroom")[0]);
  F.setCache(false); const a = F.layout(room, ops, 0); F.setCache(true);
  F.clearCache();
  const b = F.layout(room, ops, 0), c = F.layout(room, ops, 0);
  assert.deepEqual(b, a); assert.deepEqual(c, a);
  c.inserts[0].x = -999;                                   // callers may not poison the cache
  assert.deepEqual(F.layout(room, ops, 0), a);
  const moved = Object.assign({}, room, { x: 500, y: 700 });
  const mops = ops.map(o => Object.assign({}, o, (o.side === "N" || o.side === "S") ? { s0: o.s0 + 500, s1: o.s1 + 500 } : { s0: o.s0 + 700, s1: o.s1 + 700 }));
  const m = F.layout(moved, mops, 0);
  assert.equal(m.inserts.length, a.inserts.length);
  m.inserts.forEach((ins, i) => { assert.equal(ins.x, a.inserts[i].x + 500); assert.equal(ins.y, a.inserts[i].y + 700); });
});

test("rooms arrive furnished at their default sizes (no drops)", () => {
  for (const type of HP.ROOM_ORDER) {
    const [w, h] = HP.ROOM_TYPES[type].size;
    const room = { id: "r", type, x: 0, y: 0, w, h };
    const ops = realise(room, [{ kind: "door", side: "S", pos: "start", w: 80, swingInto: true, hinge: "start" },
                               { kind: "window", side: "N", pos: "centre", w: HP.ROOM_TYPES[type].winDef || 100 }]);
    const L = F.layout(room, ops, 0);
    assert.deepEqual(check(room, ops, L), [], type);
    assert.deepEqual(L.dropped, [], type + " " + w + "x" + h + " dropped " + L.dropped);
    if (type !== "hall" && type !== "open") assert.ok(L.inserts.length >= 2, type + " has furniture");
  }
});

test("sample house (real HP.analyze): every room, every variant keeps the rules", { skip: !haveAnalyze && "src/analyze.js not there yet" }, t => {
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "sample-house.json"), "utf8"));
  const A = HP.analyze(plan);
  for (const r of A.rooms) {
    const ops = A.roomOpenings[r.id] || [];
    const nv = F.variants(r.type).length;
    for (let v = 0; v < nv; v++) {
      const L = F.layout(r, ops, v);
      assert.deepEqual(check(r, ops, L), [], r.id + " variant " + v);
      if (v === 0) {
        t.diagnostic(r.id + " " + r.type + " " + r.w + "x" + r.h + " -> " + L.label + ", " + L.inserts.length + " pieces" +
          (L.dropped.length ? ", dropped " + L.dropped.join(", ") : "") + (L.skipped.length ? ", left out " + L.skipped.join(", ") : ""));
        assert.deepEqual(L.dropped, [], r.id + " " + r.type + " arrives complete");
      }
    }
  }
});
