"use strict";
/* ============================================================================
   House Planner - core.js
   ----------------------------------------------------------------------------
   Shared by every module: units, the plan (save-file) format, room types, the
   rules, layers and small exact geometry helpers. No DOM in here.

   UNITS: every length inside a plan is an INTEGER number of CENTIMETRES on a
   5 cm grid. Only drawing.js converts to metres (for the screen and the DXF).
   AXES:  x to the right, y UP (CAD convention). The plot's first edge (pts[0]
   -> pts[1]) is the bottom edge, which is the front by default.
   ROOMS: x, y, w, h describe the CLEAR inside of the room (inner wall faces).
   Walls are the space between rooms: a shared wall is a gap of exactly
   walls.int between two rooms; every room has walls.ext of wall round any
   side that does not touch another room.
============================================================================ */
(function (HP) {
  const VERSION = 1;
  const GRID = 5;                                   // cm

  // ------------------------------------------------------------ numbers
  const snap = v => Math.round(v / GRID) * GRID;
  const snapDown = v => Math.floor(v / GRID + 1e-9) * GRID;
  const snapUp = v => Math.ceil(v / GRID - 1e-9) * GRID;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cm2m = v => v / 100;
  const fmtM = cm => (cm / 100).toFixed(2);          // 420 -> "4.20"
  const fmtArea = cm2 => (cm2 / 10000).toFixed(1);   // cm^2 -> "12.5"

  // ------------------------------------------------------------ room types
  /* win      allowed window widths for this room [min, max] cm (rule R2), null = no windows
     winDef   width used when a window is placed automatically
     size     default clear size [w, h] when dropped from the side panel
     hardMin  a drag can never make either side smaller than this (cm)
     roofed   false = open to the sky (counts as an open area)
     needsWindow  rule: must have at least one window onto an open area
     tint     screen-only colour hint for the type (never exported)            */
  const ROOM_TYPES = {
    bedroom:   { label: "Bedroom",     roofed: true,  needsWindow: true,  win: [100, 150], winDef: 120, size: [360, 400], hardMin: 200, tint: "#6c7bd9" },
    living:    { label: "Living room", roofed: true,  needsWindow: true,  win: [150, 250], winDef: 150, size: [450, 500], hardMin: 200, tint: "#d9a35f" },
    reception: { label: "Reception",   roofed: true,  needsWindow: true,  win: [150, 250], winDef: 150, size: [400, 450], hardMin: 200, tint: "#c06cd9" },
    kitchen:   { label: "Kitchen",     roofed: true,  needsWindow: true,  win: [150, 250], winDef: 150, size: [300, 400], hardMin: 150, tint: "#5fcf8f" },
    bath:      { label: "Bathroom",    roofed: true,  needsWindow: true,  win: [60, 60],   winDef: 60,  size: [200, 250], hardMin: 100, tint: "#5fbfd9" },
    wc:        { label: "Toilet (WC)", roofed: true,  needsWindow: true,  win: [60, 60],   winDef: 60,  size: [130, 180], hardMin: 80,  tint: "#5f93d9" },
    open:      { label: "Open area",   roofed: false, needsWindow: false, win: null,       winDef: 0,   size: [200, 300], hardMin: 100, tint: "#4f9a6c" },
    hall:      { label: "Hall",        roofed: true,  needsWindow: false, win: [60, 250],  winDef: 100, size: [160, 400], hardMin: 90,  tint: "#8a93a3" },
  };
  const ROOM_ORDER = ["bedroom", "living", "reception", "kitchen", "bath", "wc", "open", "hall"];

  const WINDOW_SIZES = [60, 100, 120, 150, 200, 250];   // cm, what the side panel offers
  const DOOR_SIZES = [80, 100];                         // cm
  const DOORS = { entrance: 100, interior: 80 };        // default widths

  // ------------------------------------------------------------ the rules
  /* From the v0.5 generator (engine.js RULES) and Rasa's brief of 2026-10-14.
     Rule ids are what analyze() reports; the text lives in analyze.js.       */
  const RULES = {
    bedroom:      { min: 300, max: 500 },             // R1: both sides 3.00-5.00 m
    openArea:     { shortMin: 130, longMin: 200 },    // R4: an open area is at least 1.30 x 2.00 m
    minOpenDepth: 100,  // unbuilt plot in front of a wall counts as open (yard) only if at least this deep
    minGap:       100,  // two outer wall faces (or a face and the boundary) closer than this leave a
                        // useless slot - edits snap such gaps shut or open to this
    endClear:     10,   // wall left between an opening and a corner
    openingGap:   10,   // wall left between two openings on one wall
    needOneOf:    ["bath", "wc", "living"],           // at least one of each must exist
  };

  // ------------------------------------------------------------ layers
  /* One table for the screen and the DXF, so they can never disagree.
     color = true colour (hex). ltype = linetype name. lw = lineweight in mm.
     Colours come from Rasa's reference DXF via the old generator.            */
  const LAYERS = {
    "A-WALL":      { color: "#a04040", ltype: "CONTINUOUS", lw: 0.35, desc: "Wall outlines" },
    "A-WALL-PATT": { color: "#8c2f2f", ltype: "CONTINUOUS", lw: 0.13, desc: "Wall hatch (ANSI31)" },
    "A-DOOR":      { color: "#e2e2ea", ltype: "CONTINUOUS", lw: 0.25, desc: "Door leaves and swings" },
    "A-GLAZ":      { color: "#2e9bd6", ltype: "CONTINUOUS", lw: 0.25, desc: "Windows" },
    "A-FURN":      { color: "#8b93a7", ltype: "CONTINUOUS", lw: 0.18, desc: "Furniture" },
    "A-FIXT":      { color: "#7fb2c2", ltype: "CONTINUOUS", lw: 0.18, desc: "Sanitary and kitchen fixtures" },
    "A-ANNO-TEXT": { color: "#9a9ae4", ltype: "CONTINUOUS", lw: 0.18, desc: "Room names and areas" },
    "A-ANNO-DIMS": { color: "#16b6c9", ltype: "CONTINUOUS", lw: 0.18, desc: "Dimensions", text: "#8fe6f0" },
    "A-SECT":      { color: "#d94b4b", ltype: "DASHDOT",    lw: 0.35, desc: "Section marks" },
    "A-PLOT":      { color: "#5a6b82", ltype: "DASHED",     lw: 0.25, desc: "Property line" },
    "A-ROAD":      { color: "#4b5567", ltype: "CONTINUOUS", lw: 0.18, desc: "Street" },
    "A-OPEN-PATT": { color: "#28455c", ltype: "CONTINUOUS", lw: 0.13, desc: "Open-area hatch (DOTS)" },
    "A-SITE-PATT": { color: "#2f8f5b", ltype: "CONTINUOUS", lw: 0.13, desc: "Yard hatch (GRASS)" },
    "A-LEVL":      { color: "#cfd6e4", ltype: "CONTINUOUS", lw: 0.18, desc: "Level marks" },
  };
  const COLORS = {                 // screen-only extras
    bg: "#0f1620", swing: "#7d7d94", dimText: "#8fe6f0",
  };

  // ------------------------------------------------------------ sides
  const SIDES = ["N", "E", "S", "W"];
  /* The edge `side` of a room's clear rectangle.
       axis  'x' for N/S (the edge runs along x), 'y' for E/W
       fixed the coordinate of the inner wall face (y for N/S, x for E/W)
       s0,s1 the edge's span along its axis (s0 < s1); an opening's `at` is
             measured from s0
       n     outward unit normal (pointing away from the room, into the wall)  */
  function sideInfo(r, side) {
    switch (side) {
      case "N": return { axis: "x", fixed: r.y + r.h, s0: r.x, s1: r.x + r.w, n: [0, 1] };
      case "S": return { axis: "x", fixed: r.y,       s0: r.x, s1: r.x + r.w, n: [0, -1] };
      case "E": return { axis: "y", fixed: r.x + r.w, s0: r.y, s1: r.y + r.h, n: [1, 0] };
      case "W": return { axis: "y", fixed: r.x,       s0: r.y, s1: r.y + r.h, n: [-1, 0] };
    }
    throw new Error("bad side " + side);
  }
  const opposite = s => ({ N: "S", S: "N", E: "W", W: "E" })[s];

  // ------------------------------------------------------------ rectangles
  const rect = (x, y, w, h) => ({ x, y, w, h });
  const grow = (r, d) => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });
  // positive-area overlap (touching edges do NOT overlap)
  const rectsOverlap = (a, b) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  // length of the overlap of [a0,a1] and [b0,b1] (0 if none)
  const spanOverlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const containsPt = (r, p) => p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;

  // ------------------------------------------------------------ polygons
  function polyArea(pts) {           // signed, CCW positive
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }
  // even-odd; points ON the boundary count as inside
  function pointInPoly(p, pts) {
    const [x, y] = p;
    for (let i = 0; i < pts.length; i++) {         // on an edge?
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const cr = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (Math.abs(cr) < 1e-6 &&
          x >= Math.min(a[0], b[0]) - 1e-6 && x <= Math.max(a[0], b[0]) + 1e-6 &&
          y >= Math.min(a[1], b[1]) - 1e-6 && y <= Math.max(a[1], b[1]) + 1e-6) return true;
    }
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  // proper crossing of segments ab and cd (touching does not count)
  function segsCross(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
    return o1 * o2 < 0 && o3 * o4 < 0;
  }
  // is the whole rectangle inside the polygon (boundary contact allowed)?
  function rectInPoly(r, pts) {
    const c = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
    if (!c.every(p => pointInPoly(p, pts))) return false;
    for (const v of pts)                              // a plot corner poking into the rect
      if (v[0] > r.x && v[0] < r.x + r.w && v[1] > r.y && v[1] < r.y + r.h) return false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      for (let k = 0; k < 4; k++) if (segsCross(a, b, c[k], c[(k + 1) % 4])) return false;
    }
    return true;
  }
  const rectPlot = (w, d) => [[0, 0], [w, 0], [w, d], [0, d]];

  // ------------------------------------------------------------ plans
  function newPlan(opts) {
    const o = Object.assign({ w: 1000, d: 2000 }, opts || {});
    const now = new Date().toISOString();
    return {
      version: VERSION,
      meta: { title: "House plan", created: now, modified: now },
      plot: {
        pts: rectPlot(snap(o.w), snap(o.d)),          // CCW, edge i = pts[i] -> pts[i+1]
        edges: ["street", "neighbour", "neighbour", "neighbour"],   // bottom edge = street
        road: 800,                                    // street width drawn outside a street edge
      },
      walls: { ext: 20, int: 20 },
      rooms: [],      // { id, type, name, x, y, w, h, furn }
      openings: [],   // { id, kind:'door'|'window', room, side, at, w, hinge:'start'|'end', swing:'in'|'out' }
      sections: [],   // { id, label, a:[x,y], b:[x,y], look: 1|-1 }
      seq: 1,         // next id number
    };
  }
  const clone = s => JSON.parse(JSON.stringify(s));
  // call on a CLONE: hands out the next unique id
  function newId(s, prefix) { const id = prefix + s.seq; s.seq += 1; return id; }

  // "Bedroom 1", "Bedroom 2" ... ; the first room of a kind with no number is
  // renamed "<kind> 1" when a second one arrives (call on a CLONE)
  function nextName(s, type) {
    const base = ROOM_TYPES[type].label;
    const same = s.rooms.filter(r => r.type === type);
    if (!same.length) return base;
    same.forEach(r => { if (r.name === base) r.name = base + " 1"; });
    let n = same.length + 1;
    const taken = new Set(s.rooms.map(r => r.name));
    while (taken.has(base + " " + n)) n++;
    return base + " " + n;
  }

  // ------------------------------------------------------------ save files
  function serialize(s) {
    const out = clone(s);
    out.meta = Object.assign({}, out.meta, { modified: new Date().toISOString() });
    return JSON.stringify(out, null, 1);
  }
  // throws an Error with a plain-English message when the file is not a plan
  function deserialize(text) {
    let s;
    try { s = JSON.parse(text); } catch (e) { throw new Error("This file is not a house plan (it is not readable)."); }
    if (!s || typeof s !== "object" || !s.plot || !Array.isArray(s.rooms))
      throw new Error("This file is not a house plan.");
    if ((s.version | 0) > VERSION)
      throw new Error("This plan was saved by a newer House Planner. Please update.");
    const base = newPlan();
    s = Object.assign(base, s);
    s.openings = s.openings || []; s.sections = s.sections || [];
    s.walls = Object.assign({ ext: 20, int: 20 }, s.walls || {});
    let maxId = 0;
    [...s.rooms, ...s.openings, ...s.sections].forEach(o => {
      const n = parseInt(String(o.id).replace(/\D/g, ""), 10);
      if (n > maxId) maxId = n;
    });
    s.seq = Math.max(s.seq | 0, maxId + 1);
    s.version = VERSION;
    return s;
  }

  Object.assign(HP, {
    VERSION, GRID, snap, snapDown, snapUp, clamp, cm2m, fmtM, fmtArea,
    ROOM_TYPES, ROOM_ORDER, WINDOW_SIZES, DOOR_SIZES, DOORS, RULES, LAYERS, COLORS,
    SIDES, sideInfo, opposite,
    rect, grow, rectsOverlap, spanOverlap, containsPt,
    polyArea, pointInPoly, segsCross, rectInPoly, rectPlot,
    newPlan, clone, newId, nextName, serialize, deserialize,
  });
})(globalThis.HP = globalThis.HP || {});

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.HP;
