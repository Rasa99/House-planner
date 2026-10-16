"use strict";
/* ============================================================================
   House Planner - panels.js   (owner: panels agent)
   ----------------------------------------------------------------------------
   Everything round the drawing board:
     top bar     mark, plan title (edit in place), New / Open / Save,
                 Export DXF + units, Undo / Redo, Fit, Help
     palette     room / door / window / section tiles. pointerdown, then a
                 4 px move -> store 'palette:start' {item, event}; a release
                 without moving -> 'palette:click' {item}. The canvas does
                 the rest (contract section 10/11).
     sidebar     cards: Selected (inspector), Rules, Land, Streets, Walls
     status bar  rules badge, land size, built area, rooms, zoom, last message
     toasts, tooltips, help popover, the New-plan dialog, global keys.

   Every word the user reads is in T below (dad may want another language).
   The sidebar is rebuilt as a fresh DOM tree and MORPHED into the live one,
   so a field the user is typing in keeps its focus, caret and text.
   No external resources: this file is inlined into one offline HTML file.
============================================================================ */
(function (HP) {
  // ======================================================== words (one table)
  const T = {
    appName: "House Planner",
    untitled: "House plan",

    // top bar
    titleTip: "The name of this plan. Click to change it.",
    newBtn: "New", newTip: "Start a new, empty plan",
    openBtn: "Open", openTip: "Open a saved plan file",
    saveBtn: "Save", saveTip: "Save this plan as a file",
    dxfBtn: "Export DXF", dxfTip: "Make a DXF drawing for AutoCAD",
    unitsTip: "Units used inside the DXF file",
    unitNames: { m: "metres", cm: "centimetres", mm: "millimetres" },
    undoBtn: "Undo", redoBtn: "Redo",
    undoTip: "Undo: {label}", redoTip: "Redo: {label}",
    noUndo: "Nothing to undo", noRedo: "Nothing to redo",
    fitBtn: "Fit", fitTip: "Show the whole plan",
    helpBtn: "Help", helpTip: "How to use House Planner",

    // help popover
    helpTitle: "How it works",
    help: [
      ["Add a room", "Drag it from the left onto the land."],
      ["Move a room", "Grab it by its name and drag. Drop it on another room to swap the two."],
      ["Resize", "Drag a wall. The room on the other side follows. Hold Alt to move only one room."],
      ["Doors and windows", "Drag them along a wall, or onto another wall."],
      ["Flip a door", "Double-click it."],
      ["Look around", "Scroll to zoom. Drag empty space to move the view."],
      ["Remove", "Click it, then press Delete."],
    ],
    helpKeys: [["Ctrl+Z", "Undo"], ["Ctrl+Y", "Redo"], ["Ctrl+S", "Save"], ["Ctrl+O", "Open"],
               ["Ctrl+E", "Export DXF"], ["F", "Fit"]],
    helpFoot: "Sizes are in metres. Every change is kept in this browser until you save a file.",

    // palette
    dragHint: "Drag onto the land",
    gRooms: "Rooms", gDoors: "Doors", gWindows: "Windows", gSection: "Section",
    roomArrives: "Arrives {w} \u00d7 {h} m with furniture, a door and a window.",
    roomRule: {
      bedroom: "Bedrooms must be {min}\u2013{max} m each way.",
      living: "Every house needs a living room.",
      reception: "For guests. Not required.",
      kitchen: "Needs a window onto an open area, the yard or the street.",
      bath: "Every house needs a bathroom.",
      wc: "Every house needs a toilet.",
      open: "Open to the sky. At least {s} \u00d7 {l} m. Rooms get light from here.",
      hall: "Joins rooms together. No window needed.",
    },
    roomWin: "Window {a} m.", roomWinRange: "Window {a}\u2013{b} m.",
    doorName: "Door {w} m",
    doorTip: { 80: "Inside door. Drop it on a wall between two rooms.",
               100: "Entrance door. Drop it on an outside wall that faces the street or the yard." },
    winName: "Window {w} m",
    winFor: "Right size for: {list}.",
    winWhere: "Windows only go on walls that face an open area, the yard or the street.",
    sectionName: "Section mark",
    sectionTile: "A\u2013A",
    sectionTip: "Drag it across the house to show where the plan is cut.",

    // cards
    cInsp: "Selected", cRules: "Rules", cLand: "Land", cStreets: "Streets", cWalls: "Walls",
    collapseTip: "Show or hide",

    // inspector
    nothing1: "Click a room, door or window on the drawing to change it here.",
    nothing2: "Drag rooms from the left onto the land to start.",
    kRoom: "Room", kDoor: "Door", kWindow: "Window", kSection: "Section", kCorner: "Land corner",
    name: "Name", type: "Type", width: "Width", depth: "Depth", area: "Area",
    sizeTip: "Clear size inside the walls, in metres. Press Enter to apply.",
    furniture: "Furniture",
    openingsOf: "Doors and windows",
    noOpenings: "No doors or windows yet.",
    problems: "Problems",
    del: "Delete", delRoom: "Delete room", delDoor: "Delete door", delWindow: "Delete window",
    delSection: "Delete section",
    size: "Size",
    winRange: "{type} windows: {a}\u2013{b} m",
    winOne: "{type} windows: {a} m",
    winNone: "{type}: no windows",
    opens: "Opens", swingIn: "In", swingOut: "Out",
    swingInTip: "Opens into the room", swingOutTip: "Opens out of the room",
    hinge: "Hinge", left: "Left", right: "Right",
    hingeTip: "Seen from inside the room, looking at the door",
    faces: "Faces",
    inRoom: "In {name}",
    hostRoom: "Room",
    toRoom: "Leads to {name}",
    ontoOpen: "Onto {name} (open to the sky)",
    ontoYard: "Onto the yard",
    ontoStreet: "Onto the street",
    ontoNeighbour: "Onto the neighbour - not allowed",
    blocked: "Too close to something - no light or way out",
    letter: "Letter", flip: "Flip", flipTip: "Look the other way",
    turn: "Turn", turnTip: "Turn it a quarter turn",
    sectionLooks: "The arrows show which way the section looks.",
    cornerOf: "Corner {c}",
    removeCorner: "Remove corner",
    addCorner: "Add a corner after {c}",
    xTip: "Metres from the left", yTip: "Metres from the front",

    // rules
    allOk: "All rules OK", nProblems: "{n} problems", oneProblem: "1 problem",
    noAnalysis: "The rules are not loaded.",
    showOnPlan: "Click to show it on the plan",
    allPass: "All {n} rules pass", nPass: "{n} more rules pass", onePass: "1 more rule passes",
    showPass: "Show", hidePass: "Hide",

    // land
    landW: "Width", landD: "Depth",
    landTip: "Size of the land in metres. Press Enter to apply.",
    editCorners: "Edit corners", doneCorners: "Done",
    cornersHelpOff: "To give the land a different shape, edit its corners.",
    cornersHelpOn: "Drag the land's corners on the drawing, or type them below.",
    notRect: "The land is not a rectangle. Its corners:",
    makeRect: "Make it a rectangle",

    // streets
    sideNames4: ["Front", "Right", "Back", "Left"],
    sideN: "Side {n}",
    street: "STREET", neighbour: "Neighbour",
    edgeTipStreet: "{side}: street. Click to make it a neighbour.",
    edgeTipNb: "{side}: neighbour. Click to make it a street.",
    streetOn: "Street: {list}",
    noStreet: "No street side. The house needs one for its entrance.",
    clickSide: "Click a side to switch it.",
    road: "Road width", roadTip: "Width of the street drawn outside the land, in metres.",
    nbNote: "Doors and windows can't go on a neighbour wall.",

    // walls
    wallsExt: "Outside walls", wallsInt: "Inside walls",
    wallsTip: "Wall thickness in metres",

    // status bar
    sLand: "Land", sBuilt: "Built", sRooms: "{n} rooms", sRoom: "1 room", sZoom: "Zoom",
    zoomTip: "100% = scale 1:100 on a normal screen",
    badgeTip: "Show the rules",

    // files
    newTitle: "Start a new plan?",
    newText: "The drawing is cleared. You can still get this plan back with Undo.",
    newOk: "New plan", cancel: "Cancel",
    saved: "Saved \u201c{name}\u201d - look in your Downloads folder.",
    opened: "Opened \u201c{name}\u201d.",
    openFailed: "Could not open \u201c{name}\u201d: {msg}",
    dxfSaved: "Exported \u201c{name}\u201d ({units}) - look in your Downloads folder.",
    dxfFailed: "Could not make the DXF: {msg}",
    dxfNotReady: "DXF export is not ready in this copy of House Planner.",
    newDone: "New plan started. Undo brings the old one back.",

    // general
    m: "m", m2: "m\u00b2",
    badNumber: "Type a size in metres, like 4.20",
    notReady: "This part of House Planner is missing ({op}).",
    failed: "Something went wrong. Nothing was changed.",
    cannot: "That can't be done here.",

    // undo labels (shown in the Undo tooltip)
    L: {
      title: "Rename plan", plot: "Land size", corner: "Move corner", addCorner: "Add corner",
      delCorner: "Remove corner", edge: "Street side", road: "Road width", walls: "Wall thickness",
      roomSize: "Room size", rename: "Rename room", type: "Room type", furn: "Furniture",
      delRoom: "Delete room", opening: "Change opening", delOpening: "Delete opening",
      secLabel: "Section letter", secFlip: "Flip section", secTurn: "Turn section",
      delSection: "Delete section", newPlan: "New plan", openPlan: "Open plan",
    },
  };

  const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v && v[k] != null ? v[k] : m));
  const fmtM = cm => HP.fmtM(cm);
  const fmtA = cm2 => HP.fmtArea(cm2);

  // ======================================================== tiny DOM helpers
  const SVGNS = "http://www.w3.org/2000/svg";
  function dispatch(e) { const f = this._on && this._on[e.type]; if (f) f.call(this, e); }
  function listen(el, on) {
    el._on = on;
    el._types = el._types || new Set();
    for (const t in on) if (!el._types.has(t)) { el._types.add(t); el.addEventListener(t, dispatch); }
  }
  function append(el, kids) {
    for (const k of kids) {
      if (k == null || k === false || k === true) continue;
      if (Array.isArray(k)) append(el, k);
      else el.appendChild(typeof k === "object" ? k : document.createTextNode(String(k)));
    }
  }
  function build(ns, tag, props, kids) {
    const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    let value;
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === "on") listen(el, v);
      else if (k === "key") el.setAttribute("data-key", v);
      else if (k === "value") value = String(v);
      else if (k === "html") el.innerHTML = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    append(el, kids);
    if (value !== undefined) { el._value = value; el.value = value; }
    return el;
  }
  const h = (tag, props, ...kids) => build(null, tag, props, kids);
  const s = (tag, props, ...kids) => build(SVGNS, tag, props, kids);

  /* morph(a, b): make the live node `a` look like the fresh node `b` and
     return the node that stays in the document. Keyed children (data-key)
     are matched by key. A focused field the user has typed in (_dirty) keeps
     its text. Event handlers travel through el._on.                         */
  const keyOf = n => (n.nodeType === 1 ? n.getAttribute("data-key") : null);
  function morph(a, b) {
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName || keyOf(a) !== keyOf(b)) {
      a.replaceWith(b); return b;
    }
    if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return a; }
    for (const at of Array.from(a.attributes)) if (!b.hasAttribute(at.name)) a.removeAttribute(at.name);
    for (const at of Array.from(b.attributes)) if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    if (b._on) listen(a, b._on); else if (a._on) a._on = null;
    morphKids(a, b);
    if (b._value !== undefined) {
      const busy = a === document.activeElement && a._dirty;
      if (!busy && a.value !== b._value) a.value = b._value;
      a._value = b._value;
    }
    return a;
  }
  function morphKids(a, b) {
    const want = Array.from(b.childNodes);
    let cur = a.firstChild;
    for (const n of want) {
      if (!cur) { a.appendChild(n); continue; }
      const k = keyOf(n);
      if (k != null && keyOf(cur) !== k) {
        let m = cur.nextSibling;
        while (m && keyOf(m) !== k) m = m.nextSibling;
        if (m) { a.insertBefore(m, cur); cur = m; }
      }
      cur = morph(cur, n).nextSibling;
    }
    while (cur) { const nx = cur.nextSibling; a.removeChild(cur); cur = nx; }
  }

  // ======================================================== icons (24 x 24, stroked)
  const ICONS = {
    house: "M3.5 11 12 4l8.5 7M6 9.5V20h12V9.5M10 20v-5.5h4V20",
    newf: "M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5zM14 3.5v5h5M12 11.5v6M9 14.5h6",
    open: "M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
    save: "M12 4v10.5M7.5 10l4.5 4.5 4.5-4.5M5 19.5h14",
    dxf: "M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 13.5v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1h5",
    undo: "M8.5 4.5 4 9l4.5 4.5M4 9h10.5a5 5 0 0 1 0 10H11",
    redo: "M15.5 4.5 20 9l-4.5 4.5M20 9H9.5a5 5 0 0 0 0 10H13",
    fit: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
    help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.4a2.5 2.5 0 0 1 4.9.6c0 1.7-2.5 2.2-2.5 3.9M12 16.9v.2",
    pencil: "M4.5 19.5h3.8L19 8.8 15.2 5 4.5 15.7zM13.4 6.8l3.8 3.8",
    trash: "M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 12.5h9.4L17.5 7M9.5 7V4.5h5V7",
    check: "M5 12.5l4.5 4.5L19 7.5",
    cross: "M7 7l10 10M17 7 7 17",
    warn: "M12 4 21 19.5H3zM12 10v4.5M12 17.2v.3",
    info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.8v.2",
    chev: "M7 10l5 5 5-5",
    flip: "M12 3.5v17M9 7.5 4 12l5 4.5zM15 7.5l5 4.5-5 4.5z",
    turn: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4.5H15",
    plus: "M12 5.5v13M5.5 12h13",
    target: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    hand: "M8.5 12.5V6.5a1.5 1.5 0 0 1 3 0V11M11.5 11V5a1.5 1.5 0 0 1 3 0v6M14.5 11V7a1.5 1.5 0 0 1 3 0v6.5c0 4-2.5 6.5-6 6.5-2.4 0-3.9-1.1-5.3-3.3L4.3 14a1.4 1.4 0 0 1 2.3-1.6l1.9 2.1",
    door: "M3.5 19.5h4M16.5 19.5h4M7.5 19.5V7.5M7.5 7.5A12 12 0 0 1 19.5 19.5",
    window: "M3.5 8.5v7M20.5 8.5v7M3.5 10h17M3.5 12h17M3.5 14h17",
    section: "M3 16h5M10.5 16h2.5M15.5 16h5.5M14.5 12.5l3.5-7 3.5 7z",
    corner: "M5 19V9.5L14.5 5H19M5 19h14V5",
  };
  function icon(name, size, cls) {
    const z = size || 16;
    return s("svg", { viewBox: "0 0 24 24", width: z, height: z, class: "pn-ic" + (cls ? " " + cls : ""),
      "aria-hidden": "true", focusable: "false" }, s("path", { d: ICONS[name] || "" }));
  }

  // ======================================================== palette pictograms (48 x 48)
  const PICT = {
    bedroom: '<rect x="4" y="5" width="6" height="6" rx="1"/><rect x="38" y="5" width="6" height="6" rx="1"/>' +
      '<rect x="12" y="5" width="24" height="38" rx="2.5"/><rect x="15" y="8.5" width="8" height="6" rx="2"/>' +
      '<rect x="25" y="8.5" width="8" height="6" rx="2"/><path d="M12 19h24M28 43l8-8"/>',
    living: '<rect x="6" y="9" width="36" height="8" rx="2.5"/><rect x="6" y="9" width="6" height="21" rx="2.5"/>' +
      '<rect x="36" y="9" width="6" height="21" rx="2.5"/><path d="M12 17v13h24V17M24 17v13"/>' +
      '<rect x="15" y="35" width="18" height="8" rx="1.5"/>',
    reception: '<rect x="12" y="4" width="24" height="8" rx="2.5"/><rect x="12" y="36" width="24" height="8" rx="2.5"/>' +
      '<rect x="3" y="15" width="8" height="18" rx="2.5"/><rect x="37" y="15" width="8" height="18" rx="2.5"/>' +
      '<rect x="16.5" y="17.5" width="15" height="13" rx="2"/>',
    kitchen: '<path d="M4 4h40v13H17v27H4z"/><circle cx="27" cy="10.5" r="3.2"/><circle cx="37" cy="10.5" r="3.2"/>' +
      '<rect x="6.5" y="23" width="8" height="11" rx="2"/><circle cx="10.5" cy="28.5" r="1" class="f"/>',
    bath: '<rect x="5" y="6" width="38" height="19" rx="4"/><rect x="8.5" y="9.5" width="31" height="12" rx="5.5"/>' +
      '<circle cx="35" cy="15.5" r="1.2" class="f"/><rect x="8" y="31" width="14" height="12" rx="2.5"/>' +
      '<ellipse cx="15" cy="37" rx="4" ry="3"/><path d="M30 31h13v12H30zM30 31l13 12M43 31 30 43"/>',
    wc: '<rect x="15" y="5" width="18" height="8" rx="1.8"/><path d="M17 13h14v6c0 9-3.2 16-7 16s-7-7-7-16z"/>' +
      '<ellipse cx="24" cy="22" rx="4" ry="6.5"/>',
    open: '<circle cx="24" cy="24" r="7"/><path d="M24 7v5M24 36v5M7 24h5M36 24h5M12 12l3.5 3.5M32.5 32.5 36 36M36 12l-3.5 3.5M15.5 32.5 12 36"/>',
    hall: '<path d="M42 6v13M42 29v13M6 24h28M27 17l7 7-7 7"/><path d="M6 6v36" class="d"/>',
  };
  function doorPict() {
    return '<path d="M3 40h9M38 40h7" class="w"/><path d="M12 40V14"/><path d="M12 14A26 26 0 0 1 38 40" class="d"/>';
  }
  function winPict(w) {
    const L = Math.round(14 + (w - 60) / (250 - 60) * 26);      // 14..40 px: wider window, wider symbol
    const x0 = 24 - L / 2, x1 = 24 + L / 2;
    return `<path d="M2 18h${x0 - 2}M2 30h${x0 - 2}M${x1} 18h${46 - x1}M${x1} 30h${46 - x1}" class="w"/>` +
      `<path d="M${x0} 18v12M${x1} 18v12M${x0} 21h${L}M${x0} 24h${L}M${x0} 27h${L}"/>`;
  }
  function sectionPict() {
    return '<path d="M3 34h11M18 34h3M25 34h11" class="d"/><path d="M33 34h12" class="w"/>' +
      '<path d="M33 30h12l-6-10z" class="f"/><text x="12" y="25" class="t">A</text>';
  }
  const pict = (inner, cls) =>
    `<svg viewBox="0 0 48 48" class="pn-pict${cls ? " " + cls : ""}" aria-hidden="true" focusable="false">${inner}</svg>`;

  function hexA(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return `rgba(22,182,201,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ======================================================== state of the panels
  const PREF_KEY = "houseplanner.panels.v1";
  const UI = {
    roots: null,
    collapsed: {},           // card id -> true
    units: "m",
    msg: {},                 // card id -> {text, level}
    zoom: null,              // px per metre from the canvas 'view' event
    zoomPct: null,
    last: null,              // last message {text, level, t}
    showPassing: false,      // the rules that pass are folded into one line
  };
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
      if (p && typeof p === "object") {
        if (p.collapsed && typeof p.collapsed === "object") UI.collapsed = p.collapsed;
        if (["m", "cm", "mm"].includes(p.units)) UI.units = p.units;
        UI.showPassing = !!p.showPassing;
      }
    } catch (e) { /* storage off: defaults */ }
  }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ collapsed: UI.collapsed, units: UI.units, showPassing: UI.showPassing })); }
    catch (e) { /* fine */ }
  }

  const plan = () => HP.store.get();
  function analysis() {
    if (typeof HP.analyze !== "function") return null;
    try { return HP.store.analysis(); } catch (e) { console.error("[panels] analyze failed", e); return null; }
  }
  const roomById = (P, id) => P.rooms.find(r => r.id === id);
  const roomName = (P, id) => { const r = roomById(P, id); return r ? r.name : "?"; };
  const typeLabel = t => (HP.ROOM_TYPES[t] ? HP.ROOM_TYPES[t].label : t);

  // ======================================================== running model ops
  /* run(op, args, label, where): call HP.model[op](plan, ...args), commit the
     new plan under `label`, show `reason` inline in card `where` (or as a
     toast when where is null) and `note` as a toast.                         */
  function run(op, args, label, where) {
    const M = HP.model;
    if (!M || typeof M[op] !== "function") { say(where, fill(T.notReady, { op: "model." + op }), "error"); return null; }
    const before = HP.store.get();
    let res;
    try { res = M[op](before, ...args); }
    catch (e) { console.error("[panels] model." + op + " failed", e); say(where, T.failed, "error"); return null; }
    if (!res) return null;
    const changed = !!res.state && res.state !== before;
    if (res.ok === false) setMsg(where || "_", res.reason || T.cannot, "warn");
    else delete UI.msg[where || "_"];
    if (changed) HP.store.commit(res.state, label);
    if (res.ok === false && !where) toast(res.reason || T.cannot, "warn");
    if (res.note) toast(res.note, "info");
    renderAll();
    return res;
  }
  function say(where, text, level) {
    if (where) { setMsg(where, text, level); renderSidebar(); }
    else toast(text, level);
  }
  // a card's message line; it goes away by itself after MSG_MS so an old reason never lingers
  const MSG_MS = 10000;
  function setMsg(where, text, level) {
    UI.msg[where] = { text, level, t: Date.now() };
    clearTimeout(setMsg.timer);
    setMsg.timer = setTimeout(renderSidebar, MSG_MS + 50);
  }
  function msgLine(where) {
    const m = UI.msg[where];
    if (!m) return null;
    if (Date.now() - m.t > MSG_MS) { delete UI.msg[where]; return null; }
    return h("div", { class: "pn-msg is-" + m.level, role: "alert", key: "msg-" + where },
      icon(m.level === "error" ? "warn" : "info", 14), h("span", null, m.text));
  }

  // ======================================================== form pieces
  function parseM(str) {
    const t = String(str).trim().replace(",", ".").replace(/\s*m$/i, "");
    if (!/^-?\d*\.?\d+$|^-?\d+\.$/.test(t)) return null;
    const v = Number(t);
    return isFinite(v) ? v : null;
  }
  const toCm = v => HP.snap(Math.round(v * 100));

  /* A metre field. `cm` = shown value; commit(cm) is called with a 5 cm value
     on Enter, blur, or ArrowUp/ArrowDown (Shift = 0.50 m).                    */
  function mField(key, label, cm, commit, opts) {
    const o = opts || {};
    const finish = (el, v) => {
      el._dirty = false;
      if (v == null) { say(o.where, T.badNumber, "warn"); el.value = el._value; return; }
      commit(v);
    };
    const input = h("input", {
      class: "pn-in pn-num", key, type: "text", inputmode: "decimal", spellcheck: "false",
      autocomplete: "off", "aria-label": label, value: fmtM(cm), disabled: o.disabled, "data-tip": o.tip,
      on: {
        input() { this._dirty = true; },
        focus() { const el = this; setTimeout(() => { if (document.activeElement === el) el.select(); }, 0); },
        keydown(e) {
          if (e.key === "Enter") {
            e.preventDefault();
            const v = parseM(this.value);
            finish(this, v == null ? null : toCm(v));
            const el = this; setTimeout(() => { if (document.activeElement === el) el.select(); }, 0);
          } else if (e.key === "Escape") {
            e.preventDefault(); this._dirty = false; this.value = this._value; this.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const v = parseM(this.value);
            const base = v == null ? cm : toCm(v);
            const step = (e.shiftKey ? 50 : 5) * (e.key === "ArrowUp" ? 1 : -1);
            finish(this, base + step);
          }
        },
        blur() { if (this._dirty) { const v = parseM(this.value); finish(this, v == null ? null : toCm(v)); } },
      },
    });
    return h("label", { class: "pn-field" + (o.cls ? " " + o.cls : "") },
      label ? h("span", { class: "pn-field-l" }, label) : null,
      h("span", { class: "pn-in-wrap" }, input, h("span", { class: "pn-unit" }, T.m)));
  }

  /* A text field: commit(text) on Enter / blur; Esc puts the old text back. */
  function tField(key, label, text, commit, opts) {
    const o = opts || {};
    const input = h("input", {
      class: "pn-in" + (o.cls ? " " + o.cls : ""), key, type: "text", spellcheck: "false", autocomplete: "off",
      maxlength: o.max || 60, "aria-label": label, value: text,
      on: {
        input() { this._dirty = true; },
        keydown(e) {
          if (e.key === "Enter") { e.preventDefault(); this.blur(); }
          else if (e.key === "Escape") { e.preventDefault(); this._dirty = false; this.value = this._value; this.blur(); }
        },
        blur() {
          if (!this._dirty) return;
          this._dirty = false;
          const v = this.value.trim();
          if (!v || v === this._value) { this.value = this._value; return; }
          commit(v);
        },
      },
    });
    return h("label", { class: "pn-field" }, label ? h("span", { class: "pn-field-l" }, label) : null, input);
  }

  /* Segmented buttons. opts: [{v, label, tip, dim}] */
  function seg(key, options, current, pick, cls) {
    return h("div", { class: "pn-seg" + (cls ? " " + cls : ""), key, role: "group" },
      options.map(o => h("button", {
        type: "button", key: key + "-" + o.v,
        class: "pn-seg-b" + (o.v === current ? " is-on" : "") + (o.dim ? " is-dim" : ""),
        "aria-pressed": o.v === current ? "true" : "false", "data-tip": o.tip,
        on: { click() { if (o.v !== current) pick(o.v); } },
      }, o.icon ? icon(o.icon, 14) : null, o.label)));
  }
  function btn(key, iconName, label, onClick, cls, tip) {
    return h("button", { type: "button", key, class: "pn-btn" + (cls ? " " + cls : ""), "data-tip": tip,
      on: { click: onClick } }, iconName ? icon(iconName, 15) : null, label ? h("span", null, label) : null);
  }

  // ======================================================== cards
  function card(id, title, right, body, extraCls) {
    const col = !!UI.collapsed[id];
    return h("section", { class: "pn-card" + (col ? " is-collapsed" : "") + (extraCls ? " " + extraCls : ""),
      key: "card-" + id, "data-card": id },
      h("header", { class: "pn-card-h", key: "h-" + id },
        h("button", { type: "button", class: "pn-card-tog", "aria-expanded": col ? "false" : "true",
          "data-tip": T.collapseTip, on: { click() { toggleCard(id); } } },
          icon("chev", 14, "pn-chev"), h("span", { class: "pn-card-t" }, title)),
        right ? h("span", { class: "pn-card-r" }, right) : null),
      col ? null : h("div", { class: "pn-card-b", key: "b-" + id }, body));
  }
  function toggleCard(id, force) {
    const open = force != null ? force : !!UI.collapsed[id];
    if (open) delete UI.collapsed[id]; else UI.collapsed[id] = true;
    savePrefs(); renderSidebar();
  }

  // ---------------------------------------------------------------- inspector
  function inspectorCard(P, A) {
    const sel = HP.store.selection();
    let kind = null, body = null, right = null;
    if (sel && sel.kind === "room") {
      const r = roomById(P, sel.id);
      if (r) { kind = T.kRoom; ({ body, right } = roomInspector(P, A, r)); }
    } else if (sel && sel.kind === "opening") {
      const o = P.openings.find(x => x.id === sel.id);
      if (o) { kind = o.kind === "door" ? T.kDoor : T.kWindow; ({ body, right } = openingInspector(P, A, o)); }
    } else if (sel && sel.kind === "section") {
      const sc = P.sections.find(x => x.id === sel.id);
      if (sc) { kind = T.kSection; body = sectionInspector(P, sc); right = sc.label + "\u2013" + sc.label; }
    } else if (sel && sel.kind === "plot" && sel.id != null && P.plot.pts[sel.id]) {
      kind = T.kCorner; body = cornerInspector(P, sel.id); right = String.fromCharCode(65 + sel.id);
    }
    if (!body) {
      body = [h("p", { class: "pn-tip" }, icon("info", 15), h("span", null, T.nothing1)),
              h("p", { class: "pn-tip" }, icon("hand", 15), h("span", null, T.nothing2))];
    }
    return card("insp", kind || T.cInsp, right ? h("span", { class: "pn-mono" }, right) : null,
      [body, msgLine("insp")], "pn-card-insp");
  }

  function roomInspector(P, A, r) {
    const ty = HP.ROOM_TYPES[r.type] || {};
    const ar = A && A.rooms ? A.rooms.find(x => x.id === r.id) : null;
    const area = ar && ar.area != null ? ar.area : r.w * r.h;
    const id = r.id;
    const body = [];
    body.push(h("div", { class: "pn-roomhead", key: "rhead-" + id, style: "--tint:" + (ty.tint || "#16b6c9") },
      h("span", { class: "pn-dot" }),
      tField("rname-" + id, null, r.name, v => run("renameRoom", [id, v], T.L.rename, "insp"), { cls: "pn-in-name", max: 40 })));
    body.push(h("div", { class: "pn-row2", key: "rsz-" + id },
      mField("rw-" + id, T.width, r.w, v => run("setRoomSize", [id, v, r.h], T.L.roomSize, "insp"), { where: "insp", tip: T.sizeTip }),
      mField("rh-" + id, T.depth, r.h, v => run("setRoomSize", [id, r.w, v], T.L.roomSize, "insp"), { where: "insp", tip: T.sizeTip })));
    body.push(h("div", { class: "pn-kv", key: "rarea-" + id }, h("span", null, T.area),
      h("b", { class: "pn-mono" }, fmtA(area) + " " + T.m2)));
    // type
    body.push(h("label", { class: "pn-field", key: "rtype-" + id }, h("span", { class: "pn-field-l" }, T.type),
      h("span", { class: "pn-select" },
        h("select", { class: "pn-in", "aria-label": T.type, value: r.type,
          on: { change() { run("setRoomType", [id, this.value], T.L.type, "insp"); } } },
          HP.ROOM_ORDER.map(t => h("option", { value: t }, typeLabel(t)))),
        icon("chev", 14))));
    // furniture
    let vars = [];
    try { vars = HP.furniture && HP.furniture.variants ? HP.furniture.variants(r.type) || [] : []; } catch (e) { vars = []; }
    if (vars.length > 1) {
      const cur = r.furn | 0;
      body.push(h("div", { class: "pn-field", key: "rfurn-" + id }, h("span", { class: "pn-field-l" }, T.furniture),
        h("div", { class: "pn-chips" }, vars.map((v, i) => h("button", {
          type: "button", key: "fv-" + i, class: "pn-chip" + (i === cur ? " is-on" : ""), "aria-pressed": i === cur ? "true" : "false",
          on: { click() { if (i !== cur) run("setFurniture", [id, i], T.L.furn, "insp"); } },
        }, v.label || v.key)))));
    }
    // doors and windows of this room
    const list = roomOpenings(P, A, r);
    body.push(h("div", { class: "pn-field", key: "rops-" + id }, h("span", { class: "pn-field-l" }, T.openingsOf),
      list.length ? h("div", { class: "pn-list" }, list.map(x => h("button", {
        type: "button", key: "op-" + x.id, class: "pn-li" + (x.bad ? " is-bad" : ""),
        on: { click() { HP.store.select({ kind: "opening", id: x.id }); } },
      }, icon(x.kind === "door" ? "door" : "window", 16, "pn-li-ic"),
        h("span", { class: "pn-li-main" }, h("b", null, x.title), h("small", null, x.faces)),
        x.bad ? icon("warn", 14, "pn-li-warn") : null)))
        : h("p", { class: "pn-muted" }, T.noOpenings)));
    // problems
    const probs = issuesOf(A, id);
    if (probs.length) body.push(problemBox("rp-" + id, probs));
    body.push(h("div", { class: "pn-actions", key: "ract-" + id },
      btn("rdel-" + id, "trash", T.delRoom, () => run("removeRoom", [id], T.L.delRoom, "insp"), "pn-btn-danger")));
    return { body, right: fmtA(area) + " " + T.m2 };
  }

  function roomOpenings(P, A, r) {
    let items;
    if (A && A.roomOpenings && A.roomOpenings[r.id]) items = A.roomOpenings[r.id].map(x => x.id);
    else items = P.openings.filter(o => o.room === r.id).map(o => o.id);
    return items.map(oid => {
      const o = P.openings.find(x => x.id === oid);
      if (!o) return null;
      const ao = A && A.openings ? A.openings.find(x => x.id === oid) : null;
      const title = fill(o.kind === "door" ? T.doorName : T.winName, { w: fmtM(o.w) });
      return { id: oid, kind: o.kind, title, faces: facingText(P, ao, o, r.id),
               bad: (ao && ao.ok === false) || issuesOf(A, oid).length > 0 };
    }).filter(Boolean);
  }
  function facingText(P, ao, o, fromRoom) {
    if (!ao) return fill(T.inRoom, { name: roomName(P, o.room) });
    if (fromRoom && ao.room !== fromRoom) return fill(T.toRoom, { name: roomName(P, ao.room) });
    switch (ao.facing) {
      case "room": return fill(T.toRoom, { name: roomName(P, ao.other) });
      case "open": return fill(T.ontoOpen, { name: roomName(P, ao.other) });
      case "yard": return T.ontoYard;
      case "street": return T.ontoStreet;
      case "neighbour": return T.ontoNeighbour;
      case "blocked": return T.blocked;
      default: return "";
    }
  }
  function issuesOf(A, id) {
    if (!A || !A.issues || !A.issues[id]) return [];
    return A.issues[id].map(rid => (A.rules || []).find(r => r.id === rid) || { id: rid, title: rid, detail: "" });
  }
  function problemBox(key, rules, extra) {
    return h("div", { class: "pn-probs", key },
      h("span", { class: "pn-field-l" }, T.problems),
      extra ? h("div", { class: "pn-prob" }, icon("warn", 14), h("span", null, extra)) : null,
      rules.map(r => h("div", { class: "pn-prob", key: "pr-" + r.id }, icon("warn", 14),
        h("span", null, h("b", null, r.title), r.detail ? h("small", null, r.detail) : null))));
  }

  // which way is "left" for a door: seen from inside the host room, facing the wall
  const startIsLeft = side => side === "N" || side === "W";

  function openingInspector(P, A, o) {
    const id = o.id, host = roomById(P, o.room);
    const ao = A && A.openings ? A.openings.find(x => x.id === id) : null;
    const body = [];
    const sizes = o.kind === "door" ? HP.DOOR_SIZES : HP.WINDOW_SIZES;
    let range = null, note = null;
    if (o.kind === "window" && host) {
      const ty = HP.ROOM_TYPES[host.type];
      range = ty && ty.win;
      const tl = ty ? ty.label : host.type;
      note = !range ? fill(T.winNone, { type: tl })
        : range[0] === range[1] ? fill(T.winOne, { type: tl, a: fmtM(range[0]) })
        : fill(T.winRange, { type: tl, a: fmtM(range[0]), b: fmtM(range[1]) });
    }
    body.push(h("div", { class: "pn-kv", key: "ohost-" + id }, h("span", null, T.hostRoom),
      h("b", null, host ? host.name : "?")));
    body.push(h("div", { class: "pn-field", key: "osz-" + id }, h("span", { class: "pn-field-l" }, T.size),
      seg("osz-" + id, sizes.map(w => ({ v: w, label: fmtM(w),
        dim: !!(range && (w < range[0] || w > range[1])) || (o.kind === "window" && !range) })),
        o.w, w => run("setOpening", [id, { w }], T.L.opening, "insp"), sizes.length > 4 ? "pn-seg-wrap" : ""),
      note ? h("small", { class: "pn-note" }, note) : null));
    if (o.kind === "door") {
      const sl = startIsLeft(o.side);
      const leftV = sl ? "start" : "end", rightV = sl ? "end" : "start";
      body.push(h("div", { class: "pn-row2", key: "odoor-" + id },
        h("div", { class: "pn-field" }, h("span", { class: "pn-field-l" }, T.opens),
          seg("osw-" + id, [{ v: "in", label: T.swingIn, tip: T.swingInTip }, { v: "out", label: T.swingOut, tip: T.swingOutTip }], o.swing || "in",
            v => run("setOpening", [id, { swing: v }], T.L.opening, "insp"))),
        h("div", { class: "pn-field" }, h("span", { class: "pn-field-l", "data-tip": T.hingeTip }, T.hinge),
          seg("ohi-" + id, [{ v: leftV, label: T.left, tip: T.hingeTip }, { v: rightV, label: T.right, tip: T.hingeTip }],
            o.hinge || "start", v => run("setOpening", [id, { hinge: v }], T.L.opening, "insp")))));
    }
    const faces = facingText(P, ao, o, null);
    const bad = ao && ao.ok === false;
    if (faces) body.push(h("div", { class: "pn-kv" + (bad || (ao && (ao.facing === "neighbour" || ao.facing === "blocked")) ? " is-bad" : ""), key: "ofc-" + id },
      h("span", null, T.faces), h("b", null, faces)));
    const probs = issuesOf(A, id);
    if (probs.length || (bad && ao.reason)) body.push(problemBox("op-" + id, probs, bad ? ao.reason : null));
    body.push(h("div", { class: "pn-actions", key: "oact-" + id },
      btn("odel-" + id, "trash", o.kind === "door" ? T.delDoor : T.delWindow,
        () => run("removeOpening", [id], T.L.delOpening, "insp"), "pn-btn-danger")));
    return { body, right: fmtM(o.w) + " " + T.m };
  }

  function sectionInspector(P, sc) {
    const id = sc.id;
    return [
      h("div", { class: "pn-row2", key: "sec-" + id },
        tField("slab-" + id, T.letter, sc.label, v => run("setSectionLabel", [id, v.toUpperCase().slice(0, 2)], T.L.secLabel, "insp"),
          { max: 2, cls: "pn-in-letter" }),
        h("div", { class: "pn-field" }, h("span", { class: "pn-field-l" }, "\u00a0"),
          h("div", { class: "pn-btnrow" },
            btn("sflip-" + id, "flip", T.flip, () => run("flipSection", [id], T.L.secFlip, "insp"), null, T.flipTip),
            btn("sturn-" + id, "turn", T.turn, () => run("turnSection", [id], T.L.secTurn, "insp"), null, T.turnTip)))),
      h("p", { class: "pn-muted", key: "snote-" + id }, T.sectionLooks),
      h("div", { class: "pn-actions", key: "sact-" + id },
        btn("sdel-" + id, "trash", T.delSection, () => run("removeSection", [id], T.L.delSection, "insp"), "pn-btn-danger")),
    ];
  }

  function cornerInspector(P, i) {
    const p = P.plot.pts[i], c = String.fromCharCode(65 + i);
    return [
      h("div", { class: "pn-row2", key: "cin-" + i },
        mField("cix-" + i, "x", p[0], v => run("movePlotCorner", [i, [v, p[1]]], T.L.corner, "insp"), { where: "insp", tip: T.xTip }),
        mField("ciy-" + i, "y", p[1], v => run("movePlotCorner", [i, [p[0], v]], T.L.corner, "insp"), { where: "insp", tip: T.yTip })),
      P.plot.pts.length > 3 ? h("div", { class: "pn-actions", key: "cact-" + i },
        btn("cdel-" + i, "trash", T.removeCorner, () => {
          const r = run("removePlotCorner", [i], T.L.delCorner, "insp");
          if (r && r.state !== P) HP.store.select(null);
        }, "pn-btn-danger", fill(T.cornerOf, { c }))) : null,
    ];
  }

  // ---------------------------------------------------------------- rules
  function rulesSummary(A) {
    if (!A || !A.rules) return null;
    const bad = A.rules.filter(r => !r.ok);
    const errs = bad.filter(r => r.level !== "warn").length;
    return { n: bad.length, errs, text: bad.length === 0 ? T.allOk : bad.length === 1 ? T.oneProblem : fill(T.nProblems, { n: bad.length }),
             level: bad.length === 0 ? "ok" : errs ? "bad" : "warn" };
  }
  function rulesCard(P, A) {
    const sum = rulesSummary(A);
    if (!sum) return card("rules", T.cRules, null, h("p", { class: "pn-muted" }, T.noAnalysis));
    const bad = A.rules.filter(r => !r.ok), good = A.rules.filter(r => r.ok);
    const row = r => {
      const warn = r.level === "warn";
      const refs = Array.isArray(r.refs) ? r.refs : [];
      const can = refs.length > 0;
      return h(can ? "button" : "div", {
        key: "rule-" + r.id, type: can ? "button" : null,
        class: "pn-rule " + (r.ok ? "is-ok" : warn ? "is-warn" : "is-bad") + (can ? " is-link" : ""),
        "data-tip": can ? T.showOnPlan : null,
        on: can ? { click() { focusRefs(refs); } } : null,
      }, h("span", { class: "pn-rule-ic" }, icon(r.ok ? "check" : warn ? "warn" : "cross", 13)),
        h("span", { class: "pn-rule-txt" }, h("span", { class: "pn-rule-t" }, r.title || r.id),
          !r.ok && r.detail ? h("span", { class: "pn-rule-d" }, r.detail) : null),
        can ? icon("target", 14, "pn-rule-go") : null);
    };
    // problems always show; the rules that pass fold into one line (open it to see each one)
    const rows = bad.map(row);
    if (good.length) {
      const open = !!UI.showPassing;
      rows.push(h("button", { type: "button", key: "rules-pass", class: "pn-rule pn-rule-more is-ok is-link",
        "aria-expanded": open ? "true" : "false",
        on: { click() { UI.showPassing = !open; savePrefs(); renderSidebar(); } } },
        h("span", { class: "pn-rule-ic" }, icon("check", 13)),
        h("span", { class: "pn-rule-txt" }, h("span", { class: "pn-rule-t" },
          bad.length ? (good.length === 1 ? T.onePass : fill(T.nPass, { n: good.length })) : fill(T.allPass, { n: good.length }))),
        h("span", { class: "pn-rule-more-l" }, open ? T.hidePass : T.showPass, icon("chev", 13, "pn-rule-chev"))));
      if (open) for (const r of good) rows.push(row(r));
    }
    return card("rules", T.cRules, h("span", { class: "pn-badge is-" + sum.level }, sum.text), h("div", { class: "pn-rules" }, rows));
  }
  function focusRefs(refs) {
    if (HP.canvas && typeof HP.canvas.focus === "function") { try { HP.canvas.focus(refs); } catch (e) { console.error(e); } }
    const P = plan(), id = refs[0];
    const kind = P.rooms.some(r => r.id === id) ? "room" : P.openings.some(o => o.id === id) ? "opening"
      : P.sections.some(x => x.id === id) ? "section" : null;
    if (kind) HP.store.select({ kind, id });
  }

  // ---------------------------------------------------------------- land
  function plotBox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    return { x0, y0, x1, y1, w: x1 - x0, d: y1 - y0 };
  }
  function isRect(pts) {
    if (pts.length !== 4) return false;
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4], c = pts[(i + 2) % 4];
      const h1 = a[1] === b[1], v1 = a[0] === b[0], h2 = b[1] === c[1], v2 = b[0] === c[0];
      if (!((h1 && v2) || (v1 && h2))) return false;
    }
    return true;
  }
  function landCard(P) {
    const pts = P.plot.pts, bb = plotBox(pts), rect = isRect(pts);
    const plotting = HP.store.tool() === "plot";
    const area = Math.abs(HP.polyArea(pts));
    const body = [];
    body.push(h("div", { class: "pn-row2", key: "lwd" },
      mField("lw", T.landW, bb.w, v => run("setPlotRect", [v, bb.d], T.L.plot, "land"), { where: "land", disabled: !rect, tip: T.landTip }),
      mField("ld", T.landD, bb.d, v => run("setPlotRect", [bb.w, v], T.L.plot, "land"), { where: "land", disabled: !rect, tip: T.landTip })));
    body.push(msgLine("land"));
    body.push(h("div", { class: "pn-toggle-row", key: "ltool" },
      h("button", { type: "button", class: "pn-toggle" + (plotting ? " is-on" : ""), "aria-pressed": plotting ? "true" : "false",
        on: { click() { HP.store.setTool(plotting ? "select" : "plot"); } } },
        h("span", { class: "pn-switch" }), icon("corner", 15), h("span", null, plotting ? T.doneCorners : T.editCorners)),
      h("small", { class: "pn-muted" }, plotting ? T.cornersHelpOn : T.cornersHelpOff)));
    if (!rect || plotting) {
      const sel = HP.store.selection();
      if (!rect) body.push(h("div", { class: "pn-kv", key: "lnr" }, h("span", null, T.notRect),
        h("button", { type: "button", class: "pn-link", on: { click() { run("setPlotRect", [bb.w, bb.d], T.L.plot, "land"); } } }, T.makeRect)));
      body.push(h("div", { class: "pn-corners", key: "lcorners" }, pts.map((p, i) => {
        const c = String.fromCharCode(65 + i);
        const on = sel && sel.kind === "plot" && sel.id === i;
        return h("div", { class: "pn-corner" + (on ? " is-on" : ""), key: "corner-" + i },
          h("button", { type: "button", class: "pn-corner-c", "data-tip": fill(T.cornerOf, { c }),
            on: { click() { HP.store.select({ kind: "plot", id: i }); } } }, c),
          mField("cx-" + i, null, p[0], v => run("movePlotCorner", [i, [v, p[1]]], T.L.corner, "land"), { where: "land", tip: T.xTip, cls: "pn-field-x" }),
          mField("cy-" + i, null, p[1], v => run("movePlotCorner", [i, [p[0], v]], T.L.corner, "land"), { where: "land", tip: T.yTip, cls: "pn-field-y" }),
          h("button", { type: "button", class: "pn-icon-btn", "data-tip": fill(T.addCorner, { c }), "aria-label": fill(T.addCorner, { c }),
            on: { click() {
              const q = pts[(i + 1) % pts.length];
              run("addPlotCorner", [i, [HP.snap((p[0] + q[0]) / 2), HP.snap((p[1] + q[1]) / 2)]], T.L.addCorner, "land");
            } } }, icon("plus", 14)),
          pts.length > 3 ? h("button", { type: "button", class: "pn-icon-btn is-danger", "data-tip": T.removeCorner, "aria-label": T.removeCorner,
            on: { click() { run("removePlotCorner", [i], T.L.delCorner, "land"); } } }, icon("trash", 14)) : h("span", { class: "pn-icon-gap" }));
      })));
    }
    return card("land", T.cLand, h("span", { class: "pn-mono" }, fmtA(area) + " " + T.m2), body);
  }

  // ---------------------------------------------------------------- streets
  function sideName(P, i) {
    return P.plot.pts.length === 4 ? T.sideNames4[i] : fill(T.sideN, { n: i + 1 });
  }
  function streetsCard(P, A) {
    const pts = P.plot.pts, n = pts.length, edges = P.plot.edges || [];
    const W = 256, PAD = 30, BW = 17, MAXH = 220;
    const bb = plotBox(pts);
    const sc = Math.min((W - 2 * PAD) / Math.max(bb.w, 1), (MAXH - 2 * PAD) / Math.max(bb.d, 1));
    const H = Math.round(bb.d * sc + 2 * PAD);
    const ox = (W - bb.w * sc) / 2;
    const X = x => +(ox + (x - bb.x0) * sc).toFixed(1);
    const Y = y => +(PAD + (bb.y1 - y) * sc).toFixed(1);
    const ccw = HP.polyArea(pts) >= 0 ? 1 : -1;
    const kids = [];
    kids.push(s("defs", null, s("pattern", { id: "pn-nb-hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
      s("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "pn-hatch-l" }))));
    kids.push(s("polygon", { points: pts.map(p => X(p[0]) + "," + Y(p[1])).join(" "), class: "pn-land" }));
    if (A && A.footprint && Array.isArray(A.footprint.loops) && A.footprint.loops.length) {
      kids.push(s("path", { class: "pn-foot", "fill-rule": "evenodd",
        d: A.footprint.loops.map(l => "M" + l.map(p => X(p[0]) + " " + Y(p[1])).join("L") + "Z").join("") }));
    } else {
      for (const r of P.rooms) kids.push(s("rect", { class: "pn-foot", x: X(r.x), y: Y(r.y + r.h), width: +(r.w * sc).toFixed(1), height: +(r.h * sc).toFixed(1) }));
    }
    const streetNames = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const ax = X(a[0]), ay = Y(a[1]), bx = X(b[0]), by = Y(b[1]);
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      const nx = ccw * dy / L, ny = ccw * dx / L;          // outward normal on SCREEN (y down)
      const kind = edges[i] === "street" ? "street" : "neighbour";
      const nm = sideName(P, i);
      if (kind === "street") streetNames.push(nm);
      const band = [[ax, ay], [bx, by], [bx + nx * BW, by + ny * BW], [ax + nx * BW, ay + ny * BW]]
        .map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
      const len = Math.hypot(bx - ax, by - ay);
      let ang = Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
      if (ang > 90.01) ang -= 180; else if (ang < -89.99) ang += 180;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const tx = mx + nx * BW / 2, ty = my + ny * BW / 2;
      const ix = mx - nx * 11, iy = my - ny * 11;
      const g = [];
      g.push(s("polygon", { points: band, class: "pn-band" }));
      if (kind === "street") {
        g.push(s("line", { x1: (ax + nx * BW / 2).toFixed(1), y1: (ay + ny * BW / 2).toFixed(1),
          x2: (bx + nx * BW / 2).toFixed(1), y2: (by + ny * BW / 2).toFixed(1), class: "pn-band-mid" }));
      }
      g.push(s("line", { x1: ax, y1: ay, x2: bx, y2: by, class: "pn-edge-line" }));
      if (len > 46) g.push(s("text", { x: tx.toFixed(1), y: ty.toFixed(1), class: "pn-band-t",
        transform: `rotate(${ang.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)})` }, kind === "street" ? T.street : T.neighbour));
      const room = Math.abs(nx) * bb.w * sc + Math.abs(ny) * bb.d * sc;     // land depth behind this side, px
      if (len > 34 && room > 44) g.push(s("text", { x: ix.toFixed(1), y: iy.toFixed(1), class: "pn-side-t",
        transform: `rotate(${ang.toFixed(1)} ${ix.toFixed(1)} ${iy.toFixed(1)})` }, nm));
      g.push(s("line", { x1: (ax + nx * BW / 2).toFixed(1), y1: (ay + ny * BW / 2).toFixed(1),
        x2: (bx + nx * BW / 2).toFixed(1), y2: (by + ny * BW / 2).toFixed(1), class: "pn-edge-hit", "stroke-width": BW + 10 }));
      kids.push(s("g", {
        class: "pn-edge is-" + kind, key: "edge-" + i, role: "button", tabindex: 0,
        "aria-label": fill(kind === "street" ? T.edgeTipStreet : T.edgeTipNb, { side: nm }),
        "data-tip": fill(kind === "street" ? T.edgeTipStreet : T.edgeTipNb, { side: nm }),
        on: {
          click() { run("setEdgeKind", [i, kind === "street" ? "neighbour" : "street"], T.L.edge, "streets"); },
          keydown(e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._on.click.call(this); } },
        },
      }, g));
    }
    const svg = s("svg", { class: "pn-streets-svg", viewBox: `0 0 ${W} ${H}`, width: "100%", key: "ssvg",
      style: `max-height:${H}px`, preserveAspectRatio: "xMidYMid meet" }, kids);
    const body = [
      svg,
      h("div", { class: "pn-street-sum" + (streetNames.length ? "" : " is-bad"), key: "ssum" },
        streetNames.length ? fill(T.streetOn, { list: streetNames.join(", ") }) : T.noStreet,
        h("span", { class: "pn-muted" }, " \u00b7 " + T.clickSide)),
      h("div", { class: "pn-row2", key: "sroad" },
        mField("road", T.road, P.plot.road != null ? P.plot.road : 800, v => run("setRoad", [v], T.L.road, "streets"), { where: "streets", tip: T.roadTip }),
        h("span")),
      msgLine("streets"),
      h("p", { class: "pn-note-line", key: "snb" }, icon("info", 14), h("span", null, T.nbNote)),
    ];
    return card("streets", T.cStreets, null, body);
  }

  // ---------------------------------------------------------------- walls
  const WALL_SIZES = [10, 15, 20, 25, 30];
  function wallsCard(P) {
    const w = P.walls || { ext: 20, int: 20 };
    const opts = WALL_SIZES.map(v => ({ v, label: fmtM(v), tip: T.wallsTip }));
    return card("walls", T.cWalls, null, [
      h("div", { class: "pn-field", key: "wext" }, h("span", { class: "pn-field-l" }, T.wallsExt),
        seg("wext", opts, w.ext, v => run("setWalls", [v, w.int], T.L.walls, "walls"))),
      h("div", { class: "pn-field", key: "wint" }, h("span", { class: "pn-field-l" }, T.wallsInt),
        seg("wint", opts, w.int, v => run("setWalls", [w.ext, v], T.L.walls, "walls"))),
      msgLine("walls"),
    ]);
  }

  // ======================================================== sidebar render
  let sideInner = null;
  function renderSidebar() {
    if (!sideInner) return;
    const P = plan();
    if (!P) return;
    const A = analysis();
    let fresh;
    try {
      fresh = h("div", { class: "pn-side-in" },
        inspectorCard(P, A), rulesCard(P, A), landCard(P), streetsCard(P, A), wallsCard(P));
    } catch (e) { console.error("[panels] sidebar render failed", e); return; }
    morphKids(sideInner, fresh);
  }

  // ======================================================== top bar
  const top = {};
  function buildTop(root) {
    root.classList.add("pn-topbar");
    root.innerHTML = "";
    top.title = h("input", { class: "pn-title-in", type: "text", spellcheck: "false", autocomplete: "off",
      maxlength: 80, "aria-label": T.titleTip, "data-tip": T.titleTip, "data-tip-pos": "below" });
    top.title.addEventListener("input", () => { top.title._dirty = true; });
    top.title.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); top.title.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); top.title._dirty = false; top.title.value = plan().meta.title || ""; top.title.blur(); }
    });
    top.title.addEventListener("blur", () => {
      if (!top.title._dirty) return;
      top.title._dirty = false;
      const v = top.title.value.trim();
      const P = plan();
      if (!v || v === P.meta.title) { top.title.value = P.meta.title || ""; return; }
      setTitle(v);
    });
    const tb = (iconName, label, tip, kbd, fn, cls) => {
      const b = h("button", { type: "button", class: "pn-tb" + (cls ? " " + cls : ""), "data-tip": tip,
        "data-kbd": kbd, "data-tip-pos": "below", "aria-label": label },
        icon(iconName, 17), h("span", { class: "pn-tb-l" }, label));
      b.addEventListener("click", fn);
      return b;
    };
    top.newB = tb("newf", T.newBtn, T.newTip, null, () => askNew());
    top.openB = tb("open", T.openBtn, T.openTip, "Ctrl+O", () => pickFile());
    top.saveB = tb("save", T.saveBtn, T.saveTip, "Ctrl+S", () => saveFile());
    top.dxfB = tb("dxf", T.dxfBtn, T.dxfTip, "Ctrl+E", () => exportDxf(), "pn-tb-primary");
    top.units = h("div", { class: "pn-units", role: "group", "data-tip": T.unitsTip, "data-tip-pos": "below" },
      ["m", "cm", "mm"].map(u => {
        const b = h("button", { type: "button", class: "pn-unit-b", "data-u": u, "aria-label": T.unitNames[u] }, u);
        b.addEventListener("click", () => { UI.units = u; savePrefs(); renderTop(); });
        return b;
      }));
    top.undoB = tb("undo", T.undoBtn, T.noUndo, "Ctrl+Z", () => HP.store.undo(), "pn-tb-icon");
    top.redoB = tb("redo", T.redoBtn, T.noRedo, "Ctrl+Y", () => HP.store.redo(), "pn-tb-icon");
    top.fitB = tb("fit", T.fitBtn, T.fitTip, "F", () => { if (HP.canvas && HP.canvas.fit) HP.canvas.fit(); }, "pn-tb-icon");
    top.helpB = tb("help", T.helpBtn, T.helpTip, null, () => toggleHelp(), "pn-tb-icon");
    top.file = h("input", { type: "file", accept: ".json,.houseplan,application/json", class: "pn-hidden", tabindex: -1 });
    top.file.addEventListener("change", () => {
      const f = top.file.files && top.file.files[0];
      top.file.value = "";
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => openText(String(rd.result), f.name);
      rd.onerror = () => toast(fill(T.openFailed, { name: f.name, msg: "" }), "error");
      rd.readAsText(f);
    });
    root.append(
      h("div", { class: "pn-brand" },
        h("span", { class: "pn-mark" }, icon("house", 18)),
        h("span", { class: "pn-brand-n" }, T.appName)),
      h("div", { class: "pn-title" }, top.title, icon("pencil", 14, "pn-title-pen")),
      h("div", { class: "pn-grow" }),
      h("div", { class: "pn-tgroup pn-files" }, top.newB, top.openB, top.saveB),
      h("div", { class: "pn-tgroup pn-export" }, top.dxfB, top.units),
      h("div", { class: "pn-tsep" }),
      h("div", { class: "pn-tgroup" }, top.undoB, top.redoB),
      h("div", { class: "pn-tsep" }),
      h("div", { class: "pn-tgroup" }, top.fitB, top.helpB),
      top.file);
  }
  function renderTop() {
    if (!top.title) return;
    const P = plan();
    const t = (P && P.meta && P.meta.title) || "";
    if (!(document.activeElement === top.title && top.title._dirty) && top.title.value !== t) top.title.value = t;
    document.title = (t ? t + " - " : "") + T.appName;
    const cu = HP.store.canUndo(), cr = HP.store.canRedo();
    top.undoB.disabled = !cu; top.redoB.disabled = !cr;
    top.undoB.setAttribute("data-tip", cu ? fill(T.undoTip, { label: HP.store.undoLabel() }) : T.noUndo);
    top.redoB.setAttribute("data-tip", cr ? fill(T.redoTip, { label: HP.store.redoLabel() }) : T.noRedo);
    for (const b of top.units.children) {
      const on = b.getAttribute("data-u") === UI.units;
      b.classList.toggle("is-on", on); b.setAttribute("aria-pressed", on ? "true" : "false");
    }
    top.dxfB.setAttribute("data-tip", T.dxfTip + " (" + T.unitNames[UI.units] + ")");
  }
  function setTitle(v) {
    if (HP.model && typeof HP.model.setTitle === "function") { run("setTitle", [v], T.L.title, null); return; }
    const P = HP.clone(plan()); P.meta.title = v;               // trivial fallback: the op is a one-liner
    HP.store.commit(P, T.L.title);
  }

  // ======================================================== palette
  let tileTip = null;
  function buildPalette(root) {
    root.classList.add("pn-palette");
    root.innerHTML = "";
    const RT = HP.ROOM_TYPES, R = HP.RULES;
    const roomTiles = HP.ROOM_ORDER.filter(t => RT[t]).map(t => {
      const ty = RT[t];
      const lines = [ty.label, fill(T.roomArrives, { w: fmtM(ty.size[0]), h: fmtM(ty.size[1]) })];
      const rule = T.roomRule[t];
      if (rule) lines.push(fill(rule, { min: fmtM(R.bedroom.min), max: fmtM(R.bedroom.max),
        s: fmtM(R.openArea.shortMin), l: fmtM(R.openArea.longMin) }));
      if (ty.win && ty.needsWindow) lines.push(ty.win[0] === ty.win[1] ? fill(T.roomWin, { a: fmtM(ty.win[0]) })
        : fill(T.roomWinRange, { a: fmtM(ty.win[0]), b: fmtM(ty.win[1]) }));
      return tile({ kind: "room", type: t }, "pn-tile-room", pict(PICT[t] || ""), ty.label, lines.join("\n"), ty.tint);
    });
    const doorTiles = HP.DOOR_SIZES.map(w => tile({ kind: "door", w }, "pn-tile-small", pict(doorPict(), "is-door"),
      fmtM(w) + " " + T.m, [fill(T.doorName, { w: fmtM(w) }), T.doorTip[w] || ""].join("\n"), "#e2e2ea"));
    const winTiles = HP.WINDOW_SIZES.map(w => {
      const fits = HP.ROOM_ORDER.filter(t => RT[t] && RT[t].win && RT[t].needsWindow && w >= RT[t].win[0] && w <= RT[t].win[1]).map(typeLabel);
      return tile({ kind: "window", w }, "pn-tile-small", pict(winPict(w), "is-win"), fmtM(w),
        [fill(T.winName, { w: fmtM(w) }), fits.length ? fill(T.winFor, { list: fits.join(", ") }) : "", T.winWhere].filter(Boolean).join("\n"),
        HP.LAYERS && HP.LAYERS["A-GLAZ"] ? HP.LAYERS["A-GLAZ"].color : "#2e9bd6");
    });
    const secTile = tile({ kind: "section" }, "pn-tile-sec", pict(sectionPict(), "is-sec"), T.sectionName,
      [T.sectionName + " (" + T.sectionTile + ")", T.sectionTip].join("\n"), "#d94b4b");
    const group = (title, cls, tiles) => h("div", { class: "pn-pal-g" }, h("div", { class: "pn-pal-gt" }, title),
      h("div", { class: "pn-tiles " + cls }, tiles));
    root.append(h("div", { class: "pn-pal-in" },
      h("div", { class: "pn-pal-hint" }, icon("hand", 16), h("span", null, T.dragHint)),
      group(T.gRooms, "pn-tiles-2", roomTiles),
      group(T.gDoors, "pn-tiles-2", doorTiles),
      group(T.gWindows, "pn-tiles-3", winTiles),
      group(T.gSection, "pn-tiles-1", [secTile])));
  }
  function tile(item, cls, svgHtml, label, tip, tint) {
    const el = h("button", { type: "button", class: "pn-tile " + cls, "data-tip": tip, "data-tip-pos": "right",
      "aria-label": tip.split("\n")[0], "data-item": JSON.stringify(item),
      style: `--tint:${tint};--tint-a:${hexA(tint, 0.13)};--tint-b:${hexA(tint, 0.45)}` },
      h("span", { class: "pn-tile-p", html: svgHtml }), h("span", { class: "pn-tile-l" }, label));
    bindTile(el, item);
    return el;
  }
  /* pointerdown -> wait for a 4 px move -> palette:start {item, event}
     (event = the PointerEvent that crossed 4 px) and let go of the gesture;
     released without moving -> palette:click {item}.                        */
  function bindTile(el, item) {
    el.addEventListener("pointerdown", e => {
      if (e.button !== 0 || !e.isPrimary) return;
      e.preventDefault();
      hideTip();
      try { if (el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); } catch (err) { /* fine */ }
      const x0 = e.clientX, y0 = e.clientY, pid = e.pointerId;
      el.classList.add("is-press");
      const end = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", up, true);
        el.classList.remove("is-press");
      };
      const move = ev => {
        if (ev.pointerId !== pid) return;
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        end();
        HP.store.emit("palette:start", { item: Object.assign({}, item), event: ev });
      };
      const up = ev => {
        if (ev.pointerId !== pid) return;
        end();
        if (ev.type === "pointerup") HP.store.emit("palette:click", { item: Object.assign({}, item) });
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", up, true);
    });
    // keyboard (Enter / Space make a click with detail 0); mouse clicks are handled above
    el.addEventListener("click", e => { if (e.detail === 0) HP.store.emit("palette:click", { item: Object.assign({}, item) }); });
    el.addEventListener("dragstart", e => e.preventDefault());
  }

  // ======================================================== status bar
  const st = {};
  function buildStatus(root) {
    root.classList.add("pn-status");
    root.innerHTML = "";
    st.badge = h("button", { type: "button", class: "pn-sbadge", "data-tip": T.badgeTip, "data-tip-pos": "above" });
    st.badge.addEventListener("click", () => {
      toggleCard("rules", true);
      const c = sideInner && sideInner.querySelector('[data-card="rules"]');
      if (c) c.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    st.land = h("span", { class: "pn-spill" });
    st.built = h("span", { class: "pn-spill" });
    st.rooms = h("span", { class: "pn-spill" });
    st.zoom = h("span", { class: "pn-spill", "data-tip": T.zoomTip, "data-tip-pos": "above" });
    st.msg = h("span", { class: "pn-smsg", role: "status", "aria-live": "polite" });
    root.append(st.badge, st.land, st.built, st.rooms, st.zoom, st.msg);
  }
  function renderStatus() {
    if (!st.land) return;
    const P = plan(); if (!P) return;
    const A = analysis();
    const sum = rulesSummary(A);
    st.badge.style.display = sum ? "" : "none";
    if (sum) {
      st.badge.className = "pn-sbadge is-" + sum.level;
      st.badge.replaceChildren(icon(sum.level === "ok" ? "check" : "warn", 13), h("span", null, sum.text));
    }
    const bb = plotBox(P.plot.pts);
    st.land.replaceChildren(h("i", null, T.sLand), " " + fmtM(bb.w) + " \u00d7 " + fmtM(bb.d) + " " + T.m);
    const stats = A && A.stats;
    if (stats && stats.builtArea != null) {
      const cov = stats.coverage != null ? stats.coverage : (stats.plotArea ? stats.builtArea / stats.plotArea : 0);
      st.built.replaceChildren(h("i", null, T.sBuilt), " " + fmtA(stats.builtArea) + " " + T.m2 + " \u00b7 " + Math.round(cov * 100) + "%");
      st.built.style.display = "";
    } else st.built.style.display = "none";
    const n = P.rooms.length;
    st.rooms.textContent = n === 1 ? T.sRoom : fill(T.sRooms, { n });
    if (UI.zoomPct != null) { st.zoom.style.display = ""; st.zoom.replaceChildren(h("i", null, T.sZoom), " " + UI.zoomPct + "%"); }
    else st.zoom.style.display = "none";
  }
  function setStatusMsg(m) {
    UI.last = { text: m.text, level: m.level || "info", t: Date.now() };
    if (!st.msg) return;
    st.msg.className = "pn-smsg is-" + UI.last.level;
    st.msg.textContent = m.text;
    clearTimeout(setStatusMsg.timer);
    setStatusMsg.timer = setTimeout(() => st.msg.classList.add("is-old"), 9000);
  }

  // ======================================================== toasts
  let toastBox = null;
  function toast(text, level) { HP.store.toast(text, level); }   // goes through the store -> 'message'
  function showToast(m) {
    if (!toastBox || !m || !m.text) return;
    const level = m.level || "info";
    for (const old of Array.from(toastBox.children)) {        // same text again: restart its timer
      if (old._text === m.text && !old.classList.contains("is-out")) { clearTimeout(old._timer); arm(old, level); return; }
    }
    const el = h("div", { class: "pn-toast is-" + level, role: level === "error" ? "alert" : "status" },
      icon(level === "ok" ? "check" : level === "info" ? "info" : "warn", 16), h("span", null, m.text));
    el._text = m.text;
    el.addEventListener("click", () => dismiss(el));
    toastBox.appendChild(el);
    while (toastBox.children.length > 3) toastBox.removeChild(toastBox.firstChild);
    arm(el, level);
  }
  function arm(el, level) { el._timer = setTimeout(() => dismiss(el), level === "error" ? 7000 : level === "warn" ? 5000 : 3500); }
  function dismiss(el) {
    clearTimeout(el._timer);
    if (el.classList.contains("is-out")) return;
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 200);
  }

  // ======================================================== tooltips
  let tipEl = null, tipFor = null, tipTimer = null;
  function setupTips() {
    tipEl = h("div", { class: "pn-tipbox", role: "tooltip" });
    document.body.appendChild(tipEl);
    document.addEventListener("pointerover", e => {
      const t = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
      if (t === tipFor) return;
      hideTip();
      if (!t || e.pointerType === "touch" || !insidePanels(t)) return;
      tipFor = t;
      tipTimer = setTimeout(() => showTip(t), t.classList.contains("pn-tile") ? 350 : 500);
    });
    document.addEventListener("pointerdown", hideTip, true);
    document.addEventListener("scroll", hideTip, true);
    window.addEventListener("blur", hideTip);
  }
  const insidePanels = el => !!(UI.roots && (Object.values(UI.roots).some(r => r && r.contains(el))
    || (helpEl && helpEl.contains(el))));
  function showTip(t) {
    if (!document.body.contains(t)) return;
    const txt = t.getAttribute("data-tip") || "";
    if (!txt) return;
    const lines = txt.split("\n");
    const kbd = t.getAttribute("data-kbd");
    const multi = lines.length > 1;
    const kids = [multi ? h("b", null, lines[0]) : h("span", null, lines[0])];
    if (multi) for (const l of lines.slice(1)) kids.push(h("span", null, l));
    if (kbd) kids.push(h("kbd", null, kbd));
    tipEl.replaceChildren(...kids);
    tipEl.classList.toggle("is-multi", multi);
    tipEl.classList.add("is-on");
    const r = t.getBoundingClientRect(), b = tipEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const pos = t.getAttribute("data-tip-pos") || "below";
    let x, y;
    if (pos === "right") { x = r.right + 10; y = r.top + r.height / 2 - b.height / 2; }
    else if (pos === "above") { x = r.left + r.width / 2 - b.width / 2; y = r.top - b.height - 8; }
    else { x = r.left + r.width / 2 - b.width / 2; y = r.bottom + 8; }
    if (pos !== "right" && y + b.height > vh - 6) y = r.top - b.height - 8;   // no room below: go above
    x = Math.max(6, Math.min(vw - b.width - 6, x));
    y = Math.max(6, Math.min(vh - b.height - 6, y));
    tipEl.style.left = Math.round(x) + "px"; tipEl.style.top = Math.round(y) + "px";
  }
  function hideTip() {
    clearTimeout(tipTimer); tipTimer = null; tipFor = null;
    if (tipEl) tipEl.classList.remove("is-on");
  }

  // ======================================================== help popover
  let helpEl = null;
  function buildHelp() {
    helpEl = h("div", { class: "pn-pop pn-help", role: "dialog", "aria-label": T.helpTitle },
      h("div", { class: "pn-pop-h" }, h("b", null, T.helpTitle),
        h("button", { type: "button", class: "pn-icon-btn", "aria-label": T.cancel, on: { click() { toggleHelp(false); } } }, icon("cross", 14))),
      h("dl", { class: "pn-help-list" }, T.help.map(([a, b]) => [h("dt", null, a), h("dd", null, b)])),
      h("div", { class: "pn-help-keys" }, T.helpKeys.map(([k, v]) => h("span", null, h("kbd", null, k), v))),
      h("p", { class: "pn-muted" }, T.helpFoot));
    document.body.appendChild(helpEl);
    document.addEventListener("pointerdown", e => {
      if (helpEl.classList.contains("is-on") && !helpEl.contains(e.target) && !top.helpB.contains(e.target)) toggleHelp(false);
    }, true);
  }
  function toggleHelp(force) {
    const on = force != null ? force : !helpEl.classList.contains("is-on");
    helpEl.classList.toggle("is-on", on);
    top.helpB.classList.toggle("is-on", on);
    if (on) {
      hideTip();
      const r = top.helpB.getBoundingClientRect(), vw = document.documentElement.clientWidth;
      helpEl.style.top = Math.round(r.bottom + 8) + "px";
      helpEl.style.right = Math.max(8, Math.round(vw - r.right)) + "px";
    }
  }

  // ======================================================== confirm dialog
  function confirmBox(title, text, okLabel) {
    return new Promise(resolve => {
      const prevFocus = document.activeElement;
      let done = false;
      const close = v => {
        if (done) return; done = true;
        wrap.classList.add("is-out");
        document.removeEventListener("keydown", onKey, true);
        setTimeout(() => wrap.remove(), 160);
        if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) { /* fine */ }
        resolve(v);
      };
      const onKey = e => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
        else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(document.activeElement !== cancelB); }
      };
      const okB = h("button", { type: "button", class: "pn-btn pn-btn-primary" }, okLabel);
      const cancelB = h("button", { type: "button", class: "pn-btn" }, T.cancel);
      okB.addEventListener("click", () => close(true));
      cancelB.addEventListener("click", () => close(false));
      const wrap = h("div", { class: "pn-modal" },
        h("div", { class: "pn-dialog", role: "alertdialog", "aria-modal": "true", "aria-label": title },
          h("div", { class: "pn-dialog-ic" }, icon("newf", 22)),
          h("div", { class: "pn-dialog-b" }, h("b", null, title), h("p", null, text),
            h("div", { class: "pn-dialog-a" }, cancelB, okB))));
      wrap.addEventListener("pointerdown", e => { if (e.target === wrap) close(false); });
      document.body.appendChild(wrap);
      document.addEventListener("keydown", onKey, true);
      okB.focus();
    });
  }

  // ======================================================== files
  function safeName(t) {
    const n = String(t || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    return n || T.untitled;
  }
  // one download per click (a second one from a timer is blocked by the browser)
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.style.display = "none";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function saveFile() {
    commitFocusedField();
    const P = HP.store.committed();
    const name = safeName(P.meta && P.meta.title) + ".houseplan.json";
    let text;
    try { text = HP.serialize(P); } catch (e) { console.error(e); toast(T.failed, "error"); return; }
    api.download(name, text, "application/json");
    toast(fill(T.saved, { name }), "ok");
  }
  function pickFile() { commitFocusedField(); top.file.click(); }
  function openText(text, fileName) {
    let P;
    try { P = HP.deserialize(text); }
    catch (e) { toast(fill(T.openFailed, { name: fileName || "?", msg: e.message }), "error"); return false; }
    HP.store.load(P, T.L.openPlan);
    if (HP.store.tool() !== "select") HP.store.setTool("select");
    if (HP.canvas && HP.canvas.fit) try { HP.canvas.fit(); } catch (e) { console.error(e); }
    toast(fill(T.opened, { name: (P.meta && P.meta.title) || fileName || T.untitled }), "ok");
    return true;
  }
  function exportDxf() {
    commitFocusedField();
    if (!HP.drawing || typeof HP.drawing.build !== "function" || !HP.dxf || typeof HP.dxf.write !== "function") {
      toast(T.dxfNotReady, "error"); return null;
    }
    const P = HP.store.committed();
    let text;
    try {
      const d = HP.drawing.build(P, HP.store.analysis(P), {});
      text = HP.dxf.write(d, { units: UI.units });
    } catch (e) { console.error("[panels] DXF export failed", e); toast(fill(T.dxfFailed, { msg: e.message }), "error"); return null; }
    if (typeof text !== "string" || !text) { toast(fill(T.dxfFailed, { msg: "empty" }), "error"); return null; }
    const name = safeName(P.meta && P.meta.title) + ".dxf";
    api.download(name, text, "application/dxf");
    toast(fill(T.dxfSaved, { name, units: T.unitNames[UI.units] }), "ok");
    return text;
  }
  async function askNew() {
    commitFocusedField();
    const yes = await confirmBox(T.newTitle, T.newText, T.newOk);
    if (!yes) return;
    HP.store.load(HP.newPlan(), T.L.newPlan);
    if (HP.store.tool() !== "select") HP.store.setTool("select");
    if (HP.canvas && HP.canvas.fit) try { HP.canvas.fit(); } catch (e) { console.error(e); }
    toast(T.newDone, "info");
  }
  // a field the user is still typing in: apply it before saving / exporting
  function commitFocusedField() {
    const a = document.activeElement;
    if (a && a._dirty && a.blur && insidePanels(a)) a.blur();
  }

  // ======================================================== keys
  const typing = el => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  function onKey(e) {
    if (e.key === "Escape" && helpEl && helpEl.classList.contains("is-on")) { toggleHelp(false); return; }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (document.querySelector(".pn-modal")) return;
    const k = e.key.toLowerCase();
    const inField = typing(document.activeElement);
    if (k === "z" || k === "y") {
      if (inField) return;                       // the field's own undo
      e.preventDefault();
      if (k === "y" || e.shiftKey) HP.store.redo(); else HP.store.undo();
    } else if (k === "s") { e.preventDefault(); saveFile(); }
    else if (k === "o") { e.preventDefault(); pickFile(); }
    else if (k === "e") { e.preventDefault(); exportDxf(); }
  }

  // ======================================================== wiring
  let liveTimer = null;
  function renderAll() { renderTop(); renderSidebar(); renderStatus(); }
  function onState(ev) {
    if (ev && ev.preview) {                       // a drag on the board: keep the panels live, cheaply
      if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = null; renderSidebar(); renderStatus(); }, 70);
      return;
    }
    clearTimeout(liveTimer); liveTimer = null;
    renderAll();
  }

  function init(roots) {
    if (!roots || !roots.topbar || !roots.palette || !roots.sidebar || !roots.statusbar)
      throw new Error("HP.panels.init needs {topbar, palette, sidebar, statusbar}");
    UI.roots = roots;
    loadPrefs();
    buildTop(roots.topbar);
    buildPalette(roots.palette);
    roots.sidebar.classList.add("pn-sidebar");
    roots.sidebar.innerHTML = "";
    sideInner = h("div", { class: "pn-side-in" });
    roots.sidebar.appendChild(sideInner);
    buildStatus(roots.statusbar);
    toastBox = h("div", { class: "pn-toasts", "aria-live": "polite" });
    document.body.appendChild(toastBox);
    setupTips();
    buildHelp();
    HP.store.on("state", onState);
    HP.store.on("select", () => { delete UI.msg.insp; renderSidebar(); });
    HP.store.on("message", m => { showToast(m); setStatusMsg(m); });
    HP.store.on("view", v => {
      if (!v) return;
      if (typeof v.zoom === "number") UI.zoomPct = Math.round(v.zoom * 100);
      else if (typeof v.scale === "number") UI.zoomPct = Math.round(v.scale / 37.795 * 100);   // 1:100 at 96 dpi = 100%
      UI.zoom = v.scale;
      renderStatus();
    });
    window.addEventListener("keydown", onKey);
    renderAll();
  }

  const api = { init, T, render: renderAll, download, saveFile, openText, exportDxf, newPlan: askNew,
                _morph: morph, _parseM: parseM };
  HP.panels = api;
})(globalThis.HP = globalThis.HP || {});

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.HP;
