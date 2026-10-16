# House Planner

A drag-and-drop house-plan program for Rasa's dad. Plan (top) view only.
It replaces the old procedural generator (`../engine.js`, `../prototype.html`,
kept as they were) because a procedural layout could never be steered closely
enough. Started 2026-10-14.

**The file to give dad: `House Planner.html`** (one file, works offline,
double-click to open in Chrome or Edge). Rebuild it after any change:

```
py -3 build.py
```

## What dad can do

- **Land:** type width x depth (5 cm steps), or switch on *Edit corners* and drag
  the corners for a land that is not a rectangle.
- **Streets:** click the sides of the little land drawing to mark each one street
  or neighbour. The street is drawn outside that side with its width.
- **Rooms:** drag Bedroom, Living room, Reception, Kitchen, Bathroom, Toilet (WC),
  Open area or Hall onto the land. A room arrives with its furniture, a door and
  a window wherever a legal wall exists. Clicking a tile instead adds the room in
  the middle of the view.
- **Resize:** drag any wall. The rooms on its other side follow, in 5 cm steps,
  with the sizes shown live. Alt + drag moves only one room's edge. Exact sizes
  can be typed in the inspector on the right.
- **Move:** grab a room by its NAME. It snaps against the other rooms and stays
  on the land. Drop it on another room and the two swap places.
- **Doors** (0.80 / 1.00 m) and **windows** (0.60, 1.00, 1.20, 1.50, 2.00,
  2.50 m) are dragged in from the left, then along their wall or onto another
  wall. Double-click a door to flip its swing. Doors and windows never go on a
  neighbour wall. Windows only go on walls facing an open area, the yard or the
  street.
- **Section mark:** drag it in, drag its line or its ends, click a head to flip
  which way it looks.
- **Furniture:** chosen automatically for the room's size and doors. The
  inspector offers other layouts: double, king or two single beds; sofa set,
  L-sofa or Iraqi floor seating; L, U or one-wall kitchen; western or squat
  toilet, and so on.
- **Rules**, live on the right. Click a problem to zoom to it. The rules are:
  - at least one open area, of at least 1.30 x 2.00 m;
  - a bathroom, a toilet and a living room;
  - every room except the hall has a window onto an open area, the yard or
    the street;
  - window widths suit the room: bath/WC 0.60, bedroom 1.00-1.50, living /
    kitchen / reception 1.50-2.50;
  - bedrooms are 3.00-5.00 m each way;
  - every room can be reached through doors from outside.
- **Save / Open** a `.houseplan.json` file (this is how a plan moves between
  computers). It also autosaves in the browser.
- **Export DXF** for AutoCAD, in m (the default), cm or mm.

## Files

| File | What |
|---|---|
| `House Planner.html` | the built program, everything inlined; made by `build.py` |
| `index.html` | the development page; loads `src/*` one by one |
| `src/core.js` | units, the plan format, room types, rules constants, layers, geometry helpers |
| `src/store.js` | the current plan, undo/redo, selection, events, autosave |
| `src/analyze.js` | walls, what each wall faces, wall handles, the rules, access |
| `src/model.js` | every edit (add/move/swap rooms, drag walls, doors/windows, sections, land) |
| `src/furniture.js` | 47 top-view furniture blocks + the automatic layout |
| `src/drawing.js` | the plan as drawing items, in metres (one source for the screen and the DXF) |
| `src/dxf.js` | DXF writer (AC1032) |
| `src/render.js`, `src/canvas.js`, `src/app.css` | the drawing board |
| `src/panels.js`, `src/panels.css` | top bar, palette, land/streets/walls/inspector/rules, status bar |
| `CONTRACT.md` | the agreement the modules were built to (units, formats, APIs) |
| `test/` | node tests; `test/fixtures/sample-house.json` is a plan that passes every rule |
| `dev/` | dev pages and checks: `furniture-sheet.html`, `canvas-tests.js`, `dxf-check.py`, `dxf-acad.ps1` |

Tests: `node --test` run inside this folder. A bare folder path does not work
on Node 24; `node --test "<this folder>/test/*.test.js"` also works.

DXF checks:
- `node dev/dxf-export.js` writes a plan to DXF;
- `py -3 dev/dxf-check.py` runs the ezdxf audit and renders a PNG;
- `dev/dxf-acad.ps1` runs AutoCAD 2027 headless, only through
  `AutoCAD Tools\Run-Headless.ps1`.

Dev server: `.claude/launch.json` entry `houseplanner` (port 8796).

## How it is built (decisions worth knowing)

- **Everything is integer centimetres on a 5 cm grid** until `drawing.js`
  converts to metres. Rooms are stored as their CLEAR inside rectangle. A
  shared wall is a gap of exactly the inside-wall thickness. Every other side
  gets the outside wall.
- **No artifacts.** Two rooms either share a wall or leave a real passage:
  2 x outside wall + 1.00 m. The same holds between a wall and the land edge
  (0 or at least 1.00 m). Gaps in between snap shut or open.
- **"Open" for a window** means a courtyard (Open area), at least 1.00 m of
  unbuilt land in front (the yard), or a street side. Street-facing windows are
  allowed. This is a reading of the brief; Rasa may say otherwise.
- **The screen and the DXF come from the same drawing items**, so what dad sees
  is what AutoCAD gets.
- **The DXF** (AC1032, metres) has:
  - layers with true colours (`A-WALL`, `A-WALL-PATT`, `A-DOOR`, `A-GLAZ`,
    `A-FURN`, `A-FIXT`, `A-ANNO-TEXT`, `A-ANNO-DIMS`, `A-SECT`, `A-PLOT`,
    `A-ROAD`, `A-OPEN-PATT`, `A-SITE-PATT`);
  - real HATCH entities using AutoCAD's own acadiso.pat definitions (ANSI31
    walls, DOTS open areas, GRASS yard, SOLID section arrows);
  - real DIMENSION entities with dimstyle `HP` (oblique ticks, 2 decimals);
  - furniture as BLOCK + INSERT.
- **The look** is the old generator's: dark navy, maroon hatched walls, cyan
  dimensions with oblique ticks, blue windows, lavender labels.
- Panels CSS classes use the `pn-` prefix. The board uses `hp-`. Panel
  preferences (collapsed cards, DXF units, rules fold) are kept in localStorage
  under `houseplanner.panels.v1`. The plan's autosave is under
  `houseplanner.autosave.v1`.

## Verified (2026-10-15)

- An end-to-end run on the built file, with a real mouse, from an empty plot:
  - rooms dragged in, a door dragged onto a wall, and a shared wall dragged;
  - windows a new room covered moved themselves to a free outside wall (with a
    message);
  - a bathroom dropped into a 1.70 m gap was made 1.70 m wide;
  - then exported; AutoCAD AUDIT found 0 errors, and its counts and hatch
    areas equal the drawing's.
- 94 node tests pass, including a fuzz run of 6,000 random edits that stay legal
  and a furniture sweep of 73,165 layouts with 0 rule breaks (292,660 in the full
  sweep).
- The DXF opens in AutoCAD 2027 (headless) with "Total errors found 0". Entity
  counts and hatch areas match. ezdxf audit: 0 errors.
- The board passed 26 scripted interaction checks against the real modules.
  The panels were checked control by control, with real downloads.
- One drag step (edit + analysis + drawing + redraw) takes about 4-5 ms on the
  sample house and about 12 ms on a 20-room plan.

## Not verified / known limits

- Not used by dad yet. Not opened in the interactive AutoCAD window: everything
  was headless, though the plot PNG is AutoCAD's own.
- The built file was tested over http, not from `file://`.
- No touch pinch-zoom; HiDPI screens are not seen.
- AutoCAD redraws the 0.20 wall-thickness dimensions with small stubs outside
  the ticks. Dimension text colour in AutoCAD's redraw is ACI 141, very near the
  screen cyan.
- No path drawn through the garden to the entrance, and no "SECTION A-A" title.
  Two streets meeting at a corner simply cross.
- When a new room covers the house's only entrance door, that door becomes an
  inside door. The rules panel then says rooms can't be reached; dad drags in a
  1.00 m door. No new entrance is added automatically.
- Top and side dimension chains measure every room seen from that side, so
  long extension lines can cross the yard to a room set far back.
- Room names are small at "fit" zoom on a small screen (about 8-9 px). Zooming
  in fixes it.
- **The reference pictures Rasa mentioned on 2026-10-14 never arrived. Ask for
  them before changing the look.**
- Rasa offered his own furniture block library. The blocks are plain data in
  `furniture.js` and can be replaced.
