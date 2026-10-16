"use strict";
/* ============================================================================
   House Planner - canvas.js  (canvas agent)
   ----------------------------------------------------------------------------
   The drawing board: pan/zoom, hit-testing, every drag on the board, drops
   from the palette, hover/selection visuals, live read-outs, board keys.

     HP.canvas.init(stageEl)          build the board inside #stage
     HP.canvas.fit()                  show the whole drawing
     HP.canvas.zoomBy(f [, sx, sy])   zoom about a screen point (css px in the stage; default centre)
     HP.canvas.focus(ids)             zoom/pan to show rooms/openings/sections and flash them
     HP.canvas.toWorld(cx, cy)        client px -> [x, y] cm (y up)
     HP.canvas.redraw()               draw now (synchronous)

   Each frame: A = HP.store.analysis(); drawing = HP.drawing.build(plan, A)
   (cached per plan object); HP.render.draw(); then the overlays. Redraws are
   coalesced through requestAnimationFrame WITH a setTimeout fallback (rAF may
   never fire in a hidden/embedded page); during a drag the frame is drawn
   straight after the model op so what you see is never a frame behind.

   Drags follow store.js: start = HP.store.get() on pointerdown; every move
   previews op(start, ..., absoluteTarget); release commits; Esc cancels.
   Emits 'view' {scale (px per metre), ox, oy} on every zoom/pan.
============================================================================ */
(function (HP) {
  const MIN_SCALE = 4, MAX_SCALE = 900;       // px per metre
  const DRAG_PX = 3;                          // movement before a press becomes a drag
  const TIP_DELAY = 550;                      // ms of still hover before the little hint shows
  const ACCENT = "#16b6c9", ACCENT_HI = "#46e0f0", BAD = "#e5534b", SWAP = "#e0a542";

  const VIEW = { scale: 40, ox: 0, oy: 0 };
  let stage = null, cv = null, ctx = null, ov = null, hintEl = null, tipEl = null, menuEl = null;
  let W = 0, H = 0, dpr = 1, rect = { left: 0, top: 0 };
  let inited = false, needFit = false;
  let pending = false;
  let drag = null;              // the gesture in progress
  let hoverT = null;            // what is under the pointer (when not dragging)
  let lastPtr = null;           // last pointer position, css px in the stage
  let spaceDown = false;
  let flash = null;             // { ids:Set, t0, dur }
  let labels = {};              // room label boxes from the last render (css px)
  let tip = { key: "", timer: 0, shown: false };
  let menuOpen = false;
  let font = null;
  const chipPool = [];
  const drawCache = new WeakMap();
  const perf = { frames: [], moves: [] };
  let buildError = null;

  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const snap5 = v => Math.round(v / 5) * 5;
  const label = t => (HP.ROOM_TYPES[t] ? HP.ROOM_TYPES[t].label : t);

  // ------------------------------------------------------------------ coordinates
  const SX = x => VIEW.ox + x / 100 * VIEW.scale;          // cm -> css px in the stage
  const SY = y => VIEW.oy - y / 100 * VIEW.scale;
  const SL = l => l / 100 * VIEW.scale;
  const WX = sx => (sx - VIEW.ox) / VIEW.scale * 100;       // css px -> cm
  const WY = sy => (VIEW.oy - sy) / VIEW.scale * 100;
  const pxToCm = px => px / VIEW.scale * 100;
  function local(e) { return { x: e.clientX - rect.left, y: e.clientY - rect.top }; }
  function toWorld(clientX, clientY) { refreshRect(); return [WX(clientX - rect.left), WY(clientY - rect.top)]; }
  function refreshRect() {
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    // ResizeObserver / resize events only arrive while the page renders: catch a missed size change here
    if (inited && r.width > 0 && r.height > 0 && (Math.round(r.width) !== W || Math.round(r.height) !== H)) resize(r.width, r.height);
  }

  // ------------------------------------------------------------------ scheduling
  function schedule(cb) {
    let done = false;
    const run = () => { if (done) return; done = true; cb(); };
    const hidden = typeof document !== "undefined" && document.hidden;
    if (!hidden && typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    setTimeout(run, hidden ? 0 : 40);       // rAF may never fire (hidden / embedded page)
  }
  function requestDraw() {
    if (pending) return;
    pending = true;
    schedule(() => { if (pending) frame(); });
  }
  function flush() { if (pending) frame(); }
  function redraw() { pending = true; frame(); }

  // ------------------------------------------------------------------ model glue
  function analysisOf(st) {
    try { return st ? HP.store.analysis(st) : null; }
    catch (e) { report("analyze", e); return null; }
  }
  function drawingFor(plan, A) {
    if (!plan || !A || !HP.drawing || !HP.drawing.build) return null;
    let d = drawCache.get(plan);
    if (d) return d;
    try { d = HP.drawing.build(plan, A, {}); buildError = null; }
    catch (e) { report("drawing.build", e); d = null; }
    if (d) drawCache.set(plan, d);
    return d;
  }
  const reported = new Set();
  function report(where, e) {
    const k = where + ":" + (e && e.message);
    if (!reported.has(k)) { reported.add(k); console.error("[canvas] " + where + " failed", e); }
    if (where === "drawing.build") buildError = e;
  }
  /* call a model op safely; returns {state, ok, reason, id, note} or null */
  function op(name, ...args) {
    const f = HP.model && HP.model[name];
    if (!f) { report("model." + name, new Error("HP.model." + name + " is missing")); return null; }
    try {
      const r = f.apply(HP.model, args);
      return r && r.state ? r : null;
    } catch (e) { report("model." + name, e); return null; }
  }
  function commitResult(res, lbl, sel) {
    if (!res) return false;
    if (!res.ok && res.state === HP.store.committed()) {
      if (res.reason) HP.store.toast(res.reason, "warn");
      return false;
    }
    const changed = HP.store.commit(res.state, lbl);
    if (sel) HP.store.select(sel);
    if (res.note) HP.store.toast(res.note, "info");
    else if (!res.ok && res.reason) HP.store.toast(res.reason, "warn");
    return changed;
  }

  // ------------------------------------------------------------------ view
  function emitView() { HP.store.emit("view", { scale: VIEW.scale, ox: VIEW.ox, oy: VIEW.oy }); }
  function setView(scale, ox, oy) {
    VIEW.scale = clamp(scale, MIN_SCALE, MAX_SCALE); VIEW.ox = ox; VIEW.oy = oy;
    hideTip();                              // also cancels a hint that is about to appear
    emitView(); requestDraw();
  }
  function zoomBy(f, sx, sy) {
    if (sx == null) { sx = W / 2; sy = H / 2; }
    const ns = clamp(VIEW.scale * f, MIN_SCALE, MAX_SCALE), k = ns / VIEW.scale;
    setView(ns, sx - (sx - VIEW.ox) * k, sy - (sy - VIEW.oy) * k);
    hideTip();
  }
  function extentsM() {
    const plan = HP.store.get();
    if (!plan) return null;
    const d = drawingFor(plan, analysisOf(plan));
    if (d && d.extents && isFinite(d.extents.x0) && d.extents.x1 > d.extents.x0) return d.extents;
    const pts = plan.plot.pts;
    const xs = pts.map(p => p[0] / 100), ys = pts.map(p => p[1] / 100);
    return { x0: Math.min(...xs) - 1, y0: Math.min(...ys) - 1, x1: Math.max(...xs) + 1, y1: Math.max(...ys) + 1 };
  }
  function fitBox(b, pad) {      // b in metres -> {scale, ox, oy}
    const bw = Math.max(0.5, b.x1 - b.x0), bh = Math.max(0.5, b.y1 - b.y0);
    const s = clamp(Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh), MIN_SCALE, MAX_SCALE);
    return { scale: s, ox: W / 2 - (b.x0 + b.x1) / 2 * s, oy: H / 2 + (b.y0 + b.y1) / 2 * s };
  }
  function fit() {
    if (!inited) return;
    refreshRect();
    if (!W || !H) { needFit = true; return; }
    const e = extentsM();
    if (!e) return;
    const v = fitBox(e, Math.max(18, Math.min(W, H) * 0.04));
    setView(v.scale, v.ox, v.oy);
    needFit = false;
  }
  function animateView(target, ms) {
    const from = { scale: VIEW.scale, ox: VIEW.ox, oy: VIEW.oy }, t0 = now();
    // interpolate the world point at the centre, and the log of the scale
    const cx0 = (W / 2 - from.ox) / from.scale, cy0 = (from.oy - H / 2) / from.scale;
    const cx1 = (W / 2 - target.ox) / target.scale, cy1 = (target.oy - H / 2) / target.scale;
    const step = () => {
      const t = clamp((now() - t0) / ms, 0, 1), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const s = Math.exp(Math.log(from.scale) + (Math.log(target.scale) - Math.log(from.scale)) * e);
      const cx = cx0 + (cx1 - cx0) * e, cy = cy0 + (cy1 - cy0) * e;
      setView(s, W / 2 - cx * s, H / 2 + cy * s);
      if (t < 1) schedule(step);
    };
    step();
  }

  /* zoom/pan to show these rooms/openings/sections, then flash them */
  function focus(ids) {
    if (!inited) return;
    ids = (Array.isArray(ids) ? ids : [ids]).filter(v => v != null);
    const plan = HP.store.get(), A = analysisOf(plan);
    if (!plan || !A || !ids.length) return;
    const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const add = (x, y) => { bb.x0 = Math.min(bb.x0, x); bb.x1 = Math.max(bb.x1, x); bb.y0 = Math.min(bb.y0, y); bb.y1 = Math.max(bb.y1, y); };
    for (const id of ids) {
      const r = (A.rooms || []).find(q => q.id === id);
      if (r) { add(r.x, r.y); add(r.x + r.w, r.y + r.h); continue; }
      const o = (A.openings || []).find(q => q.id === id);
      if (o) { const b = openingBox(o); add(b.x0, b.y0); add(b.x1, b.y1); continue; }
      const s = (plan.sections || []).find(q => q.id === id);
      if (s) { add(s.a[0], s.a[1]); add(s.b[0], s.b[1]); }
    }
    if (!isFinite(bb.x0)) return;
    const m = { x0: bb.x0 / 100 - 1, y0: bb.y0 / 100 - 1, x1: bb.x1 / 100 + 1, y1: bb.y1 / 100 + 1 };
    // already comfortably on screen at a readable size? then only flash
    const inView = SX(bb.x0) > W * 0.06 && SX(bb.x1) < W * 0.94 && SY(bb.y1) > H * 0.06 && SY(bb.y0) < H * 0.94;
    if (!inView) {
      const fitv = fitBox(m, 50);
      const s = Math.min(VIEW.scale, fitv.scale) || fitv.scale;
      const cx = (m.x0 + m.x1) / 2, cy = (m.y0 + m.y1) / 2;
      animateView({ scale: s, ox: W / 2 - cx * s, oy: H / 2 + cy * s }, 280);
    }
    flash = { ids: new Set(ids), t0: now(), dur: 1500 };
    const pulse = () => { requestDraw(); if (flash && now() - flash.t0 < flash.dur + 50) setTimeout(pulse, 90); else { flash = null; requestDraw(); } };
    pulse();
  }

  // ------------------------------------------------------------------ geometry helpers (cm)
  function openingBox(o) {
    const a0 = Math.min(o.fixed, o.far), a1 = Math.max(o.fixed, o.far);
    return o.axis === "x" ? { x0: o.s0, x1: o.s1, y0: a0, y1: a1 } : { x0: a0, x1: a1, y0: o.s0, y1: o.s1 };
  }
  function openingCentre(o) {
    const m = (o.s0 + o.s1) / 2, c = (o.fixed + o.far) / 2;
    return o.axis === "x" ? [m, c] : [c, m];
  }
  function handleThick(plan, h) {
    const w = plan.walls || { ext: 20, int: 20 };
    return h.kind === "shared" ? w.int : w.ext;
  }
  function handleBox(plan, h) {
    const t = handleThick(plan, h) / 2;
    return h.orient === "v" ? { x0: h.pos - t, x1: h.pos + t, y0: h.from, y1: h.to }
                            : { x0: h.from, x1: h.to, y0: h.pos - t, y1: h.pos + t };
  }
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
  }
  function roomAt(A, w, exclude) {
    for (const r of A.rooms || []) {
      if (r.id === exclude) continue;
      if (w[0] >= r.x && w[0] <= r.x + r.w && w[1] >= r.y && w[1] <= r.y + r.h) return r;
    }
    return null;
  }
  function nearestHandle(A, w) {
    let best = null, bd = Infinity;
    for (const h of A.handles || []) {
      const along = h.orient === "v" ? w[1] : w[0], across = h.orient === "v" ? w[0] : w[1];
      const da = along < h.from ? h.from - along : along > h.to ? along - h.to : 0;
      const d = Math.hypot(da, across - h.pos);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }
  function inPlot(plan, w) { return HP.pointInPoly(w, plan.plot.pts); }

  // ------------------------------------------------------------------ hit testing
  /* What is under css point (sx, sy)? Priority: land corners/edges (land tool),
     openings, section ends, walls, room names, section line, door swings, rooms. */
  function hitTest(sx, sy) {
    const plan = HP.store.get(), A = analysisOf(plan);
    if (!plan) return { t: "bg" };
    const w = [WX(sx), WY(sy)], cmpx = pxToCm(1);
    if (HP.store.tool() === "plot") {
      const pts = plan.plot.pts;
      let best = null, bd = 11;
      pts.forEach((p, i) => { const d = Math.hypot(SX(p[0]) - sx, SY(p[1]) - sy); if (d < bd) { bd = d; best = { t: "corner", i }; } });
      if (best) return best;
      bd = 8;
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % pts.length];
        const d = segDist(w, p, q) / cmpx;
        if (d < bd) { bd = d; best = { t: "edge", i }; }
      });
      if (best) return best;
      return inPlot(plan, w) ? { t: "land" } : { t: "bg" };
    }
    if (!A) return inPlot(plan, w) ? { t: "land" } : { t: "bg" };

    // openings: the bar in the wall, a few px bigger
    let best = null, bd = Infinity;
    const pad = 5 * cmpx;
    for (const o of A.openings || []) {
      const b = openingBox(o);
      if (w[0] >= b.x0 - pad && w[0] <= b.x1 + pad && w[1] >= b.y0 - pad && w[1] <= b.y1 + pad) {
        const c = openingCentre(o), d = Math.hypot(w[0] - c[0], w[1] - c[1]);
        if (d < bd) { bd = d; best = { t: "opening", id: o.id, kind: o.kind }; }
      }
    }
    if (best) return best;

    // section ends (heads)
    for (const s of plan.sections || []) {
      for (const part of ["a", "b"]) {
        const p = s[part];
        if (Math.hypot(SX(p[0]) - sx, SY(p[1]) - sy) < 13) return { t: "section", id: s.id, part };
      }
    }

    // walls
    for (const h of A.handles || []) {
      const t = handleThick(plan, h) / 2;
      const along = h.orient === "v" ? w[1] : w[0], across = h.orient === "v" ? w[0] : w[1];
      if (along < h.from - t || along > h.to + t) continue;
      const d = Math.abs(across - h.pos);
      if (d <= t + 4 * cmpx && d < bd) { bd = d; best = { t: "wall", key: h.key, h }; }
    }
    if (best) return best;

    // room names (what was drawn last frame)
    for (const r of A.rooms || []) {
      const b = labelBox(r);
      if (b && sx >= b.x0 - 6 && sx <= b.x1 + 6 && sy >= b.y0 - 5 && sy <= b.y1 + 5) return { t: "label", id: r.id };
    }

    // section line
    for (const s of plan.sections || []) {
      if (segDist(w, s.a, s.b) / cmpx < 6) return { t: "section", id: s.id, part: "line" };
    }

    // door swings
    for (const o of A.openings || []) {
      if (o.kind !== "door") continue;
      const al = o.axis === "x" ? 0 : 1, ac = 1 - al;
      const hinge = o.hinge === "end" ? o.s1 : o.s0, dir = o.hinge === "end" ? -1 : 1;
      const face = o.swing === "out" ? o.far : o.fixed;
      const nn = (o.axis === "x" ? o.n[1] : o.n[0]) * (o.swing === "out" ? 1 : -1);
      const u = (w[al] - hinge) * dir, v = (w[ac] - face) * nn;
      if (u >= 0 && v >= 0 && u * u + v * v <= o.w * o.w) return { t: "opening", id: o.id, kind: "door" };
    }

    const r = roomAt(A, w, null);
    if (r) return { t: "room", id: r.id };
    return inPlot(plan, w) ? { t: "land" } : { t: "bg" };
  }
  /* the label box of a room: what render drew, or a fallback round the centre */
  function labelBox(r) {
    const b = labels[r.id];
    if (b) return b;
    const cx = SX(r.x + r.w / 2), cy = SY(r.y + r.h / 2);
    const hw = Math.min(SL(r.w) / 2 - 4, 36), hh = Math.min(SL(r.h) / 2 - 4, 11);
    if (hw < 4 || hh < 4) return { x0: cx - 8, x1: cx + 8, y0: cy - 8, y1: cy + 8 };
    return { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh };
  }

  // ------------------------------------------------------------------ hover
  const CURSOR = {
    label: "grab", opening: "grab", corner: "grab", edge: "copy", room: "pointer",
    land: "default", bg: "default",
  };
  function cursorFor(h) {
    if (!h) return "default";
    if (h.t === "wall") return h.h.orient === "v" ? "col-resize" : "row-resize";
    if (h.t === "section") return h.part === "line" ? "move" : "pointer";
    return CURSOR[h.t] || "default";
  }
  function setCursor(c) { if (cv && cv.style.cursor !== c) cv.style.cursor = c; }
  function hoverKey(h) { return h ? h.t + ":" + (h.id || h.key || h.i || "") + ":" + (h.part || "") : ""; }
  function storeHoverOf(h) {
    if (!h) return null;
    if (h.t === "label" || h.t === "room") return { kind: "room", id: h.id };
    if (h.t === "opening") return { kind: "opening", id: h.id };
    if (h.t === "section") return { kind: "section", id: h.id };
    if (h.t === "wall") return { kind: "wall", id: h.key };
    if (h.t === "corner") return { kind: "plot", id: h.i };
    return null;
  }
  function updateHover(p, quiet) {      // quiet: after a commit or release, no hint
    const h = p ? hitTest(p.x, p.y) : null;
    const changed = hoverKey(h) !== hoverKey(hoverT);
    hoverT = h;
    setCursor(spaceDown ? "grab" : cursorFor(h));
    if (changed) {
      HP.store.setHover(storeHoverOf(h));
      requestDraw();
      if (quiet) hideTip(); else armTip(h);
    }
    if (tip.shown && p) placeTip(p);
  }
  function tipText(h) {
    if (!h) return "";
    switch (h.t) {
      case "label": return "Drag the name to move the room. Drop it on another room to swap them.";
      case "wall": return "Drag the wall to change the room sizes. Hold Alt to move one room only.";
      case "opening": return h.kind === "door" ? "Drag the door along a wall. Double-click to turn it." : "Drag the window along a wall.";
      case "section": return h.part === "line" ? "Drag to move the section line." : "Drag to make it longer. Click to look the other way.";
      case "corner": return "Drag the corner. Press Delete to remove it.";
      case "edge": return "Double-click to add a corner here.";
      case "room": return "Click to select. Drag the room's name to move it.";
    }
    return "";
  }
  function armTip(h) {
    clearTimeout(tip.timer);
    hideTip();
    const text = tipText(h);
    tip.key = hoverKey(h);
    if (!text || drag) return;
    const key = tip.key;
    tip.timer = setTimeout(() => {
      if (tip.key !== key || drag || menuOpen || !lastPtr) return;
      tipEl.textContent = text;
      tipEl.classList.add("is-on");
      tip.shown = true;
      placeTip(lastPtr);
    }, TIP_DELAY);
  }
  function placeTip(p) {
    const x = clamp(p.x + 16, 6, Math.max(6, W - 300)), y = clamp(p.y + 20, 6, Math.max(6, H - 40));
    tipEl.style.transform = "translate(" + x.toFixed(0) + "px," + y.toFixed(0) + "px)";
  }
  function hideTip() {
    clearTimeout(tip.timer);
    if (tipEl && tip.shown) { tipEl.classList.remove("is-on"); }
    tip.shown = false;
  }

  // ------------------------------------------------------------------ pointer: board
  function onDown(e) {
    closeMenu();
    if (drag) return;
    if (e.button === 2) return;                            // the context menu handles it
    refreshRect();
    const p = local(e);
    lastPtr = p;
    if (e.button === 1) e.preventDefault();               // no autoscroll
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    try { cv.focus({ preventScroll: true }); } catch (err) { /* old browsers */ }
    hideTip();
    if (HP.store.get() !== HP.store.committed()) HP.store.cancel();   // a stray preview
    const start = HP.store.get();
    const hit = (e.button === 0 && !spaceDown) ? hitTest(p.x, p.y) : { t: "bg" };
    const pan = e.button === 1 || spaceDown || hit.t === "land" || hit.t === "bg" || hit.t === "room";
    drag = {
      pointerId: e.pointerId, button: e.button, p0: p, w0: [WX(p.x), WY(p.y)], hit, start,
      A0: analysisOf(start), moved: false, pan, view0: { scale: VIEW.scale, ox: VIEW.ox, oy: VIEW.oy },
      last: null, lastOk: null, chips: [], ghost: null, swap: null, alt: e.altKey, p: p,
    };
    if (pan) setCursor("grabbing");
    else if (hit.t === "label" || hit.t === "opening" || hit.t === "corner" || (hit.t === "section" && hit.part !== "line")) setCursor("grabbing");
  }
  function onMove(e) {
    const p = local(e);
    lastPtr = p;
    if (!drag) { if (!menuOpen) updateHover(p); return; }
    if (drag.type === "palette" || e.pointerId !== drag.pointerId) return;
    drag.p = p; drag.alt = e.altKey;
    if (!drag.moved) {
      if (Math.hypot(p.x - drag.p0.x, p.y - drag.p0.y) < DRAG_PX) return;
      drag.moved = true;
      if (!drag.pan) HP.store.setHover(storeHoverOf(drag.hit));
    }
    dragMove();
    requestDraw();          // a move may change only the ghost / chips, not the plan
    flush();
  }
  function onUp(e) {
    if (!drag || drag.type === "palette" || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* fine */ }
    if (!d.moved) click(d, e);
    else if (!d.pan) finishDrag(d);
    const p = local(e);
    lastPtr = p;
    hoverT = null;
    updateHover(p, true);
    redraw();
  }
  function onCancel(e) {
    if (!drag || drag.type === "palette" || e.pointerId !== drag.pointerId) return;
    cancelDrag();
  }
  function cancelDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.type === "palette") detachPalette();
    else { try { cv.releasePointerCapture(d.pointerId); } catch (err) { /* fine */ } }
    if (d.view0 && d.pan) { /* a pan just stays where it is */ }
    HP.store.cancel();
    hoverT = null;
    if (lastPtr) updateHover(lastPtr, true);
    redraw();
  }

  function click(d, e) {
    const h = d.hit;
    switch (h.t) {
      case "label": case "room": HP.store.select({ kind: "room", id: h.id }); break;
      case "opening": HP.store.select({ kind: "opening", id: h.id }); break;
      case "section":
        if (h.part === "line") HP.store.select({ kind: "section", id: h.id });
        else {
          const r = op("flipSection", HP.store.get(), h.id);
          commitResult(r, "Turn the section view", { kind: "section", id: h.id });
        }
        break;
      case "corner": HP.store.select({ kind: "plot", id: h.i }); break;
      case "wall": {
        // a click on a wall selects the room on the side that was clicked
        const A = d.A0, w = d.w0;
        const off = (d.hit.h.orient === "v" ? w[0] : w[1]) - d.hit.h.pos;
        const m = memberOnSide(A, d.hit.h, w, off);
        HP.store.select(m ? { kind: "room", id: m } : null);
        break;
      }
      default:
        if (d.button === 0) HP.store.select(HP.store.tool() === "plot" ? { kind: "plot", id: null } : null);
    }
  }

  /* the member room of a wall handle on the pointer's side of the centre line */
  function memberOnSide(A, h, w, off) {
    const along = h.orient === "v" ? w[1] : w[0];
    let best = null, bd = Infinity;
    for (const m of h.members || []) {
      const r = (A.rooms || []).find(q => q.id === m.room);
      if (!r) continue;
      const s0 = h.orient === "v" ? r.y : r.x, s1 = s0 + (h.orient === "v" ? r.h : r.w);
      const da = along < s0 ? s0 - along : along > s1 ? along - s1 : 0;
      // E/N sides lie on the low side of the line, W/S on the high side
      const low = m.side === "E" || m.side === "N";
      const sideOk = off === 0 ? 1 : ((off < 0) === low ? 0 : 1);
      const d = da + sideOk * 1e5;
      if (d < bd) { bd = d; best = m.room; }
    }
    return best;
  }

  // ------------------------------------------------------------------ drags on the board
  function dragMove() {
    const d = drag, p = d.p, h = d.hit;
    const w = [WX(p.x), WY(p.y)];
    d.ghost = null; d.chips = []; d.swap = null;
    if (d.pan) {
      VIEW.ox = d.view0.ox + (p.x - d.p0.x);
      VIEW.oy = d.view0.oy + (p.y - d.p0.y);
      emitView(); requestDraw();
      return;
    }
    const t0 = now();
    switch (h.t) {
      case "label": moveRoomDrag(d, w); break;
      case "wall": wallDrag(d, w); break;
      case "opening": openingDrag(d, w); break;
      case "section": sectionDrag(d, w); break;
      case "corner": cornerDrag(d, w); break;
    }
    d.opMs = now() - t0;
  }

  function moveRoomDrag(d, w) {
    const id = d.hit.id, A0 = d.A0;
    const r0 = d.start.rooms.find(r => r.id === id);
    if (!r0 || !A0) return;
    const other = roomAt(A0, w, id);
    let res;
    if (other) {
      res = op("swapRooms", d.start, id, other.id);
      d.swap = other;
      if (res && res.ok) {
        d.chips.push({ cls: "swap", text: "Swap with " + other.name, w: [w[0], w[1]], dx: 0, dy: -34 });
        HP.store.preview(res.state);
      } else {
        HP.store.preview(d.start);
        d.ghost = { kind: "rect", x: other.x, y: other.y, w: other.w, h: other.h };
        d.chips.push({ cls: "reason", text: (res && res.reason) || "These two rooms can't swap.", w, dx: 16, dy: 22, left: true });
      }
    } else {
      const tx = snap5(r0.x + w[0] - d.w0[0]), ty = snap5(r0.y + w[1] - d.w0[1]);
      res = op("moveRoom", d.start, id, tx, ty, { snap: Math.round(pxToCm(10)) });
      if (res) {
        HP.store.preview(res.state);
        if (!res.ok) {
          d.ghost = { kind: "rect", x: tx, y: ty, w: r0.w, h: r0.h };
          if (res.reason) d.chips.push({ cls: "reason", text: res.reason, w, dx: 16, dy: 22, left: true });
        }
      }
    }
    d.last = res;
  }

  function wallDrag(d, w) {
    const h = d.hit.h;
    const axis = h.orient === "v" ? 0 : 1;
    const delta = snap5(w[axis] - d.w0[axis]);
    if (d.only === undefined) {
      const off = d.w0[axis] - h.pos;
      d.only = memberOnSide(d.A0, h, d.w0, off);
    }
    const res = op("dragWall", d.start, d.hit.key, delta, { only: d.alt ? d.only : null });
    d.last = res;
    if (!res) return;
    HP.store.preview(res.state);
    // live size read-outs for every room that changed
    const byId = new Map(d.start.rooms.map(r => [r.id, r]));
    for (const r of res.state.rooms) {
      const r0 = byId.get(r.id);
      if (!r0) continue;
      const dw = r.w !== r0.w, dh = r.h !== r0.h;
      if (!dw && !dh) continue;
      if (h.orient === "v" && dw) {
        const y = clamp(w[1], r.y + Math.min(60, r.h * 0.25), r.y + r.h - Math.min(60, r.h * 0.25));
        d.chips.push({ cls: "size", text: HP.fmtM(r.w), w: [r.x + r.w / 2, y], arrow: "h" });
      } else if (h.orient === "h" && dh) {
        const x = clamp(w[0], r.x + Math.min(60, r.w * 0.25), r.x + r.w - Math.min(60, r.w * 0.25));
        d.chips.push({ cls: "size", text: HP.fmtM(r.h), w: [x, r.y + r.h / 2], arrow: "v" });
      } else {
        d.chips.push({ cls: "size", text: HP.fmtM(r.w) + " \u00d7 " + HP.fmtM(r.h), w: [r.x + r.w / 2, r.y + r.h / 2] });
      }
    }
    if (!res.ok && res.reason) d.chips.push({ cls: "reason", text: res.reason, w, dx: 16, dy: 22, left: true });
  }

  function openingDrag(d, w) {
    const id = d.hit.id, A0 = d.A0;
    const o0 = (A0.openings || []).find(o => o.id === id);
    if (!o0) return;
    if (!d.off) { const c = openingCentre(o0); d.off = [c[0] - d.w0[0], c[1] - d.w0[1]]; d.o0 = o0; }
    const pt = [snap5(w[0] + d.off[0]), snap5(w[1] + d.off[1])];
    const res = op("moveOpening", d.start, id, pt, { analysis: A0 });
    d.last = res;
    if (res && res.ok) { HP.store.preview(res.state); d.lastOk = res; return; }
    // not legal: keep the last legal preview, show a red ghost at the pointer + the reason
    const curA = analysisOf(HP.store.get());
    const cur = curA && (curA.openings || []).find(o => o.id === id);
    const nh = nearestHandle(A0, pt);
    const axis = nh ? (nh.orient === "v" ? "y" : "x") : (cur || o0).axis;
    d.ghost = { kind: "bar", c: pt, len: o0.w, axis, thick: (HP.store.get().walls || {}).ext || 20 };
    d.chips.push({ cls: "reason", text: (res && res.reason) || "It can't go here.", w, dx: 18, dy: 24, left: true });
  }

  function sectionDrag(d, w) {
    const id = d.hit.id, part = d.hit.part;
    let res;
    if (part === "line") res = op("moveSection", d.start, id, { dx: snap5(w[0] - d.w0[0]), dy: snap5(w[1] - d.w0[1]) });
    else res = op("moveSection", d.start, id, { [part]: [snap5(w[0]), snap5(w[1])] });
    d.last = res;
    if (res) HP.store.preview(res.state);
    if (res && !res.ok && res.reason) d.chips.push({ cls: "reason", text: res.reason, w, dx: 16, dy: 22, left: true });
  }

  function cornerDrag(d, w) {
    const res = op("movePlotCorner", d.start, d.hit.i, [snap5(w[0]), snap5(w[1])]);
    d.last = res;
    if (res) HP.store.preview(res.state);
    if (res && !res.ok) {
      d.ghost = { kind: "dot", c: [snap5(w[0]), snap5(w[1])] };
      if (res.reason) d.chips.push({ cls: "reason", text: res.reason, w, dx: 16, dy: 22, left: true });
    }
  }

  function finishDrag(d) {
    const cur = HP.store.get();
    if (cur === HP.store.committed()) { HP.store.cancel(); return; }
    const h = d.hit;
    let lbl = "Edit", sel = null;
    switch (h.t) {
      case "label": lbl = d.swap ? "Swap rooms" : "Move room"; sel = { kind: "room", id: h.id }; break;
      case "wall": lbl = "Move wall"; break;
      case "opening": lbl = h.kind === "door" ? "Move door" : "Move window"; sel = { kind: "opening", id: h.id }; break;
      case "section": lbl = h.part === "line" ? "Move section" : "Lengthen section"; sel = { kind: "section", id: h.id }; break;
      case "corner": lbl = "Move land corner"; sel = { kind: "plot", id: h.i }; break;
    }
    HP.store.commit(cur, lbl);
    if (sel) HP.store.select(sel);
    const res = h.t === "opening" ? d.lastOk : d.last;
    if (res && res.note) HP.store.toast(res.note, "info");
  }

  // ------------------------------------------------------------------ palette drops
  function itemLabel(it) {
    if (it.kind === "room") return label(it.type);
    if (it.kind === "door") return "door";
    if (it.kind === "window") return "window";
    return "section";
  }
  function paletteOp(start, item, pt) {
    switch (item.kind) {
      case "room": return op("addRoom", start, item.type, pt);
      case "door": return op("addOpening", start, "door", item.w || 80, pt, { analysis: analysisOf(start) });
      case "window": return op("addOpening", start, "window", item.w || 120, pt, { analysis: analysisOf(start) });
      case "section": return op("addSection", start, pt);
    }
    return null;
  }
  function selOf(item, id) {
    if (!id) return null;
    if (item.kind === "room") return { kind: "room", id };
    if (item.kind === "door" || item.kind === "window") return { kind: "opening", id };
    if (item.kind === "section") return { kind: "section", id };
    return null;
  }
  function startPalette(item, ev) {
    if (!inited || !item) return;
    if (drag) cancelDrag();
    closeMenu(); hideTip();
    if (HP.store.get() !== HP.store.committed()) HP.store.cancel();
    drag = { type: "palette", item, start: HP.store.get(), A0: analysisOf(HP.store.get()), pointerId: ev ? ev.pointerId : null,
             last: null, chips: [], ghost: null, over: false, key: "" };
    document.addEventListener("pointermove", onPalMove, true);
    document.addEventListener("pointerup", onPalUp, true);
    document.addEventListener("pointercancel", onPalCancel, true);
    if (ev && ev.clientX != null) onPalMove(ev);
  }
  function detachPalette() {
    document.removeEventListener("pointermove", onPalMove, true);
    document.removeEventListener("pointerup", onPalUp, true);
    document.removeEventListener("pointercancel", onPalCancel, true);
  }
  function overBoard(e) {
    refreshRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return false;
    // something on top of the board (a panel, a menu) does not count
    const top = document.elementFromPoint ? document.elementFromPoint(e.clientX, e.clientY) : null;
    return !top || top === cv || ov.contains(top) || stage === top;
  }
  function onPalMove(e) {
    const d = drag;
    if (!d || d.type !== "palette") return;
    if (d.pointerId != null && e.pointerId != null && e.pointerId !== d.pointerId) return;
    const p = local(e);
    lastPtr = p;
    d.p = p; d.chips = []; d.ghost = null;
    d.over = overBoard(e);
    if (!d.over) {
      if (HP.store.get() !== d.start) HP.store.preview(d.start);
      d.last = null; d.key = "";
      setCursor("default");
      requestDraw(); flush();
      return;
    }
    setCursor("copy");
    const pt = [snap5(WX(p.x)), snap5(WY(p.y))];
    const key = pt[0] + "," + pt[1];
    if (key === d.key && d.lastPt) { d.chips = d.lastChips || []; d.ghost = d.lastGhost || null; requestDraw(); flush(); return; }
    d.key = key;
    const t0 = now();
    const res = paletteOp(d.start, d.item, pt);
    d.opMs = now() - t0;
    d.last = res;
    if (res && res.ok) {
      HP.store.preview(res.state);
    } else {
      if (HP.store.get() !== d.start) HP.store.preview(d.start);
      if (d.item.kind === "room") {
        const sz = (HP.ROOM_TYPES[d.item.type] || { size: [300, 300] }).size;
        d.ghost = { kind: "rect", x: pt[0] - sz[0] / 2, y: pt[1] - sz[1] / 2, w: sz[0], h: sz[1] };
      } else if (d.item.kind === "section") {
        d.ghost = { kind: "dot", c: pt };
      } else {
        const nh = d.A0 && nearestHandle(d.A0, pt);
        d.ghost = { kind: "bar", c: pt, len: d.item.w || 100, axis: nh && nh.orient === "v" ? "y" : "x", thick: (d.start.walls || {}).ext || 20 };
      }
      d.chips.push({ cls: "reason", text: (res && res.reason) || ("The " + itemLabel(d.item) + " can't go here."), w: [WX(p.x), WY(p.y)], dx: 18, dy: 24, left: true });
    }
    d.lastPt = pt; d.lastChips = d.chips; d.lastGhost = d.ghost;
    requestDraw(); flush();
  }
  function onPalUp(e) {
    const d = drag;
    if (!d || d.type !== "palette") return;
    if (d.pointerId != null && e.pointerId != null && e.pointerId !== d.pointerId) return;
    detachPalette();
    drag = null;
    const over = overBoard(e);
    if (over && d.last && d.last.ok) {
      const lbl = "Add " + (d.item.kind === "room" ? label(d.item.type) : itemLabel(d.item));
      HP.store.commit(d.last.state, lbl);
      HP.store.select(selOf(d.item, d.last.id));
      if (d.last.note) HP.store.toast(d.last.note, "info");
    } else {
      HP.store.cancel();
      if (over && d.last && !d.last.ok && d.last.reason) HP.store.toast(d.last.reason, "warn");
    }
    lastPtr = over ? local(e) : null;
    hoverT = null;
    if (lastPtr) updateHover(lastPtr, true); else setCursor("default");
    redraw();
  }
  function onPalCancel() {
    if (drag && drag.type === "palette") cancelDrag();
  }
  function clickPalette(item) {
    if (!inited || !item) return;
    if (drag) cancelDrag();
    const start = HP.store.committed();
    if (HP.store.get() !== start) HP.store.cancel();
    const pt = [snap5(WX(W / 2)), snap5(WY(H / 2))];
    const res = paletteOp(start, item, pt);
    if (!res) return;
    if (!res.ok) { HP.store.toast(res.reason || ("There is no room for the " + itemLabel(item) + " here."), "warn"); return; }
    HP.store.commit(res.state, "Add " + (item.kind === "room" ? label(item.type) : itemLabel(item)));
    const sel = selOf(item, res.id);
    HP.store.select(sel);
    if (res.note) HP.store.toast(res.note, "info");
    if (res.id) focus([res.id]);
  }

  // ------------------------------------------------------------------ double-click, wheel, context menu
  function onDbl(e) {
    refreshRect();
    const p = local(e), h = hitTest(p.x, p.y), plan = HP.store.get();
    if (h.t === "opening" && h.kind === "door") {
      commitResult(op("flipDoor", plan, h.id, "swing"), "Turn door", { kind: "opening", id: h.id });
    } else if (h.t === "edge") {
      const res = op("addPlotCorner", plan, h.i, [snap5(WX(p.x)), snap5(WY(p.y))]);
      if (commitResult(res, "Add land corner")) HP.store.select({ kind: "plot", id: h.i + 1 });
    }
  }
  function onWheel(e) {
    e.preventDefault();
    if (drag && drag.pan) return;
    closeMenu();
    refreshRect();
    const p = local(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= H || 800;
    const f = clamp(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016)), 0.5, 2);
    zoomBy(f, p.x, p.y);
    if (drag && drag.moved && !drag.pan && drag.type !== "palette") { dragMove(); requestDraw(); }
    else if (!drag) { lastPtr = p; hoverT = null; updateHover(p); }
    flush();
  }
  function onContext(e) {
    e.preventDefault();
    if (drag) return;
    refreshRect();
    const p = local(e), h = hitTest(p.x, p.y), plan = HP.store.get();
    const items = [];
    const furnNext = (id) => {
      const r = plan.rooms.find(q => q.id === id);
      const vars = (HP.furniture && HP.furniture.variants && r) ? HP.furniture.variants(r.type) : [];
      if (!r || vars.length < 2) return null;
      const next = ((r.furn | 0) + 1) % vars.length;
      return () => commitResult(op("setFurniture", HP.store.get(), id, next), "Furniture: " + vars[next].label, { kind: "room", id });
    };
    if (h.t === "label" || h.t === "room") {
      HP.store.select({ kind: "room", id: h.id });
      const fn = furnNext(h.id);
      items.push({ text: "Next furniture layout", act: fn, off: !fn });
      items.push({ text: "Zoom to this room", act: () => focus([h.id]) });
      items.push({ sep: true });
      items.push({ text: "Delete room", key: "Del", act: () => commitResult(op("removeRoom", HP.store.get(), h.id), "Delete room"), bad: true });
    } else if (h.t === "opening") {
      HP.store.select({ kind: "opening", id: h.id });
      if (h.kind === "door") {
        items.push({ text: "Flip swing (in / out)", act: () => commitResult(op("flipDoor", HP.store.get(), h.id, "swing"), "Flip door swing", { kind: "opening", id: h.id }) });
        items.push({ text: "Flip hinge side", act: () => commitResult(op("flipDoor", HP.store.get(), h.id, "hinge"), "Flip door hinge", { kind: "opening", id: h.id }) });
        items.push({ sep: true });
      }
      items.push({ text: h.kind === "door" ? "Delete door" : "Delete window", key: "Del", act: () => commitResult(op("removeOpening", HP.store.get(), h.id), h.kind === "door" ? "Delete door" : "Delete window"), bad: true });
    } else if (h.t === "section") {
      HP.store.select({ kind: "section", id: h.id });
      items.push({ text: "Look the other way", act: () => commitResult(op("flipSection", HP.store.get(), h.id), "Turn the section view", { kind: "section", id: h.id }) });
      items.push({ text: "Turn the section 90\u00b0", act: () => commitResult(op("turnSection", HP.store.get(), h.id), "Turn section", { kind: "section", id: h.id }) });
      items.push({ sep: true });
      items.push({ text: "Delete section", key: "Del", act: () => commitResult(op("removeSection", HP.store.get(), h.id), "Delete section"), bad: true });
    } else if (h.t === "corner") {
      HP.store.select({ kind: "plot", id: h.i });
      items.push({ text: "Remove this corner", key: "Del", act: () => commitResult(op("removePlotCorner", HP.store.get(), h.i), "Remove land corner"), bad: true, off: plan.plot.pts.length <= 3 });
    } else if (h.t === "edge") {
      const pt = [snap5(WX(p.x)), snap5(WY(p.y))];
      items.push({ text: "Add a corner here", act: () => { if (commitResult(op("addPlotCorner", HP.store.get(), h.i, pt), "Add land corner")) HP.store.select({ kind: "plot", id: h.i + 1 }); } });
    } else if (h.t === "wall") {
      const m = memberOnSide(analysisOf(plan), h.h, [WX(p.x), WY(p.y)], (h.h.orient === "v" ? WX(p.x) : WY(p.y)) - h.h.pos);
      if (m) {
        HP.store.select({ kind: "room", id: m });
        const fn = furnNext(m);
        items.push({ text: "Next furniture layout", act: fn, off: !fn });
        items.push({ text: "Delete room", key: "Del", act: () => commitResult(op("removeRoom", HP.store.get(), m), "Delete room"), bad: true });
      }
    }
    if (items.length) items.push({ sep: true });
    items.push({ text: "Fit the drawing", key: "F", act: fit });
    items.push({ text: "Zoom in", key: "+", act: () => zoomBy(1.25, p.x, p.y) });
    items.push({ text: "Zoom out", key: "\u2212", act: () => zoomBy(0.8, p.x, p.y) });
    openMenu(p, items);
  }
  function openMenu(p, items) {
    hideTip();
    menuEl.textContent = "";
    for (const it of items) {
      if (it.sep) { const s = document.createElement("div"); s.className = "hp-menu__sep"; menuEl.appendChild(s); continue; }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hp-menu__item" + (it.bad ? " is-bad" : "");
      b.disabled = !!it.off;
      const t = document.createElement("span"); t.textContent = it.text; b.appendChild(t);
      if (it.key) { const k = document.createElement("kbd"); k.textContent = it.key; b.appendChild(k); }
      b.addEventListener("click", ev => { ev.stopPropagation(); closeMenu(); if (it.act) it.act(); redraw(); });
      menuEl.appendChild(b);
    }
    menuEl.classList.add("is-on");
    menuOpen = true;
    const mw = menuEl.offsetWidth || 200, mh = menuEl.offsetHeight || 160;
    const x = clamp(p.x + 2, 4, Math.max(4, W - mw - 4)), y = clamp(p.y + 2, 4, Math.max(4, H - mh - 4));
    menuEl.style.transform = "translate(" + x + "px," + y + "px)";
    const first = menuEl.querySelector("button:not([disabled])");
    if (first) try { first.focus({ preventScroll: true }); } catch (err) { /* fine */ }
  }
  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    menuEl.classList.remove("is-on");
  }

  // ------------------------------------------------------------------ keys
  function isTyping(t) {
    if (!t || !t.tagName) return false;
    const n = t.tagName;
    return n === "INPUT" || n === "TEXTAREA" || n === "SELECT" || t.isContentEditable;
  }
  function onKey(e) {
    if (!inited) return;
    if (e.key === "Alt" && drag && drag.moved && !drag.pan && drag.type !== "palette") {
      e.preventDefault(); drag.alt = true; dragMove(); requestDraw(); flush(); return;
    }
    if (isTyping(e.target)) return;
    if (e.ctrlKey || e.metaKey) return;          // Ctrl shortcuts belong to the panels
    if (document.querySelector(".hp-modal")) return;   // a panels dialog is open: its keys, not ours
    const k = e.key;
    if (menuOpen) {
      if (k === "Escape") { closeMenu(); e.preventDefault(); }
      return;
    }
    if (k === " " || k === "Spacebar") {
      if (!spaceDown) { spaceDown = true; if (!drag) setCursor("grab"); hideTip(); }
      e.preventDefault();
      return;
    }
    if (k === "Escape") {
      if (drag) cancelDrag();
      else if (HP.store.selection()) HP.store.select(null);
      e.preventDefault();
      return;
    }
    if (drag) return;
    if (k === "Delete" || k === "Backspace") { if (deleteSelection()) e.preventDefault(); return; }
    if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
      const st = e.shiftKey ? 50 : 5;
      const dx = k === "ArrowLeft" ? -st : k === "ArrowRight" ? st : 0;
      const dy = k === "ArrowDown" ? -st : k === "ArrowUp" ? st : 0;
      if (nudge(dx, dy)) e.preventDefault();
      return;
    }
    if (e.altKey) return;
    if (k === "f" || k === "F") { fit(); e.preventDefault(); return; }
    if (k === "+" || k === "=" || k === "Add") { zoomBy(1.25); e.preventDefault(); return; }
    if (k === "-" || k === "_" || k === "Subtract") { zoomBy(0.8); e.preventDefault(); return; }
  }
  function onKeyUp(e) {
    if (e.key === " " || e.key === "Spacebar") {
      spaceDown = false;
      if (!drag) setCursor(cursorFor(hoverT));
    }
    if (e.key === "Alt" && drag && drag.moved && !drag.pan && drag.type !== "palette") {
      e.preventDefault(); drag.alt = false; dragMove(); requestDraw(); flush();
    }
  }
  function deleteSelection() {
    const sel = HP.store.selection(), plan = HP.store.get();
    if (!sel || !plan) return false;
    if (sel.kind === "room") return commitResult(op("removeRoom", plan, sel.id), "Delete room") || true;
    if (sel.kind === "opening") {
      const o = plan.openings.find(q => q.id === sel.id);
      return commitResult(op("removeOpening", plan, sel.id), o && o.kind === "door" ? "Delete door" : "Delete window") || true;
    }
    if (sel.kind === "section") return commitResult(op("removeSection", plan, sel.id), "Delete section") || true;
    if (sel.kind === "plot" && sel.id != null && HP.store.tool() === "plot") {
      if (plan.plot.pts.length <= 3) { HP.store.toast("The land needs at least three corners.", "warn"); return true; }
      const ok = commitResult(op("removePlotCorner", plan, sel.id), "Remove land corner");
      if (ok) HP.store.select({ kind: "plot", id: null });
      return true;
    }
    return false;
  }
  function nudge(dx, dy) {
    const sel = HP.store.selection(), plan = HP.store.get();
    if (!sel || !plan) return false;
    if (sel.kind === "room") {
      const r = plan.rooms.find(q => q.id === sel.id);
      if (!r) return false;
      const res = op("moveRoom", plan, r.id, r.x + dx, r.y + dy, { snap: 0 });
      if (res && res.state !== plan) commitResult(res, "Nudge room", sel);
      else if (res && res.reason) HP.store.toast(res.reason, "warn");
      return true;
    }
    if (sel.kind === "opening") {
      const A = analysisOf(plan), o = A && (A.openings || []).find(q => q.id === sel.id);
      if (!o) return false;
      const c = openingCentre(o);
      const res = op("moveOpening", plan, sel.id, [c[0] + dx, c[1] + dy], { analysis: A });
      if (res && res.ok && res.state !== plan) commitResult(res, o.kind === "door" ? "Nudge door" : "Nudge window", sel);
      else if (res && res.reason) HP.store.toast(res.reason, "warn");
      return true;
    }
    if (sel.kind === "section") {
      commitResult(op("moveSection", plan, sel.id, { dx, dy }), "Nudge section", sel);
      return true;
    }
    if (sel.kind === "plot" && sel.id != null && HP.store.tool() === "plot") {
      const p = plan.plot.pts[sel.id];
      if (p) commitResult(op("movePlotCorner", plan, sel.id, [p[0] + dx, p[1] + dy]), "Move land corner", sel);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ the frame
  function frame() {
    pending = false;
    if (!inited) return;
    const t0 = now();
    if (needFit && W && H) fit();
    const plan = HP.store.get();
    const A = analysisOf(plan);
    const t1 = now();
    const drawing = drawingFor(plan, A);
    const t2 = now();
    const sel = HP.store.selection();
    const hi = new Set(), hv = new Set();
    if (sel && sel.id != null && sel.kind !== "plot") hi.add(sel.id);
    if (drag && drag.type === "palette" && drag.last && drag.last.ok && drag.last.id) hi.add(drag.last.id);
    if (drag && drag.moved && !drag.pan && drag.hit && drag.hit.id) hi.add(drag.hit.id);
    if (flash && Math.floor((now() - flash.t0) / 250) % 2 === 0) for (const id of flash.ids) hi.add(id);
    const sh = HP.store.hover();
    if (sh) {
      if (Array.isArray(sh.refs)) sh.refs.forEach(r => hv.add(r));
      else if ((sh.kind === "opening" || sh.kind === "section") && sh.id != null) hv.add(sh.id);
    }
    const tints = [];
    if (A && A.rooms) for (const r of A.rooms) {
      const T = HP.ROOM_TYPES[r.type];
      if (T && T.tint) tints.push({ x: r.x / 100, y: r.y / 100, w: r.w / 100, h: r.h / 100, color: T.tint });
    }
    labels = {};
    HP.render.draw(ctx, drawing, { scale: VIEW.scale, ox: VIEW.ox, oy: VIEW.oy, dpr, w: W, h: H },
                   { tints, highlight: hi, hover: hv, labels, font });
    const t3 = now();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const chips = [];
    try { overlays(plan, A, chips); } catch (e) { report("overlays", e); }
    domLayer(plan, A, chips);
    const t4 = now();
    const rec = { analyze: t1 - t0, build: t2 - t1, render: t3 - t2, overlay: t4 - t3, total: t4 - t0, op: drag ? drag.opMs || 0 : 0, drag: !!(drag && (drag.moved || drag.type === "palette")) };
    perf.frames.push(rec);
    if (perf.frames.length > 400) perf.frames.splice(0, perf.frames.length - 400);
  }

  // ------------------------------------------------------------------ overlays (canvas, css px)
  function rr(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  }
  function boxPx(b) { return { x: SX(b.x0), y: SY(b.y1), w: SL(b.x1 - b.x0), h: SL(b.y1 - b.y0) }; }
  function roomRectPx(r) { return { x: SX(r.x), y: SY(r.y + r.h), w: SL(r.w), h: SL(r.h) }; }

  function overlays(plan, A, chips) {
    if (!plan) return;
    const sel = HP.store.selection();
    const tool = HP.store.tool();
    const dragging = drag && (drag.moved || drag.type === "palette");
    const hvT = dragging ? null : hoverT;
    const rooms = (A && A.rooms) || [];
    const roomById = id => rooms.find(r => r.id === id);

    // ---- rooms: hover outline, selection, swap target, new room from the palette
    if (A && tool !== "plot") {
      if (hvT && (hvT.t === "room" || hvT.t === "label")) {
        const r = roomById(hvT.id);
        if (r && !(sel && sel.kind === "room" && sel.id === r.id)) {
          const q = roomRectPx(r);
          ctx.strokeStyle = "rgba(70, 224, 240, 0.45)"; ctx.lineWidth = 1.2; ctx.setLineDash([]);
          ctx.strokeRect(q.x + 0.5, q.y + 0.5, q.w - 1, q.h - 1);
        }
      }
      const selRoom = sel && sel.kind === "room" ? roomById(sel.id) : null;
      if (selRoom) {
        const q = roomRectPx(selRoom);
        ctx.fillStyle = "rgba(22, 182, 201, 0.07)"; ctx.fillRect(q.x, q.y, q.w, q.h);
        ctx.save(); ctx.shadowColor = "rgba(40, 214, 236, 0.8)"; ctx.shadowBlur = 10 * dpr;
        ctx.strokeStyle = ACCENT_HI; ctx.lineWidth = 2; ctx.strokeRect(q.x + 1, q.y + 1, q.w - 2, q.h - 2);
        ctx.restore();
      }
      if (flash && Math.floor((now() - flash.t0) / 250) % 2 === 0) {
        for (const id of flash.ids) {
          const r = roomById(id);
          if (r) { const q = roomRectPx(r); ctx.fillStyle = "rgba(70, 224, 240, 0.16)"; ctx.fillRect(q.x, q.y, q.w, q.h); ctx.strokeStyle = ACCENT_HI; ctx.lineWidth = 2; ctx.strokeRect(q.x + 1, q.y + 1, q.w - 2, q.h - 2); }
          const o = (A.openings || []).find(q => q.id === id);
          if (o) { const q = boxPx(openingBox(o)); ctx.strokeStyle = ACCENT_HI; ctx.lineWidth = 2; ctx.strokeRect(q.x - 3, q.y - 3, q.w + 6, q.h + 6); }
        }
      }
      if (drag && drag.type === "palette" && drag.last && drag.last.ok && drag.item.kind === "room") {
        const r = roomById(drag.last.id);
        if (r) {
          const q = roomRectPx(r);
          ctx.fillStyle = "rgba(75, 191, 122, 0.10)"; ctx.fillRect(q.x, q.y, q.w, q.h);
          ctx.strokeStyle = "rgba(75, 191, 122, 0.9)"; ctx.lineWidth = 2; ctx.setLineDash([7, 5]);
          ctx.strokeRect(q.x + 1, q.y + 1, q.w - 2, q.h - 2); ctx.setLineDash([]);
          chips.push({ cls: "size", text: HP.fmtM(r.w) + " \u00d7 " + HP.fmtM(r.h), x: q.x + q.w / 2, y: q.y + q.h + 18 });
        }
      }
      if (drag && drag.swap) {
        const r = roomById(drag.swap.id);
        const r2 = drag.start && analysisOf(drag.start) ? (analysisOf(drag.start).rooms || []).find(q => q.id === drag.swap.id) : null;
        const rr0 = r2 || r;
        if (rr0) {
          const q = roomRectPx(rr0);
          ctx.strokeStyle = SWAP; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
          ctx.strokeRect(q.x + 1, q.y + 1, q.w - 2, q.h - 2); ctx.setLineDash([]);
        }
      }
    }

    // ---- room name pill (hover = grab handle; while moving)
    if (A && tool !== "plot") {
      let pillId = null;
      if (hvT && hvT.t === "label") pillId = hvT.id;
      if (drag && drag.moved && drag.hit && drag.hit.t === "label") pillId = drag.hit.id;
      const r = pillId && roomById(pillId);
      if (r) {
        const b = labelBox(r);
        const x = b.x0 - 8, y = b.y0 - 5, w = b.x1 - b.x0 + 16, h = b.y1 - b.y0 + 10;
        rr(x, y, w, h, Math.min(12, h / 2));
        ctx.fillStyle = dragging ? "rgba(22, 182, 201, 0.26)" : "rgba(22, 182, 201, 0.16)";
        ctx.fill();
        ctx.strokeStyle = "rgba(70, 224, 240, 0.9)"; ctx.lineWidth = 1.3; ctx.stroke();
        // a little "move" grip on the left of the pill
        const gx = x - 2, gy = y + h / 2;
        ctx.fillStyle = ACCENT_HI;
        for (const [ax, ay] of [[0, -4], [0, 0], [0, 4], [4, -4], [4, 0], [4, 4]]) { ctx.beginPath(); ctx.arc(gx - 8 + ax, gy + ay, 1.15, 0, Math.PI * 2); ctx.fill(); }
      }
    }

    // ---- walls: hover / drag bar over the whole handle
    if (A && tool !== "plot") {
      let wh = null;
      if (hvT && hvT.t === "wall") wh = (A.handles || []).find(h => h.key === hvT.key) || hvT.h;
      if (drag && drag.hit && drag.hit.t === "wall") {
        // the handle in the CURRENT analysis that sits where the dragged one went
        const h0 = drag.hit.h;
        const cand = (A.handles || []).filter(h => h.orient === h0.orient);
        const target = drag.last && drag.moved ? h0.pos + snap5(((h0.orient === "v" ? WX(drag.p.x) : WY(drag.p.y)) - (h0.orient === "v" ? drag.w0[0] : drag.w0[1]))) : h0.pos;
        let best = null, bd = Infinity;
        for (const h of cand) {
          const ov2 = Math.min(h.to, h0.to) - Math.max(h.from, h0.from);
          const d = Math.abs(h.pos - target) + (ov2 > 0 ? 0 : 1e4);
          if (d < bd) { bd = d; best = h; }
        }
        wh = best || h0;
      }
      if (wh) {
        const q = boxPx(handleBox(plan, wh));
        const grow = 3;
        ctx.fillStyle = dragging ? "rgba(70, 224, 240, 0.55)" : "rgba(22, 182, 201, 0.38)";
        rr(q.x - grow, q.y - grow, q.w + 2 * grow, q.h + 2 * grow, 3); ctx.fill();
        ctx.strokeStyle = ACCENT_HI; ctx.lineWidth = 1.2; ctx.stroke();
        // grip marks in the middle of the handle
        const cx = q.x + q.w / 2, cy = q.y + q.h / 2;
        ctx.strokeStyle = "#e8fbff"; ctx.lineWidth = 1.4; ctx.beginPath();
        for (const k of [-5, 0, 5]) {
          if (wh.orient === "v") { ctx.moveTo(cx - 4, cy + k); ctx.lineTo(cx + 4, cy + k); }
          else { ctx.moveTo(cx + k, cy - 4); ctx.lineTo(cx + k, cy + 4); }
        }
        ctx.stroke();
      }
    }

    // ---- openings: hover / selected frame
    if (A && tool !== "plot") {
      const ids = new Set();
      if (hvT && hvT.t === "opening") ids.add(hvT.id);
      if (sel && sel.kind === "opening") ids.add(sel.id);
      if (drag && drag.hit && drag.hit.t === "opening" && drag.moved) ids.add(drag.hit.id);
      if (drag && drag.type === "palette" && drag.last && drag.last.ok && (drag.item.kind === "door" || drag.item.kind === "window")) ids.add(drag.last.id);
      for (const id of ids) {
        const o = (A.openings || []).find(q => q.id === id);
        if (!o) continue;
        const q = boxPx(openingBox(o));
        const isSel = sel && sel.kind === "opening" && sel.id === id;
        rr(q.x - 4, q.y - 4, q.w + 8, q.h + 8, 4);
        ctx.fillStyle = isSel ? "rgba(22, 182, 201, 0.22)" : "rgba(22, 182, 201, 0.14)"; ctx.fill();
        ctx.strokeStyle = ACCENT_HI; ctx.lineWidth = isSel ? 1.8 : 1.2; ctx.stroke();
        if (drag && (drag.moved || drag.type === "palette") && (drag.hit ? drag.hit.id === id : true)) {
          const c = openingCentre(o);
          chips.push({ cls: "edge", text: HP.fmtM(o.w) + " m", x: SX(c[0]) + (o.axis === "x" ? 0 : -30), y: SY(c[1]) + (o.axis === "x" ? -24 : 0) });
        }
      }
    }

    // ---- sections: end grips when hovered/selected
    if (tool !== "plot") {
      for (const s of plan.sections || []) {
        const on = (hvT && hvT.t === "section" && hvT.id === s.id) || (sel && sel.kind === "section" && sel.id === s.id) || (drag && drag.hit && drag.hit.t === "section" && drag.hit.id === s.id);
        if (!on) continue;
        for (const part of ["a", "b"]) {
          const p = s[part], x = SX(p[0]), y = SY(p[1]);
          const hot = (hvT && hvT.t === "section" && hvT.id === s.id && hvT.part === part) || (drag && drag.hit && drag.hit.id === s.id && drag.hit.part === part);
          ctx.beginPath(); ctx.arc(x, y, hot ? 9 : 7, 0, Math.PI * 2);
          ctx.fillStyle = hot ? "rgba(70, 224, 240, 0.35)" : "rgba(15, 22, 32, 0.6)"; ctx.fill();
          ctx.strokeStyle = ACCENT_HI; ctx.lineWidth = 1.5; ctx.stroke();
        }
      }
    }

    // ---- the land tool: corners, edges, live edge lengths
    if (tool === "plot") {
      const pts = plan.plot.pts, n = pts.length;
      const area = HP.polyArea(pts);
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const hot = hvT && hvT.t === "edge" && hvT.i === i;
        if (hot) {
          ctx.strokeStyle = "rgba(70, 224, 240, 0.8)"; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(SX(a[0]), SY(a[1])); ctx.lineTo(SX(b[0]), SY(b[1])); ctx.stroke();
        }
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        // outward normal of a CCW polygon is to the right of a->b
        let nx = (b[1] - a[1]) / (len || 1), ny = -(b[0] - a[0]) / (len || 1);
        if (area < 0) { nx = -nx; ny = -ny; }
        const mx = SX((a[0] + b[0]) / 2) + nx * 22, my = SY((a[1] + b[1]) / 2) - ny * 22;
        const kind = (plan.plot.edges || [])[i];
        chips.push({ cls: "edge" + (kind === "street" ? " is-street" : ""), text: HP.fmtM(len) + " m", x: mx, y: my });
      }
      pts.forEach((p, i) => {
        const x = SX(p[0]), y = SY(p[1]);
        const isSel = sel && sel.kind === "plot" && sel.id === i;
        const hot = (hvT && hvT.t === "corner" && hvT.i === i) || (drag && drag.hit && drag.hit.t === "corner" && drag.hit.i === i);
        ctx.beginPath(); ctx.arc(x, y, hot ? 8.5 : 7, 0, Math.PI * 2);
        ctx.fillStyle = isSel ? ACCENT : "#0f1620"; ctx.fill();
        ctx.strokeStyle = hot || isSel ? ACCENT_HI : ACCENT; ctx.lineWidth = 2; ctx.stroke();
      });
    }

    // ---- ghosts and chips of the gesture
    const g = drag && drag.ghost;
    if (g) {
      ctx.save();
      ctx.fillStyle = "rgba(229, 83, 75, 0.22)"; ctx.strokeStyle = BAD; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      if (g.kind === "rect") {
        const q = roomRectPx(g); ctx.fillRect(q.x, q.y, q.w, q.h); ctx.strokeRect(q.x + 1, q.y + 1, q.w - 2, q.h - 2);
      } else if (g.kind === "bar") {
        const L = SL(g.len), T = Math.max(7, SL(g.thick || 20));
        const x = SX(g.c[0]), y = SY(g.c[1]);
        ctx.setLineDash([]);
        if (g.axis === "x") rr(x - L / 2, y - T / 2, L, T, 3); else rr(x - T / 2, y - L / 2, T, L, 3);
        ctx.fill(); ctx.stroke();
      } else if (g.kind === "dot") {
        ctx.setLineDash([]); ctx.beginPath(); ctx.arc(SX(g.c[0]), SY(g.c[1]), 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
    if (drag && drag.chips) for (const c of drag.chips) {
      const x = c.w ? SX(c.w[0]) + (c.dx || 0) : c.x, y = c.w ? SY(c.w[1]) + (c.dy || 0) : c.y;
      chips.push({ cls: c.cls, text: c.text, x, y, left: c.left, arrow: c.arrow });
    }
  }

  // ------------------------------------------------------------------ DOM layer (chips, empty hint)
  function domLayer(plan, A, chips) {
    let i = 0;
    for (const c of chips) {
      let el = chipPool[i];
      if (!el) { el = document.createElement("div"); ov.appendChild(el); chipPool.push(el); el._k = ""; el._t = ""; }
      const k = "hp-chip hp-chip--" + c.cls + (c.left ? " is-left" : "") + (c.arrow ? " has-arrow-" + c.arrow : "");
      if (el._k !== k) { el.className = k; el._k = k; }
      if (el._t !== c.text) { el.textContent = c.text; el._t = c.text; }
      const x = clamp(c.x, 4, W - 4), y = clamp(c.y, 4, H - 4);
      el.style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px)";
      if (el.style.display === "none") el.style.display = "";
      i++;
    }
    for (; i < chipPool.length; i++) if (chipPool[i].style.display !== "none") chipPool[i].style.display = "none";

    // the calm hint in the middle of an empty land
    const empty = plan && plan.rooms.length === 0 && !(drag && drag.type === "palette" && drag.last && drag.last.ok);
    if (empty) {
      const pts = plan.plot.pts;
      let cx = 0, cy = 0; for (const p of pts) { cx += p[0]; cy += p[1]; }
      cx /= pts.length; cy /= pts.length;
      const x = clamp(SX(cx), 140, Math.max(140, W - 140)), y = clamp(SY(cy), 60, Math.max(60, H - 60));
      hintEl.style.transform = "translate(" + x.toFixed(0) + "px," + y.toFixed(0) + "px)";
      if (!hintEl.classList.contains("is-on")) hintEl.classList.add("is-on");
    } else if (hintEl.classList.contains("is-on")) hintEl.classList.remove("is-on");
  }

  // ------------------------------------------------------------------ size
  function resize(w, h) {
    const d = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (w === W && h === H && d === dpr) return;
    if (W && H) { VIEW.ox += (w - W) / 2; VIEW.oy += (h - H) / 2; }   // keep the middle in the middle
    W = w; H = h; dpr = d;
    cv.width = Math.round(w * d); cv.height = Math.round(h * d);
    cv.style.width = w + "px"; cv.style.height = h + "px";
    refreshRect();
    if (needFit) fit();
    redraw();
  }

  // ------------------------------------------------------------------ init
  function init(stageEl) {
    if (inited) return;
    stage = stageEl;
    stage.classList.add("hp-stage");
    cv = document.createElement("canvas");
    cv.className = "hp-board";
    cv.tabIndex = 0;
    cv.setAttribute("role", "application");
    cv.setAttribute("aria-label", "Drawing board. Drag rooms here from the left.");
    ov = document.createElement("div");
    ov.className = "hp-ov";
    hintEl = document.createElement("div");
    hintEl.className = "hp-empty";
    const h1 = document.createElement("div"); h1.className = "hp-empty__big"; h1.textContent = "Drag a room from the left onto the land.";
    const h2 = document.createElement("div"); h2.className = "hp-empty__small"; h2.textContent = "Then drag its walls to make it the size you want.";
    hintEl.append(h1, h2);
    tipEl = document.createElement("div"); tipEl.className = "hp-tip";
    menuEl = document.createElement("div"); menuEl.className = "hp-menu"; menuEl.setAttribute("role", "menu");
    ov.append(hintEl, tipEl, menuEl);
    stage.append(cv, ov);
    ctx = cv.getContext("2d");
    try {
      const f = getComputedStyle(document.documentElement).getPropertyValue("--sans").trim();
      if (f) font = f;
    } catch (e) { /* default font */ }

    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointercancel", onCancel);
    cv.addEventListener("pointerleave", () => { if (!drag) { hoverT = null; HP.store.setHover(null); hideTip(); setCursor(spaceDown ? "grab" : "default"); requestDraw(); } });
    cv.addEventListener("wheel", onWheel, { passive: false });
    cv.addEventListener("dblclick", onDbl);
    cv.addEventListener("contextmenu", onContext);
    cv.addEventListener("auxclick", e => { if (e.button === 1) e.preventDefault(); });
    ov.addEventListener("contextmenu", e => e.preventDefault());
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("pointerdown", e => { if (menuOpen && !menuEl.contains(e.target)) closeMenu(); }, true);
    window.addEventListener("blur", () => { spaceDown = false; closeMenu(); hideTip(); if (drag && drag.type !== "palette") cancelDrag(); });
    window.addEventListener("resize", () => { const r = stage.getBoundingClientRect(); resize(r.width, r.height); });
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(ents => { const r = ents[0].contentRect; resize(r.width, r.height); }).observe(stage);
    }

    HP.store.on("state", () => { if (!drag && hoverT && lastPtr) { hoverT = null; updateHover(lastPtr, true); } requestDraw(); });
    let lastTool = HP.store.tool();
    HP.store.on("select", () => {          // also fired when the tool changes: what is under the pointer may differ
      const t = HP.store.tool();
      if (t !== lastTool) {
        lastTool = t;
        hideTip();
        if (!drag && lastPtr) { hoverT = null; updateHover(lastPtr, true); }
      }
      requestDraw();
    });
    HP.store.on("hover", requestDraw);
    HP.store.on("palette:start", e => startPalette(e && e.item, e && e.event));
    HP.store.on("palette:click", e => clickPalette(e && e.item));

    inited = true;
    const r = stage.getBoundingClientRect();
    needFit = true;
    resize(r.width, r.height);
  }

  // ------------------------------------------------------------------ measurement (dev / tests)
  function summary(list) {
    if (!list.length) return null;
    const pick = k => { const v = list.map(f => f[k]).sort((a, b) => a - b); return { med: +v[Math.floor(v.length / 2)].toFixed(2), p95: +v[Math.min(v.length - 1, Math.floor(v.length * 0.95))].toFixed(2), max: +v[v.length - 1].toFixed(2) }; };
    return { n: list.length, total: pick("total"), op: pick("op"), analyze: pick("analyze"), build: pick("build"), render: pick("render"), overlay: pick("overlay") };
  }

  HP.canvas = {
    init, fit, zoomBy, focus, toWorld, redraw,
    rev: 8,
    // read-only helpers for the panels / tests
    view: () => ({ scale: VIEW.scale, ox: VIEW.ox, oy: VIEW.oy, w: W, h: H }),
    _debug: {
      hit: (sx, sy) => hitTest(sx, sy),
      setView: (s, ox, oy) => setView(s, ox, oy),
      perf: () => ({ all: summary(perf.frames), drag: summary(perf.frames.filter(f => f.drag)) }),
      resetPerf: () => { perf.frames.length = 0; },
      labels: () => labels,
      dragging: () => (drag ? { type: drag.type || drag.hit.t, moved: drag.moved, ghost: drag.ghost, chips: drag.chips } : null),
      buildError: () => buildError,
    },
  };
})(globalThis.HP = globalThis.HP || {});

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.HP;
