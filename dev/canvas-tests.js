"use strict";
/* ============================================================================
   House Planner - dev/canvas-tests.js  (canvas agent, DEV ONLY)
   ----------------------------------------------------------------------------
   Drives the REAL board with dispatched PointerEvents / KeyboardEvents and
   checks the result through HP.store. Works on dev/canvas-dev.html and on
   index.html. In the browser console (or injected):
       await CT.run()      -> [{name, ok, detail}]
       await CT.bench()    -> redraw / drag frame times
   Every test starts from the shared sample plan.
============================================================================ */
(function () {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const board = () => document.querySelector(".hp-board");
  let SAMPLE = null;
  async function sample() {     // the server's root is the planner folder
    if (!SAMPLE) SAMPLE = await (await fetch("/test/fixtures/sample-house.json", { cache: "no-store" })).text();
    return SAMPLE;
  }
  async function fresh() {
    const t = await sample();
    if (HP.store.tool() !== "select") HP.store.setTool("select");
    HP.store.load(HP.deserialize(t), "Open");
    HP.store.select(null);
    HP.canvas.fit();
    HP.canvas.redraw();
  }
  // world cm -> client px
  function P(x, y) {
    const r = board().getBoundingClientRect(), v = HP.canvas.view();
    return [r.left + v.ox + x / 100 * v.scale, r.top + v.oy - y / 100 * v.scale];
  }
  function fire(type, at, o) {
    o = o || {};
    const init = Object.assign({
      clientX: at[0], clientY: at[1], pointerId: 7, pointerType: "mouse", isPrimary: true,
      button: type === "pointermove" ? -1 : (o.button || 0), buttons: type === "pointerup" ? 0 : (type === "pointermove" && !o.down ? 0 : 1),
      bubbles: true, cancelable: true, composed: true,
    }, o);
    const tgt = o.target || (type.startsWith("pointer") && o.doc ? document.elementFromPoint(at[0], at[1]) : board());
    const e = type === "wheel" ? new WheelEvent("wheel", init) : type === "dblclick" || type === "contextmenu" ? new MouseEvent(type, init) : new PointerEvent(type, init);
    tgt.dispatchEvent(e);
    return e;
  }
  const key = (k, o) => document.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, o || {})));
  const keyUp = (k, o) => document.dispatchEvent(new KeyboardEvent("keyup", Object.assign({ key: k, bubbles: true, cancelable: true }, o || {})));
  /* press at `from`, move in `steps` to `to` (calling mid(i) after each move), release */
  async function drag(from, to, opts) {
    opts = opts || {};
    const steps = opts.steps || 10, times = [];
    fire("pointermove", from);
    fire("pointerdown", from, opts.ev);
    let midOut = null;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, at = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      const a = performance.now();
      fire("pointermove", at, Object.assign({ down: true }, opts.ev || {}));
      times.push(performance.now() - a);
      if (opts.mid && i === steps) midOut = opts.mid();
    }
    if (opts.cancel) { key("Escape"); }
    else fire("pointerup", to, opts.ev);
    return { times, mid: midOut };
  }
  const room = id => HP.store.get().rooms.find(r => r.id === id);
  const opening = id => HP.store.get().openings.find(o => o.id === id);
  const A = () => HP.store.analysis();
  const labelCentre = id => { const b = HP.canvas._debug.labels()[id]; const r = board().getBoundingClientRect(); return b ? [r.left + (b.x0 + b.x1) / 2, r.top + (b.y0 + b.y1) / 2] : null; };
  const chips = () => [...document.querySelectorAll(".hp-chip")].filter(e => e.style.display !== "none").map(e => ({ cls: e.className, text: e.textContent }));
  const med = a => { const s = a.slice().sort((x, y) => x - y); return +s[s.length >> 1].toFixed(2); };
  const mx = a => +Math.max(...a).toFixed(2);

  const T = [];
  const test = (name, fn) => T.push({ name, fn });

  test("pan by dragging empty background", async () => {
    await fresh();
    const v0 = HP.canvas.view();
    const r = board().getBoundingClientRect();
    const from = [r.left + 15, r.top + r.height - 15];
    await drag(from, [from[0] + 120, from[1] - 40]);
    const v1 = HP.canvas.view();
    return { ok: Math.abs(v1.ox - v0.ox - 120) < 1 && Math.abs(v1.oy - v0.oy + 40) < 1, detail: { dox: v1.ox - v0.ox, doy: v1.oy - v0.oy } };
  });

  test("Space + drag pans even over a room name; middle-drag pans", async () => {
    await fresh();
    const r6 = Object.assign({}, room("r6"));
    const v0 = HP.canvas.view();
    key(" ");
    const c = labelCentre("r6");
    await drag(c, [c[0] + 60, c[1] + 30]);
    keyUp(" ");
    const v1 = HP.canvas.view();
    await drag([c[0] + 60, c[1] + 30], [c[0] + 160, c[1] + 30], { ev: { button: 1, buttons: 4 } });
    const v2 = HP.canvas.view();
    const n = room("r6");
    return { ok: Math.abs(v1.ox - v0.ox - 60) < 1 && Math.abs(v2.ox - v1.ox - 100) < 1 && n.x === r6.x && n.y === r6.y,
             detail: { d1: v1.ox - v0.ox, d2: v2.ox - v1.ox, moved: n.x !== r6.x } };
  });

  test("Esc clears the selection", async () => {
    await fresh();
    HP.store.select({ kind: "room", id: "r2" });
    key("Escape");
    return { ok: HP.store.selection() === null, detail: HP.store.selection() };
  });

  test("hover on a door: grab cursor and the door glows (store hover)", async () => {
    await fresh();
    const g = A().openings.find(o => o.id === "o21");
    fire("pointermove", P((g.s0 + g.s1) / 2, (g.fixed + g.far) / 2));
    return { ok: board().style.cursor === "grab" && HP.store.hover() && HP.store.hover().id === "o21", detail: { cur: board().style.cursor, hover: HP.store.hover() } };
  });

  test("wheel zooms about the cursor", async () => {
    await fresh();
    const at = P(500, 1000).map(Math.round);       // a WheelEvent's clientX/Y are whole pixels
    const before = HP.canvas.toWorld(at[0], at[1]);
    const s0 = HP.canvas.view().scale;
    fire("wheel", at, { deltaY: -240, deltaMode: 0 });
    const after = HP.canvas.toWorld(at[0], at[1]);
    const s1 = HP.canvas.view().scale;
    return { ok: s1 > s0 * 1.2 && Math.hypot(after[0] - before[0], after[1] - before[1]) < 0.5, detail: { s0, s1, before, after } };
  });

  test("keys F, +, - change the zoom", async () => {
    await fresh();
    const s0 = HP.canvas.view().scale;
    key("+"); const s1 = HP.canvas.view().scale;
    key("-"); key("-"); const s2 = HP.canvas.view().scale;
    key("f"); const s3 = HP.canvas.view().scale;
    return { ok: s1 > s0 && s2 < s1 && Math.abs(s3 - s0) < 0.01, detail: { s0, s1, s2, s3 } };
  });

  test("hover on a room name shows the grab cursor", async () => {
    await fresh();
    const c = labelCentre("r6");
    fire("pointermove", c);
    const cur = board().style.cursor;
    return { ok: cur === "grab" && JSON.stringify(HP.store.hover()) === JSON.stringify({ kind: "room", id: "r6" }), detail: { cur, hover: HP.store.hover() } };
  });

  test("drag a room name onto another room swaps them", async () => {
    await fresh();
    const r6 = Object.assign({}, room("r6")), r8 = Object.assign({}, room("r8"));
    const out = await drag(labelCentre("r6"), P(r8.x + r8.w / 2, r8.y + r8.h / 2), { mid: () => ({ chips: chips(), preview: HP.store.get() !== HP.store.committed() }) });
    const a = room("r6"), b = room("r8");
    return { ok: a.x === r8.x && a.y === r8.y && b.x === r6.x && b.y === r6.y && HP.store.selection() && HP.store.selection().id === "r6" && HP.store.undoLabel() === "Swap rooms" && out.mid.chips.some(c => /swap/.test(c.cls)),
             detail: { r6: [a.x, a.y], r8: [b.x, b.y], mid: out.mid, label: HP.store.undoLabel(), ms: med(out.times) } };
  });

  test("drag a room name into the garden moves it (no overlap, inside the land)", async () => {
    await fresh();
    const r3 = Object.assign({}, room("r3"));
    const out = await drag(labelCentre("r3"), P(300, 350), { steps: 14 });
    const n = room("r3"), A2 = A();
    const okRule = (A2.rules.find(r => r.id === "fits") || { ok: true }).ok;
    return { ok: (n.x !== r3.x || n.y !== r3.y) && n.y + n.h < 700 && okRule && HP.store.undoLabel() === "Move room", detail: { from: [r3.x, r3.y], to: [n.x, n.y], fits: okRule, ms: med(out.times), max: mx(out.times) } };
  });

  test("Esc during a room move cancels it", async () => {
    await fresh();
    const before = HP.store.committed();
    await drag(labelCentre("r3"), P(300, 350), { cancel: true });
    // release after the cancel must not commit anything
    fire("pointerup", P(300, 350));
    return { ok: HP.store.get() === before && HP.store.committed() === before, detail: { same: HP.store.get() === before } };
  });

  test("drag the wall between Bedroom 1 and Bedroom 2: both resize, live read-outs", async () => {
    await fresh();
    const h = A().handles.find(q => q.orient === "v" && q.members.some(m => m.room === "r6" && m.side === "E") && q.members.some(m => m.room === "r7"));
    const y = 1660;
    fire("pointermove", P(h.pos, y));
    const cur = board().style.cursor;
    const out = await drag(P(h.pos, y), P(h.pos + 52, y), { mid: () => chips() });
    const a = room("r6"), b = room("r7");
    return { ok: cur === "col-resize" && a.w === 360 && b.x === 400 && b.w === 250 && out.mid.filter(c => /size/.test(c.cls)).length >= 2,
             detail: { cur, r6w: a.w, r7: [b.x, b.w], chips: out.mid, ms: med(out.times), max: mx(out.times) } };
  });

  test("Alt + wall drag moves one room only (living room's back wall, the others stay)", async () => {
    await fresh();
    // the long wall between the front rooms and the open area; press just below its centre
    // line inside the living room's span, so the living room is the one that moves
    const h = A().handles.find(q => q.orient === "h" && q.members.some(m => m.room === "r1" && m.side === "N"));
    const out = await drag(P(200, h.pos - 4), P(200, h.pos - 104), { ev: { altKey: true }, mid: () => chips() });
    const a = room("r1"), b = room("r2"), o = room("r5");
    // the model only allows a real passage (2 x 0.20 + 1.00) or a shared wall: -100 snaps to -120
    return { ok: a.h === 350 && b.h === 470 && o.y === 1210, detail: { r1h: a.h, r2h: b.h, r5y: o.y, undo: HP.store.undoLabel(), chips: out.mid } };
  });

  test("drag a door along its wall", async () => {
    await fresh();
    const g = A().openings.find(o => o.id === "o19");
    const c = [(g.s0 + g.s1) / 2, (g.fixed + g.far) / 2];
    // +30 cm: the bedroom's window starts 1.20 m further on, so this is free wall
    const out = await drag(P(c[0], c[1]), P(c[0] + 30, c[1]));
    const g2 = A().openings.find(o => o.id === "o19");
    return { ok: g2.s0 === g.s0 + 30 && g2.axis === g.axis && g2.fixed + g2.far === g.fixed + g.far && HP.store.undoLabel() === "Move door",
             detail: { before: [g.room, g.side, g.s0], after: [g2.room, g2.side, g2.s0, opening("o19").swing], ms: med(out.times) } };
  });

  test("drag a door onto a neighbour wall: red ghost + reason, last legal kept", async () => {
    await fresh();
    const g = A().openings.find(o => o.id === "o19");
    const c = [(g.s0 + g.s1) / 2, (g.fixed + g.far) / 2];
    // the west wall of Bedroom 1 faces the neighbour
    const out = await drag(P(c[0], c[1]), P(10, 1700), { steps: 12, mid: () => ({ dbg: HP.canvas._debug.dragging(), chips: chips() }) });
    const o = opening("o19");
    const ghost = out.mid.dbg && out.mid.dbg.ghost;
    const reason = out.mid.chips.find(c => /reason/.test(c.cls));
    return { ok: !!ghost && !!reason && o.side === "S", detail: { ghost, reason, o } };
  });

  test("double-click a door flips its swing", async () => {
    await fresh();
    const g = A().openings.find(o => o.id === "o19");
    const c = P((g.s0 + g.s1) / 2, (g.fixed + g.far) / 2);
    const s0 = opening("o19").swing;
    fire("dblclick", c, { buttons: 0 });
    return { ok: opening("o19").swing !== s0, detail: { before: s0, after: opening("o19").swing } };
  });

  test("right-click a door gives a context menu; Flip hinge works", async () => {
    await fresh();
    const g = A().openings.find(o => o.id === "o19");
    const c = P((g.s0 + g.s1) / 2, (g.fixed + g.far) / 2);
    fire("contextmenu", c, { button: 2, buttons: 2 });
    const menu = document.querySelector(".hp-menu");
    const items = [...menu.querySelectorAll(".hp-menu__item")].map(b => b.textContent);
    const btn = [...menu.querySelectorAll(".hp-menu__item")].find(b => /hinge/i.test(b.textContent));
    const h0 = opening("o19").hinge;
    if (btn) btn.click();
    return { ok: menu.classList.length && items.length >= 3 && opening("o19").hinge !== h0 && !menu.classList.contains("is-on"), detail: { items, h0, h1: opening("o19").hinge } };
  });

  test("click a room body selects it; Delete removes it; Ctrl-free undo via store", async () => {
    await fresh();
    const r = room("r2");
    const c = P(r.x + 30, r.y + 30);
    fire("pointerdown", c); fire("pointerup", c);
    const sel = HP.store.selection();
    key("Delete");
    const gone = !room("r2");
    HP.store.undo();
    return { ok: sel && sel.id === "r2" && gone && !!room("r2"), detail: { sel, gone } };
  });

  test("arrow keys nudge the selected room 5 cm / Shift 50 cm", async () => {
    await fresh();
    // move WC into the garden first so it has free space round it
    await drag(labelCentre("r3"), P(300, 350), { steps: 10 });
    const x0 = room("r3").x;
    HP.store.select({ kind: "room", id: "r3" });
    key("ArrowRight");
    const x1 = room("r3").x;
    key("ArrowRight", { shiftKey: true });
    const x2 = room("r3").x;
    return { ok: x1 === x0 + 5 && x2 === x1 + 50, detail: { x0, x1, x2 } };
  });

  test("palette drag of a Bedroom onto the garden previews then commits and selects it", async () => {
    await fresh();
    const n0 = HP.store.get().rooms.length;
    const tgt = P(500, 350);
    const startEv = new PointerEvent("pointermove", { clientX: 30, clientY: 200, pointerId: 9, buttons: 1, isPrimary: true });
    HP.store.emit("palette:start", { item: { kind: "room", type: "bedroom" }, event: startEv });
    const times = [];
    for (let i = 1; i <= 8; i++) {
      const at = [30 + (tgt[0] - 30) * i / 8, 200 + (tgt[1] - 200) * i / 8];
      const a = performance.now();
      fire("pointermove", at, { pointerId: 9, down: true, doc: true });
      times.push(performance.now() - a);
    }
    const mid = { rooms: HP.store.get().rooms.length, committed: HP.store.committed().rooms.length };
    fire("pointerup", tgt, { pointerId: 9, doc: true });
    const sel = HP.store.selection();
    const nr = HP.store.get().rooms.find(r => r.type === "bedroom" && r.id === (sel && sel.id));
    const ops = nr ? HP.store.get().openings.filter(o => o.room === nr.id) : [];
    return { ok: mid.rooms === n0 + 1 && mid.committed === n0 && HP.store.get().rooms.length === n0 + 1 && !!nr, detail: { mid, sel, room: nr, openings: ops.map(o => o.kind + " " + o.side + " " + o.w), ms: med(times), max: mx(times) } };
  });

  test("palette drag released outside the board cancels", async () => {
    await fresh();
    const before = HP.store.committed();
    HP.store.emit("palette:start", { item: { kind: "room", type: "kitchen" }, event: new PointerEvent("pointermove", { clientX: 30, clientY: 200, pointerId: 9, buttons: 1 }) });
    fire("pointermove", P(500, 350), { pointerId: 9, down: true, doc: true });
    const mid = HP.store.get() !== before;
    const r = board().getBoundingClientRect();
    fire("pointermove", [r.left - 40, r.top + 100], { pointerId: 9, down: true, target: document.body });
    fire("pointerup", [r.left - 40, r.top + 100], { pointerId: 9, target: document.body });
    return { ok: mid && HP.store.get() === before && HP.store.committed() === before, detail: { mid } };
  });

  test("palette drag of a window onto a neighbour wall shows a red ghost and reason", async () => {
    await fresh();
    HP.store.emit("palette:start", { item: { kind: "window", w: 120 }, event: new PointerEvent("pointermove", { clientX: 30, clientY: 200, pointerId: 9, buttons: 1 }) });
    fire("pointermove", P(10, 1650), { pointerId: 9, down: true, doc: true });
    const d = HP.canvas._debug.dragging();
    const ch = chips();
    key("Escape");
    return { ok: !!(d && d.ghost) && ch.some(c => /reason/.test(c.cls)) && !HP.canvas._debug.dragging(), detail: { ghost: d && d.ghost, chips: ch } };
  });

  test("palette click adds at the centre of the view and selects it", async () => {
    await fresh();
    const v = HP.canvas.view();
    // look at the garden so the centre of the view is free land
    HP.canvas._debug.setView(v.scale, v.w / 2 - 5 * v.scale, v.h / 2 + 3.5 * v.scale);
    const n0 = HP.store.get().rooms.length;
    HP.store.emit("palette:click", { item: { kind: "room", type: "wc" } });
    const sel = HP.store.selection();
    return { ok: HP.store.get().rooms.length === n0 + 1 && sel && sel.kind === "room", detail: { sel } };
  });

  test("section: drag the line, drag an end, click a head flips", async () => {
    await fresh();
    const s0 = JSON.parse(JSON.stringify(HP.store.get().sections[0]));
    // grab the line in the garden (where it crosses a room's name, the name wins)
    await drag(P(s0.a[0], 640), P(s0.a[0] + 100, 640));
    const s1 = HP.store.get().sections[0];
    await drag(P(s1.b[0], s1.b[1]), P(s1.b[0], s1.b[1] - 200));
    const s2 = HP.store.get().sections[0];
    const head = P(s2.a[0], s2.a[1]);
    fire("pointerdown", head); fire("pointerup", head);
    const s3 = HP.store.get().sections[0];
    return { ok: s1.a[0] === s0.a[0] + 100 && s2.b[1] === s1.b[1] - 200 && s3.look === -s2.look, detail: { s0, s1, s2, s3 } };
  });

  test("land tool: drag a corner, double-click an edge adds one, Delete removes it", async () => {
    await fresh();
    HP.store.setTool("plot");
    HP.canvas.redraw();
    const pts0 = HP.store.get().plot.pts.map(p => p.slice());
    await drag(P(1000, 1900), P(1100, 1950));
    const pts1 = HP.store.get().plot.pts.map(p => p.slice());
    const edgeChips = chips().filter(c => /edge/.test(c.cls)).map(c => c.text);
    // double-click the middle of the left edge (corner 3 -> 0)
    fire("dblclick", P(0, 950), { buttons: 0 });
    const pts2 = HP.store.get().plot.pts.length;
    const sel = HP.store.selection();
    key("Delete");
    const pts3 = HP.store.get().plot.pts.length;
    HP.store.setTool("select");
    return { ok: pts1[2][0] === 1100 && pts1[2][1] === 1950 && pts2 === 5 && pts3 === 4 && edgeChips.length === 4,
             detail: { pts0, pts1, pts2, pts3, sel, edgeChips } };
  });

  test("focus(ids) flashes and keeps the target on screen", async () => {
    await fresh();
    HP.canvas._debug.setView(80, -2000, 600);       // look far away
    HP.canvas.focus(["r5"]);
    await sleep(450);
    const v = HP.canvas.view(), r = room("r5");
    const sx = v.ox + (r.x + r.w / 2) / 100 * v.scale, sy = v.oy - (r.y + r.h / 2) / 100 * v.scale;
    return { ok: sx > 0 && sx < v.w && sy > 0 && sy < v.h, detail: { sx, sy, v } };
  });

  test("empty plan shows the hint", async () => {
    HP.store.load(HP.newPlan(), "New");
    HP.canvas.fit(); HP.canvas.redraw();
    const el = document.querySelector(".hp-empty");
    const on = el.classList.contains("is-on") && getComputedStyle(el).visibility === "visible";
    await fresh();
    const off = !el.classList.contains("is-on");
    return { ok: on && off, detail: { text: el.textContent } };
  });

  async function run(only) {
    const out = [];
    for (const t of T) {
      if (only && !t.name.includes(only)) continue;
      let r;
      try { r = await t.fn(); } catch (e) { r = { ok: false, detail: String(e && e.stack || e) }; }
      out.push({ name: t.name, ok: !!r.ok, detail: r.detail });
      key("Escape");
    }
    await fresh();
    return out;
  }

  /* frame times: redraw at the fit zoom and zoomed in, and drag steps (model op + analyze + drawing + render) */
  async function bench() {
    await fresh();
    const cv = board(), ctx = cv.getContext("2d");
    const readback = () => ctx.getImageData(0, 0, 1, 1);     // waits for the GPU: the honest cost
    const t = (fn, n) => { const a = []; for (let i = 0; i < n; i++) { const s = performance.now(); fn(i); a.push(performance.now() - s); } return { med: med(a), max: mx(a) }; };
    t(() => { HP.canvas.redraw(); readback(); }, 5);
    const fitFrame = t(() => { HP.canvas.redraw(); readback(); }, 40);
    const v = HP.canvas.view();
    HP.canvas._debug.setView(v.scale * 3, v.w / 2 - 5 * v.scale * 3, v.h / 2 + 13 * v.scale * 3);
    const zoomFrame = t(() => { HP.canvas.redraw(); readback(); }, 40);
    // full pipeline on a NEW plan object each time (nothing cached)
    const plan = HP.store.get();
    const ctxv = HP.canvas.view();
    const fullNew = t(() => {
      const p = HP.clone(plan);
      const A = HP.analyze(p), d = HP.drawing.build(p, A, {});
      HP.render.draw(ctx, d, { scale: ctxv.scale, ox: ctxv.ox, oy: ctxv.oy, dpr: devicePixelRatio, w: ctxv.w, h: ctxv.h }, { labels: {} });
      readback();
    }, 30);
    HP.canvas.fit();
    // a real wall drag: per pointermove = dragWall + preview + analyze + build + render (+ readback)
    const h = HP.store.analysis().handles.find(q => q.orient === "v" && q.members.some(m => m.room === "r6" && m.side === "E"));
    const from = P(h.pos, 1660);
    fire("pointerdown", from);
    const wall = [];
    for (let i = 1; i <= 30; i++) {
      const s = performance.now();
      fire("pointermove", [from[0] + (i % 2 ? 2 : -2) + i * 0.8, from[1]], { down: true });
      readback();
      wall.push(performance.now() - s);
    }
    key("Escape"); fire("pointerup", from);
    // a room-name drag across the garden
    const rc = labelCentre("r3");
    const tgt = P(500, 300);
    fire("pointerdown", rc);
    const move = [];
    for (let i = 1; i <= 30; i++) {
      const s = performance.now();
      fire("pointermove", [rc[0] + (tgt[0] - rc[0]) * i / 30, rc[1] + (tgt[1] - rc[1]) * i / 30], { down: true });
      readback();
      move.push(performance.now() - s);
    }
    key("Escape"); fire("pointerup", rc);
    const items = HP.drawing.build(plan, HP.store.analysis(plan), {}).items;
    await fresh();
    return { items: items.length, inserts: items.filter(i => i.kind === "insert").length, furniture: HP.furniture && HP.furniture._stub ? "stand-in" : "real",
             redrawFit: fitFrame, redrawZoom3x: zoomFrame, fullPipelineNewPlan: fullNew,
             wallDragStep: { med: med(wall), max: mx(wall) }, roomMoveStep: { med: med(move), max: mx(move) } };
  }

  window.CT = { run, bench, fresh, P, fire, drag, key, chips, labelCentre };
})();
