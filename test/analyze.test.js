"use strict";
/* Tests for src/analyze.js (model agent).  Run:
     node --test "G:/My Drive/Work Computer/Claude Tools/Web Projects/houseplan/planner/test/"   */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

require("../src/core.js");
require("../src/store.js");
require("../src/analyze.js");
const HP = globalThis.HP;

const FIX = path.join(__dirname, "fixtures");
const load = name => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const sample = () => load("sample-house.json");
const room = (plan, id) => plan.rooms.find(r => r.id === id);
const rule = (A, id) => A.rules.find(r => r.id === id);

// ------------------------------------------------------------------ helpers
/* Independent wall poche, cell by cell on the 5 cm grid: a cell is wall when it
   is inside a room grown by walls.ext, inside no clear room and inside no
   opening cut (the cut spans the opening along the wall and the wall's depth
   from the host's inner face outward; every test plan here has int = ext). */
function pocheCells(plan) {
  const ext = plan.walls.ext, int = plan.walls.int;
  assert.equal(int, ext, "helper assumes int = ext");
  const grown = plan.rooms.map(r => [r.x - ext, r.y - ext, r.x + r.w + ext, r.y + r.h + ext]);
  const clear = plan.rooms.map(r => [r.x, r.y, r.x + r.w, r.y + r.h]);
  const cuts = plan.openings.map(o => {
    const r = room(plan, o.room);
    switch (o.side) {
      case "N": return [r.x + o.at, r.y + r.h, r.x + o.at + o.w, r.y + r.h + ext];
      case "S": return [r.x + o.at, r.y - ext, r.x + o.at + o.w, r.y];
      case "E": return [r.x + r.w, r.y + o.at, r.x + r.w + ext, r.y + o.at + o.w];
      case "W": return [r.x - ext, r.y + o.at, r.x, r.y + o.at + o.w];
    }
  });
  const inside = (c, x, y) => x > c[0] && x < c[2] && y > c[1] && y < c[3];
  const X0 = Math.min(...grown.map(g => g[0])), X1 = Math.max(...grown.map(g => g[2]));
  const Y0 = Math.min(...grown.map(g => g[1])), Y1 = Math.max(...grown.map(g => g[3]));
  const cells = [];
  for (let y = Y0; y < Y1; y += 5) for (let x = X0; x < X1; x += 5) {
    const cx = x + 2.5, cy = y + 2.5;
    if (grown.some(g => inside(g, cx, cy)) && !clear.some(c => inside(c, cx, cy)) && !cuts.some(c => inside(c, cx, cy)))
      cells.push([cx, cy]);
  }
  return { cells, box: [X0, Y0, X1, Y1] };
}
// even-odd: how many loops does a horizontal ray to the right cross
function evenOddInside(loops, x, y) {
  let inside = false;
  for (const L of loops) for (let i = 0, j = L.length - 1; i < L.length; j = i++) {
    const a = L[i], b = L[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
const loopsArea = loops => loops.reduce((s, L) => s + HP.polyArea(L), 0);
function checkLoops(loops, what) {
  for (const L of loops) {
    assert.ok(L.length >= 4, what + ": a loop has fewer than 4 points");
    for (let i = 0; i < L.length; i++) {
      const p = L[i], q = L[(i + 1) % L.length], r = L[(i + 2) % L.length];
      assert.ok(Number.isInteger(p[0]) && Number.isInteger(p[1]), what + ": point not integer " + p);
      assert.ok((p[0] === q[0]) !== (p[1] === q[1]), what + ": edge not axis-aligned or zero length " + p + " " + q);
      const d1 = [Math.sign(q[0] - p[0]), Math.sign(q[1] - p[1])], d2 = [Math.sign(r[0] - q[0]), Math.sign(r[1] - q[1])];
      assert.ok(!(d1[0] === d2[0] && d1[1] === d2[1]), what + ": collinear point left at " + q);
    }
  }
}

// ------------------------------------------------------------------ sample house
test("sample house: every rule passes", () => {
  const A = HP.analyze(sample());
  const failing = A.rules.filter(r => !r.ok).map(r => r.id + ": " + r.detail);
  assert.deepEqual(failing, []);
  assert.deepEqual(A.rules.map(r => r.id),
    ["open-area", "open-size", "bath", "wc", "living", "windows", "window-size", "bedroom-size", "openings", "access", "fits"]);
  assert.deepEqual(A.issues, {});
  for (const r of A.rules) {
    assert.equal(r.level, "error");
    assert.equal(typeof r.title, "string"); assert.ok(r.title.length > 3);
    assert.equal(typeof r.detail, "string"); assert.ok(r.detail.length > 3);
  }
});

test("sample house: every opening is allowed, with the right geometry", () => {
  const A = HP.analyze(sample());
  assert.equal(A.openings.length, 15);
  for (const g of A.openings) assert.ok(g.ok, g.id + " " + g.reason);
  const o10 = A.openings.find(g => g.id === "o10");     // living front door
  assert.deepEqual([o10.axis, o10.s0, o10.s1, o10.fixed, o10.thick, o10.far, o10.facing], ["x", 60, 160, 720, 20, 700, "yard"]);
  assert.deepEqual(o10.n, [0, -1]);
  assert.equal(o10.hinge, "start"); assert.equal(o10.swing, "in");
  const o12 = A.openings.find(g => g.id === "o12");     // living -> courtyard
  assert.deepEqual([o12.facing, o12.other, o12.fixed, o12.far], ["open", "r5", 1190, 1210]);
  const o11 = A.openings.find(g => g.id === "o11");
  assert.equal(o11.hinge, undefined); assert.equal(o11.swing, undefined);
});

test("sample house: facing kinds", () => {
  const A = HP.analyze(sample());
  const one = (id, side) => { const runs = A.sides[id][side]; assert.equal(runs.length, 1, id + side + " " + JSON.stringify(runs)); return runs[0]; };
  for (const b of ["r6", "r7", "r8"]) {
    assert.equal(one(b, "N").kind, "neighbour");
    assert.equal(one(b, "N").other, 2);                     // the back edge of the plot
    assert.deepEqual([one(b, "S").kind, one(b, "S").other], ["open", "r5"]);
  }
  assert.deepEqual(one("r1", "S"), { s0: 20, s1: 440, kind: "yard", other: null, depth: 700 });
  assert.deepEqual([one("r1", "E").kind, one("r1", "E").other, one("r1", "E").depth], ["room", "r2", 0]);
  assert.deepEqual([one("r1", "W").kind, one("r1", "W").other], ["neighbour", 3]);
  assert.equal(one("r3", "S").kind, "yard");
  // the courtyard's south side: three rooms and the two T-junction walls between them
  assert.deepEqual(A.sides.r5.S.map(r => [r.s0, r.s1, r.kind, r.kind === "room" ? r.other : "-"]),
    [[20, 440, "room", "r1"], [440, 460, "blocked", "-"], [460, 720, "room", "r2"], [720, 740, "blocked", "-"], [740, 980, "room", "r4"]]);
  // runs cover each side exactly once
  for (const r of sample().rooms) for (const s of HP.SIDES) {
    const si = HP.sideInfo(r, s), runs = A.sides[r.id][s];
    assert.equal(runs[0].s0, si.s0); assert.equal(runs[runs.length - 1].s1, si.s1);
    for (let i = 1; i < runs.length; i++) assert.equal(runs[i].s0, runs[i - 1].s1);
  }
});

test("street, blocked and slanted plot edges", () => {
  const p = sample();
  // living room moved to 0.30 m from the street: its front wall now stands on the street
  const liv = room(p, "r1"); liv.y = 50; liv.h = 1140;
  let A = HP.analyze(p);
  assert.deepEqual([A.sides.r1.S[0].kind, A.sides.r1.S[0].other, A.sides.r1.S[0].depth], ["street", 0, 30]);
  // a room 0.60 m in front of the kitchen: blocked
  const q = sample();
  q.rooms.push({ id: "r99", type: "hall", name: "Hall", x: 480, y: 300, w: 200, h: 340, furn: 0 });
  A = HP.analyze(q);
  // the hall's wall (its rect grown by 20) covers x 460..700 in front of the kitchen, 40 cm away
  const k = A.sides.r2.S;
  assert.deepEqual(k.map(r => [r.s0, r.s1, r.kind]), [[460, 700, "blocked"], [700, 720, "yard"]]);
  assert.equal(k[0].other, "r99"); assert.equal(k[0].depth, 40);
  // a slanted plot edge: the right edge leans in
  const s = HP.newPlan({ w: 1000, d: 1000 });
  s.plot.pts = [[0, 0], [1000, 0], [800, 1000], [0, 1000]];
  s.rooms.push({ id: "r1", type: "bedroom", name: "Bedroom", x: 400, y: 200, w: 300, h: 300, furn: 0 });
  A = HP.analyze(s);
  // E outer face x = 720; the slanted edge x = 1000 - y/5 -> depth 280 at y=200 .. 220 at y=500: yard
  assert.equal(A.sides.r1.E.length, 1);
  assert.equal(A.sides.r1.E[0].kind, "yard");
  // depth = the smallest sample: y = 497.5 -> edge at x = 900.5, minus 720 = 180.5, rounded 181
  assert.equal(A.sides.r1.E[0].depth, 181);
  assert.equal(A.sides.r1.E[0].other, null);
});

test("wall poche: even-odd loops reproduce the poche exactly", () => {
  for (const plan of [sample(), load("model-20rooms.json")]) {
    const A = HP.analyze(plan);
    checkLoops(A.walls.loops, "walls");
    checkLoops(A.footprint.loops, "footprint");
    const { cells, box } = pocheCells(plan);
    const want = new Set(cells.map(c => c.join(",")));
    let got = 0;
    for (let y = box[1]; y < box[3]; y += 5) for (let x = box[0]; x < box[2]; x += 5) {
      const cx = x + 2.5, cy = y + 2.5, ins = evenOddInside(A.walls.loops, cx, cy);
      assert.equal(ins, want.has(cx + "," + cy), "cell " + cx + "," + cy);
      if (ins) got++;
    }
    assert.equal(got, cells.length);
    // signed areas: outer loops CCW, holes CW -> the sum is the poche area
    assert.equal(loopsArea(A.walls.loops), cells.length * 25);
  }
});

test("footprint and yard", () => {
  const plan = sample(), A = HP.analyze(plan);
  assert.deepEqual(A.footprint.loops, [[[0, 700], [1000, 700], [1000, 1900], [0, 1900]]]);
  assert.deepEqual(A.bbox, { x0: 0, y0: 700, x1: 1000, y1: 1900 });
  assert.equal(A.yard.loops.length, 2);
  assert.deepEqual(A.yard.loops[0], plan.plot.pts);
  assert.equal(loopsArea(A.yard.loops), 1000 * 1900 - 1000 * 1200);   // plot CCW, footprint reversed
  assert.equal(A.stats.plotArea, 1900000);
  assert.equal(A.stats.builtArea, 1200000);
  assert.equal(A.stats.roofedArea, 1200000 - 960 * 210);
  assert.ok(Math.abs(A.stats.coverage - 12 / 19) < 1e-12);
  assert.equal(A.stats.rooms, 8);
});

test("handles: one wall line = one handle", () => {
  const A = HP.analyze(sample());
  const find = (room, side) => A.handles.find(h => h.members.some(m => m.room === room && m.side === side));
  const back = find("r6", "N");
  assert.equal(back.orient, "h");
  assert.deepEqual(back.members.map(m => m.room + m.side).sort(), ["r6N", "r7N", "r8N"]);
  assert.equal(back.kind, "outer"); assert.equal(back.pos, 1890);
  assert.equal(back.from, 20); assert.equal(back.to, 980);
  const lk = find("r1", "E");
  assert.deepEqual(lk.members.map(m => m.room + m.side).sort(), ["r1E", "r2W"]);
  assert.equal(lk.orient, "v"); assert.equal(lk.kind, "shared"); assert.equal(lk.pos, 450);
  assert.equal(find("r2", "W"), lk);
  const court = find("r5", "S");
  assert.deepEqual(court.members.map(m => m.room + m.side).sort(), ["r1N", "r2N", "r4N", "r5S"]);
  // every side of every room is in exactly one handle, keys are unique
  const seen = new Set();
  for (const h of A.handles) for (const m of h.members) {
    const k = m.room + m.side; assert.ok(!seen.has(k), k + " twice"); seen.add(k);
  }
  assert.equal(seen.size, 8 * 4);
  assert.equal(new Set(A.handles.map(h => h.key)).size, A.handles.length);
  // the key is stable: same plan, same keys
  assert.deepEqual(HP.analyze(sample()).handles.map(h => h.key), A.handles.map(h => h.key));
  assert.deepEqual(HP.analyze.handles(sample()), A.handles);
});

test("roomOpenings: both faces of a shared wall", () => {
  const A = HP.analyze(sample());
  const r5 = A.roomOpenings.r5;
  assert.equal(r5.length, 10);                      // 4 from the front rooms + 6 from the bedrooms
  const o19 = r5.find(o => o.id === "o19");
  assert.deepEqual([o19.side, o19.s0, o19.s1, o19.swingInto, o19.hingeAt], ["N", 40, 120, false, "s0"]);
  const own = A.roomOpenings.r6.find(o => o.id === "o19");
  assert.deepEqual([own.side, own.swingInto, own.host], ["S", true, true]);
  assert.deepEqual(A.roomOpenings.r1.map(o => o.id).sort(), ["o10", "o11", "o12"]);
  assert.deepEqual(A.roomOpenings.r2.map(o => o.id).sort(), ["o13", "o14"]);
});

test("openings that break the rules are flagged with plain reasons", () => {
  // a window on the back wall (neighbours)
  let p = sample();
  p.openings.push({ id: "o90", kind: "window", room: "r6", side: "N", at: 100, w: 120 });
  let A = HP.analyze(p);
  let g = A.openings.find(o => o.id === "o90");
  assert.equal(g.ok, false); assert.equal(g.facing, "neighbour");
  assert.match(g.reason, /neighbours/);
  assert.equal(rule(A, "openings").ok, false);
  assert.deepEqual(rule(A, "openings").refs, ["o90"]);
  assert.deepEqual(A.issues.o90, ["openings"]);
  // a door on the neighbour wall
  p = sample();
  p.openings.push({ id: "o91", kind: "door", room: "r1", side: "W", at: 100, w: 80, hinge: "start", swing: "in" });
  g = HP.analyze(p).openings.find(o => o.id === "o91");
  assert.equal(g.reason, "Doors can't go on a wall shared with the neighbours.");
  // a window on a wall between two rooms
  p = sample();
  p.openings.push({ id: "o92", kind: "window", room: "r1", side: "E", at: 100, w: 150 });
  g = HP.analyze(p).openings.find(o => o.id === "o92");
  assert.equal(g.reason, "Windows only go on walls that face an open area, the yard or the street.");
  // too near a corner (5 cm)
  p = sample();
  p.openings.find(o => o.id === "o10").at = 5;
  g = HP.analyze(p).openings.find(o => o.id === "o10");
  assert.equal(g.ok, false); assert.match(g.reason, /corner/);
  // 10 cm from the corner is fine
  p.openings.find(o => o.id === "o10").at = 10;
  assert.equal(HP.analyze(p).openings.find(o => o.id === "o10").ok, true);
  // the corner of the living room's own north side
  p = sample();
  p.openings.find(o => o.id === "o12").at = 330;    // 350..430: 10 cm short of the corner at 440
  assert.equal(HP.analyze(p).openings.find(o => o.id === "o12").ok, true);
  p.openings.find(o => o.id === "o12").at = 335;    // 5 cm short
  assert.match(HP.analyze(p).openings.find(o => o.id === "o12").reason, /corner/);
  // T-junction on the FAR face: a door hosted by the courtyard, on its south side, where the
  // living/kitchen wall (x 440..460) meets it
  p = sample();
  p.openings = p.openings.filter(o => o.id !== "o14");
  const door = at => ({ id: "o95", kind: "door", room: "r5", side: "S", at, w: 80, hinge: "start", swing: "in" });
  const tj = at => { const q = HP.clone(p); q.openings.push(door(at)); return HP.analyze(q).openings.find(o => o.id === "o95"); };
  assert.equal(tj(450).ok, true);                          // 470..550: 10 cm from the T wall
  assert.match(tj(445).reason, /corner/);                  // 465..545: 5 cm
  assert.match(tj(430).reason, /runs past a corner/);      // 450..530: across the T wall
  assert.equal(tj(450).facing, "room"); assert.equal(tj(450).other, "r2");
  // two openings 5 cm apart; at 10 cm they are fine
  p = sample();
  p.openings.find(o => o.id === "o11").at = 145;    // door o10 = 60..160, window 165..315
  A = HP.analyze(p);
  assert.equal(A.openings.find(o => o.id === "o10").ok, false);
  assert.equal(A.openings.find(o => o.id === "o11").ok, false);
  assert.match(A.openings.find(o => o.id === "o11").reason, /between two doors or windows/);
  p.openings.find(o => o.id === "o11").at = 150;
  assert.equal(HP.analyze(p).openings.every(o => o.ok), true);
  // openings on the two faces of one shared wall see each other
  p = sample();
  p.openings.push({ id: "o93", kind: "door", room: "r5", side: "S", at: 240, w: 80, hinge: "start", swing: "in" });
  A = HP.analyze(p);
  assert.equal(A.openings.find(o => o.id === "o93").ok, false);   // 260..340 vs o12 300..380
  assert.equal(A.openings.find(o => o.id === "o12").ok, false);
  // a window hosted by the open area
  p = sample();
  p.openings.push({ id: "o94", kind: "window", room: "r5", side: "S", at: 100, w: 60 });
  assert.match(HP.analyze(p).openings.find(o => o.id === "o94").reason, /not in an open area/);
  // off the end of its wall
  p = sample();
  p.openings.find(o => o.id === "o16").at = 200;
  assert.match(HP.analyze(p).openings.find(o => o.id === "o16").reason, /does not fit/);
});

test("slots agree with the ok check", () => {
  const p = sample(), A = HP.analyze(p);
  for (const r of p.rooms) for (const side of HP.SIDES) for (const kind of ["door", "window"]) for (const w of [80, 150]) {
    const sl = HP.analyze.slots(p, A, r.id, side, kind, w, null);
    const len = side === "N" || side === "S" ? r.w : r.h;
    for (let at = 0; at + w <= len; at += 5) {
      const inSlot = sl.some(s => at >= s.a0 && at <= s.a1);
      const q = HP.clone(p);
      q.openings.push({ id: "oT", kind, room: r.id, side, at, w, hinge: "start", swing: "in" });
      const g = HP.analyze(q).openings.find(o => o.id === "oT");
      assert.equal(inSlot, g.ok, `${r.id}${side} ${kind} w${w} at${at}: slot ${inSlot} ok ${g.ok} ${g.reason}`);
    }
  }
});

test("rules that fail say what and where", () => {
  let p = sample();
  p.rooms = p.rooms.filter(r => r.type !== "living" && r.type !== "bath");
  p.openings = p.openings.filter(o => p.rooms.some(r => r.id === o.room));
  let A = HP.analyze(p);
  assert.equal(rule(A, "living").ok, false); assert.equal(rule(A, "bath").ok, false);
  assert.equal(rule(A, "wc").ok, true);
  // the courtyard lost its doors from the living room: everything behind it is cut off
  assert.equal(rule(A, "access").ok, false);
  assert.deepEqual(rule(A, "access").refs.sort(), ["r2", "r6", "r7", "r8"]);
  assert.deepEqual(A.access.entrances, ["o15"]);
  // no door out at all
  p = sample();
  p.openings = p.openings.filter(o => o.id !== "o10" && o.id !== "o15");
  A = HP.analyze(p);
  assert.equal(rule(A, "access").ok, false);
  assert.match(rule(A, "access").detail, /no door to the outside/);
  // bedroom too narrow, window too wide, courtyard too thin, no window
  p = sample();
  room(p, "r7").w = 280; room(p, "r8").x = 650; room(p, "r8").w = 330;
  p.openings.find(o => o.id === "o24").w = 150;
  p.openings.find(o => o.id === "o18").w = 100;
  p.openings = p.openings.filter(o => o.id !== "o13");
  A = HP.analyze(p);
  assert.equal(rule(A, "bedroom-size").ok, false); assert.deepEqual(rule(A, "bedroom-size").refs, ["r7"]);
  assert.match(rule(A, "bedroom-size").detail, /Bedroom 2 is 2\.80 x 4\.40 m/);
  assert.equal(rule(A, "window-size").ok, false); assert.deepEqual(rule(A, "window-size").refs, ["o18"]);
  assert.match(rule(A, "window-size").detail, /Bathroom window is 1\.00 m - Bathroom windows are 0\.60 m/);
  assert.equal(rule(A, "windows").ok, false); assert.deepEqual(rule(A, "windows").refs, ["r2"]);
  assert.match(rule(A, "windows").detail, /^Kitchen needs a window/);
  p = sample();
  room(p, "r5").h = 120; room(p, "r6").y = 1350; room(p, "r6").h = 530;
  A = HP.analyze(p);
  assert.equal(rule(A, "open-size").ok, false); assert.deepEqual(rule(A, "open-size").refs, ["r5"]);
  // outside the land, overlapping
  p = sample();
  room(p, "r8").w = 330;
  room(p, "r3").x = 700;
  A = HP.analyze(p);
  assert.equal(rule(A, "fits").ok, false);
  assert.deepEqual(rule(A, "fits").refs.sort(), ["r2", "r3", "r8"]);
  // no open area
  p = sample();
  room(p, "r5").type = "hall";
  assert.equal(rule(HP.analyze(p), "open-area").ok, false);
});

test("empty plan and odd input do not throw", () => {
  const A = HP.analyze(HP.newPlan());
  assert.deepEqual(A.walls.loops, []);
  assert.deepEqual(A.footprint.loops, []);
  assert.equal(A.yard.loops.length, 1);
  assert.equal(A.bbox, null);
  assert.deepEqual(A.handles, []);
  assert.equal(rule(A, "access").ok, true);
  assert.equal(rule(A, "open-area").ok, false);
  // an opening whose room is gone
  const p = sample();
  p.openings.push({ id: "o77", kind: "door", room: "r404", side: "S", at: 0, w: 80 });
  const B = HP.analyze(p);
  assert.equal(B.openings.length, 15);
  assert.equal(rule(B, "openings").ok, false);
  assert.deepEqual(rule(B, "openings").refs, ["o77"]);
  // analysis is plain data
  assert.doesNotThrow(() => JSON.stringify(B));
  assert.deepEqual(JSON.parse(JSON.stringify(B)).handles, B.handles);
});

test("speed: sample < 3 ms, 20 rooms < 8 ms", () => {
  const time = (plan, n) => {
    for (let i = 0; i < 20; i++) HP.analyze(plan);           // warm up
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) HP.analyze(plan);
    return Number(process.hrtime.bigint() - t0) / 1e6 / n;
  };
  const a = time(sample(), 200), b = time(load("model-20rooms.json"), 100);
  console.log(`    analyze: sample ${a.toFixed(3)} ms, 20 rooms ${b.toFixed(3)} ms`);
  assert.ok(a < 3, "sample took " + a);
  assert.ok(b < 8, "20 rooms took " + b);
});
