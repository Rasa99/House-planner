"use strict";
/* ============================================================================
   House Planner - store.js
   ----------------------------------------------------------------------------
   The one place the current plan lives, plus undo/redo, selection, a tiny
   event bus and autosave. Plans are never mutated: every edit makes a new
   plan object (HP.model ops do that) and hands it here.

   Drag pattern (canvas.js):
       const start = HP.store.get();                   // on pointerdown
       HP.store.preview(HP.model.moveRoom(start, id, x, y).state);   // each move
       HP.store.commit(HP.store.get(), "Move room");   // on pointerup
       HP.store.cancel();                              // on Esc
   preview() changes what is shown without touching the undo history; commit()
   records the last committed plan on the undo stack.

   Events (HP.store.on(name, fn) returns an unsubscribe function):
     'state'    {preview:bool, label}  the plan changed (preview or commit)
     'select'   sel                    selection changed
     'hover'    hov                    hover target changed (canvas sets it)
     'view'     {scale, ox, oy}        zoom/pan changed (canvas emits it; scale = px per metre)
     'message'  {text, level}          a toast: level 'info'|'ok'|'warn'|'error'
     'palette:start' {item, event}     a drag began on a side-panel tile
     'palette:click' {item}            a side-panel tile was clicked (no drag)
============================================================================ */
(function (HP) {
  const KEY = "houseplanner.autosave.v1";
  const MAX_UNDO = 200;
  const listeners = {};
  const S = {
    committed: null, current: null, undo: [], redo: [],
    sel: null,     // { kind: 'room'|'opening'|'section'|'plot', id }  (plot: id = corner index or null)
    hover: null,
    tool: "select", // 'select' | 'plot' (editing the land corners)
  };
  const cache = new WeakMap();
  let saveTimer = null;

  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
    return () => { listeners[evt] = (listeners[evt] || []).filter(f => f !== fn); };
  }
  function emit(evt, payload) {
    (listeners[evt] || []).slice().forEach(fn => {
      try { fn(payload); } catch (e) { console.error("[store] listener for " + evt + " failed", e); }
    });
  }

  const get = () => S.current;
  const committed = () => S.committed;

  function preview(next) {
    if (!next || next === S.current) return;
    S.current = next;
    emit("state", { preview: true });
  }
  function cancel() {
    if (S.current === S.committed) return;
    S.current = S.committed;
    emit("state", { preview: false, label: "cancel" });
  }
  function commit(next, label) {
    next = next || S.current;
    if (next === S.committed) { S.current = next; return false; }
    S.undo.push({ state: S.committed, label: label || "Edit" });
    if (S.undo.length > MAX_UNDO) S.undo.shift();
    S.redo.length = 0;
    S.committed = S.current = next;
    dropStaleSelection();
    emit("state", { preview: false, label });
    autosave();
    return true;
  }
  function undo() {
    if (!S.undo.length) return false;
    const u = S.undo.pop();
    S.redo.push({ state: S.committed, label: u.label });
    S.committed = S.current = u.state;
    dropStaleSelection();
    emit("state", { preview: false, label: "Undo " + u.label });
    autosave();
    return true;
  }
  function redo() {
    if (!S.redo.length) return false;
    const r = S.redo.pop();
    S.undo.push({ state: S.committed, label: r.label });
    S.committed = S.current = r.state;
    dropStaleSelection();
    emit("state", { preview: false, label: "Redo " + r.label });
    autosave();
    return true;
  }
  const canUndo = () => S.undo.length > 0;
  const canRedo = () => S.redo.length > 0;
  const undoLabel = () => (S.undo.length ? S.undo[S.undo.length - 1].label : "");
  const redoLabel = () => (S.redo.length ? S.redo[S.redo.length - 1].label : "");

  // analysis of a plan, computed once per plan object
  function analysis(st) {
    st = st || S.current;
    let a = cache.get(st);
    if (!a) { a = HP.analyze(st); cache.set(st, a); }
    return a;
  }

  function select(sel) {
    const same = JSON.stringify(sel || null) === JSON.stringify(S.sel || null);
    S.sel = sel || null;
    if (!same) emit("select", S.sel);
  }
  const selection = () => S.sel;
  function setHover(h) {
    if (JSON.stringify(h || null) === JSON.stringify(S.hover || null)) return;
    S.hover = h || null;
    emit("hover", S.hover);
  }
  const hover = () => S.hover;
  function setTool(t) { if (S.tool !== t) { S.tool = t; emit("select", S.sel); } }
  const tool = () => S.tool;

  function dropStaleSelection() {
    const s = S.sel, st = S.committed;
    if (!s || !st) return;
    const list = s.kind === "room" ? st.rooms : s.kind === "opening" ? st.openings
               : s.kind === "section" ? st.sections : null;
    if (list && !list.some(o => o.id === s.id)) { S.sel = null; emit("select", null); }
  }

  function toast(text, level) { emit("message", { text, level: level || "info" }); }

  // replace the whole plan (open a file / new plan); undoable
  function load(st, label) { commit(st, label || "Open plan"); select(null); }

  function autosave() {
    if (typeof localStorage === "undefined") return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(KEY, HP.serialize(S.committed)); } catch (e) { /* storage off: fine */ }
    }, 400);
  }
  function restore() {
    try {
      const t = typeof localStorage !== "undefined" && localStorage.getItem(KEY);
      if (t) return HP.deserialize(t);
    } catch (e) { /* unreadable autosave: start fresh */ }
    return null;
  }

  // start with the autosaved plan if there is one, else a fresh plan
  function init(st) {
    S.committed = S.current = st || restore() || HP.newPlan();
    S.undo.length = 0; S.redo.length = 0; S.sel = null;
    emit("state", { preview: false, label: "init" });
  }

  HP.store = {
    on, emit, get, committed, preview, cancel, commit, undo, redo,
    canUndo, canRedo, undoLabel, redoLabel, analysis,
    select, selection, setHover, hover, setTool, tool, toast, load, init, KEY,
  };
})(globalThis.HP = globalThis.HP || {});

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.HP;
