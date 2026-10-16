"use strict";
/* dev/report.js - builds report/report.html (features, every furniture variant,
   two sample 10 x 20 m plans) for printing to PDF.   node dev/report.js       */
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
["core", "store", "analyze", "model", "furniture", "drawing"].forEach(m => require(path.join(root, "src", m + ".js")));
const HP = globalThis.HP;

// ---------------------------------------------------------------- SVG from drawing items
function svgOf(d, maxW) {
  const L = HP.LAYERS, e = d.extents, pad = 0.6;
  const W = e.x1 - e.x0 + 2 * pad, H = e.y1 - e.y0 + 2 * pad;
  const o = [];
  const col = it => it.color || (L[it.layer] && L[it.layer].color) || "#ccc";
  const f = n => +n.toFixed(3);
  function draw(it, T, rotA, mir) {
    const P = p => { const q = T(p); return [f(q[0]), f(-q[1])]; };
    const c = col(it), sw = it.layer === "A-WALL" ? 0.03 : 0.015;
    switch (it.kind) {
      case "line": { const a = P(it.a), b = P(it.b); o.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${c}" stroke-width="${sw}"/>`); break; }
      case "circle": { const p = P(it.c); o.push(`<circle cx="${p[0]}" cy="${p[1]}" r="${f(it.r)}" fill="none" stroke="${c}" stroke-width="${sw}"/>`); break; }
      case "arc": {
        let a0 = it.a0, a1 = it.a1;
        if (mir) [a0, a1] = [180 - a1, 180 - a0];
        a0 += rotA; a1 += rotA;
        const ctr = T(it.c), s = [ctr[0] + it.r * Math.cos(a0 * Math.PI / 180), ctr[1] + it.r * Math.sin(a0 * Math.PI / 180)],
              t = [ctr[0] + it.r * Math.cos(a1 * Math.PI / 180), ctr[1] + it.r * Math.sin(a1 * Math.PI / 180)];
        const large = ((a1 - a0) % 360 + 360) % 360 > 180 ? 1 : 0;
        o.push(`<path d="M${f(s[0])} ${f(-s[1])}A${f(it.r)} ${f(it.r)} 0 ${large} 1 ${f(t[0])} ${f(-t[1])}" fill="none" stroke="${c}" stroke-width="${sw}"/>`); break;
      }
      case "pline": {
        const pts = it.pts, n = pts.length, segs = it.closed ? n : n - 1;
        let s = "M" + P(pts[0]).join(" ");
        for (let i = 0; i < segs; i++) {
          const a = pts[i], b = pts[(i + 1) % n], bu = (it.bulges && it.bulges[i]) || 0, q = P(b);
          if (!bu) { s += "L" + q.join(" "); continue; }
          const dd = Math.hypot(b[0] - a[0], b[1] - a[1]), r = dd * (1 + bu * bu) / (4 * Math.abs(bu));
          const ccw = (bu > 0) !== !!mir;
          s += `A${f(r)} ${f(r)} 0 ${Math.abs(bu) > 1 ? 1 : 0} ${ccw ? 0 : 1} ${q.join(" ")}`;
        }
        if (it.closed) s += "Z";
        o.push(`<path d="${s}" fill="none" stroke="${c}" stroke-width="${it.width ? f(it.width) : sw}"/>`); break;
      }
      case "hatch": {
        const s = it.loops.map(l => "M" + l.map(p => P(p).join(" ")).join("L") + "Z").join("");
        const op = it.pattern === "SOLID" ? 1 : it.pattern === "ANSI31" ? 0.55 : 0.18;
        o.push(`<path d="${s}" fill="${c}" fill-opacity="${op}" fill-rule="evenodd"/>`); break;
      }
      case "text": {
        const p = P(it.p), fs = f(it.h / (HP.drawing.CAP || 0.7));
        const anc = /c$/.test(it.align) ? "middle" : /r$/.test(it.align) ? "end" : "start";
        const base = /^m/.test(it.align) ? "middle" : /^t/.test(it.align) ? "hanging" : "auto";
        const fill = it.layer === "A-ANNO-DIMS" ? HP.COLORS.dimText : c;
        o.push(`<text x="${p[0]}" y="${p[1]}" font-size="${fs}" fill="${fill}" text-anchor="${anc}" dominant-baseline="${base}" transform="rotate(${-(it.rot || 0)} ${p[0]} ${p[1]})">${String(it.text).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`); break;
      }
      case "dim": {
        const c2 = L["A-ANNO-DIMS"].color, rot = Math.round(it.rot || 0) % 180;
        if (rot !== 0 && rot !== 90) break;
        const a = rot === 0 ? [it.a[0], it.d[1]] : [it.d[0], it.a[1]], b = rot === 0 ? [it.b[0], it.d[1]] : [it.d[0], it.b[1]];
        draw({ kind: "line", a, b, color: c2 }, T, 0, false);
        [a, b].forEach(p => draw({ kind: "line", a: [p[0] - 0.05, p[1] - 0.05], b: [p[0] + 0.05, p[1] + 0.05], color: c2 }, T, 0, false));
        const m = [(a[0] + b[0]) / 2 + (rot ? -0.08 : 0), (a[1] + b[1]) / 2 + (rot ? 0 : 0.08)];
        draw({ kind: "text", p: m, h: it.small ? 0.08 : 0.13, text: it.text, align: "bc", rot, layer: "A-ANNO-DIMS" }, T, 0, false);
        break;
      }
      case "insert": {
        const blk = d.blocks[it.block]; if (!blk) break;
        const r = (it.rot || 0) * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r), sx = it.sx || 1;
        const T2 = p => { const x = p[0] * sx, y = p[1]; return T([it.p[0] + x * cs - y * sn, it.p[1] + x * sn + y * cs]); };
        blk.items.forEach(b => draw(Object.assign({ layer: blk.layer || it.layer }, b, { color: b.color || col(it) }), T2, rotA + (it.rot || 0), sx < 0));
        break;
      }
    }
  }
  d.items.forEach(it => draw(it, p => p, 0, false));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(e.x0 - pad)} ${f(-e.y1 - pad)} ${f(W)} ${f(H)}" style="width:100%;max-width:${maxW}px;background:#0f1620;border-radius:8px" font-family="Segoe UI,Arial">${o.join("")}</svg>`;
}

// ---------------------------------------------------------------- helpers
let notes = [];
function apply(r) { if (r.note) notes.push(r.note); return r.state; }
function add(p, type, pt) { const r = HP.model.addRoom(p, type, pt); if (r.note) notes.push(r.note); return r; }

// ---------------------------------------------------------------- furniture sheets
const VAR_TYPES = ["bedroom", "living", "reception", "kitchen", "bath", "wc", "open", "hall"];
const BIG = { bedroom: [400, 420], living: [480, 520], reception: [450, 500], kitchen: [340, 420], bath: [220, 260], wc: [140, 190], open: [300, 400], hall: [180, 420] };
let furnHtml = "";
for (const type of VAR_TYPES) {
  const vs = HP.furniture.variants(type);
  furnHtml += `<h3>${HP.ROOM_TYPES[type].label}</h3><div class="grid">`;
  for (let i = 1; i < vs.length; i++) {
    let p = HP.newPlan({ w: 900, d: 900 });
    p.plot.edges = ["street", "street", "street", "street"];
    const r = add(p, type, [450, 450]); p = r.state;
    const room = p.rooms[0];
    p = HP.model.setRoomSize(p, room.id, BIG[type][0], BIG[type][1]).state;
    p = HP.model.setFurniture(p, room.id, i).state;
    const A = HP.analyze(p), d = HP.drawing.build(p, A, { dims: false, site: false, sections: false, sizes: false });
    // crop to the room
    const rm = p.rooms[0]; d.extents = { x0: (rm.x - 40) / 100, y0: (rm.y - 40) / 100, x1: (rm.x + rm.w + 40) / 100, y1: (rm.y + rm.h + 40) / 100 };
    furnHtml += `<figure>${svgOf(d, 260)}<figcaption>${vs[i].label}</figcaption></figure>`;
  }
  furnHtml += `</div>`;
}
const blocks = Object.keys(HP.furniture.BLOCKS);

// ---------------------------------------------------------------- two 10 x 20 m plans
function planA() {
  let p = HP.deserialize(fs.readFileSync(path.join(root, "test/fixtures/sample-house.json"), "utf8"));
  p.meta.title = "Plan A - courtyard house, street at front";
  p.plot.pts = HP.rectPlot(1000, 2000); p.rooms.forEach(r => { r.y += 100; }); p.sections = [];
  return p;
}
function planB() {
  let p = HP.newPlan({ w: 1000, d: 2000 }); p.meta.title = "Plan B - corner plot, streets at front and right";
  p.plot.edges = ["street", "street", "neighbour", "neighbour"];
  const P = (t, pt) => { const r = add(p, t, pt); p = r.state; return r.id; };
  P("reception", [230, 450]); P("hall", [520, 700]); P("living", [780, 600]);
  P("kitchen", [200, 1000]); P("open", [780, 1100]); P("bath", [450, 1200]); P("wc", [450, 1000]);
  const B = pt => { const id = P("bedroom", pt); p = HP.model.setRoomSize(p, id, 300, 400).state; };
  B([170, 1750]); B([500, 1750]); B([830, 1750]);
  p.rooms.filter(r => r.type === "bedroom").forEach(r => { const q = HP.model.addOpening(p, "door", 80, [r.x + 60, r.y - 10]); if (q.ok) p = q.state; });
  return p;
}
function planBlock(p) {
  // add a section mark through the middle
  p = HP.model.addSection(p, [500, 1000]).state;
  const A = HP.analyze(p), d = HP.drawing.build(p, A, {});
  const bad = A.rules.filter(r => !r.ok);
  const list = p.rooms.map(r => `<li>${r.name}: ${HP.fmtM(r.w)} x ${HP.fmtM(r.h)} m (${HP.fmtArea(r.w * r.h)} m²)</li>`).join("");
  return `<h2>${p.meta.title}</h2>${svgOf(d, 760)}
  <p class="${bad.length ? "bad" : "ok"}">Rules: ${bad.length ? bad.map(r => r.title + " - " + r.detail).join("; ") : "all " + A.rules.length + " rules pass"}</p>
  <ul class="cols">${list}</ul>`;
}
notes = [];
const plans = planBlock(planA()) + `<div class="pb"></div>` + planBlock(planB());

// ---------------------------------------------------------------- page
const feats = [
  ["Land", "Type width x depth in 5 cm steps, or switch on Edit corners and drag, add or remove corners for a land that is not a rectangle."],
  ["Streets", "Click each side of the land: street or neighbour. Streets are drawn outside with their width. No door or window ever goes on a neighbour wall."],
  ["Walls", "Outside and inside wall thickness: 0.10 / 0.15 / 0.20 / 0.25 / 0.30 m."],
  ["Add rooms", "Drag Bedroom, Living room, Reception, Kitchen, Bathroom, Toilet (WC), Open area or Hall onto the land (or click the tile). Each arrives with furniture, a door and a window. Too big for the gap? It shrinks to fit."],
  ["Resize", "Drag any wall in 5 cm steps; the room on the other side follows, sizes shown live. Alt + drag moves only one room. Exact sizes can be typed in the inspector."],
  ["Move / swap", "Grab a room by its name to move it; it snaps to the other rooms and stays on the land. Drop it on another room to swap them. Arrow keys nudge 5 cm (Shift 50 cm)."],
  ["Doors", "0.80 m and 1.00 m. Drag along a wall or onto another wall. Double-click flips the swing; inspector sets swing in/out and hinge left/right."],
  ["Windows", "0.60, 1.00, 1.20, 1.50, 2.00, 2.50 m. Only on walls facing an open area, the yard or the street. Sizes the room type does not allow are fitted automatically. A window covered by a new room moves itself to a free outside wall."],
  ["Furniture", "Chosen automatically for the room's size and doors, or pick a layout per room (see the next pages). Rearranges itself when the room or its doors change."],
  ["Section mark", "Drag in, move the line or its ends, click a head to flip the view, turn 90 degrees, change its letter."],
  ["Rules (live)", "An open area of at least 1.30 x 2.00 m; a bathroom, a toilet, a living room; every room has a window onto open air; window widths suit the room; bedrooms 3.00-5.00 m each way; every room reachable through doors. Click a problem to zoom to it."],
  ["Files", "Save / Open a .houseplan.json file (moves between computers); autosave; Export DXF in m, cm or mm with real hatches, real dimensions, furniture blocks and named layers. Undo / Redo for everything."],
  ["Board", "Scroll to zoom, drag empty space to pan, F to fit, right-click menu, Delete removes, Esc cancels."],
];
const html = `<!doctype html><html><head><meta charset="utf-8"><title>House Planner report</title><style>
@page{size:A4;margin:12mm}body{font-family:Segoe UI,Arial,sans-serif;color:#1b2430;font-size:11pt}
h1{margin:0 0 4px;font-size:22pt}h2{font-size:14pt;margin:14px 0 6px}h3{font-size:12pt;margin:12px 0 4px;color:#0e5f6c}
.sub{color:#667;margin-bottom:10px}table{border-collapse:collapse;width:100%}td{border-top:1px solid #ddd;padding:5px 6px;vertical-align:top}
td:first-child{font-weight:600;white-space:nowrap;color:#0e5f6c}.grid{display:flex;flex-wrap:wrap;gap:8px}
figure{margin:0;width:31%;break-inside:avoid}figcaption{font-size:9pt;text-align:center}.pb{break-after:page}
.ok{color:#1e7a46;font-weight:600}.bad{color:#b33}.cols{columns:2;font-size:9.5pt}h3,figure{break-inside:avoid}
</style></head><body>
<h1>House Planner</h1><div class="sub">Feature report - ${new Date().toISOString().slice(0, 10)} - ${blocks.length} furniture blocks, ${VAR_TYPES.reduce((n, t) => n + HP.furniture.variants(t).length - 1, 0)} furniture layouts</div>
<h2>What you can do</h2><table>${feats.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("")}</table>
<div class="pb"></div>
<h2>Furniture layouts (each room type, every choice)</h2>
<p style="font-size:9.5pt">Automatic picks one of these for the room size; any of them can be chosen in the inspector. Blocks: ${blocks.join(", ")}.</p>
${furnHtml}
<div class="pb"></div>
${plans}
</body></html>`;
fs.mkdirSync(path.join(root, "report"), { recursive: true });
fs.writeFileSync(path.join(root, "report", "report.html"), html);
console.log("wrote report/report.html");
