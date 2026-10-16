"use strict";
/* Tests for src/model.js (model agent).  Run:
     node --test "G:/My Drive/Work Computer/Claude Tools/Web Projects/houseplan/planner/test/"   */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

require("../src/core.js");
require("../src/store.js");
require("../src/analyze.js");
require("../src/model.js");
const HP = globalThis.HP, M = HP.model;

const FIX = path.join(__dirname, "fixtures");
const load = name => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
const sample = () => load("sample-house.json");
const room = (plan, id) => plan.rooms.find(r => r.id === id);
const opening = (plan, id) => plan.openings.find(o => o.id === id);
const handleOf = (plan, id, side) =>
  HP.analyze(plan).handles.find(h => h.members.some(m => m.room === id && m.side === side));
/* where an opening physically is: [axis, s0, s1, wall band] */
function place(plan, id) {
  const g = HP.analyze(plan).openings.find(o => o.id === id);
  return [g.axis, g.s0, g.s1, Math.min(g.fixed, g.far), Math.max(g.fixed, g.far)];
}
/* run an op and check the contract shape + that the input was not touched */
function run(name, plan, ...args) {
  const before = JSON.stringify(plan);
  const r = M[name](plan, ...args);
  assert.equal(JSON.stringify(plan), before, name + " changed its input");
  assert.ok(r && typeof r === "object" && r.state, name + " returned no state");
  assert.equal(typeof r.ok, "boolean"); assert.equal(typeof r.reason, "string"); assert.equal(typeof r.note, "string");
  assert.ok("id" in r);
  if (!r.ok) assert.ok(r.reason.length > 0, name + " failed without a reason");
  return r;
}
const legalOk = (plan, what) => { const L = M.legal(plan); assert.ok(L.ok, (what || "") + " " + L.reason); };

// ------------------------------------------------------------------ legality
test("legal(): the sample is legal, and each kind of fault is caught", () => {
  legalOk(sample());
  legalOk(load("model-20rooms.json"));
  const bad = (edit, re) => { const p = sample(); edit(p); const L = M.legal(p); assert.equal(L.ok, false); assert.match(L.reason, re); };
  bad(p => { room(p, "r8").w = 330; }, /outside the land/);
  bad(p => { room(p, "r3").x = 700; room(p, "r3").w = 280; }, /overlaps/);
  bad(p => { room(p, "r2").x = 470; room(p, "r2").w = 250; }, /too close/);         // 30 cm gap: neither wall nor passage
  bad(p => { room(p, "r1").x = 70; room(p, "r1").w = 370; }, /from the land edge/); // 50 cm slot at the side
  bad(p => { room(p, "r3").h = 177; }, /grid/);
  bad(p => { room(p, "r6").w = 150; room(p, "r6").x = 180; }, /smaller than 2\.00 m/);
  bad(p => { opening(p, "o16").at = 200; }, /off its wall/);
  // a diagonal clean joint is fine; a diagonal near-miss is not
  const q = HP.newPlan({ w: 1000, d: 1000 });
  q.rooms.push({ id: "a", type: "hall", name: "A", x: 20, y: 20, w: 300, h: 300, furn: 0 });
  q.rooms.push({ id: "b", type: "hall", name: "B", x: 340, y: 340, w: 300, h: 300, furn: 0 });
  legalOk(q, "corner joint");
  q.rooms[1].x = 370;
  assert.equal(M.legal(q).ok, false);
});

// ------------------------------------------------------------------ dragWall
test("dragWall: living/kitchen wall by +50, clamped by the hard minimum", () => {
  const p = sample();
  const h = handleOf(p, "r1", "E");
  let r = run("dragWall", p, h.key, 50);
  assert.equal(r.ok, true);
  assert.equal(room(r.state, "r1").w, 470);
  assert.equal(room(r.state, "r2").x, 510); assert.equal(room(r.state, "r2").w, 210);
  legalOk(r.state);
  // the living room's openings are untouched; the kitchen lost 50 cm at its west end, so its
  // front window (was 5 cm from the new corner) and courtyard door (was off the new wall) move
  // just far enough to keep 10 cm from the corner
  for (const id of ["o10", "o11", "o12"]) assert.deepEqual(place(r.state, id), place(p, id));
  assert.deepEqual(place(r.state, "o13").slice(1, 3), [520, 670]);
  assert.deepEqual(place(r.state, "o14").slice(1, 3), [520, 600]);
  assert.ok(HP.analyze(r.state).openings.every(o => o.ok));
  // the other way the kitchen's doors and windows keep their place on the ground
  r = run("dragWall", p, h.key, -20);
  assert.equal(room(r.state, "r2").x, 440);
  for (const id of ["o13", "o14"]) assert.deepEqual(place(r.state, id), place(p, id), id);
  r = run("dragWall", p, h.key, 50);
  // the kitchen can't go below 1.50 m
  r = run("dragWall", p, h.key, 300);
  assert.equal(r.ok, false); assert.match(r.reason, /1\.10 m/);
  assert.equal(room(r.state, "r2").w, 150); assert.equal(room(r.state, "r1").w, 530);
  legalOk(r.state);
  // its 1.50 window no longer fits a 1.50 wall: it steps down to 1.20, kept on the wall
  const o13 = opening(r.state, "o13");
  assert.equal(o13.w, 120); assert.ok(o13.at >= 10 && o13.at + o13.w <= 140);
  assert.match(r.note, /smaller/);
  // the living room can't go below 2.00 m the other way
  r = run("dragWall", p, h.key, -400);
  assert.equal(room(r.state, "r1").w, 200); assert.equal(room(r.state, "r2").x, 240);
  legalOk(r.state);
  // a drag that can't move at all gives back the same plan
  const back = handleOf(p, "r6", "N");
  assert.equal(run("dragWall", p, back.key, 40).state, p);
});

test("dragWall: the gap rule snaps to 0 or to a real gap", () => {
  const p = sample();
  const back = handleOf(p, "r6", "N");                 // the back wall stands on the land edge
  assert.equal(back.members.length, 3);
  let r = run("dragWall", p, back.key, -40);            // 40 cm slot: snaps back shut
  assert.equal(r.state, p); assert.equal(r.ok, false);
  r = run("dragWall", p, back.key, -80);                // nearer to 1.00 m: snaps open
  for (const id of ["r6", "r7", "r8"]) assert.equal(room(r.state, id).h, 340);
  legalOk(r.state);
  r = run("dragWall", p, back.key, -150);
  for (const id of ["r6", "r7", "r8"]) assert.equal(room(r.state, id).h, 290);
  assert.equal(r.ok, true);
  // only one room's edge, on a shared wall: 0.50 m is a slot, so it opens to a 1.40 m passage
  const lk = handleOf(p, "r1", "E");
  r = run("dragWall", p, lk.key, -100, { only: "r1" });
  assert.equal(room(r.state, "r1").w, 300); assert.deepEqual(room(r.state, "r2"), room(p, "r2"));
  legalOk(r.state);
  assert.equal(run("dragWall", p, lk.key, 50, { only: "r1" }).state, p);    // into the kitchen: no
  assert.equal(run("dragWall", p, "nope", 50).ok, false);
});

test("setRoomSize goes through the wall machinery", () => {
  const p = sample();
  let r = run("setRoomSize", p, "r2", 300, 470);       // kitchen wider: the WC and bath give way
  assert.equal(r.ok, true);
  assert.deepEqual([room(r.state, "r2").w, room(r.state, "r3").x, room(r.state, "r3").w, room(r.state, "r4").w], [300, 780, 200, 200]);
  legalOk(r.state);
  r = run("setRoomSize", p, "r1", 420, 520);           // taller living room: the courtyard side can't move, so it grows to the front
  assert.equal(r.ok, true);
  assert.deepEqual([room(r.state, "r1").y, room(r.state, "r1").h], [670, 520]);
  r = run("setRoomSize", p, "r3", 240, 50);
  assert.equal(r.ok, false); assert.match(r.reason, /at least 0\.80 m/);
  r = run("setRoomSize", p, "r6", 600, 440);           // bedroom 1 can't get 6 m wide here
  assert.equal(r.ok, false); legalOk(r.state);
});

// ------------------------------------------------------------------ moveRoom
test("moveRoom: magnet, nearest free spot, openings travel", () => {
  const p = sample();
  // into the front yard, 5 cm off the bath's line: the magnet pulls it into line and against the kitchen
  let r = run("moveRoom", p, "r3", 745, 530);
  assert.equal(r.ok, true);
  assert.deepEqual([room(r.state, "r3").x, room(r.state, "r3").y], [740, 520]);
  legalOk(r.state);
  // its door and window came along
  assert.deepEqual(opening(r.state, "o15"), opening(p, "o15"));
  const before = place(p, "o16"), after = place(r.state, "o16");
  assert.equal(after[1], before[1]); assert.equal(after[3], before[3] - 200);
  // magnet off: exactly where asked
  r = run("moveRoom", p, "r3", 640, 300, { snap: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual([room(r.state, "r3").x, room(r.state, "r3").y], [640, 300]);
  // onto the kitchen: the nearest free spot is where it already is
  r = run("moveRoom", p, "r3", 700, 720);
  assert.equal(r.ok, false); assert.equal(r.state, p); assert.match(r.reason, /taken/);
  // into the street slot: pushed to 1.00 m from the land edge or onto it, whichever is nearer
  r = run("moveRoom", p, "r3", 740, 50, { snap: 0 });
  assert.equal(r.ok, false); legalOk(r.state);
  assert.ok([20, 120].includes(room(r.state, "r3").y), "y " + room(r.state, "r3").y);
});

// ------------------------------------------------------------------ swapRooms
test("swapRooms: rectangles swap, openings stay where they are", () => {
  const p = sample();
  let r = run("swapRooms", p, "r6", "r1");            // bedroom 1 <-> living room
  assert.equal(r.ok, true); legalOk(r.state);
  assert.deepEqual([room(r.state, "r6").x, room(r.state, "r6").y, room(r.state, "r6").w], [20, 720, 420]);
  assert.deepEqual([room(r.state, "r1").x, room(r.state, "r1").y, room(r.state, "r1").w], [20, 1440, 310]);
  for (const id of ["o10", "o12", "o19"]) assert.deepEqual(place(r.state, id), place(p, id), id);
  assert.equal(opening(r.state, "o10").room, "r6");   // the front door now belongs to the bedroom there
  assert.equal(opening(r.state, "o19").room, "r1");
  // bedroom 1's 1.20 window is now a living-room window: refitted to 1.50 about its centre
  const o20 = opening(r.state, "o20");
  assert.equal(o20.w, 150); assert.equal(o20.at, 125);
  assert.equal(r.note, "Living room windows are 1.50 to 2.50 m - set to 1.50.");
  // a bedroom does not fit in the toilet's space
  r = run("swapRooms", p, "r6", "r3");
  assert.equal(r.ok, false); assert.equal(r.state, p);
  // swapping with the courtyard: the courtyard's windows go to the roofed room across, or out
  r = run("swapRooms", p, "r7", "r5");
  legalOk(r.state);
  assert.ok(r.state.openings.every(o => o.kind !== "window" || HP.ROOM_TYPES[room(r.state, o.room).type].roofed));
});

// ------------------------------------------------------------------ addRoom
test("addRoom: nearest legal spot, auto name, a door and a window", () => {
  // empty land: centred on the point, an entrance door and a window
  let p = HP.newPlan({ w: 1000, d: 2000 });
  let r = run("addRoom", p, "bedroom", [500, 1000]);
  assert.equal(r.ok, true);
  const b = room(r.state, r.id);
  assert.deepEqual([b.x, b.y, b.w, b.h, b.name], [320, 800, 360, 400, "Bedroom"]);
  let A = HP.analyze(r.state);
  const own = A.openings.filter(o => o.room === r.id);
  assert.equal(own.length, 2);
  assert.ok(own.every(o => o.ok), JSON.stringify(own));
  assert.equal(own.find(o => o.kind === "door").w, 100);
  assert.equal(own.find(o => o.kind === "window").w, 120);
  // the second bedroom renames the first
  r = run("addRoom", r.state, "bedroom", [500, 300]);
  assert.deepEqual(r.state.rooms.map(x => x.name), ["Bedroom 1", "Bedroom 2"]);
  // against the bare north wall of a living room: an inside door into it, the window on the yard
  p = HP.newPlan({ w: 1000, d: 2000 });
  r = run("addRoom", p, "living", [500, 1000]);
  const liv = room(r.state, r.id);
  assert.deepEqual([liv.x, liv.y, liv.w, liv.h], [275, 750, 450, 500]);
  r = run("addRoom", r.state, "bedroom", [liv.x + 180, liv.y + liv.h + 20 + 200]);
  assert.equal(r.ok, true); legalOk(r.state);
  assert.deepEqual([room(r.state, r.id).x, room(r.state, r.id).y], [275, 1270]);
  A = HP.analyze(r.state);
  const door = A.openings.find(o => o.room === r.id && o.kind === "door");
  assert.ok(door.ok, door.reason);
  assert.deepEqual([door.w, door.side, door.facing, door.other, door.at], [80, "S", "room", liv.id, 20]);
  const win = A.openings.find(o => o.room === r.id && o.kind === "window");
  assert.ok(win.ok); assert.equal(win.facing, "yard"); assert.equal(win.w, 120);
  // in the sample's front yard, centred on the drop point against the living room and kitchen:
  // the living room's window it covers moves to the north wall first, so the bedroom gets an
  // inside door into the living room. The kitchen's 1.50 window has no other legal wall (its
  // courtyard wall is taken by its door, and 1.50 is the smallest kitchen window): it stays and
  // the rules panel flags it.
  p = sample();
  r = run("addRoom", p, "bedroom", [500, 500]);
  assert.equal(r.ok, true); legalOk(r.state);
  assert.deepEqual([room(r.state, r.id).x, room(r.state, r.id).y], [320, 300]);
  assert.equal(r.note, "Moved the Living room window to the north wall.");
  A = HP.analyze(r.state);
  assert.deepEqual(A.openings.filter(o => !o.ok).map(o => o.id), ["o13"]);
  const d2 = A.openings.find(o => o.room === r.id && o.kind === "door");
  assert.deepEqual([d2.w, d2.facing, d2.other], [80, "room", "r1"]);
  assert.equal(room(r.state, r.id).name, "Bedroom 4");
  // no room at all: a plain reason
  p = sample();
  p.plot.pts = [[0, 700], [1000, 700], [1000, 1900], [0, 1900]];
  legalOk(p);
  r = run("addRoom", p, "bedroom", [500, 1000]);
  assert.equal(r.ok, false); assert.equal(r.reason, "There is no free space for a bedroom here.");
  assert.equal(r.state, p);
  // an open area gets a door hosted by the roofed room next to it, and no window
  p = sample();
  r = run("addRoom", p, "open", [880, 600]);
  assert.equal(r.ok, true); legalOk(r.state);
  assert.equal(r.state.openings.filter(o => o.room === r.id && o.kind === "window").length, 0);
});

// ------------------------------------------------------------------ doors and windows
test("checkOpening / addOpening: refusals and fitting", () => {
  const p = sample();
  // a window dropped on the back wall (neighbours)
  let c = M.checkOpening(p, "window", 120, [175, 1890]);
  assert.equal(c.ok, false); assert.equal(c.placement, null);
  assert.equal(c.reason, "Windows can't go on a wall shared with the neighbours.");
  let r = run("addOpening", p, "window", 120, [175, 1890]);
  assert.equal(r.ok, false); assert.equal(r.state, p); assert.equal(r.reason, c.reason);
  // a door on the side wall (neighbours)
  assert.equal(M.checkOpening(p, "door", 80, [10, 1000]).reason, "Doors can't go on a wall shared with the neighbours.");
  // a window on the wall between two rooms
  assert.equal(M.checkOpening(p, "window", 150, [450, 1000]).reason,
    "Windows only go on walls that face an open area, the yard or the street.");
  // nothing near
  assert.match(M.checkOpening(p, "door", 80, [500, 300]).reason, /onto a wall/);
  // a 1.20 window on the bathroom becomes 0.60
  const q = HP.clone(p);
  q.openings = q.openings.filter(o => o.id !== "o18");
  r = run("addOpening", q, "window", 120, [920, 1195]);
  assert.equal(r.ok, true);
  assert.equal(r.note, "Bathroom windows are 0.60 m - set to 0.60.");
  assert.deepEqual(opening(r.state, r.id), { id: r.id, kind: "window", room: "r4", side: "N", at: 150, w: 60 });
  assert.ok(HP.analyze(r.state).openings.find(o => o.id === r.id).ok);
  // a door dropped on the living/kitchen wall: the host is the room on the pointer's side
  assert.deepEqual(M.checkOpening(p, "door", 80, [445, 1000]).placement, { room: "r1", side: "E", at: 240, w: 80 });
  assert.deepEqual(M.checkOpening(p, "door", 80, [455, 1000]).placement, { room: "r2", side: "W", at: 240, w: 80 });
  // a window on the courtyard wall is always hosted by the roofed room
  const k = HP.clone(p); k.openings = k.openings.filter(o => o.id !== "o20");
  assert.equal(M.checkOpening(k, "window", 120, [220, 1425]).placement.room, "r6");
  // nothing changes in checkOpening
  assert.equal(JSON.stringify(p), JSON.stringify(sample()));
});

test("moveOpening: along a wall, onto another wall, refused with a reason", () => {
  const p = sample();
  // the kitchen's courtyard door onto the kitchen/WC wall: re-hosted
  let r = run("moveOpening", p, "o14", [725, 800]);
  assert.equal(r.ok, true);
  assert.deepEqual(opening(r.state, "o14"), { id: "o14", kind: "door", room: "r2", side: "E", at: 40, w: 80, hinge: "start", swing: "in" });
  r = run("moveOpening", p, "o14", [735, 800]);        // 5 cm into the WC's half: the kitchen keeps it
  assert.deepEqual([opening(r.state, "o14").room, opening(r.state, "o14").side], ["r2", "E"]);
  r = run("moveOpening", p, "o14", [740, 800]);        // 10 cm in: the WC hosts it
  assert.deepEqual([opening(r.state, "o14").room, opening(r.state, "o14").side, opening(r.state, "o14").at], ["r3", "W", 40]);
  assert.ok(HP.analyze(r.state).openings.every(o => o.ok));
  // the front door along its wall, clear of the window
  r = run("moveOpening", p, "o10", [200, 710]);
  assert.equal(r.ok, true);
  assert.ok(HP.analyze(r.state).openings.find(o => o.id === "o10").ok);
  // a bedroom door onto the neighbours' wall: no
  r = run("moveOpening", p, "o19", [100, 1890]);
  assert.equal(r.ok, false); assert.equal(r.state, p);
  assert.equal(r.reason, "Doors can't go on a wall shared with the neighbours.");
  // a window from the bedroom to another bedroom's courtyard wall is refitted if needed and stays legal
  r = run("moveOpening", p, "o22", [380 + 200, 1430]);
  assert.ok(r.ok || r.state === p);
});

test("setOpening, flipDoor, removeOpening", () => {
  const p = sample();
  let r = run("setOpening", p, "o10", { swing: "out", hinge: "end" });
  assert.deepEqual([opening(r.state, "o10").swing, opening(r.state, "o10").hinge], ["out", "end"]);
  r = run("setOpening", p, "o11", { w: 200 });          // wider living window, kept on its centre where it fits
  assert.equal(opening(r.state, "o11").w, 200);
  assert.ok(HP.analyze(r.state).openings.find(o => o.id === "o11").ok);
  r = run("setOpening", p, "o16", { w: 250 });          // a 2.50 window on the WC wall: no room
  assert.equal(r.ok, false); assert.equal(r.state, p);
  r = run("flipDoor", p, "o12", "swing");
  assert.equal(opening(r.state, "o12").swing, "out");
  r = run("flipDoor", r.state, "o12", "hinge");
  assert.equal(opening(r.state, "o12").hinge, "end");
  assert.equal(run("flipDoor", p, "o11", "swing").ok, false);
  r = run("removeOpening", p, "o11");
  assert.equal(r.state.openings.length, 14);
  assert.equal(run("setOpening", p, "o10", {}).state, p);
});

// ------------------------------------------------------------------ rooms: the rest
test("removeRoom, renameRoom, setRoomType, setFurniture", () => {
  const p = sample();
  let r = run("removeRoom", p, "r3");
  assert.equal(r.state.rooms.length, 7);
  assert.ok(r.state.openings.every(o => o.room !== "r3"));
  r = run("renameRoom", p, "r6", "  Master bedroom ");
  assert.equal(room(r.state, "r6").name, "Master bedroom");
  assert.equal(run("renameRoom", p, "r6", "   ").ok, false);
  r = run("setRoomType", p, "r7", "bath");               // bedroom 2 -> bathroom: its window becomes 0.60
  assert.equal(room(r.state, "r7").type, "bath");
  assert.equal(room(r.state, "r7").name, "Bathroom 2");
  assert.equal(room(r.state, "r4").name, "Bathroom 1");
  assert.equal(opening(r.state, "o22").w, 60);
  assert.equal(r.note, "Bathroom windows are 0.60 m - set to 0.60.");
  r = run("setRoomType", p, "r3", "bedroom");            // a 2.40 x 1.80 toilet can't be a bedroom
  assert.equal(r.ok, false); assert.equal(r.reason, "A bedroom must be at least 2.00 m each way.");
  r = run("setRoomType", p, "r7", "open");
  assert.ok(r.state.openings.every(o => !(o.room === "r7" && o.kind === "window")));
  assert.match(r.note, /no windows/);
  r = run("setFurniture", p, "r6", 2);
  assert.equal(room(r.state, "r6").furn, 2);
  assert.equal(run("setFurniture", p, "r6", 0).state, p);
});

// ------------------------------------------------------------------ sections
test("sections", () => {
  const p = sample();
  let r = run("addSection", p, [302, 1000]);
  const s = r.state.sections.find(x => x.id === r.id);
  assert.deepEqual(s, { id: r.id, label: "B", a: [300, 550], b: [300, 2050], look: 1 });
  r = run("moveSection", r.state, r.id, { b: [480, 1800] });           // a diagonal pull stays vertical
  let t = r.state.sections.find(x => x.label === "B");
  assert.deepEqual([t.a, t.b], [[300, 550], [300, 1800]]);
  r = run("moveSection", r.state, t.id, { a: [100, 1900] });           // mostly sideways: it turns horizontal
  t = r.state.sections.find(x => x.label === "B");
  assert.deepEqual([t.a, t.b], [[100, 1800], [300, 1800]]);
  r = run("moveSection", r.state, t.id, { dx: 52, dy: -10 });
  t = r.state.sections.find(x => x.label === "B");
  assert.deepEqual([t.a, t.b], [[150, 1790], [350, 1790]]);
  r = run("turnSection", r.state, t.id);
  t = r.state.sections.find(x => x.label === "B");
  assert.equal(t.a[0], t.b[0]); assert.equal(Math.abs(t.b[1] - t.a[1]), 200);
  r = run("flipSection", r.state, t.id);
  assert.equal(r.state.sections.find(x => x.label === "B").look, -1);
  assert.equal(run("setSectionLabel", r.state, t.id, "a").ok, false);   // A is taken
  r = run("setSectionLabel", r.state, t.id, "c");
  assert.equal(r.state.sections.find(x => x.id === t.id).label, "C");
  assert.equal(run("moveSection", r.state, t.id, { a: t.b }).ok, false);
  r = run("removeSection", r.state, t.id);
  assert.equal(r.state.sections.length, 1);
  // the first free letter
  r = run("addSection", run("setSectionLabel", p, "s30", "B").state, [100, 100]);
  assert.equal(r.state.sections[1].label, "A");
});

// ------------------------------------------------------------------ land and walls
test("land: refusals keep the plan legal", () => {
  const p = sample();
  let r = run("setPlotRect", p, 1000, 1850);
  assert.equal(r.ok, false); assert.match(r.reason, /outside the land/); assert.equal(r.state, p);
  r = run("setPlotRect", p, 1050, 1900);                 // a 50 cm slot at the side
  assert.equal(r.ok, false); assert.match(r.reason, /less than 1\.00 m/);
  r = run("setPlotRect", p, 1200, 2000);
  assert.equal(r.ok, true); legalOk(r.state);
  r = run("movePlotCorner", p, 2, [1200, 2100]);         // a slanted back edge
  assert.equal(r.ok, true); legalOk(r.state);
  assert.ok(HP.analyze(r.state).rules.find(x => x.id === "fits").ok);
  assert.equal(run("movePlotCorner", p, 2, [-100, -100]).ok, false);
  assert.equal(run("movePlotCorner", p, 1, [-100, 1000]).ok, false);
  r = run("addPlotCorner", p, 1, [1200, 950]);
  assert.equal(r.state.plot.pts.length, 5); assert.equal(r.state.plot.edges.length, 5);
  legalOk(r.state);
  r = run("removePlotCorner", r.state, 2);
  assert.deepEqual(r.state.plot.pts, p.plot.pts);
  assert.equal(run("removePlotCorner", p, 2).ok, false);
  const tri = HP.newPlan(); tri.plot.pts = [[0, 0], [1000, 0], [0, 1000]]; tri.plot.edges = ["street", "neighbour", "neighbour"];
  assert.equal(run("removePlotCorner", tri, 0).reason, "The land needs at least 3 corners.");
  r = run("setEdgeKind", p, 2, "street");
  assert.equal(r.state.plot.edges[2], "street");
  assert.equal(HP.analyze(r.state).sides.r6.N[0].kind, "street");
  assert.equal(run("setRoad", p, 1003).state.plot.road, 1005);
  assert.equal(run("setTitle", p, " My house ").state.meta.title, "My house");
});

test("setWalls keeps everything on the grid and legal", () => {
  const p = sample();
  let r = run("setWalls", p, 25, 25);
  assert.equal(r.ok, true); legalOk(r.state);
  assert.deepEqual(r.state.walls, { ext: 25, int: 25 });
  assert.deepEqual(room(r.state, "r2"), Object.assign({}, room(p, "r2"), { x: 465, w: 255 }));
  assert.deepEqual(room(r.state, "r8"), Object.assign({}, room(p, "r8"), { x: 675, y: 1445, w: 300, h: 430 }));
  // physical positions of the openings did not move along their walls
  for (const o of p.openings) assert.deepEqual(place(r.state, o.id).slice(0, 3), place(p, o.id).slice(0, 3), o.id);
  // every door and window still allowed; thicker walls only cost Bedroom 2 its 3.00 m (a rule, not a fault)
  assert.deepEqual(HP.analyze(r.state).rules.filter(x => !x.ok).map(x => x.id + ":" + x.refs), ["bedroom-size:r7"]);
  r = run("setWalls", p, 20, 15);
  legalOk(r.state); assert.ok(HP.analyze(r.state).rules.every(x => x.ok));
  r = run("setWalls", p, 15, 40);
  assert.equal(r.ok, false); assert.match(r.reason, /twice as thick/);
  r = run("setWalls", p, 30, 20);
  legalOk(r.state);
  assert.equal(run("setWalls", p, 20, 20).state, p);
});

// ------------------------------------------------------------------ follow-up fixes (2026-10-15)
test("fix 1: a door slid along a shared wall keeps its host, swing and hinge", () => {
  let p = sample();
  p = run("setOpening", p, "o19", { swing: "out", hinge: "end" }).state;
  const g = HP.analyze(p).openings.find(o => o.id === "o19");
  const cy = (g.fixed + g.far) / 2;                     // 1430: the wall's centre line, where canvas holds it
  assert.equal(cy, 1430);
  let r = run("moveOpening", p, "o19", [(g.s0 + g.s1) / 2 + 30, cy]);
  assert.equal(r.ok, true);
  assert.deepEqual(opening(r.state, "o19"), Object.assign({}, opening(p, "o19"), { at: 50 }));   // r6, S, out, end
  // 5 cm onto the courtyard's half is still the bedroom's door
  r = run("moveOpening", p, "o19", [(g.s0 + g.s1) / 2 + 30, cy - 5]);
  assert.equal(opening(r.state, "o19").room, "r6");
  // pulled right across: the courtyard hosts it, and the leaf still opens into the bedroom
  const q = sample();                                    // o19: swing in, hinge start
  r = run("moveOpening", q, "o19", [110, 1415]);
  assert.deepEqual([opening(r.state, "o19").room, opening(r.state, "o19").side, opening(r.state, "o19").swing,
                    opening(r.state, "o19").hinge], ["r5", "N", "out", "start"]);
  const inBed = HP.analyze(r.state).roomOpenings.r6.find(o => o.id === "o19");
  assert.equal(inBed.swingInto, true);
  // 25 cm inside walls: the centre line falls between 5 cm steps; neither side of it flips the host
  const t = run("setWalls", sample(), 20, 25).state;
  const g2 = HP.analyze(t).openings.find(o => o.id === "o19");
  assert.equal((g2.fixed + g2.far) / 2, 1432.5);
  for (const y of [1430, 1435]) {
    r = run("moveOpening", t, "o19", [110, y]);
    assert.deepEqual([opening(r.state, "o19").room, opening(r.state, "o19").swing], ["r6", "in"], "y " + y);
  }
});

test("fix 2: a turned section stays within the house plus 1.50 m", () => {
  const p = sample();                                    // s30: x 550, y 550..2050 (15 m) on a 10 m wide land
  let r = run("turnSection", p, "s30");
  let s = r.state.sections[0];
  assert.deepEqual([s.a, s.b], [[1150, 1300], [-150, 1300]]);   // house x 0..1000, plus 1.50 m each end
  r = run("turnSection", r.state, "s30");
  s = r.state.sections[0];
  assert.deepEqual([s.a, s.b], [[500, 1950], [500, 650]]);
  // a section left out beside the house takes the whole reach when turned
  r = run("moveSection", p, "s30", { dx: 2450, dy: 0 });
  r = run("turnSection", r.state, "s30");
  s = r.state.sections[0];
  assert.deepEqual([s.a, s.b], [[1150, 1300], [-150, 1300]]);
  // no rooms: the land is the reach
  const e = HP.newPlan({ w: 1000, d: 2000 });
  r = run("addSection", e, [500, 1000]);
  assert.deepEqual([r.state.sections[0].a, r.state.sections[0].b], [[500, -150], [500, 2150]]);
  r = run("turnSection", r.state, r.id);
  assert.deepEqual([r.state.sections[0].a, r.state.sections[0].b], [[1150, 1000], [-150, 1000]]);
});

test("fix 3: land size between 3 and 200 m each way", () => {
  const p = sample();
  let r = run("setPlotRect", p, 31200, 1900);
  assert.equal(r.ok, false); assert.equal(r.reason, "The land can be at most 200 m each way."); assert.equal(r.state, p);
  assert.equal(run("setPlotRect", p, 1000, 20005).ok, false);
  assert.equal(run("setPlotRect", p, 250, 1900).reason, "The land must be at least 3.00 x 3.00 m.");
  r = run("setPlotRect", p, 20000, 20000);
  assert.equal(r.ok, true); legalOk(r.state);
  assert.equal(run("setPlotRect", p, 1000, 1900).state, p);          // already that size: nothing changes
});

test("fix 4: making a shaped land rectangular keeps its lower-left corner", () => {
  const p = sample();
  let r = run("movePlotCorner", p, 0, [0, -100]);       // front-left corner 1.00 m lower: a slanted front
  assert.equal(r.ok, true);
  const shaped = r.state;
  r = run("setPlotRect", shaped, 1000, 2000);           // panels' "Make it a rectangle": bbox size
  assert.equal(r.ok, true); legalOk(r.state);
  assert.deepEqual(r.state.plot.pts, [[0, -100], [1000, -100], [1000, 1900], [0, 1900]]);
  assert.deepEqual(r.state.plot.edges, ["street", "neighbour", "neighbour", "neighbour"]);
  // a size that would cut the bedrooms off is refused
  r = run("setPlotRect", shaped, 1000, 1900);
  assert.equal(r.ok, false); assert.match(r.reason, /outside the land/); assert.equal(r.state, shaped);
  // five corners, the street still at the front, a street side on the right kept by direction
  let five = run("addPlotCorner", p, 1, [1200, 700]).state;
  five = run("setEdgeKind", five, 2, "street").state;    // the upper, longer part of the right side
  r = run("setPlotRect", five, 1200, 1900);
  assert.deepEqual(r.state.plot.pts, [[0, 0], [1200, 0], [1200, 1900], [0, 1900]]);
  assert.deepEqual(r.state.plot.edges, ["street", "street", "neighbour", "neighbour"]);
});

// ------------------------------------------------------------------ integration fixes (2026-10-15, second round)
test("fix A: a narrow space other rooms fill is no slot - the living/kitchen wall moves", () => {
  // Rasa's repro: kitchen and open area meet only corner to corner, with the living room between
  const p = HP.newPlan();
  p.rooms.push({ id: "r1", type: "living", name: "Living room", x: 20, y: 130, w: 450, h: 500, furn: 0 });
  p.rooms.push({ id: "r4", type: "kitchen", name: "Kitchen", x: 490, y: 140, w: 300, h: 400, furn: 0 });
  p.rooms.push({ id: "r7", type: "open", name: "Open area", x: 150, y: 650, w: 200, h: 300, furn: 0 });
  p.seq = 8;
  legalOk(p);
  assert.ok(HP.analyze(p).handles.some(h => h.key === "v470:130:630"));
  let r = run("dragWall", p, "v470:130:630", -5);
  assert.equal(r.ok, true, r.reason); legalOk(r.state);
  assert.deepEqual([room(r.state, "r1").w, room(r.state, "r4").x, room(r.state, "r4").w], [445, 485, 305]);
  r = run("dragWall", p, "v470:130:630", -80);
  assert.equal(r.ok, true, r.reason); legalOk(r.state);
  assert.deepEqual([room(r.state, "r1").w, room(r.state, "r4").x, room(r.state, "r4").w], [370, 410, 380]);
  // the space between the kitchen's and open area's corners is inside the living room's wall;
  // without the living room it is a real 20 cm slot again
  const bare = HP.clone(r.state);
  bare.rooms = bare.rooms.filter(x => x.id !== "r1");
  assert.equal(M.legal(bare).ok, false);
  // so taking the living room out is refused with a reason, and moving it keeps the space filled
  const rm = run("removeRoom", r.state, "r1");
  assert.equal(rm.ok, false); assert.equal(rm.state, r.state); assert.match(rm.reason, /too narrow/);
  const mv = run("moveRoom", r.state, "r1", 20, 1300, { snap: 0 });
  legalOk(mv.state);
  // a corner-to-corner slot that nobody fills is still not allowed
  const q = HP.newPlan({ w: 1000, d: 1000 });
  q.rooms.push({ id: "a", type: "hall", name: "A", x: 20, y: 20, w: 300, h: 300, furn: 0 });
  q.rooms.push({ id: "b", type: "hall", name: "B", x: 410, y: 410, w: 300, h: 300, furn: 0 });   // 0.50 m slot both ways
  assert.equal(M.legal(q).ok, false);
});

test("fix B: doors and windows an edit blocks move to the nearest legal wall of their room", () => {
  // the WC moved against the living room's front wall covers half of its window
  let p = sample();
  let r = run("moveRoom", p, "r3", 20, 520, { snap: 0 });
  assert.equal(r.ok, true); legalOk(r.state);
  assert.deepEqual(opening(r.state, "o11"), { id: "o11", kind: "window", room: "r1", side: "N", at: 120, w: 150 });
  assert.equal(r.note, "Moved the Living room window to the north wall.");
  assert.ok(HP.analyze(r.state).openings.every(o => o.ok));
  // a kitchen dropped against the living room's east wall, where its door and window are
  let q = run("addRoom", HP.newPlan({ w: 1400, d: 2000 }), "living", [500, 1000]).state;
  assert.deepEqual(q.openings.map(o => o.room + o.side), ["r1E", "r1E"]);
  r = run("addRoom", q, "kitchen", [895, 1000]);
  assert.equal(r.ok, true); legalOk(r.state);
  const A = HP.analyze(r.state);
  assert.ok(A.openings.every(o => o.ok), JSON.stringify(A.openings.filter(o => !o.ok)));
  assert.deepEqual(r.state.openings.filter(o => o.room === "r1").map(o => o.kind + o.side), ["doorS", "windowN"]);
  assert.match(r.note, /Moved the Living room window to the north wall\./);
  assert.match(r.note, /Moved the Living room door to the south wall\./);
  // and the wall it shares with the living room is free for the kitchen's own inside door
  const kd = A.openings.find(o => o.room === r.id && o.kind === "door");
  assert.deepEqual([kd.w, kd.facing, kd.other], [80, "room", "r1"]);
  // the same edit twice gives the same plan (it runs in every drag preview)
  assert.deepEqual(run("addRoom", q, "kitchen", [895, 1000]).state, r.state);
  // Bedroom 1 moved under the WC's front wall: the WC's other walls face the bath, the kitchen
  // and the neighbours, so its window has nowhere legal to go - it stays and the rules flag it;
  // the kitchen's window, half covered, slides along its own wall
  p = sample();
  r = run("moveRoom", p, "r6", 670, 260, { snap: 0 });
  assert.equal(r.ok, true); legalOk(r.state);
  assert.deepEqual(opening(r.state, "o16"), opening(p, "o16"));
  const g16 = HP.analyze(r.state).openings.find(o => o.id === "o16");
  assert.equal(g16.ok, false); assert.equal(g16.facing, "room");
  assert.deepEqual([opening(r.state, "o13").side, opening(r.state, "o13").at], ["S", 30]);
  assert.ok(HP.analyze(r.state).openings.find(o => o.id === "o13").ok);
  assert.equal(r.note, "Moved the Kitchen window along its wall.");
  // an edit that blocks nothing moves nothing and says nothing
  r = run("dragWall", sample(), handleOf(sample(), "r6", "N").key, -100);
  assert.equal(r.note, "");
  assert.deepEqual(r.state.openings, sample().openings);
});

test("fix C: a dropped room first fits where it is dropped", () => {
  // a 1.70 m gap between a kitchen and a living room (clear rooms 2.10 apart)
  const p = HP.newPlan();
  p.rooms.push({ id: "r1", type: "kitchen", name: "Kitchen", x: 20, y: 1000, w: 300, h: 400, furn: 0 });
  p.rooms.push({ id: "r2", type: "living", name: "Living room", x: 530, y: 1000, w: 450, h: 400, furn: 0 });
  p.seq = 3;
  legalOk(p);
  let r = run("addRoom", p, "bath", [425, 1200]);
  assert.equal(r.ok, true); legalOk(r.state);
  const b = room(r.state, r.id);
  assert.deepEqual([b.x, b.y, b.w, b.h], [340, 1075, 170, 250]);
  assert.ok(b.x <= 425 && 425 <= b.x + b.w && b.y <= 1200 && 1200 <= b.y + b.h);
  assert.equal(r.note, "The bathroom was made 1.70 x 2.50 m to fit here.");
  const A = HP.analyze(r.state);
  assert.ok(A.openings.filter(o => o.room === r.id).every(o => o.ok));
  // a bedroom in a 3.20 m gap is made 3.20 wide (a size the rules accept)
  const q = HP.newPlan();
  q.rooms.push({ id: "r1", type: "kitchen", name: "Kitchen", x: 20, y: 1000, w: 300, h: 400, furn: 0 });
  q.rooms.push({ id: "r2", type: "living", name: "Living room", x: 680, y: 1000, w: 300, h: 400, furn: 0 });
  q.seq = 3;
  r = run("addRoom", q, "bedroom", [500, 1200]);
  assert.deepEqual([room(r.state, r.id).w, room(r.state, r.id).h], [320, 400]);
  assert.match(r.note, /was made 3\.20 x 4\.00 m to fit here/);
  // room enough at the drop point: the default size, no note
  r = run("addRoom", HP.newPlan(), "bath", [500, 1000]);
  assert.deepEqual([room(r.state, r.id).w, room(r.state, r.id).h], [200, 250]);
  assert.equal(r.note, "");
  // dropped inside another room: only then the nearest free spot anywhere
  r = run("addRoom", sample(), "bath", [200, 900]);
  assert.equal(r.ok, true); legalOk(r.state);
  assert.match(r.note, /^The bathroom went to the nearest free spot\./);
  assert.deepEqual([room(r.state, r.id).w, room(r.state, r.id).h], [200, 250]);
});

// ------------------------------------------------------------------ save files
test("serialize / deserialize round trip", () => {
  const p = sample();
  const back = HP.deserialize(HP.serialize(p));
  assert.notEqual(back.meta.modified, undefined);
  back.meta.modified = p.meta.modified;
  assert.deepEqual(back, p);
  assert.deepEqual(HP.analyze(back), HP.analyze(p));
  const r = run("addRoom", p, "bath", [300, 300]);
  const again = HP.deserialize(HP.serialize(r.state));
  again.meta.modified = r.state.meta.modified;
  assert.deepEqual(again, r.state);
  assert.throws(() => HP.deserialize("{nope"), /not a house plan/);
});

// ------------------------------------------------------------------ fuzz
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* independent wall poche on the 5 cm grid (wall depth re-derived from the rooms) */
function pocheCheck(plan, A) {
  const ext = plan.walls.ext, int = plan.walls.int;
  const grown = plan.rooms.map(r => [r.x - ext, r.y - ext, r.x + r.w + ext, r.y + r.h + ext]);
  const clear = plan.rooms.map(r => [r.x, r.y, r.x + r.w, r.y + r.h]);
  const SG = { N: 1, E: 1, S: -1, W: -1 }, OP = { N: "S", S: "N", E: "W", W: "E" };
  const cuts = plan.openings.map(o => {
    const r = room(plan, o.room), si = HP.sideInfo(r, o.side), s0 = si.s0 + o.at, s1 = s0 + o.w;
    let cover = 0;
    for (const b of plan.rooms) {
      if (b === r) continue;
      const bi = HP.sideInfo(b, OP[o.side]);
      if (bi.fixed === si.fixed + SG[o.side] * int) cover += HP.spanOverlap(s0, s1, bi.s0, bi.s1);
    }
    // the T-junction pieces between shared runs are walls of depth ext in the analysis
    const thick = cover === o.w ? int : cover === 0 ? ext : Math.max(int, ext);
    const f0 = Math.min(si.fixed, si.fixed + SG[o.side] * thick), f1 = Math.max(si.fixed, si.fixed + SG[o.side] * thick);
    return si.axis === "x" ? [s0, f0, s1, f1] : [f0, s0, f1, s1];
  });
  const inside = (c, x, y) => x > c[0] && x < c[2] && y > c[1] && y < c[3];
  if (!grown.length) { assert.equal(A.walls.loops.length, 0); return; }
  const X0 = Math.min(...grown.map(g => g[0])), X1 = Math.max(...grown.map(g => g[2]));
  const Y0 = Math.min(...grown.map(g => g[1])), Y1 = Math.max(...grown.map(g => g[3]));
  let cells = 0;
  for (let y = Y0; y < Y1; y += 5) for (let x = X0; x < X1; x += 5) {
    const cx = x + 2.5, cy = y + 2.5;
    if (grown.some(g => inside(g, cx, cy)) && !clear.some(c => inside(c, cx, cy)) && !cuts.some(c => inside(c, cx, cy))) cells++;
  }
  const area = A.walls.loops.reduce((s, L) => s + HP.polyArea(L), 0);
  assert.equal(area, cells * 25, "poche area");
}
function invariants(plan, what) {
  const L = M.legal(plan);
  assert.ok(L.ok, what + ": " + L.reason);
  const ids = [...plan.rooms, ...plan.openings, ...plan.sections].map(o => o.id);
  assert.equal(new Set(ids).size, ids.length, what + ": duplicate ids");
  for (const r of plan.rooms) for (const k of ["x", "y", "w", "h"]) assert.ok(Number.isInteger(r[k]) && r[k] % 5 === 0, what + " grid " + r.id + k);
  for (const o of plan.openings) {
    assert.ok(Number.isInteger(o.at) && o.at % 5 === 0 && o.w % 5 === 0, what + " opening grid " + o.id);
    const r = room(plan, o.room);
    const len = o.side === "N" || o.side === "S" ? r.w : r.h;
    assert.ok(o.at >= 0 && o.at + o.w <= len, what + " opening off its wall " + o.id);
  }
  for (const p of plan.plot.pts) assert.ok(p[0] % 5 === 0 && p[1] % 5 === 0, what + " plot grid");
  for (const s of plan.sections) {
    assert.ok([...s.a, ...s.b].every(v => v % 5 === 0), what + " section grid");
    assert.ok(s.a[0] === s.b[0] || s.a[1] === s.b[1], what + " section not straight");
  }
  let A;
  assert.doesNotThrow(() => { A = HP.analyze(plan); }, what + ": analyze threw");
  for (const loops of [A.walls.loops, A.footprint.loops]) for (const Lp of loops) {
    assert.ok(Lp.length >= 4, what + " short loop");
    const f = Lp[0], l = Lp[Lp.length - 1];
    assert.ok(!(f[0] === l[0] && f[1] === l[1]), what + " closing point repeated");
    for (let i = 0; i < Lp.length; i++) {
      const p = Lp[i], q = Lp[(i + 1) % Lp.length];
      assert.ok((p[0] === q[0]) !== (p[1] === q[1]), what + " loop edge not closed/orthogonal");
    }
  }
  assert.ok(A.rules.find(x => x.id === "fits").ok, what + " fits rule");
  return A;
}

test("fuzz: random edit sequences keep every plan legal", () => {
  const TYPES = HP.ROOM_ORDER;
  const SEQS = 240, STEPS = 25;
  const counts = {};
  let steps = 0, okCount = 0, opMs = 0, worst = 0, worstOp = "";
  const t0 = Date.now();
  for (let seq = 0; seq < SEQS; seq++) {
    const rand = rng(1000 + seq);
    const ri = n => Math.floor(rand() * n);
    const pick = a => a[ri(a.length)];
    const r5 = (a, b) => HP.snap(a + rand() * (b - a));
    let plan = seq % 4 === 3 ? load("model-20rooms.json") : sample();
    for (let step = 0; step < STEPS; step++) {
      const A = HP.analyze(plan);
      const P = plan.plot.pts, bx = Math.max(...P.map(p => p[0])), by = Math.max(...P.map(p => p[1]));
      const nearWall = () => {
        const r = pick(plan.rooms), side = pick(HP.SIDES), si = HP.sideInfo(r, side);
        const s = si.s0 + rand() * (si.s1 - si.s0), across = si.fixed + si.n[0] * 10 + si.n[1] * 10 + (rand() - 0.5) * 30;
        return si.axis === "x" ? [s, across] : [across, s];
      };
      const choices = [];
      if (plan.rooms.length) {
        choices.push(["moveRoom", 6], ["dragWall", 8], ["setRoomSize", 3], ["swapRooms", 2], ["setRoomType", 1]);
        choices.push(["addOpening", 3], ["removeRoom", plan.rooms.length > 10 ? 2 : 0.3]);
      }
      if (plan.openings.length) choices.push(["moveOpening", 5], ["setOpening", 1], ["flipDoor", 0.5], ["removeOpening", 0.5]);
      if (plan.rooms.length < 22) choices.push(["addRoom", 3]);
      choices.push(["setWalls", 0.3], ["movePlotCorner", 0.6], ["addSection", 0.3], ["moveSection", 0.4], ["turnSection", 0.2],
                   ["setPlotRect", 0.2]);
      let tot = choices.reduce((s, c) => s + c[1], 0), x = rand() * tot, name = choices[0][0];
      for (const [n, w] of choices) { if ((x -= w) <= 0) { name = n; break; } }
      let args;
      switch (name) {
        case "moveRoom": { const r = pick(plan.rooms); args = [r.id, r.x + (rand() - 0.5) * 700, r.y + (rand() - 0.5) * 700, { snap: pick([0, 25, 40]) }]; break; }
        case "dragWall": { const h = pick(A.handles); args = [h.key, (rand() - 0.5) * 400, rand() < 0.2 ? { only: pick(h.members).room } : {}]; break; }
        case "setRoomSize": { const r = pick(plan.rooms); args = [r.id, r.w + r5(-150, 150), r.h + r5(-150, 150)]; break; }
        case "swapRooms": args = [pick(plan.rooms).id, pick(plan.rooms).id]; break;
        case "setRoomType": args = [pick(plan.rooms).id, pick(TYPES)]; break;
        case "addRoom": args = [pick(TYPES), [rand() * bx, rand() * by]]; break;
        case "removeRoom": args = [pick(plan.rooms).id]; break;
        case "addOpening": { const k = pick(["door", "window"]); args = [k, k === "door" ? pick(HP.DOOR_SIZES) : pick(HP.WINDOW_SIZES), nearWall()]; break; }
        case "moveOpening": args = [pick(plan.openings).id, nearWall()]; break;
        case "setOpening": { const o = pick(plan.openings); args = [o.id, { w: o.kind === "door" ? pick(HP.DOOR_SIZES) : pick(HP.WINDOW_SIZES), swing: pick(["in", "out"]) }]; break; }
        case "flipDoor": args = [pick(plan.openings).id, pick(["swing", "hinge"])]; break;
        case "removeOpening": args = [pick(plan.openings).id]; break;
        case "setWalls": { const e = pick([15, 20, 25, 30]); args = [e, pick([15, 20, 25, 30].filter(v => v <= 2 * e))]; break; }
        case "movePlotCorner": { const i = ri(P.length); args = [i, [P[i][0] + r5(-200, 200), P[i][1] + r5(-200, 200)]]; break; }
        case "setPlotRect": args = [bx + r5(-200, 300), by + r5(-200, 300)]; break;
        case "addSection": args = [[rand() * bx, rand() * by]]; break;
        case "moveSection": { if (!plan.sections.length) { name = "addSection"; args = [[rand() * bx, rand() * by]]; break; }
          const s = pick(plan.sections); args = [s.id, pick([{ dx: r5(-100, 100), dy: r5(-100, 100) }, { a: [s.a[0] + r5(-300, 300), s.a[1] + r5(-300, 300)] }, { b: [s.b[0] + r5(-300, 300), s.b[1]] }])]; break; }
        case "turnSection": { if (!plan.sections.length) { name = "addSection"; args = [[rand() * bx, rand() * by]]; break; } args = [pick(plan.sections).id]; break; }
      }
      const what = `seq ${seq} step ${step} ${name}(${JSON.stringify(args)})`;
      const before = JSON.stringify(plan);
      const ts = process.hrtime.bigint();
      let r;
      try { r = M[name](plan, ...args); } catch (e) { assert.fail(what + " threw " + e.stack); }
      const ms = Number(process.hrtime.bigint() - ts) / 1e6;
      opMs += ms; if (ms > worst) { worst = ms; worstOp = what.slice(0, 120); }
      assert.equal(JSON.stringify(plan), before, what + " changed its input");
      assert.ok(r && r.state && typeof r.ok === "boolean" && typeof r.reason === "string", what + " bad result");
      if (!r.ok) assert.ok(r.reason, what + " failed without a reason");
      const A2 = invariants(r.state, what);
      // openings the model just placed are allowed
      if (r.ok && (name === "addOpening" || name === "moveOpening")) {
        const id = name === "addOpening" ? r.id : args[0];
        const g = A2.openings.find(o => o.id === id);
        assert.ok(g && g.ok, what + " placed an opening analyze() rejects: " + (g && g.reason));
      }
      if (r.ok && name === "addRoom") {                 // the new room's own door and window
        const old = new Set(plan.openings.map(o => o.id));
        for (const g of A2.openings) if (!old.has(g.id)) assert.ok(g.ok, what + " default opening rejected: " + g.reason);
      }
      // a door or window an edit blocked was moved if its room had any legal place for it
      if (["moveRoom", "dragWall", "setRoomSize", "swapRooms", "setRoomType", "addRoom", "removeRoom",
           "setWalls", "movePlotCorner", "setPlotRect"].includes(name)) {
        const okBefore = new Set(A.openings.filter(g => g.ok).map(g => g.id));
        for (const g of A2.openings) {
          if (g.ok || !okBefore.has(g.id)) continue;
          const host = room(r.state, g.room), T = HP.ROOM_TYPES[host.type];
          const widths = [g.w].concat(g.kind === "door" ? (g.w > 80 ? [80] : [])
            : HP.WINDOW_SIZES.filter(v => v < g.w && T.win && v >= T.win[0] && v <= T.win[1]));
          for (const side of HP.SIDES) for (const w of widths)
            assert.equal(HP.analyze.slots(r.state, A2, host.id, side, g.kind, w, g.id).length, 0,
              what + ": " + g.id + " was blocked but " + host.name + " " + side + " has room for it at " + w);
        }
      }
      if (step % 12 === 11) pocheCheck(r.state, A2);
      counts[name] = (counts[name] || 0) + 1;
      if (r.ok) okCount++;
      steps++;
      plan = r.state;
    }
  }
  const secs = (Date.now() - t0) / 1000;
  console.log(`    fuzz: ${steps} steps (${okCount} ok) in ${secs.toFixed(1)} s; model ops avg ${(opMs / steps).toFixed(3)} ms, worst ${worst.toFixed(1)} ms (${worstOp})`);
  console.log("    fuzz ops: " + Object.entries(counts).map(([k, v]) => k + " " + v).join(", "));
  assert.ok(steps >= 6000);
});

// ------------------------------------------------------------------ speed
test("speed: one drag step on a 20-room plan", () => {
  const p = load("model-20rooms.json");
  const A = HP.analyze(p);
  const h = A.handles.find(x => x.members.length >= 4);
  const time = (f, n) => {
    for (let i = 0; i < 5; i++) f();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) f();
    return Number(process.hrtime.bigint() - t0) / 1e6 / n;
  };
  const r = p.rooms[5];
  const tm = {
    moveRoom: time(() => HP.analyze(M.moveRoom(p, r.id, r.x + 37, r.y - 120).state), 100),
    moveRoomBlocked: time(() => HP.analyze(M.moveRoom(p, r.id, r.x + 300, r.y).state), 50),
    dragWall: time(() => HP.analyze(M.dragWall(p, h.key, 120).state), 100),
    moveOpening: time(() => HP.analyze(M.moveOpening(p, p.openings[3].id, [700, 1530]).state), 100),
    addRoom: time(() => HP.analyze(M.addRoom(p, "bedroom", [900, 1600]).state), 30),
  };
  // the sample with its land cut to the house: there is nowhere for a new room (worst case search)
  const full = load("sample-house.json");
  full.plot.pts = [[0, 700], [1000, 700], [1000, 1900], [0, 1900]];
  tm.addRoomNoSpace = time(() => M.addRoom(full, "bedroom", [500, 1000]), 10);
  console.log("    model op + analyze, ms: " + Object.entries(tm).map(([k, v]) => k + " " + v.toFixed(2)).join(", "));
  for (const k of ["moveRoom", "dragWall", "moveOpening"]) assert.ok(tm[k] < 8, k + " " + tm[k]);
});
