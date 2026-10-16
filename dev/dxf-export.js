"use strict";
/* ============================================================================
   dev/dxf-export.js  (drafting agent)
   ----------------------------------------------------------------------------
   Writes a plan to DXF the way the app does, plus a JSON summary of the
   drawing (item counts by kind/layer/role, dimension chains) for the checks.

     node dev/dxf-export.js <plan.json> <out.dxf> [--units m|cm|mm] [--standin] [--no-furniture]

   Uses src/analyze.js and src/furniture.js when they exist; otherwise (or with
   --standin) the stand-ins in dev/dxf-standin.js.
============================================================================ */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--units"));
if (files.length < 2) { console.error("usage: node dev/dxf-export.js <plan.json> <out.dxf> [--units m|cm|mm] [--standin] [--no-furniture]"); process.exit(2); }

const HP = require(path.join(root, "src/core.js"));
const real = n => fs.existsSync(path.join(root, "src", n));
if (!flag("--standin")) {
  if (real("analyze.js")) require(path.join(root, "src/analyze.js"));
  if (real("model.js")) { try { require(path.join(root, "src/model.js")); } catch (e) { /* not needed here */ } }
  if (real("furniture.js")) require(path.join(root, "src/furniture.js"));
}
require(path.join(__dirname, "dxf-standin.js"));          // fills only what is still missing
require(path.join(root, "src/drawing.js"));
require(path.join(root, "src/dxf.js"));

const plan = JSON.parse(fs.readFileSync(files[0], "utf8"));
const A = HP.analyze(plan);
const drawing = HP.drawing.build(plan, A, { furniture: !flag("--no-furniture") });
const units = val("--units", "m");
const text = HP.dxf.write(drawing, { units });
fs.writeFileSync(files[1], text, "utf8");

const count = (key) => {
  const o = {};
  for (const it of drawing.items) { const k = key(it); o[k] = (o[k] || 0) + 1; }
  return o;
};
// filled area of an even-odd hatch: each loop counts + or - by how deep it sits among the others
function evenOddArea(loops) {
  let t = 0;
  for (const l of loops) {
    const a = HP.polyArea(l);
    const p = l[0], q = l[1], L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, s = a >= 0 ? 1 : -1, e = 1e-5;
    const pt = [(p[0] + q[0]) / 2 - s * (q[1] - p[1]) / L * e, (p[1] + q[1]) / 2 + s * (q[0] - p[0]) / L * e];
    let depth = 0;
    for (const o of loops) if (o !== l && HP.pointInPoly(pt, o)) depth++;
    t += (depth % 2 ? -1 : 1) * Math.abs(a);
  }
  return Math.round(t * 1e6) / 1e6;
}
const TYPE = { pline: "LWPOLYLINE", line: "LINE", arc: "ARC", circle: "CIRCLE", hatch: "HATCH", text: "TEXT", dim: "DIMENSION", insert: "INSERT" };
const summary = {
  plan: files[0], units,
  analyze: HP.analyze.standin ? "standin" : "src/analyze.js",
  furniture: HP.furniture && HP.furniture.standin ? "standin" : (HP.furniture ? "src/furniture.js" : "none"),
  entities: count(it => TYPE[it.kind]),
  layers: count(it => it.layer),
  roles: count(it => it.role),
  hatches: drawing.items.filter(i => i.kind === "hatch").map(h => ({ pattern: h.pattern, scale: h.scale, loops: h.loops.length, layer: h.layer, area: evenOddArea(h.loops) })),
  dims: drawing.items.filter(i => i.kind === "dim").map(d => ({ chain: d.chain, text: d.text, small: !!d.small })),
  blocks: Object.keys(drawing.blocks).map(n => ({ name: n, items: drawing.blocks[n].items.length })),
  texts: drawing.items.filter(i => i.kind === "text").map(t => t.text),
  extents: drawing.extents,
};
fs.writeFileSync(files[1].replace(/\.dxf$/i, "") + ".summary.json", JSON.stringify(summary, null, 1), "utf8");
console.log("wrote " + files[1] + " (" + text.length + " chars), analyze=" + summary.analyze + ", furniture=" + summary.furniture);
console.log(JSON.stringify(summary.entities));
