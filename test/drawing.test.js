"use strict";
/* test/drawing.test.js  (drafting agent)
   HP.drawing.build: primitives, dimension chains, labels, doors and windows,
   section marks, options, determinism and speed.
   node --test "Web Projects/houseplan/planner/test/"                        */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const HP = require(path.join(root, "src/core.js"));
const has = n => fs.existsSync(path.join(root, "src", n));
if (has("analyze.js")) require(path.join(root, "src/analyze.js"));
if (has("furniture.js")) require(path.join(root, "src/furniture.js"));
require(path.join(root, "dev/dxf-standin.js"));          // fills in only what is still missing
require(path.join(root, "src/drawing.js"));

const FIXTURES = ["sample-house.json", "drafting-corner.json", "drafting-fivecorner.json", "model-20rooms.json"]
  .filter(f => fs.existsSync(path.join(__dirname, "fixtures", f)));
const load = f => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8"));
const cases = FIXTURES.map(f => { const plan = load(f); const A = HP.analyze(plan); return { f, plan, A, d: HP.drawing.build(plan, A) }; });

const KINDS = new Set(["pline", "line", "arc", "circle", "hatch", "text", "dim", "insert"]);
const ROLES = new Set(["wall", "wall-hatch", "door-leaf", "door-swing", "window", "furn", "room-name", "room-area",
  "room-size", "dim", "section", "section-label", "plot", "plot-dim", "road", "road-label", "open-hatch", "yard-hatch"]);
const fin = v => typeof v === "number" && isFinite(v);
const pt = p => Array.isArray(p) && p.length === 2 && fin(p[0]) && fin(p[1]);
const cm = s => Math.round(parseFloat(s) * 100);

// axis-aligned box of a text (or a dim's text) in metres
function textBox(p, w, h, rot) {
  const r = (((rot || 0) % 180) + 180) % 180;
  const vert = Math.abs(r - 90) < 1e-6;
  if (!vert && Math.abs(r) > 1e-6 && Math.abs(r - 180) > 1e-6) {
    const c = Math.abs(Math.cos(r * Math.PI / 180)), s = Math.abs(Math.sin(r * Math.PI / 180));
    const hw = (w * c + h * s) / 2, hh = (w * s + h * c) / 2;
    return { x0: p[0] - hw, y0: p[1] - hh, x1: p[0] + hw, y1: p[1] + hh };
  }
  const hw = (vert ? h : w) / 2, hh = (vert ? w : h) / 2;
  return { x0: p[0] - hw, y0: p[1] - hh, x1: p[0] + hw, y1: p[1] + hh };
}
const overlap = (a, b, e) => a.x0 + e < b.x1 && b.x0 + e < a.x1 && a.y0 + e < b.y1 && b.y0 + e < a.y1;

test("fixtures are there and analyze/furniture are the real modules when they exist", () => {
  assert.ok(cases.length >= 3, "sample + two drafting fixtures");
  if (has("analyze.js")) assert.ok(!HP.analyze.standin, "uses src/analyze.js");
  if (has("furniture.js")) assert.ok(!HP.furniture.standin, "uses src/furniture.js");
});

for (const { f, plan, A, d } of cases) {
  test(f + ": every item is a well-formed primitive with a known layer, role and ref", () => {
    assert.ok(d.items.length > 20);
    for (const it of d.items) {
      const tag = JSON.stringify(it).slice(0, 120);
      assert.ok(KINDS.has(it.kind), "kind " + tag);
      assert.ok(HP.LAYERS[it.layer], "layer " + tag);
      assert.ok(ROLES.has(it.role), "role " + tag);
      assert.ok("ref" in it, "ref " + tag);
      switch (it.kind) {
        case "pline": assert.ok(it.pts.length >= 2 && it.pts.every(pt), tag); break;
        case "line": assert.ok(pt(it.a) && pt(it.b), tag); break;
        case "arc": assert.ok(pt(it.c) && it.r > 0 && fin(it.a0) && fin(it.a1), tag); break;
        case "circle": assert.ok(pt(it.c) && it.r > 0, tag); break;
        case "hatch":
          assert.ok(["ANSI31", "DOTS", "GRASS", "SOLID"].includes(it.pattern), tag);
          assert.ok(it.loops.length >= 1 && it.loops.every(l => l.length >= 3 && l.every(pt)), tag);
          assert.ok(it.scale > 0, tag); break;
        case "text": assert.ok(pt(it.p) && it.h > 0 && String(it.text).length > 0 && ["mc", "bc", "tc", "ml", "mr", "bl"].includes(it.align), tag); break;
        case "dim":
          assert.ok(pt(it.a) && pt(it.b) && pt(it.d) && fin(it.rot), tag);
          assert.match(it.text, /^\d+\.\d\d$/, tag); break;
        case "insert":
          assert.ok(pt(it.p) && fin(it.rot) && (it.sx === 1 || it.sx === -1) && d.blocks[it.block], tag); break;
      }
    }
    for (const k of ["x0", "y0", "x1", "y1"]) assert.ok(fin(d.extents[k]));
  });

  test(f + ": every dimension text says what its points measure", () => {
    for (const it of d.items.filter(i => i.kind === "dim")) {
      const g = HP.drawing.dimGeometry(it);
      assert.equal(g.measure.toFixed(2), it.text, it.chain + " " + it.text);
    }
  });

  test(f + ": dimension chains add up exactly", () => {
    const bb = A.bbox;
    const plotBox = { x0: Math.min(...plan.plot.pts.map(p => p[0])), x1: Math.max(...plan.plot.pts.map(p => p[0])),
      y0: Math.min(...plan.plot.pts.map(p => p[1])), y1: Math.max(...plan.plot.pts.map(p => p[1])) };
    const rect = plan.plot.pts.length === 4 && plan.plot.pts.every((p, i) => { const q = plan.plot.pts[(i + 1) % 4]; return p[0] === q[0] || p[1] === q[1]; });
    for (const side of ["S", "N", "W", "E"]) {
      const c1 = d.items.filter(i => i.chain === side + "1"), c2 = d.items.filter(i => i.chain === side + "2");
      assert.ok(c1.length >= 3 && c2.length >= 1, side + " has both chains");
      const along = side === "S" || side === "N";
      const house = along ? bb.x1 - bb.x0 : bb.y1 - bb.y0;
      const sum1 = c1.reduce((t, i) => t + cm(i.text), 0), sum2 = c2.reduce((t, i) => t + cm(i.text), 0);
      assert.equal(sum1, house, side + "1 walls + rooms = the house");
      assert.equal(sum2, rect ? (along ? plotBox.x1 - plotBox.x0 : plotBox.y1 - plotBox.y0) : house, side + "2 = the land (rectangle) or the house");
      // consecutive: each segment starts where the last one ended
      for (const ch of [c1, c2]) for (let k = 1; k < ch.length; k++) {
        const a = along ? ch[k].a[0] : ch[k].a[1], b = along ? ch[k - 1].b[0] : ch[k - 1].b[1];
        assert.ok(Math.abs(a - b) < 1e-9, side + " chain is continuous");
      }
      for (const i of c1.concat(c2)) assert.equal(cm(i.text) % 5, 0, "5 cm grid");
    }
    // a land dimension for every edge, unless the house's overall chain on the same line already says it
    const pd = d.items.filter(i => i.role === "plot-dim");
    assert.ok(pd.length >= plan.plot.pts.length - 2);
  });

  test(f + ": no two dimension texts overlap, nor the street label", () => {
    const boxes = [];
    for (const it of d.items) {
      if (it.kind === "dim") {
        const g = HP.drawing.dimGeometry(it);
        boxes.push({ b: textBox(g.text.p, HP.drawing.textWidth(it.text, g.text.h), g.text.h, it.rot), tag: it.chain + " " + it.text });
      } else if (it.role === "road-label") boxes.push({ b: textBox(it.p, it.w, it.h, it.rot), tag: "STREET" });
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++)
      assert.ok(!overlap(boxes[i].b, boxes[j].b, 0.01), boxes[i].tag + " overlaps " + boxes[j].tag);
  });

  test(f + ": room labels stay inside their rooms", () => {
    const byId = {}; A.rooms.forEach(r => byId[r.id] = r);
    for (const it of d.items.filter(i => /^room-/.test(i.role))) {
      const r = byId[it.ref];
      const b = textBox(it.p, HP.drawing.textWidth(it.text, it.h), it.h, 0);
      assert.ok(b.x0 >= r.x / 100 - 1e-9 && b.x1 <= (r.x + r.w) / 100 + 1e-9 && b.y0 >= r.y / 100 - 1e-9 && b.y1 <= (r.y + r.h) / 100 + 1e-9,
        it.text + " inside " + r.name);
    }
    for (const r of A.rooms) assert.ok(d.items.some(i => i.role === "room-name" && i.ref === r.id), r.name + " has its name");
  });

  test(f + ": doors are a leaf as long as the opening plus a 90 degree swing; windows are three glazing lines", () => {
    for (const o of A.openings) {
      const mine = d.items.filter(i => i.ref === o.id);
      const w = (o.s1 - o.s0) / 100;
      if (o.kind === "window") {
        const gl = mine.filter(i => i.role === "window");
        assert.equal(gl.length, 3, o.id);
        for (const l of gl) assert.ok(Math.abs(Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]) - w) < 1e-9);
      } else {
        const arc = mine.find(i => i.kind === "arc");
        const leaf = mine.filter(i => i.role === "door-leaf")[0];
        assert.ok(arc && leaf, o.id);
        assert.ok(Math.abs(arc.r - w) < 1e-9 && Math.abs(Math.hypot(leaf.b[0] - leaf.a[0], leaf.b[1] - leaf.a[1]) - w) < 1e-9, o.id + " leaf = width");
        assert.ok(Math.abs((((arc.a1 - arc.a0) % 360) + 360) % 360 - 90) < 1e-6, o.id + " swing is a quarter");
        assert.deepEqual(arc.c, leaf.a, o.id + " swing turns on the hinge");
        assert.equal(arc.color, HP.COLORS.swing);
      }
    }
  });

  test(f + ": section marks have a cut line, heavy ends, and two heads pointing the way it looks", () => {
    for (const s of plan.sections) {
      const mine = d.items.filter(i => i.ref === s.id);
      assert.equal(mine.filter(i => i.kind === "line").length, 1);
      assert.equal(mine.filter(i => i.kind === "pline" && i.width > 0).length, 2);
      const circles = mine.filter(i => i.kind === "circle"), arrows = mine.filter(i => i.kind === "hatch");
      assert.equal(circles.length, 2); assert.equal(arrows.length, 2);
      assert.ok(arrows.every(a => a.pattern === "SOLID" && a.loops[0].length === 3));
      assert.equal(mine.filter(i => i.role === "section-label" && i.text === s.label.toUpperCase()).length, 2);
      const ux = s.b[0] - s.a[0], uy = s.b[1] - s.a[1], L = Math.hypot(ux, uy);
      const look = [-uy / L * s.look, ux / L * s.look];
      arrows.forEach((a, k) => {
        const c = circles[k].c, tip = a.loops[0][0];
        assert.ok((tip[0] - c[0]) * look[0] + (tip[1] - c[1]) * look[1] > circles[k].r, "arrow points where the section looks");
      });
    }
  });

  test(f + ": deterministic, and the plan and analysis are not changed", () => {
    const p0 = JSON.stringify(plan), a0 = JSON.stringify(A);
    const d1 = HP.drawing.build(plan, A), d2 = HP.drawing.build(plan, A);
    assert.equal(JSON.stringify(d1), JSON.stringify(d2));
    assert.equal(JSON.stringify(plan), p0);
    assert.equal(JSON.stringify(A), a0);
  });
}

test("hatches: walls ANSI31, open areas DOTS, yard GRASS, with acadiso.pat's real lines", () => {
  const { d } = cases[0];
  const by = r => d.items.find(i => i.role === r);
  assert.equal(by("wall-hatch").pattern, "ANSI31"); assert.equal(by("wall-hatch").layer, "A-WALL-PATT");
  assert.equal(by("open-hatch").pattern, "DOTS"); assert.equal(by("open-hatch").layer, "A-OPEN-PATT");
  assert.equal(by("yard-hatch").pattern, "GRASS"); assert.equal(by("yard-hatch").layer, "A-SITE-PATT");
  // the numbers ezdxf (and AutoCAD) hold for acadiso.pat at scale 1
  const a = HP.drawing.patternLines("ANSI31", 1, 0)[0];
  assert.equal(a.angle, 45);
  assert.ok(Math.abs(a.offset[0] + 2.2450640303) < 1e-9 && Math.abs(a.offset[1] - 2.2450640303) < 1e-9);
  const g = HP.drawing.patternLines("GRASS", 1, 0);
  assert.equal(g.length, 3);
  assert.ok(Math.abs(g[0].offset[0] + 17.96051224) < 1e-6 && Math.abs(g[2].offset[1] + 17.9605122421) < 1e-6);
  assert.deepEqual(HP.drawing.patternLines("DOTS", 1, 0)[0].dashes, [0, -1.5875]);
  // walls: every wall poche loop is also a closed polyline
  assert.equal(d.items.filter(i => i.role === "wall").length, cases[0].A.walls.loops.length);
  assert.ok(d.items.filter(i => i.role === "wall").every(i => i.closed));
});

test("the street: road lines, a dashed centre line and the label on it", () => {
  const { d, plan } = cases[0];
  const road = d.items.filter(i => i.role === "road");
  assert.ok(road.length >= 4);
  assert.ok(road.some(i => i.ltype === "DASHED"));
  const lab = d.items.find(i => i.role === "road-label");
  assert.equal(lab.text, "STREET");
  assert.ok(lab.p[1] < 0 && lab.p[1] > -plan.plot.road / 100, "on the street, outside the land");
});

test("options switch parts of the drawing off", () => {
  const { plan, A } = cases[0];
  const roles = o => new Set(HP.drawing.build(plan, A, o).items.map(i => i.role));
  assert.ok(!roles({ dims: false }).has("dim") && !roles({ dims: false }).has("plot-dim"));
  assert.ok(!roles({ labels: false }).has("room-name"));
  assert.ok(!roles({ sizes: false }).has("room-size") && roles({ sizes: false }).has("room-area"));
  assert.ok(!roles({ furniture: false }).has("furn"));
  assert.ok(!roles({ sections: false }).has("section"));
  const s = roles({ site: false });
  assert.ok(!s.has("plot") && !s.has("road") && !s.has("yard-hatch"));
});

test("a label is made smaller or put on two lines in a small room, and never runs outside", () => {
  const plan = HP.newPlan({ w: 600, d: 800 });
  plan.rooms = [
    { id: "r1", type: "wc", name: "Toilet (WC)", x: 20, y: 20, w: 90, h: 130, furn: 0 },
    { id: "r2", type: "reception", name: "Guest reception room", x: 130, y: 20, w: 200, h: 300, furn: 0 },
  ];
  plan.seq = 10;
  const A = HP.analyze(plan);
  const d = HP.drawing.build(plan, A, { furniture: false });
  for (const r of plan.rooms) {
    const t = d.items.filter(i => i.ref === r.id && /^room-/.test(i.role));
    assert.ok(t.some(i => i.role === "room-name"), r.name);
    for (const it of t) {
      const b = textBox(it.p, HP.drawing.textWidth(it.text, it.h), it.h, 0);
      assert.ok(b.x0 >= r.x / 100 && b.x1 <= (r.x + r.w) / 100 && b.y0 >= r.y / 100 && b.y1 <= (r.y + r.h) / 100, it.text + " inside");
    }
    if (r.id === "r2") assert.ok(t.filter(i => i.role === "room-name").length === 2, "a long name goes on two lines");
    if (r.id === "r1") assert.ok(t.find(i => i.role === "room-name").h < HP.drawing.SIZES.name, "a tiny room gets smaller text");
  }
});

test("furniture: one INSERT per piece, each block in metres", { skip: !HP.furniture }, () => {
  const { d } = cases[0];
  const ins = d.items.filter(i => i.kind === "insert");
  assert.ok(ins.length > 0);
  for (const i of ins) {
    const b = d.blocks[i.block];
    assert.ok(b && b.items.length > 0, i.block);
    assert.ok(["A-FURN", "A-FIXT"].includes(i.layer));
    assert.ok(b.w > 0 && b.w < 5 && b.h > 0 && b.h < 5, i.block + " is in metres");
  }
});

test("speed: build(sample house) without furniture under 4 ms", t => {
  const { plan, A } = cases[0];
  for (let i = 0; i < 30; i++) HP.drawing.build(plan, A, { furniture: false });
  const N = 200, t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) HP.drawing.build(plan, A, { furniture: false });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  t.diagnostic("build(sample) without furniture: " + ms.toFixed(3) + " ms");
  assert.ok(ms < 4, ms + " ms");
});
