"use strict";
/* test/dxf.test.js  (drafting agent)
   HP.dxf.write: a well-formed AC1032 file - paired group codes, unique handles
   with real owners, entities equal to the drawing, real hatch patterns,
   dimensions with their blocks and dimstyle, UTF-8 text, units - and, when
   Python's ezdxf is installed, a round trip through ezdxf with its audit.
   AutoCAD itself is checked by hand: dev/dxf-acad.ps1 (too slow for a unit test).
   node --test "Web Projects/houseplan/planner/test/"                        */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const HP = require(path.join(root, "src/core.js"));
const has = n => fs.existsSync(path.join(root, "src", n));
if (has("analyze.js")) require(path.join(root, "src/analyze.js"));
if (has("furniture.js")) require(path.join(root, "src/furniture.js"));
require(path.join(root, "dev/dxf-standin.js"));          // fills in only what is still missing
require(path.join(root, "src/drawing.js"));
require(path.join(root, "src/dxf.js"));

const load = f => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8"));
const plan = load("sample-house.json");
const A = HP.analyze(plan);
const drawing = HP.drawing.build(plan, A);
const text = HP.dxf.write(drawing);

// ---- a small DXF reader: [{c, v}] pairs, sections, entities
function pairs(s) {
  const lines = s.split("\r\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const out = [];
  for (let i = 0; i < lines.length; i += 2) out.push({ c: parseInt(lines[i], 10), raw: lines[i], v: lines[i + 1] });
  return { out, odd: lines.length % 2 };
}
const P = pairs(text).out;
function section(name) {
  const i = P.findIndex((p, k) => p.c === 2 && p.v === name && P[k - 1].v === "SECTION");
  const j = P.findIndex((p, k) => k > i && p.c === 0 && p.v === "ENDSEC");
  return P.slice(i + 1, j);
}
function objects(list) {                         // split at every group 0
  const res = [];
  for (const p of list) { if (p.c === 0) res.push({ type: p.v, g: [] }); else if (res.length) res[res.length - 1].g.push(p); }
  return res;
}
const val = (o, c) => { const p = o.g.find(x => x.c === c); return p ? p.v : undefined; };
const vals = (o, c) => o.g.filter(x => x.c === c).map(x => x.v);
const TYPE = { pline: "LWPOLYLINE", line: "LINE", arc: "ARC", circle: "CIRCLE", hatch: "HATCH", text: "TEXT", dim: "DIMENSION", insert: "INSERT" };

test("the file is AC1032 with paired group codes and ends with EOF", () => {
  const { odd } = pairs(text);
  assert.equal(odd, 0, "an even number of lines");
  for (const p of P) assert.match(p.raw, /^ {0,2}-?\d{1,4}$/, "group code line " + JSON.stringify(p.raw));
  assert.deepEqual([P[0].c, P[0].v, P[1].c, P[1].v], [0, "SECTION", 2, "HEADER"]);
  assert.deepEqual([P[P.length - 1].c, P[P.length - 1].v], [0, "EOF"]);
  const hv = section("HEADER");
  assert.equal(hv[hv.findIndex(p => p.v === "$ACADVER") + 1].v, "AC1032");
  for (const s of ["HEADER", "CLASSES", "TABLES", "BLOCKS", "ENTITIES", "OBJECTS"]) assert.ok(section(s).length > 0, s);
});

test("handles are unique, every owner exists, and HANDSEED is above them all", () => {
  // ($HANDSEED in the HEADER is written with group 5 too: it is not a handle)
  const handles = ["TABLES", "BLOCKS", "ENTITIES", "OBJECTS"].flatMap(s => section(s)).filter(p => p.c === 5 || p.c === 105).map(p => p.v);
  assert.equal(new Set(handles).size, handles.length, "unique handles");
  const set = new Set(handles);
  for (const p of P.filter(p => p.c === 330)) assert.ok(p.v === "0" || set.has(p.v), "owner " + p.v);
  const hs = section("HEADER"); const seed = parseInt(hs[hs.findIndex(p => p.v === "$HANDSEED") + 1].v, 16);
  assert.ok(handles.every(h => parseInt(h, 16) < seed));
});

test("ENTITIES hold exactly the drawing's items, by type", () => {
  const ents = objects(section("ENTITIES"));
  const got = {}, want = {};
  ents.forEach(e => got[e.type] = (got[e.type] || 0) + 1);
  drawing.items.forEach(i => want[TYPE[i.kind]] = (want[TYPE[i.kind]] || 0) + 1);
  assert.deepEqual(got, want);
});

test("every layer and linetype an entity names is in the tables, with the core.js true colours", () => {
  const tables = objects(section("TABLES"));
  const layers = {}; tables.filter(o => o.type === "LAYER").forEach(o => layers[val(o, 2)] = o);
  const ltypes = new Set(tables.filter(o => o.type === "LTYPE").map(o => val(o, 2)));
  for (const n of Object.keys(HP.LAYERS)) {
    const L = layers[n];
    assert.ok(L, n);
    assert.equal(+val(L, 420), parseInt(HP.LAYERS[n].color.slice(1), 16), n + " true colour");
    assert.equal(+val(L, 370), Math.round(HP.LAYERS[n].lw * 100), n + " lineweight");
  }
  assert.ok(ltypes.has("DASHED") && ltypes.has("DASHDOT"));
  for (const o of objects(section("ENTITIES")).concat(objects(section("BLOCKS")))) {
    const l = val(o, 8); if (l !== undefined) assert.ok(layers[l], "layer " + l);
    const t = val(o, 6); if (t !== undefined) assert.ok(ltypes.has(t), "linetype " + t);
  }
});

test("hatches carry their real pattern definition lines, scaled as drawn", () => {
  const hs = objects(section("ENTITIES")).filter(o => o.type === "HATCH");
  const items = drawing.items.filter(i => i.kind === "hatch");
  assert.equal(hs.length, items.length);
  const LINES = { ANSI31: 1, DOTS: 1, GRASS: 3 };
  hs.forEach((h, k) => {
    const it = items[k], name = val(h, 2);
    assert.equal(name, it.pattern);
    assert.equal(val(h, 71), "0", "not associative");
    assert.equal(+val(h, 91), it.loops.length, "boundary paths");
    if (name === "SOLID") { assert.equal(val(h, 70), "1"); assert.equal(val(h, 78), undefined); return; }
    assert.equal(val(h, 70), "0");
    assert.equal(+val(h, 78), LINES[name], name + " pattern lines");
    assert.ok(Math.abs(+val(h, 41) - it.scale) < 1e-12, name + " scale");
    const want = HP.drawing.patternLines(name, it.scale, it.angle);
    const ox = vals(h, 45).map(Number), oy = vals(h, 46).map(Number);
    want.forEach((ln, i) => assert.ok(Math.abs(ox[i] - ln.offset[0]) < 1e-9 && Math.abs(oy[i] - ln.offset[1]) < 1e-9, name + " offset"));
  });
});

test("every DIMENSION has its own block (lines + text), and dimstyle HP has oblique ticks and 2 decimals", () => {
  const blocks = objects(section("BLOCKS"));
  const dims = objects(section("ENTITIES")).filter(o => o.type === "DIMENSION");
  assert.equal(dims.length, drawing.items.filter(i => i.kind === "dim").length);
  const names = new Set();
  for (const d of dims) {
    const name = val(d, 2);
    assert.ok(!names.has(name), "one block per dimension"); names.add(name);
    assert.equal(val(d, 3), "HP");
    const i = blocks.findIndex(o => o.type === "BLOCK" && val(o, 2) === name);
    assert.ok(i >= 0, name);
    const inside = [];
    for (let k = i + 1; blocks[k].type !== "ENDBLK"; k++) inside.push(blocks[k].type);
    assert.ok(inside.filter(t => t === "LINE").length >= 3 && inside.includes("TEXT"), name + ": " + inside.join(","));
  }
  const ds = objects(section("TABLES")).find(o => o.type === "DIMSTYLE" && val(o, 2) === "HP");
  assert.ok(+val(ds, 142) > 0, "DIMTSZ");
  assert.equal(val(ds, 271), "2"); assert.equal(val(ds, 77), "1"); assert.equal(val(ds, 78), "0");
  // the small 0.20 wall dimensions keep their small text when AutoCAD rebuilds them
  const small = drawing.items.filter(i => i.kind === "dim" && i.small).length;
  assert.equal(P.filter(p => p.c === 1000 && p.v === "DSTYLE").length, small);
});

test("text is UTF-8: the m² survives as it is", () => {
  assert.ok(text.includes("m²"));
  assert.ok(Buffer.from(text, "utf8").includes(Buffer.from([0x6d, 0xc2, 0xb2])));
  const texts = objects(section("ENTITIES")).filter(o => o.type === "TEXT").map(o => val(o, 1));
  assert.ok(texts.includes("STREET") && texts.some(t => /^\d+\.\d m²$/.test(t)));
  assert.ok(texts.every(t => t === t.toUpperCase() || /m²|x/.test(t)), "names are upper case");
});

test("numbers are plain decimals: never exponent form, never -0", () => {
  for (const [v, s] of [[0, "0.0"], [-0.0000001, "0.0"], [1e-7, "0.0"], [12.5, "12.5"], [3, "3.0"], [-2.25, "-2.25"], [1234567.891234, "1234567.891234"]])
    assert.equal(HP.dxf.num(v), s);
  const ents = section("ENTITIES");
  for (const p of ents) if (p.c >= 10 && p.c <= 59) assert.match(p.v, /^-?\d+\.\d+$/, p.c + " " + p.v);
});

test("units: cm and mm scale every length, hatch and dimstyle; dimension text still reads in metres", () => {
  const read = (s, name, code) => { const q = pairs(s).out; const k = q.findIndex(p => p.v === name); return q[k + 1].v; };
  const m = HP.dxf.write(drawing), c = HP.dxf.write(drawing, { units: "cm" }), mm = HP.dxf.write(drawing, { units: "mm" });
  assert.equal(read(m, "$INSUNITS"), "6"); assert.equal(read(c, "$INSUNITS"), "5"); assert.equal(read(mm, "$INSUNITS"), "4");
  const ex = s => +pairs(s).out[pairs(s).out.findIndex(p => p.v === "$EXTMAX") + 1].v;
  // each file keeps 6 decimals in its own unit
  assert.ok(Math.abs(ex(c) - ex(m) * 100) < 1e-4 && Math.abs(ex(mm) - ex(m) * 1000) < 1e-3);
  const ds = s => objects(pairs(s).out).find(o => o.type === "DIMSTYLE" && val(o, 2) === "HP");
  assert.ok(Math.abs(+val(ds(c), 144) - 0.01) < 1e-12 && Math.abs(+val(ds(mm), 144) - 0.001) < 1e-12, "DIMLFAC");
  assert.ok(Math.abs(+val(ds(c), 140) - 100 * +val(ds(m), 140)) < 1e-9, "DIMTXT");
  const hs = s => objects(pairs(s).out).filter(o => o.type === "HATCH" && val(o, 2) === "ANSI31").map(o => +val(o, 41));
  assert.ok(Math.abs(hs(c)[0] - hs(m)[0] * 100) < 1e-9, "hatch scale");
  // dimension blocks still print metres
  assert.ok(c.includes("\r\n4.20\r\n") && c.includes("\r\n10.00\r\n"));
});

test("an empty plan writes a valid file too", () => {
  const p = HP.newPlan();
  const d = HP.drawing.build(p, HP.analyze(p));
  const s = HP.dxf.write(d);
  assert.equal(pairs(s).odd, 0);
  assert.ok(s.endsWith("EOF\r\n"));
});

// ---- round trip through ezdxf (Python), when it is installed
const py = spawnSync("py", ["-3", "-c", "import ezdxf"], { encoding: "utf8" });
test("round trip through ezdxf: readfile + audit 0 errors, counts, patterns, dimension blocks", { skip: py.status !== 0 ? "py -3 with ezdxf not found" : false, timeout: 180000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hp-dxf-"));
  for (const f of ["sample-house.json", "drafting-corner.json", "drafting-fivecorner.json"]) {
    const out = path.join(dir, f.replace(".json", ".dxf"));
    const e = spawnSync(process.execPath, [path.join(root, "dev/dxf-export.js"), path.join(__dirname, "fixtures", f), out], { encoding: "utf8" });
    assert.equal(e.status, 0, e.stderr);
    const r = spawnSync("py", ["-3", path.join(root, "dev/dxf-check.py"), out], { encoding: "utf8" });
    assert.equal(r.status, 0, f + "\n" + r.stdout + r.stderr);
    assert.match(r.stdout, /audit: 0 errors, 0 fixes/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
