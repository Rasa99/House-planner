# House Planner - build contract (2026-10-14)

This file is the agreement between the agents building House Planner in
parallel. **If your code and this file disagree, this file wins** - and if
this file is wrong, say so in your report instead of silently working round it.

`src/core.js` and `src/store.js` are real code that already exists: read them
first. They hold the plan format, room types, rules constants, layer table and
the geometry helpers named below.

---

## 1. What Rasa asked for (his voice brief, transcription corrected)

A modern, fast, intuitive **drag-and-drop house-plan program for his dad**,
replacing the old procedural generator (`../engine.js`, `../prototype.html`,
which stay as they are). Top view (plan) only for now.

1. Dad defines the **land**: a width x depth (e.g. 10 x 20 m) or its corners.
2. A **panel of rooms** - Bedroom, Kitchen, Reception, Living room, Bathroom,
   Toilet (WC), Open area (plus Hall) - is **dragged onto the land**. A dropped
   room arrives with **furniture already set out, a door and a window**.
3. Rooms resize by **dragging walls in 5 cm steps**, with **dimensions updating
   live**. Moving a wall also resizes the **neighbouring rooms** on its other
   side, and furniture re-arranges itself.
4. **Clicking (grabbing) a room's name moves the room** around the house - no
   artifacts: it stays inside the land, snaps against other rooms, and what is
   around it adjusts (dropping it onto another room swaps the two).
5. **Doors** can be dragged along a wall and onto another wall. **Never a door
   on an outside wall that faces a neighbour** - plots usually have neighbours
   on three sides. Door sizes 1.00 m (entrance) and 0.80 m (inside).
6. **Windows** are dragged in from the panel in 0.60 / 1.00 / 1.20 / 1.50 /
   2.00 / 2.50 m, and **only go on walls that face an open area** (a courtyard,
   the yard, or the street). Every room needs one.
7. A **streets panel**: which sides of the land are street and which are
   neighbours (front only, front and back, two sides ...). The street is drawn.
8. A draggable **section mark** (A-A), with a better-looking symbol than the
   old generator's circle-and-letter.
9. **Rules** (from the old generator's docs + the brief): the house has at
   least one open area of reasonable size; every room has a window onto an
   open area; at least one bathroom and one WC; a living room; bedrooms 3-5 m
   each way; window widths suit the room.
10. **Export DXF** that AutoCAD reads cleanly: clean polylines and lines,
    **real hatches**, real dimensions, furniture as blocks.
11. The look and colours of the old generator (dark navy, maroon hatched
    walls, cyan dimensions with oblique ticks, blue windows, lavender labels).
    Rasa will send pictures to change the look later. **The reference pictures
    he mentioned did not arrive in this session.**

## 2. Folder, files and who owns them

`G:\My Drive\Work Computer\Claude Tools\Web Projects\houseplan\planner\`

| File | Owner | What |
|---|---|---|
| `CONTRACT.md`, `src/core.js`, `src/store.js`, `src/theme.css`, `index.html`, `build.py`, `README.md` | integration (main session) | shared |
| `src/analyze.js`, `src/model.js`, `test/model.test.js`, `test/analyze.test.js` | **model** agent | geometry, edits, rules |
| `src/furniture.js`, `test/furniture.test.js`, `dev/furniture-*` | **furniture** agent | blocks + auto layout |
| `src/drawing.js`, `src/dxf.js`, `test/drawing.test.js`, `test/dxf.test.js`, `dev/dxf-*` | **drafting** agent | the drawing + DXF |
| `src/render.js`, `src/canvas.js`, `src/app.css`, `dev/canvas-*` | **canvas** agent | the drawing board |
| `src/panels.js`, `src/panels.css`, `dev/panels-*` | **panels** agent | everything round the board |

`test/fixtures/sample-house.json` (integration) is a shared sample plan: a
10 x 19 m plot, street at the bottom, garden, living + kitchen + WC/bath across
the front, a full-width courtyard, three bedrooms behind it - it is meant to
pass every rule. Use it in your tests and dev pages.

**Other agents are writing the other modules AT THE SAME TIME.** Until a
module you depend on exists in `src/`, code against this contract and use a
stand-in that lives in YOUR `dev/` files (never in `src/`). Before you finish,
check whether the real module has appeared and, if it has, run against it.

**Only write your own files.** The folder is Google-Drive synced: two agents
writing one file make a conflict copy, not a merge. If you need a change in
someone else's file, put it in your final report. Scratch/temporary files go
in your own scratchpad, never in this folder. Test fixtures go in
`test/fixtures/<owner>-*.json`.

The deliverable for Rasa's dad is ONE file, `House Planner.html`, made by
`build.py` inlining every `src/*.js` and `src/*.css` into `index.html`'s place.
So: **no external resources at all** (no CDN, no web fonts, no fetch, no
modules/imports). Must work from `file://` with no network.

## 3. Conventions every module follows

- **Module pattern** (browser + Node tests):
  ```js
  "use strict";
  (function (HP) { ... HP.model = { ... }; })(globalThis.HP = globalThis.HP || {});
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.HP;
  ```
  Tests load modules with `require("../src/core.js")` etc. in index.html order.
- **Units:** plans and analysis are **integer centimetres on a 5 cm grid**.
  `drawing.js` is the one place that converts to **metres**; render.js and
  dxf.js only ever see metres.
- **Axes:** x right, **y up**. The canvas flips y for the screen.
- **Plans are immutable.** Every model op takes a plan and returns a NEW plan
  (`HP.clone` it first); the input is never changed. Drags always restart
  from the drag-start plan (`op(startPlan, ..., absoluteTarget)`), never
  accumulate small deltas.
- **Every model op returns** `{ state, ok, reason, id, note }`:
  `state` = the resulting plan (the input object itself if nothing changed),
  `ok` = false when the request could not be done as asked (state is then the
  nearest legal result or unchanged), `reason` = one short plain-English
  sentence for dad ("Doors can't go on a wall shared with the neighbours."),
  `id` = the id of a created thing, `note` = an info message for a toast
  ("Bathroom windows are 0.60 m - set to 0.60.").
- Plain English in every user-facing string. Dad is not a programmer and may
  not be a native English speaker: short words, no jargon.
- Speed budget: one drag step (model op + analyze + drawing + render) under
  **16 ms** for a 20-room plan on an ordinary PC.
- Tests: run `node --test` from inside the `planner` folder, or
  `node --test "<planner>/test/*.test.js"` (Node 24 treats a bare folder path
  as a file and fails with MODULE_NOT_FOUND). `node:test` + `node:assert/strict`. Python for DXF checks:
  `py -3` (ezdxf 1.4.4 installed). `python` on PATH is the Store stub - use `py`.

## 4. The plan (save file) - defined in core.js `newPlan()`

```js
{ version:1, meta:{title, created, modified},
  plot:{ pts:[[x,y],...] /* CCW */, edges:["street"|"neighbour", ...] /* edge i = pts[i]->pts[i+1] */, road:800 },
  walls:{ ext:20, int:20 },
  rooms:[ { id:"r3", type:"bedroom", name:"Bedroom 1", x, y, w, h, furn:0 } ],   // CLEAR inside rect
  openings:[ { id:"o5", kind:"door"|"window", room:"r3", side:"N"|"E"|"S"|"W",
               at /* cm from the side's start (HP.sideInfo s0) to the opening's start */, w,
               hinge:"start"|"end", swing:"in"|"out" } ],        // hinge/swing: doors only
  sections:[ { id:"s1", label:"A", a:[x,y], b:[x,y], look:1|-1 } ],  // look: +1 = looks to the LEFT of a->b
  seq:1 }
```
- Room types, default sizes, hard minimums, allowed window widths: `HP.ROOM_TYPES`.
- A **shared wall** = two rooms whose clear rects are exactly `walls.int` apart
  and overlap along that edge. Every other side of a room has `walls.ext` of
  wall. The house outline is the union of every room grown by `walls.ext`.
- `furn` = index into `HP.furniture.variants(type)`; 0 = automatic.
- An opening's host `room` is the room on whose side it sits; on a shared wall
  either room may host it. A door with `swing:"in"` opens into its host room.
  A window is always hosted by a roofed room (never by an open area).

## 5. Analysis - `HP.analyze(plan)` (model agent; `HP.store.analysis()` caches it)

All cm. Plain data (no functions), so it can be cached and logged.
```js
A.rooms[]   { id, type, name, x, y, w, h, area /*cm2*/, roofed, cx, cy }
A.sides     { [roomId]: { N:[run], E:[run], S:[run], W:[run] } }
            run = { s0, s1, kind, other, depth }   // what lies beyond that part of the side
            kind: 'room'      shared wall with roofed room `other`
                  'open'      shared wall with open area `other` (a courtyard)
                  'yard'      unbuilt land at least RULES.minOpenDepth deep in front
                  'street'    the wall stands on/near (< minOpenDepth) a street edge (other = edge index)
                  'neighbour' the wall stands on/near a neighbour edge (other = edge index)
                  'blocked'   something else is closer than minOpenDepth (not a shared wall)
            depth = clear distance (cm) in front of the wall's outer face (0 for room/open)
A.walls     { loops:[ [[x,y],...], ... ] }   // wall poche, every door/window opening CUT OUT,
                                             // closed loops (first point not repeated), even-odd, integer cm
A.footprint { loops }   // outer outline of the house (union of rooms grown by ext), even-odd
A.yard      { loops }   // plot minus footprint (for the grass hatch), even-odd
A.openings[] { id, kind, room, side, at, w, hinge, swing,
               axis /*'x'|'y'*/, s0, s1 /*absolute span along axis*/,
               fixed /*host inner-face coordinate*/, thick /*wall depth here*/, far /*fixed + n*thick*/,
               n:[nx,ny] /*outward from host*/, facing /*run kind*/, other,
               ok, reason }
A.roomOpenings { [roomId]: [ { id, kind, side /*side of THIS room*/, s0, s1, w,
                               swingInto /*door leaf sweeps into this room*/, hingeAt:'s0'|'s1' } ] }
               // includes openings hosted by the room AND those on the far face of its shared walls
A.handles[]  { key, orient:'v'|'h', pos /*centre line: x for v, y for h*/, from, to,
               members:[{room, side}], kind:'shared'|'outer' }
               // draggable wall lines. Collinear edges that touch along the line form ONE
               // handle (a long wall behind three bedrooms is one handle). 'v' moves in x.
A.bbox       { x0, y0, x1, y1 } | null   // house outer faces
A.rules[]    { id, ok, level:'error'|'warn', title, detail, refs:[ids] }
A.issues     { [roomOrOpeningId]: [ruleId, ...] }
A.access     { reachable:[roomIds], entrances:[openingIds] }
A.stats      { plotArea, builtArea, roofedArea, coverage /*0..1*/, rooms }   // cm2
```
**Openings allowed by facing:**

| facing | door | window |
|---|---|---|
| room | yes | no |
| open | yes | yes |
| yard | yes | yes |
| street | yes | yes |
| neighbour | **no** | **no** |
| blocked | no | no |

An opening must face ONE kind along its whole width, keep `RULES.endClear`
from corners and from T-junction walls on either face, and keep
`RULES.openingGap` from other openings on the same wall (either face).

**Rules** (ids, all level 'error' unless marked):
`open-area` at least one open area · `open-size` every open area at least
1.30 x 2.00 m · `bath` a bathroom · `wc` a toilet · `living` a living room ·
`windows` every room whose type `needsWindow` has a window facing open/yard/street ·
`window-size` window widths inside the room type's `win` range ·
`bedroom-size` bedrooms 3.00-5.00 m both ways · `openings` every opening is
allowed by the table above · `access` every roofed room is reachable through
doors from the yard/street, and there is an entrance · `fits` everything inside
the land (should always hold).

## 6. Model ops - `HP.model.*` (model agent)

All pure, all return `{state, ok, reason, id, note}`. `pt` = [x,y] cm.
```
addRoom(plan, type, pt)            centre the type's default size on pt, nearest legal spot, auto name,
                                   default door + window where a legal wall exists (door: shared wall with a
                                   roofed room -> 0.80 interior; else onto yard/street -> 1.00 entrance)
moveRoom(plan, id, x, y, opts)     x,y = requested lower-left; opts.snap = magnet distance cm (default 25).
                                   nearest legal spot; the room's openings travel with it
swapRooms(plan, a, b)              the rooms exchange rectangles; openings stay where they are physically
                                   and are re-hosted; window widths refitted to the new room type
dragWall(plan, key, delta, opts)   key from analyze(plan) OF THE SAME PLAN; delta cm along the handle's axis;
                                   opts.only = roomId -> move only that room's edge. Clamped to the furthest
                                   legal value (hard minimums, other rooms, the land)
setRoomSize(plan, id, w, h)        typed size; neighbours adjust as with dragWall
removeRoom / renameRoom(plan,id,name) / setRoomType(plan,id,type) / setFurniture(plan,id,index)
checkOpening(plan, kind, w, pt, opts) -> {ok, reason, placement:{room, side, at, w}}   no change; for ghosts
addOpening(plan, kind, w, pt, opts)   nearest legal placement around pt; window width fitted to the room
moveOpening(plan, id, pt, opts)       may jump to another wall / room; ok:false + reason when nothing legal near
setOpening(plan, id, {w, hinge, swing}) / flipDoor(plan, id, 'swing'|'hinge') / removeOpening(plan, id)
addSection(plan, pt) / moveSection(plan, id, {a, b, dx, dy}) / flipSection / turnSection / removeSection /
setSectionLabel(plan, id, label)   sections stay horizontal or vertical; ends snap to 5 cm
setPlotRect(plan, w, d) / movePlotCorner(plan, i, pt) / addPlotCorner(plan, edgeIndex, pt) /
removePlotCorner(plan, i) / setEdgeKind(plan, i, kind) / setRoad(plan, cm) / setWalls(plan, ext, int) /
setTitle(plan, title)
```
**No artifacts:** the gap between two rooms' clear rects (where they face each
other) is either exactly `walls.int` (a shared wall) or at least
`2*walls.ext + RULES.minGap` (a real yard/passage). The gap between a room's
outer wall face and an axis-aligned land edge is either 0 or at least
`RULES.minGap`. Anything in between snaps to the nearer allowed value. Rooms
never overlap and never leave the land.

## 7. Furniture - `HP.furniture.*` (furniture agent)

```
BLOCKS          { NAME: { layer:'A-FURN'|'A-FIXT', w, h /*cm, local extent from 0,0*/, items:[prim] } }
                prim = drawing primitives (section 8) in LOCAL CM, kinds pline/line/arc/circle/hatch only
variants(type)  -> [{ key, label }]   index 0 is always { key:'auto', label:'Automatic' }
layout(room, roomOpenings, furn) -> { inserts:[{ block, x, y, rot, sx }], used }
                room = A.rooms[i]; roomOpenings = A.roomOpenings[room.id]; all cm, world coords.
                world point = T(x,y) * R(rot deg CCW) * S(sx,1) * local point   (exactly DXF INSERT semantics;
                sx is 1 or -1)
```
As built, `layout` also returns `key`, `label`, `dropped[]` (core pieces that
did not fit) and `skipped[]` (optional extras left out), and `used` is the
index of the variant really laid out (so Automatic reports its pick). "Across
a window" = within 60 cm in front of it (`RULES.WIN_DEPTH`).

Furniture stays inside the room, out of every door's swing and the 60 cm in
front of it, tall pieces (wardrobe, fridge) never across a window; fewer
pieces when the room is small, never overlapping pieces. Deterministic. Under
1 ms per room.

## 8. Drawing - `HP.drawing.build(plan, A, opts)` (drafting agent)

Returns `{ items:[prim], blocks:{NAME:{items:[prim]}} /*metres*/, extents:{x0,y0,x1,y1} }`,
everything in **METRES**. `opts = { furniture, dims, labels, sizes, sections, site }`
(all default true; `sizes` = clear W x H under each room name).

Primitive kinds (every item has `layer`, optional `color` hex override,
`ltype`, `lw`, `ref` = id of the room/opening/section it belongs to, and
`role` - see below):
```
{kind:'pline',  pts:[[x,y],...], closed, bulges?:[...]}
{kind:'line',   a:[x,y], b:[x,y]}
{kind:'arc',    c:[x,y], r, a0, a1}          // degrees, CCW from a0 to a1
{kind:'circle', c:[x,y], r}
{kind:'hatch',  pattern:'ANSI31'|'DOTS'|'GRASS'|'SOLID', scale, angle, loops:[[[x,y],...],...]}   // even-odd
{kind:'text',   p:[x,y], h, text, align:'mc'|'bc'|'tc'|'ml'|'mr'|'bl', rot}
{kind:'dim',    a:[x,y], b:[x,y], d:[x,y] /*a point on the dimension line*/, rot /*0 horiz, 90 vert*/,
                text /*"4.20"*/, small /*wall-thickness segment*/}
{kind:'insert', block, p:[x,y], rot, sx}
```
Roles: `wall`, `wall-hatch`, `door-leaf`, `door-swing`, `window`, `furn`,
`room-name`, `room-area`, `room-size`, `dim`, `section`, `section-label`,
`plot`, `plot-dim`, `road`, `road-label`, `open-hatch`, `yard-hatch`.
Colours/linetypes/lineweights come from `HP.LAYERS` unless overridden.

## 9. DXF - `HP.dxf.write(drawing, opts) -> string` (drafting agent)

AC1032 (port the structure of `Inkline/src/Inkline/Core/Dxf.cs`, which opens in
AutoCAD 2027 with AUDIT 0 errors). Layers with true colours, linetypes, lineweights;
LWPOLYLINE, LINE, ARC, CIRCLE, TEXT, **HATCH with real pattern definitions**
(ANSI31 walls, DOTS open areas, GRASS yard, SOLID fills), **DIMENSION** entities
with a dimstyle (oblique ticks, cyan, 2 decimals) and their anonymous blocks,
furniture as BLOCK + INSERT. `opts.units` 'm' (default) | 'cm' | 'mm'.

## 10. Canvas - `HP.canvas.*` and `HP.render.*` (canvas agent)

```
HP.canvas.init(stageEl)  fit()  zoomBy(f)  focus(ids)  toWorld(clientX, clientY) -> [x,y] cm  redraw()
HP.render.draw(ctx, drawing, view, opts)   view = { scale /*px per metre*/, ox, oy /*screen px of world 0,0*/ }
```
Owns: rendering, pan/zoom, hit-testing, every drag on the board (room by its
name, walls, doors/windows along and across walls, sections and their ends,
land corners when `HP.store.tool()==='plot'`), drops from the palette (ghost +
green/red + reason), hover/selection visuals, live size read-outs while
dragging, board keys (Delete, Esc, arrows nudge 5 cm / Shift 50 cm, F fit, + -).
Listens to `palette:start` / `palette:click`. Emits `view {scale}` (px per
metre) on every zoom/pan so the status bar can show the zoom.

## 11. Panels - `HP.panels.init({topbar, palette, sidebar, statusbar})` (panels agent)

Owns: top bar (title, New, Open, Save, Export DXF, Undo/Redo, Fit), the
palette tiles (rooms, doors, windows, section) - on pointerdown it waits for a
4 px move then emits `palette:start {item, event}`, or `palette:click {item}`
on a release without moving; items are `{kind:'room', type}`,
`{kind:'door', w}`, `{kind:'window', w}`, `{kind:'section'}`. Right side: Land
(size / corner editing), Streets (click the sides of a little plot diagram),
Walls, the Inspector for the selection, the live Rules checklist (click ->
`HP.canvas.focus(refs)`), status bar and toasts. Global keys: Ctrl+Z, Ctrl+Y /
Ctrl+Shift+Z, Ctrl+S save, Ctrl+O open, Ctrl+E export (ignored while typing in
a field). Save = download `<title>.houseplan.json`; Open = file picker; the
store also autosaves to localStorage.
