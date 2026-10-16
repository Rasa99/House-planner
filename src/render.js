"use strict";
/* ============================================================================
   House Planner - render.js  (canvas agent)
   ----------------------------------------------------------------------------
   HP.render.draw(ctx, drawing, view, opts) paints the drawing primitives of
   HP.drawing.build() (METRES, y up) on a canvas.

     view = { scale (px per metre), ox, oy (screen px of world 0,0),
              dpr (device pixels per css px, default 1), w, h (css px) }
     opts = { background  false = do not paint the #0f1620 background
              tints       [{x, y, w, h (metres), color}]  faint room tints under the drawing
              highlight   Set|Array of refs - strong cyan glow (selection, flash)
              hover       ref | Set|Array of refs - soft cyan glow
              labels      {} - filled with { ref: {x0,y0,x1,y1} } screen boxes of each
                          room's name/area/size texts (the canvas uses them as grab handles)
              font        css font family for texts }
     returns { ms, items }

   Speed: everything that does not depend on the zoom is compiled ONCE per
   drawing object (WeakMap) into Path2D batches in world metres; a frame then
   only sets a transform and strokes. Furniture INSERTs are compiled per block
   and copied into the batches with Path2D.addPath(path, matrix).
   Hatches: ANSI31 = 45 degree lines in world units (a flat translucent fill when
   they would be closer than ~2.5 px), DOTS / GRASS = a tile pattern sized to the
   zoom (flat fill when tiny), SOLID = a fill. Lines keep a constant pixel width
   (mapped from the layer lineweight), dash patterns scale with the zoom.
============================================================================ */
(function (HP) {
  const DEG = Math.PI / 180;
  const BG = "#0f1620";
  const GLOW = "#46e0f0";
  const GLOW_SHADOW = "rgba(40, 214, 236, 0.95)";
  const FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';
  const MONO = '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace';
  const FALLBACK_LAYER = { color: "#c8d0dc", ltype: "CONTINUOUS", lw: 0.18 };

  /* Linetypes in METRES (they scale with the zoom). Dash, gap, dash, gap ... */
  const DASH = {
    DASHED: [0.30, 0.15],
    HIDDEN: [0.15, 0.08],
    DASHDOT: [0.60, 0.12, 0.06, 0.12],
    CENTER: [0.90, 0.12, 0.15, 0.12],
    PHANTOM: [0.90, 0.10, 0.12, 0.10, 0.12, 0.10],
    DOT: [0.01, 0.10],
  };

  /* Hatch pattern period in drawing units for scale 1 (acadiso.pat, mm based:
     ANSI31 line spacing 3.175, DOTS 1.5875, GRASS tufts every 25.4).
     spacing = base * item.scale, then clamped to a sane range in metres so a
     surprising scale never paints a solid block or nothing at all.          */
  const HATCH_BASE = { ANSI31: 3.175, DOTS: 1.5875, GRASS: 25.4 };
  const HATCH_RANGE = { ANSI31: [0.02, 0.6], DOTS: [0.05, 0.8], GRASS: [0.10, 1.5] };
  const HATCH_DEFAULT = { ANSI31: 0.07, DOTS: 0.20, GRASS: 0.30 };   // when scale is missing

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ------------------------------------------------------------------ styles
  function layerOf(name) {
    return (HP.LAYERS && HP.LAYERS[name]) || FALLBACK_LAYER;
  }
  function styleOf(it, parentLayer) {
    const ln = (it.layer && it.layer !== "0") ? it.layer : (parentLayer || it.layer || "0");
    const L = layerOf(ln);
    return {
      layer: ln,
      color: it.color || L.color,
      lw: it.lw != null ? +it.lw : L.lw,
      ltype: String(it.ltype || L.ltype || "CONTINUOUS").toUpperCase(),
      width: +it.width || 0,             // constant-width polyline, metres (scales with the zoom)
    };
  }
  const styleKey = st => st.color + "|" + st.lw + "|" + st.ltype + "|" + st.width;
  const capOf = () => (HP.drawing && HP.drawing.CAP) || 0.716;   // text h is the CAP height

  /* lineweight (mm) -> css px; a gentle zoom factor makes lines a little
     heavier when zoomed in, like a plotted drawing seen up close            */
  function lwPx(lw, zf) {
    return clamp((lw || 0.18) * 4.4, 0.8, 2.8) * zf;
  }
  function zoomFactor(scale) { return clamp(Math.pow(scale / 45, 0.3), 0.8, 1.45); }

  // ------------------------------------------------------------------ geometry -> Path2D (world metres)
  function bulgeArc(p, a, b, bulge) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-12) return;
    const k = L * (1 - bulge * bulge) / (4 * bulge);
    const cx = (a[0] + b[0]) / 2 - dy / L * k, cy = (a[1] + b[1]) / 2 + dx / L * k;
    const r = L * (1 + bulge * bulge) / (4 * Math.abs(bulge));
    const a0 = Math.atan2(a[1] - cy, a[0] - cx), a1 = Math.atan2(b[1] - cy, b[0] - cx);
    p.arc(cx, cy, r, a0, a1, bulge < 0);
  }
  function addGeom(p, it) {
    switch (it.kind) {
      case "line":
        p.moveTo(it.a[0], it.a[1]); p.lineTo(it.b[0], it.b[1]);
        return true;
      case "pline": {
        const pts = it.pts;
        if (!pts || pts.length < 2) return false;
        const bl = it.bulges;
        p.moveTo(pts[0][0], pts[0][1]);
        const n = pts.length, segs = it.closed ? n : n - 1;
        for (let i = 0; i < segs; i++) {
          const a = pts[i], b = pts[(i + 1) % n], bu = bl ? (+bl[i] || 0) : 0;
          if (Math.abs(bu) > 1e-9) bulgeArc(p, a, b, bu);
          else p.lineTo(b[0], b[1]);
        }
        if (it.closed) p.closePath();
        return true;
      }
      case "arc": {
        const c = it.c, r = it.r, a0 = it.a0 * DEG, a1 = it.a1 * DEG;
        p.moveTo(c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0));
        p.arc(c[0], c[1], r, a0, a1, false);
        return true;
      }
      case "circle":
        p.moveTo(it.c[0] + it.r, it.c[1]);
        p.arc(it.c[0], it.c[1], it.r, 0, Math.PI * 2, false);
        p.closePath();
        return true;
    }
    return false;
  }
  function loopsPath(loops) {
    const p = new Path2D();
    const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const lp of loops || []) {
      if (!lp || lp.length < 3) continue;
      p.moveTo(lp[0][0], lp[0][1]);
      for (let i = 1; i < lp.length; i++) p.lineTo(lp[i][0], lp[i][1]);
      p.closePath();
      for (const q of lp) {
        if (q[0] < bb.x0) bb.x0 = q[0]; if (q[0] > bb.x1) bb.x1 = q[0];
        if (q[1] < bb.y0) bb.y0 = q[1]; if (q[1] > bb.y1) bb.y1 = q[1];
      }
    }
    return { path: p, bbox: bb };
  }
  function matrixOf(ins) {
    const r = (ins.rot || 0) * DEG, sx = ins.sx === -1 ? -1 : 1;
    const c = Math.cos(r), s = Math.sin(r);
    return { a: c * sx, b: s * sx, c: -s, d: c, e: ins.p[0], f: ins.p[1] };
  }

  // ------------------------------------------------------------------ blocks
  /* compiled block = Map(styleKey -> {st, stroke: Path2D|null, fill: Path2D|null})
     cached per block object and per the INSERT's layer (layer-0 items inherit it) */
  const blockMemo = new WeakMap();
  function compileBlock(block, insLayer) {
    let byLayer = blockMemo.get(block);
    if (!byLayer) { byLayer = new Map(); blockMemo.set(block, byLayer); }
    const key = insLayer || block.layer || "0";
    let g = byLayer.get(key);
    if (g) return g;
    g = new Map();
    const parent = block.layer && block.layer !== "0" && !insLayer ? block.layer : (insLayer || block.layer);
    for (const it of block.items || []) {
      const st = styleOf(it, parent);
      const k = styleKey(st);
      let e = g.get(k);
      if (!e) { e = { st, stroke: null, fill: null, fillAlpha: 1 }; g.set(k, e); }
      if (it.kind === "hatch") {
        if (!e.fill) e.fill = new Path2D();
        e.fill.addPath(loopsPath(it.loops).path);
        if (String(it.pattern).toUpperCase() !== "SOLID") e.fillAlpha = 0.35;
      } else {
        if (!e.stroke) e.stroke = new Path2D();
        addGeom(e.stroke, it);
      }
    }
    byLayer.set(key, g);
    return g;
  }

  // ------------------------------------------------------------------ compile a drawing
  const compiled = new WeakMap();
  function compile(drawing) {
    let c = compiled.get(drawing);
    if (c) return c;
    c = { batches: [], dims: [], texts: [], byRef: new Map(), refPaths: new Map(), drawing, count: 0 };
    let run = null;
    const runFor = () => {
      if (!run) { run = { k: "run", groups: new Map() }; c.batches.push(run); }
      return run;
    };
    const group = (st) => {
      const r = runFor(), k = styleKey(st);
      let g = r.groups.get(k);
      if (!g) { g = { st, stroke: null, fill: null, fillAlpha: 1 }; r.groups.set(k, g); }
      return g;
    };
    const blocks = drawing.blocks || {};
    for (const it of drawing.items || []) {
      c.count++;
      if (it.ref != null) {
        let l = c.byRef.get(it.ref);
        if (!l) { l = []; c.byRef.set(it.ref, l); }
        l.push(it);
      }
      switch (it.kind) {
        case "line": case "pline": case "arc": case "circle": {
          const g = group(styleOf(it));
          if (!g.stroke) g.stroke = new Path2D();
          addGeom(g.stroke, it);
          break;
        }
        case "insert": {
          const b = blocks[it.block];
          if (!b) break;
          const m = matrixOf(it);
          for (const e of compileBlock(b, it.layer).values()) {
            const g = group(e.st);
            if (e.stroke) { if (!g.stroke) g.stroke = new Path2D(); g.stroke.addPath(e.stroke, m); }
            if (e.fill) { if (!g.fill) g.fill = new Path2D(); g.fill.addPath(e.fill, m); g.fillAlpha = Math.min(g.fillAlpha, e.fillAlpha); }
          }
          break;
        }
        case "hatch": {
          const pat = String(it.pattern || "SOLID").toUpperCase();
          const lp = loopsPath(it.loops);
          if (pat === "SOLID") {           // a solid fill joins the current run (drawn under its strokes)
            const g = group(styleOf(it));
            if (!g.fill) g.fill = new Path2D();
            g.fill.addPath(lp.path);
          } else {
            run = null;                    // a patterned hatch is an area: keep the drawing order round it
            const st = styleOf(it);
            c.batches.push({ k: "hatch", pattern: pat, scale: it.scale, angle: +it.angle || 0,
                             color: st.color, path: lp.path, bbox: lp.bbox, role: it.role });
          }
          break;
        }
        case "text": c.texts.push(it); break;
        case "dim": c.dims.push(it); break;
      }
    }
    compiled.set(drawing, c);
    return c;
  }

  /* all stroke geometry (inserts included) carrying one ref, for the glow */
  function refPath(c, ref) {
    let rp = c.refPaths.get(ref);
    if (rp) return rp;
    const p = new Path2D(), texts = [];
    let any = false;
    for (const it of c.byRef.get(ref) || []) {
      if (it.kind === "text") { texts.push(it); continue; }
      if (it.kind === "insert") {
        const b = (c.drawing.blocks || {})[it.block];
        if (!b) continue;
        const m = matrixOf(it);
        for (const e of compileBlock(b, it.layer).values()) if (e.stroke) { p.addPath(e.stroke, m); any = true; }
        continue;
      }
      if (it.kind === "hatch" || it.kind === "dim") continue;
      if (addGeom(p, it)) any = true;
    }
    rp = { path: any ? p : null, texts };
    c.refPaths.set(ref, rp);
    return rp;
  }

  // ------------------------------------------------------------------ hatch tiles
  /* One square tile per (pattern, colour, size in device px, line width). Every
     pattern is anchored to the world origin, so it does not swim when panning.
     ANSI31 = one 45 degree line through two opposite tile corners (drawn three
     times so it wraps without a seam); DOTS = two staggered dots; GRASS = two
     little tufts like the old generator's yard.                               */
  const tileCache = new Map();
  function tile(ctx, pattern, color, P, lw) {
    const key = pattern + "|" + color + "|" + P + "|" + (lw || 0);
    let t = tileCache.get(key);
    if (t) return t;
    if (tileCache.size > 64) tileCache.clear();
    const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(P, P) : Object.assign(document.createElement("canvas"), { width: P, height: P });
    const g = cv.getContext("2d");
    g.strokeStyle = color; g.fillStyle = color;
    if (pattern === "ANSI31") {
      g.lineWidth = lw || 1;
      g.beginPath();
      for (const o of [-P, 0, P]) { g.moveTo(o - 1, P + 1); g.lineTo(o + P + 1, -1); }
      g.stroke();
    } else if (pattern === "ANSI31R") {
      g.lineWidth = lw || 1;
      g.beginPath();
      for (const o of [-P, 0, P]) { g.moveTo(o - 1, -1); g.lineTo(o + P + 1, P + 1); }
      g.stroke();
    } else if (pattern === "DOTS") {
      const d = Math.max(1.2, P * 0.11);
      g.fillRect(P * 0.2 - d / 2, P * 0.2 - d / 2, d, d);
      g.fillRect(P * 0.7 - d / 2, P * 0.7 - d / 2, d, d);
    } else if (pattern === "GRASS") {
      // two little tufts per tile, staggered: a tall middle blade and two leaning ones
      g.lineWidth = Math.max(1, P * 0.045); g.lineCap = "round";
      const tuft = (x, y, h) => {
        g.beginPath();
        g.moveTo(x, y); g.lineTo(x, y - h);
        g.moveTo(x - h * 0.12, y); g.lineTo(x - h * 0.5, y - h * 0.62);
        g.moveTo(x + h * 0.12, y); g.lineTo(x + h * 0.5, y - h * 0.62);
        g.stroke();
      };
      tuft(P * 0.27, P * 0.42, P * 0.26);
      tuft(P * 0.77, P * 0.92, P * 0.2);
    }
    t = ctx.createPattern(cv, "repeat");
    tileCache.set(key, t);
    return t;
  }
  function hatchSpacing(pattern, scale) {
    const base = HATCH_BASE[pattern];
    if (!base) return 0.2;
    const sp = scale > 0 ? base * scale : HATCH_DEFAULT[pattern];
    const r = HATCH_RANGE[pattern];
    return clamp(sp, r[0], r[1]);
  }

  // ------------------------------------------------------------------ the frame
  function draw(ctx, drawing, view, opts) {
    const t0 = performance.now();
    opts = opts || {};
    const dpr = view.dpr || opts.dpr || 1;
    const W = view.w || ctx.canvas.width / dpr, H = view.h || ctx.canvas.height / dpr;
    const s = view.scale, ox = view.ox, oy = view.oy;
    const font = opts.font || FONT;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
    ctx.setLineDash([]); ctx.lineCap = "butt"; ctx.lineJoin = "round";
    if (opts.background !== false) { ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H); }
    if (!drawing) return { ms: performance.now() - t0, items: 0 };
    const c = compile(drawing);
    const zf = zoomFactor(s);
    const vw = { x0: -ox / s, x1: (W - ox) / s, y0: (oy - H) / s, y1: oy / s };
    const world = () => ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * ox, dpr * oy);
    const scr = () => ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // faint room tints (screen only), beneath everything
    if (opts.tints && opts.tints.length) {
      ctx.globalAlpha = 0.085;
      for (const t of opts.tints) {
        ctx.fillStyle = t.color;
        ctx.fillRect(ox + t.x * s, oy - (t.y + t.h) * s, t.w * s, t.h * s);
      }
      ctx.globalAlpha = 1;
    }

    // geometry and hatches, in drawing order
    for (const b of c.batches) {
      if (b.k === "hatch") drawHatch(ctx, b, s, ox, oy, dpr, W, H, vw, zf, world);
      else drawRun(ctx, b, s, zf, world);
    }
    scr();
    ctx.setLineDash([]);

    // dimensions
    if (c.dims.length) drawDims(ctx, c, s, ox, oy, zf, font, W, H, world, scr);

    // texts
    const labels = opts.labels || null;
    for (const it of c.texts) drawText(ctx, it, s, ox, oy, font, W, H, labels, 1);

    // glow for the highlighted / hovered refs
    const hi = toSet(opts.highlight), hv = toSet(opts.hover);
    if (hi.size || hv.size) {
      for (const ref of hv) if (!hi.has(ref)) glow(ctx, c, ref, 0.55, 7, s, ox, oy, dpr, zf, world, scr, font, W, H);
      for (const ref of hi) glow(ctx, c, ref, 1, 12, s, ox, oy, dpr, zf, world, scr, font, W, H);
    }
    scr();
    ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.setLineDash([]);
    return { ms: performance.now() - t0, items: c.count };
  }

  function toSet(v) {
    if (!v) return new Set();
    if (v instanceof Set) return v;
    if (Array.isArray(v)) return new Set(v);
    return new Set([v]);
  }

  function drawRun(ctx, run, s, zf, world) {
    world();
    for (const g of run.groups.values()) {
      if (!g.fill) continue;
      ctx.globalAlpha = g.fillAlpha;
      ctx.fillStyle = g.st.color;
      ctx.fill(g.fill, "evenodd");
    }
    ctx.globalAlpha = 1;
    for (const g of run.groups.values()) {
      if (!g.stroke) continue;
      ctx.strokeStyle = g.st.color;
      ctx.lineWidth = Math.max(lwPx(g.st.lw, zf) / s, g.st.width);
      const d = DASH[g.st.ltype];
      if (d) {
        let sum = 0; for (const v of d) sum += v;
        ctx.setLineDash(sum * s >= 7 ? d : []);
      } else ctx.setLineDash([]);
      ctx.stroke(g.stroke);
    }
    ctx.setLineDash([]);
  }

  /* A hatch is ONE fill of its loops (even-odd) with a world-anchored tile
     pattern - no clipping, no per-line work - or with a flat translucent colour
     when the pattern would be too fine to see.                               */
  function drawHatch(ctx, b, s, ox, oy, dpr, W, H, vw, zf, world) {
    const bb = b.bbox;
    if (!(bb.x1 >= vw.x0 && bb.x0 <= vw.x1 && bb.y1 >= vw.y0 && bb.y0 <= vw.y1)) return;
    const pat = b.pattern;
    const sp = hatchSpacing(pat, b.scale);
    const spPx = sp * s;
    world();
    let style = b.color, alpha = 1, P = 0, T = 0;
    if (pat === "ANSI31") {
      if (spPx < 2.6) alpha = 0.42;
      else if (Math.abs(b.angle % 90) > 1e-6) { drawLines(ctx, b, sp, s, zf, vw); return; }
      else {
        P = Math.max(3, Math.round(spPx * Math.SQRT2 * dpr));   // horizontal period of 45 degree lines
        T = Math.min(P, 256);
        const flip = Math.abs(Math.round(b.angle / 90)) % 2 === 1;   // 90 / 270: lines the other way
        style = tile(ctx, flip ? "ANSI31R" : pat, b.color, T, Math.min(1.15, 0.85 * zf) * dpr * (T / P));
      }
    } else if (pat === "DOTS" || pat === "GRASS") {
      if (spPx < 1.6) alpha = pat === "DOTS" ? 0.16 : 0.13;
      else {
        // below a legible tile size the texture keeps a minimum screen size (it is a texture,
        // not a measurement)
        P = Math.max(Math.round((pat === "DOTS" ? 6 : 11) * dpr), Math.round(spPx * dpr));
        T = Math.min(P, 256);
        style = tile(ctx, pat, b.color, T, 0);
        if (pat === "GRASS") alpha = 0.9;
      }
    } else alpha = 0.3;
    if (P && style.setTransform) {
      // pattern space -> device: a tile of P device px, a corner on the world origin
      const k = P / T;
      const tx = ((dpr * ox) % P + P) % P, ty = ((dpr * oy) % P + P) % P;
      const ctm = new DOMMatrix([dpr * s, 0, 0, -dpr * s, dpr * ox, dpr * oy]);
      style.setTransform(ctm.inverse().multiply(new DOMMatrix([k, 0, 0, k, tx, ty])));
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = style;
    ctx.fill(b.path, "evenodd");
    ctx.globalAlpha = 1;
  }
  /* ANSI31 at an angle that is not a multiple of 90: real lines, clipped */
  function drawLines(ctx, b, sp, s, zf, vw) {
    const bb = b.bbox;
    const r = { x0: Math.max(bb.x0, vw.x0), x1: Math.min(bb.x1, vw.x1), y0: Math.max(bb.y0, vw.y0), y1: Math.min(bb.y1, vw.y1) };
    const th = (45 + b.angle) * DEG;
    const dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
    let k0 = Infinity, k1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const q of [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]) {
      const k = q[0] * nx + q[1] * ny, t = q[0] * dx + q[1] * dy;
      if (k < k0) k0 = k; if (k > k1) k1 = k; if (t < t0) t0 = t; if (t > t1) t1 = t;
    }
    const p = new Path2D();
    for (let k = Math.ceil(k0 / sp); k * sp <= k1; k++) {
      const bx = nx * k * sp, by = ny * k * sp;
      p.moveTo(bx + dx * t0, by + dy * t0); p.lineTo(bx + dx * t1, by + dy * t1);
    }
    ctx.save();
    ctx.clip(b.path, "evenodd");
    ctx.strokeStyle = b.color;
    ctx.lineWidth = Math.min(1.15, 0.85 * zf) / s;
    ctx.stroke(p);
    ctx.restore();
  }
  // ------------------------------------------------------------------ dimensions (the old generator's look)
  /* The geometry comes from HP.drawing.dimGeometry when it is there - the very
     lines, ticks and text spot dxf.js writes - so the screen and the DXF agree.
     Only two things are screen-only: the oblique ticks never shrink below ~4 px,
     and the text never gets smaller than a legible minimum.                   */
  const DIM_FALLBACK = { text: 0.18, small: 0.12, tick: 0.06, exo: 0.06, exe: 0.08, gap: 0.05 };
  function dimGeom(it) {
    if (HP.drawing && HP.drawing.dimGeometry) return HP.drawing.dimGeometry(it);
    const S = DIM_FALLBACK;
    const th = (+it.rot || 0) * DEG, u = [Math.cos(th), Math.sin(th)], v = [-u[1], u[0]];
    const proj = p => { const t = (p[0] - it.d[0]) * u[0] + (p[1] - it.d[1]) * u[1]; return [it.d[0] + u[0] * t, it.d[1] + u[1] * t]; };
    const pa = proj(it.a), pb = proj(it.b);
    const lines = [[pa, pb]];
    for (const [p, q] of [[it.a, pa], [it.b, pb]]) {
      const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy);
      if (L > S.exo) { const w = [dx / L, dy / L]; lines.push([[p[0] + w[0] * S.exo, p[1] + w[1] * S.exo], [q[0] + w[0] * S.exe, q[1] + w[1] * S.exe]]); }
    }
    const k = [(u[0] + v[0]) * S.tick, (u[1] + v[1]) * S.tick];
    const ticks = [pa, pb].map(p => [[p[0] - k[0], p[1] - k[1]], [p[0] + k[0], p[1] + k[1]]]);
    const h = it.h || (it.small ? S.small : S.text);
    const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    const tp = it.tp || [mid[0] + v[0] * (S.gap + h / 2), mid[1] + v[1] * (S.gap + h / 2)];
    return { pa, pb, lines, ticks, measure: Math.hypot(pb[0] - pa[0], pb[1] - pa[1]), text: { p: tp, h, rot: +it.rot || 0, text: it.text, align: "mc" } };
  }
  /* compiled once per drawing: dimension + extension lines as one world path per colour,
     ticks and texts kept as data for the per-frame screen work */
  function compileDims(c) {
    if (c.dimc) return c.dimc;
    const byColor = new Map(), ticks = [], texts = [];
    const L = layerOf("A-ANNO-DIMS");
    for (const it of c.dims) {
      let g;
      try { g = dimGeom(it); } catch (e) { continue; }
      const color = it.color || L.color;
      let e = byColor.get(color);
      if (!e) { e = { color, path: new Path2D(), bb: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity } }; byColor.set(color, e); }
      for (const ln of g.lines) {
        e.path.moveTo(ln[0][0], ln[0][1]); e.path.lineTo(ln[1][0], ln[1][1]);
      }
      for (const t of g.ticks) ticks.push({ color, c: [(t[0][0] + t[1][0]) / 2, (t[0][1] + t[1][1]) / 2], d: [(t[1][0] - t[0][0]) / 2, (t[1][1] - t[0][1]) / 2] });
      if (it.text) texts.push({ it, p: g.text.p, h: g.text.h, rot: g.text.rot, measure: g.measure, small: !!it.small, color: it.textColor || L.text || "#8fe6f0" });
    }
    c.dimc = { byColor, ticks, texts };
    return c.dimc;
  }
  function drawDims(ctx, c, s, ox, oy, zf, font, W, H, world, scr) {
    const dc = compileDims(c);
    world();
    ctx.lineWidth = Math.min(1.25, 0.95 * zf) / s;
    for (const e of dc.byColor.values()) { ctx.strokeStyle = e.color; ctx.stroke(e.path); }
    scr();
    // ticks in screen space so they stay visible when zoomed out
    const tp = new Map();
    for (const t of dc.ticks) {
      const cx = ox + t.c[0] * s, cy = oy - t.c[1] * s;
      if (cx < -20 || cx > W + 20 || cy < -20 || cy > H + 20) continue;
      let dx = t.d[0] * s, dy = -t.d[1] * s;
      const L = Math.hypot(dx, dy), min = 4.2 * Math.min(zf, 1.15);
      if (L < min && L > 0) { dx *= min / L; dy *= min / L; }
      let p = tp.get(t.color);
      if (!p) { p = new Path2D(); tp.set(t.color, p); }
      p.moveTo(cx - dx, cy - dy); p.lineTo(cx + dx, cy + dy);
    }
    ctx.lineWidth = Math.min(1.6, 1.25 * zf);
    for (const [color, p] of tp) { ctx.strokeStyle = color; ctx.stroke(p); }
    // texts: never upside down, never below a legible size
    const cap = capOf();
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    for (const t of dc.texts) {
      const x = ox + t.p[0] * s, y = oy - t.p[1] * s;
      if (x < -60 || x > W + 60 || y < -60 || y > H + 60) continue;
      let px = t.h / cap * s;
      px = Math.max(px, t.small ? 5.5 : 7);
      const lenPx = t.measure * s;
      if (t.small && px * 1.6 > lenPx + 14) continue;          // a wall-thickness text with no room left
      ctx.font = (t.small ? "500 " : "600 ") + px.toFixed(2) + "px " + font;
      ctx.fillStyle = t.color;
      let rot = ((t.rot % 360) + 360) % 360;
      if (rot > 90 && rot <= 270) rot -= 180; else if (rot > 270) rot -= 360;
      if (rot) { ctx.save(); ctx.translate(x, y); ctx.rotate(-rot * DEG); ctx.fillText(t.it.text, 0, 0); ctx.restore(); }
      else ctx.fillText(t.it.text, x, y);
    }
  }

  // ------------------------------------------------------------------ texts
  const ROLE_STYLE = {
    "room-name": { weight: 650, upper: true, spacing: 0.07, alpha: 1 },
    "room-area": { weight: 500, upper: false, spacing: 0.01, alpha: 0.72 },
    "room-size": { weight: 500, upper: false, spacing: 0, alpha: 0.8, mono: true },
    "road-label": { weight: 600, upper: true, spacing: 0.45, alpha: 0.9, nofit: true },
    "section-label": { weight: 700, upper: true, spacing: 0, alpha: 1 },
  };
  const LABEL_ROLES = { "room-name": 1, "room-area": 1, "room-size": 1 };
  const FLIP_ALIGN = { ml: "mr", mr: "ml", bc: "tc", tc: "bc", bl: "tr", tr: "bl", mc: "mc", tl: "br", br: "tl" };

  function drawText(ctx, it, s, ox, oy, font, W, H, labels, alpha) {
    let px = (+it.h || 0.2) / capOf() * s;
    if (px < 3.5 || !it.text) return;
    const x = ox + it.p[0] * s, y = oy - it.p[1] * s;
    if (x < -400 || x > W + 400 || y < -100 || y > H + 100) return;
    const rs = ROLE_STYLE[it.role] || { weight: 500, upper: false, spacing: 0, alpha: 1 };
    let rot = +it.rot || 0;
    let align = it.align || "mc";
    rot = ((rot % 360) + 360) % 360;
    if (rot > 90 && rot <= 270) { rot -= 180; align = FLIP_ALIGN[align] || align; }   // never upside down
    else if (rot > 270) rot -= 360;
    const text = rs.upper ? String(it.text).toUpperCase() : String(it.text);
    const fam = rs.mono ? MONO : font;
    ctx.font = rs.weight + " " + px.toFixed(2) + "px " + fam;
    let ls = rs.spacing * px;
    const hasLS = "letterSpacing" in ctx;
    if (hasLS) ctx.letterSpacing = ls.toFixed(2) + "px";
    let mw = ctx.measureText(text).width;
    // keep to the width the drawing laid the text out for (it fitted the label to the room)
    const target = it.w > 0 && !rs.nofit ? it.w * s : 0;
    if (target && mw > target * 1.04) {
      if (ls && hasLS) { ls = 0; ctx.letterSpacing = "0px"; mw = ctx.measureText(text).width; }
      if (mw > target * 1.04) {
        px *= target * 1.02 / mw;
        ctx.font = rs.weight + " " + px.toFixed(2) + "px " + fam;
        mw = ctx.measureText(text).width;
      }
    }
    const v = align[0], h = align[1] || "c";
    ctx.textAlign = h === "l" ? "left" : h === "r" ? "right" : "center";
    ctx.textBaseline = v === "m" ? "middle" : v === "t" ? "top" : "alphabetic";
    ctx.fillStyle = it.color || layerOf(it.layer).color;
    ctx.globalAlpha = rs.alpha * (alpha == null ? 1 : alpha);
    if (rot) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(-rot * DEG); ctx.fillText(text, 0, 0); ctx.restore();
    } else ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
    if (labels && LABEL_ROLES[it.role] && it.ref != null) {
      const w = mw;
      let x0 = h === "l" ? x : h === "r" ? x - w : x - w / 2;
      let y0 = v === "m" ? y - px * 0.6 : v === "t" ? y : y - px * 0.85;
      let bw = w, bh = px * 1.2;
      if (Math.abs(Math.abs(rot) - 90) < 1) {          // a turned label: swap the box round its anchor
        const cx = x0 + bw / 2 - x, cy = y0 + bh / 2 - y;
        const sgn = rot > 0 ? -1 : 1;
        const ncx = x - sgn * cy, ncy = y + sgn * cx;
        [bw, bh] = [bh, bw]; x0 = ncx - bw / 2; y0 = ncy - bh / 2;
      }
      const b = labels[it.ref];
      if (!b) labels[it.ref] = { x0, y0, x1: x0 + bw, y1: y0 + bh };
      else { b.x0 = Math.min(b.x0, x0); b.y0 = Math.min(b.y0, y0); b.x1 = Math.max(b.x1, x0 + bw); b.y1 = Math.max(b.y1, y0 + bh); }
    }
    if (hasLS) ctx.letterSpacing = "0px";
  }
  // ------------------------------------------------------------------ glow
  function glow(ctx, c, ref, strength, blur, s, ox, oy, dpr, zf, world, scr, font, W, H) {
    const rp = refPath(c, ref);
    ctx.save();
    ctx.shadowColor = GLOW_SHADOW;
    ctx.shadowBlur = blur * dpr;
    ctx.globalAlpha = strength;
    if (rp.path) {
      world();
      ctx.strokeStyle = GLOW;
      ctx.lineWidth = (1.7 * zf) / s;
      ctx.setLineDash([]);
      ctx.stroke(rp.path);
    }
    if (rp.texts.length) {
      scr();
      for (const it of rp.texts) drawText(ctx, Object.assign({}, it, { color: "#c9c9ff" }), s, ox, oy, font, W, H, null, strength);
    }
    ctx.restore();
  }

  HP.render = { draw, compile, refPath, hatchSpacing, lwPx, BG, GLOW, DASH, HATCH_BASE, FONT, rev: 6 };
})(globalThis.HP = globalThis.HP || {});

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.HP;
