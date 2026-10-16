"use strict";
/* ============================================================================
   House Planner - drawing.js   (drafting agent)
   ----------------------------------------------------------------------------
   HP.drawing.build(plan, A, opts) -> { items, blocks, extents }   all METRES

   Turns a plan and its analysis (HP.analyze, centimetres) into drawing
   primitives (CONTRACT.md section 8). The SAME primitives are painted on the
   screen (render.js) and written to the DXF (dxf.js), so the two can never
   disagree. The look is Rasa's own drafting style, taken from his reference
   DXF through the old generator (prototype.html renderSVG): maroon ANSI31
   walls, 3-line blue windows, door leaf + swing arc, uppercase lavender room
   names with the area under them, cyan dimension chains with oblique ticks
   and 2-decimal text, small text on 0.20 wall segments.

   Sizes are for a 1:100 print in metres (a room name 0.25 m high = 2.5 mm on
   paper). TEXT HEIGHT `h` IS THE CAP HEIGHT, as in AutoCAD and ezdxf: a canvas
   that sets its font size in px should use  h / CAP * scale  to match.

   Speed: build() runs on every drag step. Everything here is plain arrays and
   a few loops over rooms and openings; the sample house builds in well under
   a millisecond without furniture (see test/drawing.test.js).
============================================================================ */
(function (HP) {
  const M = v => v / 100;                              // cm -> m
  const DEG = Math.PI / 180;

  // ---------------------------------------------------------------- sizes (m)
  const SIZES = {
    name: 0.25, nameMin: 0.12,         // room name (cap height)
    area: 0.16, size: 0.14, subMin: 0.09,
    labelPad: 0.10,                    // text keeps this far from the wall faces
    lane0: 0.60, laneStep: 0.60,       // first dimension chain off the face, then the next
    laneNeed: 1.90,                    // yard depth needed to keep two chains inside the land
    sectR: 0.33, sectText: 0.26, sectHeavy: 0.90, sectWidth: 0.045,
    roadText: 0.35, roadWalk: 1.50, roadRun: 1.00,
    yardMinHole: 0.04,                 // margin round text cut out of a hatch
  };
  // dimension style - dxf.js writes the same numbers into the "HP" dimstyle
  const DIM = { text: 0.18, small: 0.12, tick: 0.06, exo: 0.06, exe: 0.08, gap: 0.05 };
  // linetypes in metres (dash +, gap -, dot 0) - the same numbers render.js uses
  const LTYPES = {
    DASHED: { desc: "Dashed __ __ __", pat: [0.30, -0.15] },
    DASHDOT: { desc: "Dash dot __ . __ .", pat: [0.60, -0.12, 0.06, -0.12] },
  };
  // hatch pattern scale per use (acadiso.pat units; see PATTERNS)
  const HATCH = {
    wall: { pattern: "ANSI31", scale: 0.025, angle: 0 },   // lines 0.079 m apart
    open: { pattern: "DOTS", scale: 0.125, angle: 0 },     // dots 0.198 m apart
    yard: { pattern: "GRASS", scale: 0.012, angle: 0 },    // a tuft every 0.30 m
  };

  /* Hatch patterns exactly as AutoCAD 2027 ships them in acadiso.pat
     (C:\Users\PC\AppData\Roaming\Autodesk\AutoCAD 2027\R26.0\enu\Support):
     [angle, x0, y0, dx, dy, dashes]  - dx,dy in the line's own turned frame,
     the way a .pat file states them. acadiso.pat because the DXF is metric
     ($MEASUREMENT 1): if Rasa edits a hatch, AutoCAD reloads the pattern from
     acadiso.pat with the stored scale, and the hatch must stay as drawn.     */
  const PATTERNS = {
    ANSI31: [[45, 0, 0, 0, 3.175, []]],
    DOTS: [[0, 0, 0, 0.79375, 1.5875, [0, -1.5875]]],
    GRASS: [
      [90, 0, 0, 17.96051224, 17.96051224, [4.7625, -31.15852448]],
      [45, 0, 0, 0, 25.4, [4.7625, -20.6375]],
      [135, 0, 0, 0, 25.4, [4.7625, -20.6375]],
    ],
    SOLID: [[45, 0, 0, 0, 0.125, []]],
  };
  /* The pattern lines a DXF HATCH stores: scale and angle applied, offsets in
     world axes. -> [{ angle, base:[x,y], offset:[x,y], dashes:[...] }]        */
  function patternLines(name, scale, angle) {
    const def = PATTERNS[String(name).toUpperCase()];
    if (!def) return [];
    const k = scale || 1, rot = angle || 0;
    const turn = (x, y, a) => { const c = Math.cos(a * DEG), s = Math.sin(a * DEG); return [x * c - y * s, x * s + y * c]; };
    return def.map(([a, x0, y0, dx, dy, dashes]) => ({
      angle: ((a + rot) % 360 + 360) % 360,
      base: turn(x0 * k, y0 * k, rot),
      offset: turn(dx * k, dy * k, a + rot),
      dashes: dashes.map(d => d * k),
    }));
  }

  // ---------------------------------------------------------------- text size
  /* Arial advance widths (1/1000 em). CAP = Arial cap height in em. A TEXT
     `h` is the cap height, so a string is  sum(adv) / 1000 * h / CAP  wide.   */
  const CAP = 0.716;
  const ADV = {};
  (function () {
    const set = (chars, w) => { for (const c of chars) ADV[c] = w; };
    set("ABEKPSVXY", 667); set("CDHNRUw", 722); set("GOQ", 778); set("FTZ", 611);
    set("Mm", 833); set("W", 944); set("L", 556); set("J", 500); set("Iijl", 222);
    set("0123456789abdeghnopqu", 556); set("ckstvxyz", 500); set("frt", 278);
    set("r", 333); set(" .,:;", 278); set("I", 278); set("()-²", 333); set("x", 500);
  })();
  function textWidth(s, h) {
    let t = 0;
    for (const ch of String(s)) t += ADV[ch] || (ch >= "a" && ch <= "z" ? 520 : 650);
    return t / 1000 * h / CAP;
  }

  // ---------------------------------------------------------------- small helpers
  const LAYER = n => (HP.LAYERS && HP.LAYERS[n]) ? n : n;   // names are fixed in core.js
  function item(kind, layer, role, ref, props) {
    return Object.assign({ kind, layer: LAYER(layer), role, ref: ref == null ? null : ref }, props);
  }
  const loopsM = loops => (loops || []).map(l => l.map(p => [M(p[0]), M(p[1])]));
  const rectLoop = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const boxOverlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const angleNorm = a => ((a % 360) + 360) % 360;
  // a text direction that never reads upside down: (-90, 90]
  function readable(deg) {
    let a = angleNorm(deg);
    if (a > 90 && a <= 270) a -= 180;
    else if (a > 270) a -= 360;
    return Math.abs(a) < 1e-9 ? 0 : a;
  }
  function inRegion(p, loops) {                       // even-odd over every loop
    let k = 0;
    for (const l of loops) if (HP.pointInPoly(p, l)) k++;
    return (k & 1) === 1;
  }

  // ---------------------------------------------------------------- dimensions
  /* The geometry of one 'dim' primitive, in the same units as the primitive:
     the dimension line, the extension lines, the two oblique ticks and the
     text. dxf.js writes exactly this into the dimension's anonymous block, and
     render.js may draw it the same way.                                       */
  function dimGeometry(dm, style) {
    const S = Object.assign({}, DIM, style || {});
    const th = (+dm.rot || 0) * DEG, u = [Math.cos(th), Math.sin(th)], v = [-u[1], u[0]];
    const proj = p => { const t = (p[0] - dm.d[0]) * u[0] + (p[1] - dm.d[1]) * u[1]; return [dm.d[0] + u[0] * t, dm.d[1] + u[1] * t]; };
    const pa = proj(dm.a), pb = proj(dm.b);
    const lines = [[pa, pb]];
    for (const [p, q] of [[dm.a, pa], [dm.b, pb]]) {
      const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy);
      if (L > S.exo + 1e-9) {
        const w = [dx / L, dy / L];
        lines.push([[p[0] + w[0] * S.exo, p[1] + w[1] * S.exo], [q[0] + w[0] * S.exe, q[1] + w[1] * S.exe]]);
      }
    }
    const k = [(u[0] + v[0]) * S.tick, (u[1] + v[1]) * S.tick];      // 45 degrees to the line
    const ticks = [pa, pb].map(p => [[p[0] - k[0], p[1] - k[1]], [p[0] + k[0], p[1] + k[1]]]);
    const h = dm.h || (dm.small ? S.small : S.text);
    const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    const tp = dm.tp || [mid[0] + v[0] * (S.gap + h / 2), mid[1] + v[1] * (S.gap + h / 2)];
    const measure = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    return { pa, pb, lines, ticks, measure, text: { p: tp, h, rot: +dm.rot || 0, text: dm.text, align: "mc" } };
  }

  /* One chain of dimensions along one side of the house.
     side S/N: the chain runs along x and looks from below / above;
     side W/E: along y, from the left / right.  Everything in integer cm.     */
  function sideProfile(rooms, ext, int, side, bb) {
    const alongX = side === "S" || side === "N";
    const front = side === "S" || side === "W" ? -1 : 1;             // which way is "out"
    const spans = rooms.map(r => {
      const p0 = alongX ? r.x : r.y, p1 = alongX ? r.x + r.w : r.y + r.h;
      const q0 = alongX ? r.y : r.x, q1 = alongX ? r.y + r.h : r.x + r.w;
      return { id: r.id, p0, p1, g0: p0 - ext, g1: p1 + ext, face: front < 0 ? q0 - ext : q1 + ext, q0, q1 };
    });
    // a shared wall thicker than two outer walls would leave a slit: cover it
    if (int > 2 * ext) {
      const extra = [];
      for (let i = 0; i < spans.length; i++) for (let j = 0; j < spans.length; j++) {
        const a = spans[i], b = spans[j];
        if (i !== j && b.p0 - a.p1 === int && Math.min(a.q1, b.q1) - Math.max(a.q0, b.q0) > 0)
          extra.push({ id: null, p0: a.p1, p1: a.p1, g0: a.p1, g1: b.p0, face: front < 0 ? Math.min(a.face, b.face) : Math.max(a.face, b.face) });
      }
      spans.push(...extra);
    }
    const lo = alongX ? bb.x0 : bb.y0, hi = alongX ? bb.x1 : bb.y1;
    const cand = new Set([lo, hi]);
    for (const s of spans) for (const c of [s.p0, s.p1, s.g0, s.g1]) if (c > lo && c < hi) cand.add(c);
    const cs = [...cand].sort((a, b) => a - b);
    const segs = [];
    for (let i = 0; i + 1 < cs.length; i++) {
      const u = cs[i], w = cs[i + 1], m = (u + w) / 2;
      let best = null;
      for (const s of spans) if (s.g0 < m && m < s.g1 && (!best || s.face * front > best.face * front)) best = s;
      const kind = !best ? "gap" : (best.id && best.p0 < m && m < best.p1 ? "room" : "wall");
      const key = kind === "room" ? "r:" + best.id : kind;
      const last = segs[segs.length - 1];
      if (last && last.key === key) { last.b = w; if (best && best.face * front > last.face * front) last.face = best.face; }
      else segs.push({ a: u, b: w, key, kind, ref: kind === "room" ? best.id : null, face: best ? best.face : null });
    }
    return { segs, front, alongX };
  }

  // distance from the house face to the land edge, looking out from side `side`
  function yardDepth(plotPts, side, bb) {
    const alongX = side === "S" || side === "N";
    const front = side === "S" || side === "W" ? -1 : 1;
    const face = side === "S" ? bb.y0 : side === "N" ? bb.y1 : side === "W" ? bb.x0 : bb.x1;
    /* measured in front of the MIDDLE of the house: on a rectangular plot that is
       the depth everywhere; on a slanted one (a plot narrowing to a point behind
       the house) the chains then stay beside the house, crossing the land line
       for a short stretch, instead of standing metres away beyond its tip     */
    const p0 = alongX ? bb.x0 : bb.y0, p1 = alongX ? bb.x1 : bb.y1;
    const samples = [(p0 + p1) / 2];
    let best = Infinity;
    for (const s of samples) {
      // ray from (s, face) outward along q; nearest crossing with the plot edges
      for (let i = 0; i < plotPts.length; i++) {
        const a = plotPts[i], b = plotPts[(i + 1) % plotPts.length];
        const ap = alongX ? a[0] : a[1], bp = alongX ? b[0] : b[1];
        const aq = alongX ? a[1] : a[0], bq = alongX ? b[1] : b[0];
        if ((ap - s) * (bp - s) > 0 || ap === bp) continue;
        const q = aq + (bq - aq) * (s - ap) / (bp - ap);
        const d = (q - face) * front;
        if (d >= -1e-6 && d < best) best = d;
      }
    }
    return best === Infinity ? 0 : best;
  }

  // ---------------------------------------------------------------- labels
  function splitTwo(s) {
    const words = s.split(" ");
    if (words.length < 2) return null;
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const l1 = words.slice(0, i).join(" "), l2 = words.slice(i).join(" ");
      const w = Math.max(textWidth(l1, 1), textWidth(l2, 1));
      if (!best || w < best.w) best = { l1, l2, w };
    }
    return best;
  }
  /* The lines of one room label, fitted to the room: smaller text or two
     lines for the name, the small lines dropped before anything runs out.   */
  function fitLabel(name, subs, W, H, k) {
    k = k || 1;                                     // < 1: the whole label smaller (a crowded room)
    let nh = SIZES.name * k, lines = [name];
    const w1 = textWidth(name, 1);
    if (w1 * nh > W) {
      const hOne = W / w1;
      const sp = splitTwo(name);
      const hTwo = sp ? Math.min(SIZES.name * k, W / sp.w) : 0;
      if (sp && hTwo > hOne * 1.2) { lines = [sp.l1, sp.l2]; nh = hTwo; } else nh = hOne;
      nh = Math.max(SIZES.nameMin, nh);
    }
    let sub = subs.map(s => {
      let h = Math.min(s.h * Math.max(k, 0.8), nh * 0.72);
      h = Math.min(h, W / textWidth(s.text, 1));
      return { text: s.text, h, role: s.role };
    }).filter(s => s.h >= SIZES.subMin);
    const heightOf = () => lines.length * nh + (lines.length - 1) * nh * 0.4 +
      sub.reduce((t, s) => t + s.h + Math.max(0.06, s.h * 0.55), 0);
    while (sub.length && heightOf() > H) sub.pop();
    if (heightOf() > H && lines.length === 2) {                     // two lines do not fit: one line
      lines = [name]; nh = Math.max(SIZES.nameMin, Math.min(nh, W / w1));
    }
    if (heightOf() > H) nh = Math.max(SIZES.nameMin * 0.75, Math.min(nh, H / (lines.length * 1.4 - 0.4)));
    const out = lines.map(t => ({ text: t, h: nh, role: "room-name" })).concat(sub);
    const width = Math.max(...out.map(l => textWidth(l.text, l.h)));
    return { lines: out, w: width, h: heightOf(), nh };
  }
  // stack the label lines centred on (cx, cy)
  function placeLines(lab, cx, cy) {
    const out = [];
    let y = cy + lab.h / 2;
    lab.lines.forEach((l, i) => {
      if (i > 0) y -= (l.role === "room-name" ? l.h * 0.4 : Math.max(0.06, l.h * 0.55));
      out.push({ text: l.text, h: l.h, role: l.role, p: [cx, y - l.h / 2], w: textWidth(l.text, l.h) });
      y -= l.h;
    });
    return out;
  }

  // ================================================================= build
  function build(plan, A, opts) {
    opts = Object.assign({ furniture: true, dims: true, labels: true, sizes: true, sections: true, site: true }, opts || {});
    const items = [], blocks = {};
    if (!plan || !A) return { items, blocks, extents: { x0: 0, y0: 0, x1: 1, y1: 1 } };
    const ext = (plan.walls && plan.walls.ext) || 20, int = (plan.walls && plan.walls.int) || 20;
    const rooms = A.rooms || [];
    const planRoom = {};
    for (const r of plan.rooms || []) planRoom[r.id] = r;
    const plotPts = (plan.plot && plan.plot.pts) || [];

    // ---- layer groups, painted in this order
    const G = { yard: [], open: [], wallHatch: [], site: [], walls: [], glaz: [], doors: [], furn: [], text: [], dims: [], sect: [] };

    // ---------------------------------------------------------- furniture
    const furnBoxes = {};                                  // roomId -> [box m]
    if (opts.furniture && HP.furniture && typeof HP.furniture.layout === "function") {
      const BL = HP.furniture.BLOCKS || {};
      for (const r of rooms) {
        let lay;
        try {
          lay = HP.furniture.layout(r, (A.roomOpenings && A.roomOpenings[r.id]) || [], planRoom[r.id] ? (planRoom[r.id].furn | 0) : 0);
        } catch (e) { if (typeof console !== "undefined") console.error("[drawing] furniture.layout failed for " + r.id, e); continue; }
        if (!lay || !lay.inserts) continue;
        for (const ins of lay.inserts) {
          const B = BL[ins.block];
          if (!B) continue;
          const rot = +ins.rot || 0, sx = ins.sx === -1 ? -1 : 1;
          G.furn.push(item("insert", B.layer || "A-FURN", "furn", r.id, { block: ins.block, p: [M(ins.x), M(ins.y)], rot, sx }));
          if (!blocks[ins.block]) blocks[ins.block] = blockToMetres(B);
          // world boxes of the piece (its real footprint `parts` when it has them),
          // for keeping the room's name clear of it
          const c = Math.cos(rot * DEG), s = Math.sin(rot * DEG);
          for (const pr of (B.parts && B.parts.length ? B.parts : [[0, 0, B.w, B.h]])) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const [lx, ly] of [[pr[0], pr[1]], [pr[2], pr[1]], [pr[2], pr[3]], [pr[0], pr[3]]]) {
              const X = sx * lx, wx = ins.x + X * c - ly * s, wy = ins.y + X * s + ly * c;
              x0 = Math.min(x0, wx); y0 = Math.min(y0, wy); x1 = Math.max(x1, wx); y1 = Math.max(y1, wy);
            }
            (furnBoxes[r.id] = furnBoxes[r.id] || []).push({ x0: M(x0), y0: M(y0), x1: M(x1), y1: M(y1) });
          }
        }
      }
    }

    // ---------------------------------------------------------- walls
    const wl = loopsM(A.walls && A.walls.loops);
    if (wl.length) {
      G.wallHatch.push(item("hatch", "A-WALL-PATT", "wall-hatch", null,
        { pattern: HATCH.wall.pattern, scale: HATCH.wall.scale, angle: HATCH.wall.angle, loops: wl }));
      for (const l of wl) G.walls.push(item("pline", "A-WALL", "wall", null, { pts: l, closed: true }));
    }

    // ---------------------------------------------------------- doors and windows
    const entrances = new Set((A.access && A.access.entrances) || []);
    for (const o of A.openings || []) {
      const s0 = M(o.s0), s1 = M(o.s1), fx = M(o.fixed), fr = M(o.far), t = M(o.thick);
      const P = o.axis === "x" ? (s, q) => [s, q] : (s, q) => [q, s];
      const nq = o.axis === "x" ? o.n[1] : o.n[0];
      if (o.kind === "window") {
        for (const k of [0.25, 0.5, 0.75]) {
          const q = fx + nq * t * k;
          G.glaz.push(item("line", "A-GLAZ", "window", o.id, { a: P(s0, q), b: P(s1, q) }));
        }
      } else {
        const w = s1 - s0;
        const into = o.swing !== "out";
        const qf = into ? fx : fr, dq = into ? -nq : nq;
        const hs = o.hinge === "end" ? s1 : s0, os = o.hinge === "end" ? s0 : s1;
        const H = P(hs, qf), E = P(hs, qf + dq * w), C = P(os, qf);
        G.doors.push(item("line", "A-DOOR", "door-leaf", o.id, { a: H, b: E }));
        const aC = Math.atan2(C[1] - H[1], C[0] - H[0]) / DEG, aE = Math.atan2(E[1] - H[1], E[0] - H[0]) / DEG;
        const ccw = Math.abs(angleNorm(aE - aC) - 90) < 1e-6;
        G.doors.push(item("arc", "A-DOOR", "door-swing", o.id,
          { c: H, r: w, a0: angleNorm(ccw ? aC : aE), a1: angleNorm(ccw ? aE : aC), color: HP.COLORS.swing }));
        const entrance = entrances.size ? entrances.has(o.id) : (o.facing === "yard" || o.facing === "street");
        if (entrance) G.doors.push(item("line", "A-DOOR", "door-leaf", o.id, { a: P(s0, fr), b: P(s1, fr) }));
      }
    }

    // ---------------------------------------------------------- room labels + open-area hatch
    const swingBoxes = {};
    for (const r of rooms) {
      const list = (A.roomOpenings && A.roomOpenings[r.id]) || [];
      const bx = [];
      for (const o of list) {
        if (o.kind !== "door" || !o.swingInto) continue;
        const w = o.w || (o.s1 - o.s0);
        let b;
        if (o.side === "S") b = { x0: o.s0, y0: r.y, x1: o.s1, y1: r.y + w };
        else if (o.side === "N") b = { x0: o.s0, y0: r.y + r.h - w, x1: o.s1, y1: r.y + r.h };
        else if (o.side === "W") b = { x0: r.x, y0: o.s0, x1: r.x + w, y1: o.s1 };
        else b = { x0: r.x + r.w - w, y0: o.s0, x1: r.x + r.w, y1: o.s1 };
        bx.push({ x0: M(b.x0), y0: M(b.y0), x1: M(b.x1), y1: M(b.y1) });
      }
      swingBoxes[r.id] = bx;
    }
    const sectBoxes = [];                                  // a band round every section line
    if (opts.sections)
      for (const s of plan.sections || []) {
        const e = 0.08;
        sectBoxes.push({ x0: M(Math.min(s.a[0], s.b[0])) - e, y0: M(Math.min(s.a[1], s.b[1])) - e,
          x1: M(Math.max(s.a[0], s.b[0])) + e, y1: M(Math.max(s.a[1], s.b[1])) + e });
      }
    for (const r of rooms) {
      const x0 = M(r.x), y0 = M(r.y), x1 = M(r.x + r.w), y1 = M(r.y + r.h);
      const open = r.roofed === false || r.type === "open";
      let holes = [];
      if (opts.labels) {
        const subs = [];
        if (!open) subs.push({ text: HP.fmtArea(r.area != null ? r.area : r.w * r.h) + " m\u00b2", h: SIZES.area, role: "room-area" });
        if (opts.sizes) subs.push({ text: HP.fmtM(r.w) + " x " + HP.fmtM(r.h), h: SIZES.size, role: "room-size" });
        const pad = SIZES.labelPad;
        const W = Math.max(0.2, x1 - x0 - 2 * pad), H = Math.max(0.2, y1 - y0 - 2 * pad);
        const name = String(r.name || "").toUpperCase();
        /* the spot nearest the middle that is clear of furniture, door swings
           and section lines; if the whole label finds none, the size line goes,
           then the area line, and the name alone takes the least crowded spot */
        const roomBox = { x0, y0, x1, y1 };
        const hard = (furnBoxes[r.id] || []).concat(swingBoxes[r.id] || []);   // may cost the small lines
        const soft = sectBoxes.filter(b => boxOverlap(b, roomBox));            // only moves the label
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        let lab = fitLabel(name, subs, W, H), cx = mx, cy = my;
        if (hard.length || soft.length) {
          const over = (list, b) => {
            let t = 0;
            for (const o of list) if (boxOverlap(o, b))
              t += (Math.min(o.x1, b.x1) - Math.max(o.x0, b.x0)) * (Math.min(o.y1, b.y1) - Math.max(o.y0, b.y0));
            return t;
          };
          // smaller first, fewer lines last: the area under the name is the drafting style
          const noSize = subs.filter(s => s.role !== "room-size");
          const variants = [[subs, 1], [subs, 0.8], [subs, 0.65], [noSize, 0.65], [[], 0.65]];
          let placed = false, last = null;
          for (let vi = 0; vi < variants.length && !placed; vi++) {
            const [vs, vk] = variants[vi];
            if (vi > 0 && vs.length === variants[vi - 1][0].length && vk === variants[vi - 1][1]) continue;
            const L = vi === 0 ? lab : fitLabel(name, vs, W, H, vk);
            const hw = L.w / 2 + 0.05, hh = L.h / 2 + 0.05;
            const rx = Math.max(0, (x1 - x0) / 2 - pad - hw), ry = Math.max(0, (y1 - y0) / 2 - pad - hh);
            const cands = [[mx, my, 0]];
            const n = 5;
            for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
              if (!i && !j) continue;
              const px = mx + rx * i / n, py = my + ry * j / n;
              cands.push([px, py, (px - mx) ** 2 + (py - my) ** 2]);
            }
            cands.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
            // nearest the middle among the spots clear of furniture, least on a section line
            let best = null, bh = Infinity, bs = Infinity;
            for (const c of cands) {
              const b = { x0: c[0] - hw, y0: c[1] - hh, x1: c[0] + hw, y1: c[1] + hh };
              const kh = over(hard, b), ks = over(soft, b);
              if (kh < bh - 1e-9 || (Math.abs(kh - bh) <= 1e-9 && ks < bs - 1e-9)) { best = c; bh = kh; bs = ks; }
              if (bh === 0 && bs === 0) break;
            }
            last = { L, best };
            if (bh === 0) { lab = L; cx = best[0]; cy = best[1]; placed = true; }
          }
          if (!placed && last) { lab = last.L; cx = last.best[0]; cy = last.best[1]; }
        }
        for (const l of placeLines(lab, cx, cy))
          G.text.push(item("text", "A-ANNO-TEXT", l.role, r.id, { p: l.p, h: l.h, text: l.text, align: "mc", rot: 0, w: l.w }));
        const m = SIZES.yardMinHole + 0.04;
        const hb = { x0: cx - lab.w / 2 - m, y0: cy - lab.h / 2 - m, x1: cx + lab.w / 2 + m, y1: cy + lab.h / 2 + m };
        if (hb.x0 > x0 && hb.x1 < x1 && hb.y0 > y0 && hb.y1 < y1) holes = [rectLoop(hb.x0, hb.y0, hb.x1, hb.y1)];
      }
      if (open)
        G.open.push(item("hatch", "A-OPEN-PATT", "open-hatch", r.id,
          { pattern: HATCH.open.pattern, scale: HATCH.open.scale, angle: HATCH.open.angle, loops: [rectLoop(x0, y0, x1, y1)].concat(holes) }));
    }

    // ---------------------------------------------------------- dimensions
    const bb = A.bbox || null;
    const plotBox = plotPts.length ? {
      x0: Math.min(...plotPts.map(p => p[0])), y0: Math.min(...plotPts.map(p => p[1])),
      x1: Math.max(...plotPts.map(p => p[0])), y1: Math.max(...plotPts.map(p => p[1])),
    } : null;
    const rectPlotAxis = plotPts.length === 4 && plotPts.every((p, i) => {
      const q = plotPts[(i + 1) % 4]; return p[0] === q[0] || p[1] === q[1];
    });
    const lanesOut = { S: false, N: false, W: false, E: false };   // chains outside the land on that side
    const reach = { S: 0, N: 0, W: 0, E: 0 };                       // how far dims stand out past the land (m)
    if (opts.dims && bb && rooms.length) {
      for (const side of ["S", "N", "W", "E"]) {
        const pr = sideProfile(rooms, ext, int, side, bb);
        const alongX = pr.alongX, front = pr.front;
        const face = side === "S" ? bb.y0 : side === "N" ? bb.y1 : side === "W" ? bb.x0 : bb.x1;
        const pface = !plotBox ? face : side === "S" ? plotBox.y0 : side === "N" ? plotBox.y1 : side === "W" ? plotBox.x0 : plotBox.x1;
        const depth = plotPts.length >= 3 ? yardDepth(plotPts, side, bb) : Infinity;
        const inside = depth >= SIZES.laneNeed * 100;
        lanesOut[side] = !inside;
        const base = inside ? face : (front < 0 ? Math.min(face, pface) : Math.max(face, pface));
        const lane = k => M(base) + front * (SIZES.lane0 + k * SIZES.laneStep);
        if (!inside) reach[side] = Math.max(reach[side], SIZES.lane0 + SIZES.laneStep + DIM.gap + DIM.text);
        const P = alongX ? (p, q) => [p, q] : (p, q) => [q, p];
        const rot = alongX ? 0 : 90;
        const v = alongX ? [0, 1] : [-1, 0];                          // the side the text stands on
        // chain 1: walls and rooms seen from this side
        const segs = pr.segs;
        const faceAt = i => {                                          // q of the tick between seg i-1 and i
          const fs = [segs[i - 1], segs[i]].filter(s => s && s.face != null).map(s => s.face);
          return fs.length ? (front < 0 ? Math.min(...fs) : Math.max(...fs)) : face;
        };
        const chain1 = [];
        segs.forEach((s, i) => {
          const qa = faceAt(i), qb = faceAt(i + 1);
          chain1.push({ a: P(M(s.a), M(qa)), b: P(M(s.b), M(qb)), len: s.b - s.a, small: s.kind === "wall", ref: s.ref });
        });
        // chain 2: the overall length, with the distances to the land where the land is a plain rectangle
        const p0 = alongX ? bb.x0 : bb.y0, p1 = alongX ? bb.x1 : bb.y1;
        const chain2 = [{ a: P(M(p0), M(faceAt(0))), b: P(M(p1), M(faceAt(segs.length))), len: p1 - p0, small: false, ref: null }];
        if (rectPlotAxis && plotBox) {
          const P0 = alongX ? plotBox.x0 : plotBox.y0, P1 = alongX ? plotBox.x1 : plotBox.y1;
          if (p0 > P0) chain2.unshift({ a: P(M(P0), M(face)), b: P(M(p0), M(faceAt(0))), len: p0 - P0, small: false, ref: null });
          if (P1 > p1) chain2.push({ a: P(M(p1), M(faceAt(segs.length))), b: P(M(P1), M(face)), len: P1 - p1, small: false, ref: null });
        }
        [chain1, chain2].forEach((chain, k) => {
          const q = lane(k);
          let prevEnd = -Infinity, prevFlip = false;
          for (const c of chain) {
            const dm = item("dim", "A-ANNO-DIMS", "dim", c.ref, {
              a: c.a, b: c.b, d: P(alongX ? c.a[0] : c.a[1], q), rot, text: HP.fmtM(c.len), small: c.small,
              h: c.small ? DIM.small : DIM.text, chain: side + (k + 1),
            });
            // text boxes along the chain must not run into each other: flip to the other side
            const m0 = alongX ? Math.min(c.a[0], c.b[0]) : Math.min(c.a[1], c.b[1]);
            const m1 = alongX ? Math.max(c.a[0], c.b[0]) : Math.max(c.a[1], c.b[1]);
            const mid = (m0 + m1) / 2, tw = textWidth(dm.text, dm.h);
            let flip = false;
            if (mid - tw / 2 < prevEnd + 0.03 && !prevFlip) {
              flip = true;
              const off = DIM.gap + dm.h / 2;                         // the other side of the line
              dm.tp = alongX ? [mid, q - v[1] * off] : [q - v[0] * off, mid];
            }
            prevEnd = mid + tw / 2; prevFlip = flip;
            G.dims.push(dm);
          }
        });
      }
    }

    // ---------------------------------------------------------- land, street, plot dims
    if (opts.site && plotPts.length >= 3) {
      const pm = plotPts.map(p => [M(p[0]), M(p[1])]);
      G.site.push(item("pline", "A-PLOT", "plot", null, { pts: pm, closed: true }));
      const yl = loopsM(A.yard && A.yard.loops);
      const n = pm.length;
      const edges = (plan.plot.edges || []);
      const R = M(plan.plot.road || 0);
      // plot edge dimensions first: the street label must keep clear of them
      const edgeDimReach = [];
      for (let i = 0; i < n; i++) {
        const p = pm[i], q = pm[(i + 1) % n];
        const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy);
        edgeDimReach[i] = 0;
        if (L < 1e-9) continue;
        const nrm = [dy / L, -dx / L];                                    // outward (pts are CCW)
        const side = Math.abs(nrm[0]) > Math.abs(nrm[1]) ? (nrm[0] > 0 ? "E" : "W") : (nrm[1] > 0 ? "N" : "S");
        // past the house's chains only when it is a straight edge on the land's outer face on that side
        const P0 = plotPts[i], Q0 = plotPts[(i + 1) % n];                // cm, like plotBox
        const onFace = plotBox && (side === "S" ? P0[1] === plotBox.y0 && Q0[1] === plotBox.y0 : side === "N" ? P0[1] === plotBox.y1 && Q0[1] === plotBox.y1
          : side === "W" ? P0[0] === plotBox.x0 && Q0[0] === plotBox.x0 : P0[0] === plotBox.x1 && Q0[0] === plotBox.x1);
        const off = SIZES.lane0 + (lanesOut[side] && onFace ? 2 * SIZES.laneStep : 0);
        if (!opts.dims) continue;
        // the house's overall chain already says the same thing on the same line: skip it
        if (lanesOut[side] && bb && rooms.length && (dx === 0 || dy === 0)) {
          const along = dy === 0;
          const lo = along ? Math.min(p[0], q[0]) : Math.min(p[1], q[1]), hi = along ? Math.max(p[0], q[0]) : Math.max(p[1], q[1]);
          const hlo = M(along ? bb.x0 : bb.y0), hhi = M(along ? bb.x1 : bb.y1);
          if (Math.abs(lo - hlo) < 1e-9 && Math.abs(hi - hhi) < 1e-9) { edgeDimReach[i] = reach[side]; continue; }
        }
        const rot = readable(Math.atan2(dy, dx) / DEG);
        const mid = [(p[0] + q[0]) / 2 + nrm[0] * off, (p[1] + q[1]) / 2 + nrm[1] * off];
        const lenCm = Math.round(Math.hypot(plotPts[(i + 1) % n][0] - plotPts[i][0], plotPts[(i + 1) % n][1] - plotPts[i][1]));
        G.dims.push(item("dim", "A-ANNO-DIMS", "plot-dim", null, {
          a: p, b: q, d: mid, rot, text: HP.fmtM(lenCm), small: false, h: DIM.text, chain: "plot" + i,
        }));
        edgeDimReach[i] = off + DIM.gap + DIM.text;
      }
      // the street: a road band outside every street edge
      for (let i = 0; i < n; i++) {
        if (edges[i] !== "street" || R <= 0) continue;
        const p = pm[i], q = pm[(i + 1) % n];
        const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy);
        if (L < 1e-9) continue;
        const u = [dx / L, dy / L], nrm = [u[1], -u[0]];
        const run = SIZES.roadRun;
        const at = (s, off) => [p[0] + u[0] * s + nrm[0] * off, p[1] + u[1] * s + nrm[1] * off];
        // the pavement is widened so no kerb line runs between dimension lanes standing on the street
        let walk = Math.min(SIZES.roadWalk, R / 4);
        if (edgeDimReach[i] && edgeDimReach[i] + 0.25 > walk && edgeDimReach[i] + 0.25 < R / 2 - SIZES.roadText) walk = edgeDimReach[i] + 0.25;
        for (const off of [walk, R - walk, R])
          G.site.push(item("line", "A-ROAD", "road", "edge" + i, { a: at(-run, off), b: at(L + run, off) }));
        // the label sits on the centre line unless the dimensions reach that far
        const th = SIZES.roadText, tw = textWidth("STREET", th);
        const need = (edgeDimReach[i] || 0) + 0.3 + th / 2;
        const off = Math.max(R / 2, need);
        const rot = readable(Math.atan2(dy, dx) / DEG);
        const lp = at(L / 2, off);
        if (off === R / 2) {
          const g = tw / 2 + 0.3;
          G.site.push(item("line", "A-ROAD", "road", "edge" + i, { a: at(-run, R / 2), b: at(L / 2 - g, R / 2), ltype: "DASHED" }));
          G.site.push(item("line", "A-ROAD", "road", "edge" + i, { a: at(L / 2 + g, R / 2), b: at(L + run, R / 2), ltype: "DASHED" }));
        } else {
          G.site.push(item("line", "A-ROAD", "road", "edge" + i, { a: at(-run, R / 2), b: at(L + run, R / 2), ltype: "DASHED" }));
        }
        G.text.push(item("text", "A-ROAD", "road-label", "edge" + i, { p: lp, h: th, text: "STREET", align: "mc", rot, w: tw }));
      }
      // the yard: grass, with the dimension texts that stand on it cut out
      if (yl.length) {
        const holes = [];
        const fp = loopsM(A.footprint && A.footprint.loops);
        const okBox = b => {
          const cs = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
          if (!cs.every(c => inRegion(c, yl))) return false;
          for (const l of yl.concat(fp)) for (const v of l) if (v[0] > b.x0 && v[0] < b.x1 && v[1] > b.y0 && v[1] < b.y1) return false;
          return !holes.some(h => boxOverlap(h, b));
        };
        for (const dm of G.dims) {
          const g = dimGeometry(dm);
          const tw = textWidth(dm.text, g.text.h) / 2 + SIZES.yardMinHole, thh = g.text.h / 2 + SIZES.yardMinHole;
          const vert = Math.abs(Math.abs(readable(dm.rot)) - 90) < 1e-6;
          if (!vert && Math.abs(readable(dm.rot)) > 1e-6) continue;
          const [px, py] = g.text.p;
          const b = vert ? { x0: px - thh, y0: py - tw, x1: px + thh, y1: py + tw } : { x0: px - tw, y0: py - thh, x1: px + tw, y1: py + thh };
          if (okBox(b)) holes.push(b);
        }
        G.yard.push(item("hatch", "A-SITE-PATT", "yard-hatch", null, {
          pattern: HATCH.yard.pattern, scale: HATCH.yard.scale, angle: HATCH.yard.angle,
          loops: yl.concat(holes.map(b => rectLoop(b.x0, b.y0, b.x1, b.y1))),
        }));
      }
    }

    // ---------------------------------------------------------- sections
    if (opts.sections) {
      for (const s of plan.sections || []) {
        const a = [M(s.a[0]), M(s.a[1])], b = [M(s.b[0]), M(s.b[1])];
        const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
        if (L < 1e-9) continue;
        const U = [dx / L, dy / L];
        const look = s.look === -1 ? -1 : 1;
        const Lk = [-U[1] * look, U[0] * look];                     // +1 looks to the left of a->b
        const hv = Math.min(SIZES.sectHeavy, L / 4);
        const r = SIZES.sectR;
        const label = String(s.label == null ? "" : s.label).toUpperCase();
        G.sect.push(item("line", "A-SECT", "section", s.id, { a, b, lw: 0.18 }));
        for (const [end, out] of [[a, [-U[0], -U[1]]], [b, U]]) {
          const inner = [end[0] - out[0] * hv, end[1] - out[1] * hv];
          G.sect.push(item("pline", "A-SECT", "section", s.id, { pts: [inner, end], closed: false, width: SIZES.sectWidth, lw: 0.7, ltype: "CONTINUOUS" }));
          const c = [end[0] + out[0] * r, end[1] + out[1] * r];
          G.sect.push(item("circle", "A-SECT", "section", s.id, { c, r, ltype: "CONTINUOUS", lw: 0.35 }));
          // the arrow: a solid point whose sides touch the circle, aimed the way the section looks
          const ap = [c[0] + Lk[0] * 2 * r, c[1] + Lk[1] * 2 * r];
          const k = Math.cos(60 * DEG) * r, w = Math.sin(60 * DEG) * r;
          const t1 = [c[0] + Lk[0] * k + out[0] * w, c[1] + Lk[1] * k + out[1] * w];
          const t2 = [c[0] + Lk[0] * k - out[0] * w, c[1] + Lk[1] * k - out[1] * w];
          G.sect.push(item("hatch", "A-SECT", "section", s.id, { pattern: "SOLID", scale: 1, angle: 0, loops: [[ap, t1, t2]] }));
          if (label) G.sect.push(item("text", "A-SECT", "section-label", s.id, { p: c, h: SIZES.sectText, text: label, align: "mc", rot: 0, w: textWidth(label, SIZES.sectText) }));
        }
      }
    }

    items.push(...G.yard, ...G.open, ...G.wallHatch, ...G.site, ...G.walls, ...G.glaz, ...G.doors,
      ...G.furn, ...G.text, ...G.dims, ...G.sect);
    return { items, blocks, extents: extentsOf(items, blocks) };
  }

  // ---------------------------------------------------------------- blocks
  const blockCache = typeof WeakMap !== "undefined" ? new WeakMap() : null;
  function blockToMetres(B) {
    if (blockCache && blockCache.has(B)) return blockCache.get(B);
    const P = p => [M(p[0]), M(p[1])];
    const conv = it => {
      const o = Object.assign({}, it);
      if (it.pts) o.pts = it.pts.map(P);
      if (it.a) o.a = P(it.a);
      if (it.b) o.b = P(it.b);
      if (it.c) o.c = P(it.c);
      if (it.p) o.p = P(it.p);
      if (it.r != null) o.r = M(it.r);
      if (it.h != null && it.kind === "text") o.h = M(it.h);
      if (it.loops) o.loops = it.loops.map(l => l.map(P));
      if (it.kind === "hatch" && it.scale != null && String(it.pattern).toUpperCase() !== "SOLID") o.scale = it.scale / 100;
      if (it.width != null) o.width = M(it.width);
      return o;
    };
    const out = { layer: B.layer || "A-FURN", w: M(B.w || 0), h: M(B.h || 0), items: (B.items || []).map(conv) };
    if (blockCache) blockCache.set(B, out);
    return out;
  }

  // ---------------------------------------------------------------- extents
  function extentsOf(items, blocks) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    const bboxCache = {};
    const blockBox = name => {
      if (bboxCache[name]) return bboxCache[name];
      const b = blocks[name];
      const e = b ? extentsOf(b.items, {}) : null;
      return (bboxCache[name] = e);
    };
    for (const it of items) {
      switch (it.kind) {
        case "pline": for (const p of it.pts) add(p[0], p[1]); break;
        case "line": add(it.a[0], it.a[1]); add(it.b[0], it.b[1]); break;
        case "circle": case "arc": add(it.c[0] - it.r, it.c[1] - it.r); add(it.c[0] + it.r, it.c[1] + it.r); break;
        case "hatch": for (const l of it.loops) for (const p of l) add(p[0], p[1]); break;
        case "text": {
          const w = (it.w != null ? it.w : textWidth(it.text, it.h)) / 2 + it.h, hh = it.h;
          const r = Math.max(w, hh);
          add(it.p[0] - r, it.p[1] - r); add(it.p[0] + r, it.p[1] + r); break;
        }
        case "dim": {
          const g = dimGeometry(it);
          for (const l of g.lines) { add(l[0][0], l[0][1]); add(l[1][0], l[1][1]); }
          const r = textWidth(it.text, g.text.h) / 2;
          add(g.text.p[0] - r, g.text.p[1] - r); add(g.text.p[0] + r, g.text.p[1] + r);
          break;
        }
        case "insert": {
          const e = blockBox(it.block);
          if (!e) { add(it.p[0], it.p[1]); break; }
          const c = Math.cos((it.rot || 0) * DEG), s = Math.sin((it.rot || 0) * DEG), sx = it.sx === -1 ? -1 : 1;
          for (const [lx, ly] of [[e.x0, e.y0], [e.x1, e.y0], [e.x1, e.y1], [e.x0, e.y1]]) {
            const X = sx * lx; add(it.p[0] + X * c - ly * s, it.p[1] + X * s + ly * c);
          }
          break;
        }
      }
    }
    if (!(x0 <= x1)) return { x0: 0, y0: 0, x1: 1, y1: 1 };
    return { x0, y0, x1, y1 };
  }

  HP.drawing = {
    build, dimGeometry, patternLines, textWidth, extentsOf,
    PATTERNS, HATCH, SIZES, DIM, LTYPES, CAP,
  };
})(globalThis.HP = globalThis.HP || {});

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.HP;
