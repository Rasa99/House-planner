"use strict";
/* ============================================================================
   House Planner - furniture.js          (furniture agent; CONTRACT.md s.7)
   ----------------------------------------------------------------------------
   The furniture blocks and the automatic furniture layout.

   HP.furniture.BLOCKS   plain data, one entry per piece (swap freely):
       { layer:'A-FURN'|'A-FIXT', w, h, label, group, tall, parts?, items:[prim] }
     items  section-8 primitives in LOCAL CENTIMETRES, kinds pline / line /
            arc / circle only (no hatches, no text). Every item carries the
            block's layer; inner detail lines carry lw 0.13 (outlines use the
            layer's own lineweight).
     tall   true for pieces that must never stand across a window
            (wardrobes, fridge, tall cupboard, TV unit).
     parts  optional: the real footprint as local rects [x0,y0,x1,y1] when the
            piece is not a rectangle (the L-shaped sofa). Collision tests use
            the parts; w x h is still the full bounding box.

   LOCAL ORIENTATION (every block):
     - origin (0,0) is the lower-left corner; the piece lies in [0,w] x [0,h];
     - the BACK of the piece - the side that stands against a wall (headboard,
       sofa back, counter back, WC cistern, TV) - is the TOP edge, y = h;
     - the FRONT (where you stand, sit or walk up to it) faces -y (y = 0);
     - "left" is local x = 0 as seen standing in front of the piece facing
       the wall. With sx = 1 the local left is the viewer's left.
   Bulges are DXF LWPOLYLINE bulges: bulges[i] belongs to the segment
   pts[i] -> pts[i+1] (for a closed pline the last one closes it);
   bulge = tan(sweep/4), positive = counter-clockwise.

   HP.furniture.variants(type) -> [{key,label}]   index 0 = Automatic
   HP.furniture.layout(room, roomOpenings, furn) ->
       { inserts:[{block,x,y,rot,sx}], used, key, label, dropped:[], skipped:[] }
     room = A.rooms[i] (x,y,w,h = clear inside, cm); roomOpenings =
     A.roomOpenings[room.id] (s0/s1 ABSOLUTE along the side's axis, as
     analyze.js makes them). world = T(x,y) * R(rot deg CCW) * S(sx,1) * local
     (exact DXF INSERT semantics), rot in {0,90,180,270}, sx in {1,-1}.
     used    = index of the variant that was really laid out (Automatic
               resolves to a real one); key/label = that variant.
     dropped = pieces the variant needs but could not place (room too small,
               openings in the way); skipped = optional extras left out.

   LAYOUT RULES (all hard, checked again by test/furniture.test.js):
     - every piece inside the room's clear rect, no two pieces overlapping;
     - nothing inside a door's swing (the w x w square on the swing side of a
       door with swingInto) nor in the 60 cm in front of any door, either face;
     - tall pieces never in the 60 cm in front of a window;
     - access space kept in front of pieces (wardrobe 60, WC/basin 60 and
       20/10 cm either side of them, counters 90, bed foot 50 and one long
       side 55, dining chairs 40 all round, sofa seats 40);
     - deterministic: no randomness, fixed candidate order, ties keep the first.
   Soft preferences are scored: bed head not under a window and not looking
   straight at the door, nightstands both sides, sink under the window,
   cooker away from window / fridge / sink, wardrobe in a corner or beside
   the door, desk under the window, TV opposite the sofa, ...
   When the room is too small pieces are dropped, least important first
   (extras such as desk, dresser, armchairs, then nightstands, ...).

   Results are cached per (type, size, variant, openings relative to the
   room) so a drag that only moves a room costs nothing.
============================================================================ */
(function (HP) {
  // =========================================================================
  // 1. helpers for drawing blocks (local cm)
  // =========================================================================
  const DET = 0.13;                                   // lineweight of inner detail lines
  const rn = v => Math.round(v * 10000) / 10000;

  function pl(pts, closed, bulges) {
    const p = { kind: "pline", pts: pts.map(q => [rn(q[0]), rn(q[1])]), closed: !!closed };
    if (bulges && bulges.some(b => Math.abs(b) > 1e-12)) p.bulges = bulges.map(b => Math.round(b * 1e9) / 1e9);
    return p;
  }
  const ln = (a, b) => ({ kind: "line", a: [rn(a[0]), rn(a[1])], b: [rn(b[0]), rn(b[1])] });
  const circ = (c, r) => ({ kind: "circle", c: [rn(c[0]), rn(c[1])], r });
  const det = p => Object.assign(p, { lw: DET });

  /* A polygon (closed) or polyline (open) with its corners filleted.
     radii: one number or one per vertex (0 = sharp). Works for any turn;
     the end vertices of an open polyline are never rounded. */
  function roundPoly(pts, radii, closed) {
    const n = pts.length, out = [], bul = [];
    for (let i = 0; i < n; i++) {
      const v = pts[i];
      const r = Array.isArray(radii) ? (radii[i] || 0) : (radii || 0);
      if (!r || (!closed && (i === 0 || i === n - 1))) { out.push(v); bul.push(0); continue; }
      const p = pts[(i - 1 + n) % n], q = pts[(i + 1) % n];
      const ux = p[0] - v[0], uy = p[1] - v[1], lu = Math.hypot(ux, uy);
      const wx = q[0] - v[0], wy = q[1] - v[1], lw = Math.hypot(wx, wy);
      const ix = -ux, iy = -uy;                            // incoming direction
      const cross = ix * wy - iy * wx, dot = ix * wx + iy * wy;
      const turn = Math.atan2(Math.abs(cross), dot);       // 0..pi
      const t = r * Math.tan(turn / 2);                    // tangent length
      out.push([v[0] + ux / lu * t, v[1] + uy / lu * t]); bul.push(Math.sign(cross) * Math.tan(turn / 4));
      out.push([v[0] + wx / lw * t, v[1] + wy / lw * t]); bul.push(0);
    }
    return pl(out, closed, bul);
  }
  // rounded rectangle; r = number or [bottom-left, bottom-right, top-right, top-left]
  function rr(x, y, w, h, r) {
    return roundPoly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], Array.isArray(r) ? r : [r, r, r, r], true);
  }
  // scalloped ring (tree canopy, plant): n arcs bulging outwards
  function scallop(cx, cy, R, n, b) {
    const pts = [], bul = [];
    for (let k = 0; k < n; k++) {
      const t = Math.PI / 2 + k * 2 * Math.PI / n;
      pts.push([cx + R * Math.cos(t), cy + R * Math.sin(t)]); bul.push(b);
    }
    return pl(pts, true, bul);
  }
  // a dining chair pushed in under a table: only the visible part is drawn
  // (an open U from the table edge plus the back-rest line). dir +1 = below the edge.
  function chairU(cx, edge, dir) {
    const y = t => edge - dir * t, hw = 21, V = 35;
    return [roundPoly([[cx - hw, y(0)], [cx - hw, y(V)], [cx + hw, y(V)], [cx + hw, y(0)]], [0, 5, 5, 0], false),
            ln([cx - hw + 1, y(V - 7)], [cx + hw - 1, y(V - 7)])];
  }

  // =========================================================================
  // 2. the blocks
  // =========================================================================
  const BLOCKS = {};
  function def(name, layer, group, w, h, label, tall, items, extra) {
    BLOCKS[name] = Object.assign({ layer, group, w, h, label, tall: !!tall,
      items: items.map(it => Object.assign({ layer }, it)) }, extra || {});
  }

  // ---------------------------------------------------------------- bedroom
  // mattress 0..200 deep, headboard 200..210 (against the wall)
  function bedItems(w, pillowW, nPillows, fold) {
    const M = 200, items = [];
    items.push(roundPoly([[0, M], [0, 0], [w, 0], [w, M]], [0, 6, 6, 0], false));   // frame (open at the head)
    items.push(rr(0, M, w, 10, 0));                                                  // headboard
    const gap = (w - nPillows * pillowW) / (nPillows + 1);
    for (let i = 0; i < nPillows; i++) items.push(det(rr(gap + i * (pillowW + gap), 152, pillowW, 40, 9)));
    const yb = 138, x1 = w - fold;                     // turned-down duvet, one corner folded back
    items.push(ln([0, yb], [x1, yb]));
    items.push(ln([x1, yb], [w, yb - fold]));
    items.push(det(pl([[x1, yb], [x1, yb - fold], [w, yb - fold]], false)));
    return items;
  }
  def("BED_DOUBLE", "A-FURN", "Bedroom", 160, 210, "Double bed 160 x 200", false, bedItems(160, 64, 2, 50));
  def("BED_KING", "A-FURN", "Bedroom", 180, 210, "King bed 180 x 200", false, bedItems(180, 74, 2, 55));
  def("BED_SINGLE", "A-FURN", "Bedroom", 90, 210, "Single bed 90 x 200", false, bedItems(90, 62, 1, 38));
  {
    const c = [22.5, 21], k = 7.07;
    def("NIGHTSTAND", "A-FURN", "Bedroom", 45, 40, "Bedside table 45 x 40", false, [
      rr(0, 0, 45, 40, 2), det(circ(c, 10)),
      det(ln([c[0] - k, c[1] - k], [c[0] + k, c[1] + k])), det(ln([c[0] - k, c[1] + k], [c[0] + k, c[1] - k])),
    ]);
  }
  function wardrobeItems(w) {
    const D = 60, doors = Math.round(w / 60), items = [rr(0, 0, w, D, 0)];
    items.push(ln([0, 4], [w, 4]));                                     // inside face of the doors
    for (let i = 1; i < doors; i++) items.push(ln([i * w / doors, 0], [i * w / doors, 4]));   // door joints
    items.push(det(ln([6, 33], [w - 6, 33])));                          // hanging rail
    const n = Math.floor((w - 24) / 14) + 1, x0 = (w - (n - 1) * 14) / 2;
    for (let i = 0; i < n; i++) { const x = x0 + i * 14; items.push(det(ln([x - 5, 12], [x + 5, 54]))); }   // hangers
    return items;
  }
  for (const w of [120, 180, 240]) def("WARDROBE_" + w, "A-FURN", "Bedroom", w, 60, "Wardrobe " + w + " x 60", true, wardrobeItems(w));
  def("DRESSER", "A-FURN", "Bedroom", 100, 45, "Dresser 100 x 45", false, [
    rr(0, 0, 100, 45, 1), det(rr(20, 39, 60, 3, 0)), det(ln([3, 3], [97, 3])),
  ]);
  {
    // desk 120 x 60 at the back, office chair in front (block depth 105)
    const t = Math.tan(Math.PI / 12);                  // bulge of a 60-degree arc
    const P1 = [60 + 30 * Math.cos(4 * Math.PI / 3), 30 + 30 * Math.sin(4 * Math.PI / 3)];
    const P2 = [60 + 30 * Math.cos(5 * Math.PI / 3), 30 + 30 * Math.sin(5 * Math.PI / 3)];
    const Q2 = [60 + 25 * Math.cos(5 * Math.PI / 3), 30 + 25 * Math.sin(5 * Math.PI / 3)];
    const Q1 = [60 + 25 * Math.cos(4 * Math.PI / 3), 30 + 25 * Math.sin(4 * Math.PI / 3)];
    def("DESK", "A-FURN", "Bedroom", 120, 105, "Desk 120 x 60 with chair", false, [
      rr(0, 45, 120, 60, 1),
      det(rr(40, 90, 40, 4, 1)),                                        // screen
      rr(42, 9, 36, 33, 8),                                             // seat
      pl([P1, P2, Q2, Q1], true, [t, 0, -t, 0]),                        // curved back rest
      det(rr(37, 14, 4, 22, 2)), det(rr(79, 14, 4, 22, 2)),             // arm rests
    ]);
  }

  // ---------------------------------------------------------------- living / reception
  function sofaItems(w, n, D, arm, back) {
    const yb = D - back, items = [rr(0, 0, w, D, [8, 8, 4, 4])];
    items.push(ln([arm, yb], [w - arm, yb]));                           // front of the back rest
    items.push(ln([arm, 0], [arm, yb]), ln([w - arm, 0], [w - arm, yb]));   // arms
    const gap = 2, inner = w - 2 * arm - 2, cw = (inner - (n - 1) * gap) / n;
    for (let i = 0; i < n; i++) items.push(det(rr(arm + 1 + i * (cw + gap), 1.5, cw, yb - 3, 4)));
    return items;
  }
  def("SOFA_3", "A-FURN", "Living", 210, 90, "Sofa, 3 seats 210 x 90", false, sofaItems(210, 3, 90, 20, 22));
  def("SOFA_2", "A-FURN", "Living", 160, 90, "Sofa, 2 seats 160 x 90", false, sofaItems(160, 2, 90, 20, 22));
  def("ARMCHAIR", "A-FURN", "Living", 85, 85, "Armchair 85 x 85", false, sofaItems(85, 1, 85, 16, 18));
  {
    // corner sofa: long arm along the back (top), the return down the left side
    const W = 250, H = 170, D = 90, A = 20, items = [];
    items.push(roundPoly([[0, 0], [D, 0], [D, H - D], [W, H - D], [W, H], [0, H]], [8, 8, 0, 8, 4, 4], true));
    items.push(pl([[A, A], [A, H - A], [W - A, H - A]], false));       // inside face of both back rests
    items.push(ln([A, A], [D, A]));                                     // arm at the end of the return
    items.push(ln([W - A, H - D], [W - A, H - A]));                     // arm at the end of the long side
    const s = D - A - 2;                                                // 68
    items.push(det(rr(A + 1, H - D + 1, s, s, 4)));                     // corner seat
    items.push(det(rr(A + 1, A + 1, s, H - D - A - 2, 4)));             // return seat
    const x0 = D + 1, cw = (W - A - 1 - x0 - 2) / 2;
    items.push(det(rr(x0, H - D + 1, cw, s, 4)), det(rr(x0 + cw + 2, H - D + 1, cw, s, 4)));
    def("SOFA_L", "A-FURN", "Living", W, H, "Corner sofa 250 x 170", false, items,
      { parts: [[0, H - D, W, H], [0, 0, D, H - D]] });
  }
  def("COFFEE_TABLE", "A-FURN", "Living", 110, 60, "Coffee table 110 x 60", false, [
    rr(0, 0, 110, 60, 3), det(rr(6, 6, 98, 48, 2)),
  ]);
  def("CENTRE_TABLE", "A-FURN", "Living", 140, 70, "Centre table 140 x 70", false, [
    rr(0, 0, 140, 70, 4), det(rr(7, 7, 126, 56, 2)), det(circ([70, 35], 12)),
  ]);
  def("TV_UNIT", "A-FURN", "Living", 180, 45, "TV unit 180 x 45", true, [
    rr(0, 0, 180, 45, 1), rr(30, 33, 120, 5, 1), det(rr(75, 24, 30, 7, 2)),
  ]);
  // Iraqi floor seating (qa'ada / majlis): floor cushions with a back cushion against the wall
  def("FLOOR_SEAT", "A-FURN", "Living", 70, 70, "Floor seat cushion 70 x 70", false, [
    rr(0, 0, 70, 70, 4), det(rr(4, 50, 62, 17, 8)),
  ]);
  def("FLOOR_SEAT_CORNER", "A-FURN", "Living", 70, 70, "Floor seat, corner 70 x 70", false, [
    rr(0, 0, 70, 70, 4),
    det(roundPoly([[4, 4], [21, 4], [21, 50], [66, 50], [66, 67], [4, 67]], [8, 8, 0, 8, 8, 8], true)),
  ]);
  def("FLOOR_TABLE", "A-FURN", "Living", 80, 80, "Low round tray table 80", false, [
    circ([40, 40], 40), det(circ([40, 40], 36)), det(circ([40, 40], 12)),
  ]);

  // ---------------------------------------------------------------- kitchen
  const KIT_MODS = [120, 100, 90, 80, 60, 55, 50, 45, 40, 35, 30];
  for (const w of KIT_MODS.slice().sort((a, b) => a - b))
    def("KIT_BASE_" + w, "A-FIXT", "Kitchen", w, 60, "Base cupboard " + w + " x 60", false, [rr(0, 0, w, 60, 0)]);
  {
    const items = [rr(0, 0, 120, 60, 0), rr(4, 6, 112, 48, 4), rr(62, 10, 48, 40, 7),
      det(circ([86, 30], 2.5)), det(circ([86, 57], 2))];
    for (let y = 15; y <= 45; y += 6) items.push(det(ln([12, y], [54, y])));   // drainer grooves
    def("KIT_SINK", "A-FIXT", "Kitchen", 120, 60, "Sink with drainer 120 x 60", false, items);
  }
  def("KIT_COOKER", "A-FIXT", "Kitchen", 60, 60, "Cooker 60 x 60, 4 burners", false, [
    rr(0, 0, 60, 60, 0), ln([0, 8], [60, 8]),
    det(circ([10, 4], 2)), det(circ([22, 4], 2)), det(circ([38, 4], 2)), det(circ([50, 4], 2)),
    circ([16, 25], 9), det(circ([16, 25], 4.5)), circ([44, 25], 7), det(circ([44, 25], 3)),
    circ([16, 47], 7), det(circ([16, 47], 3)), circ([44, 47], 9), det(circ([44, 47], 4.5)),
  ]);
  def("FRIDGE", "A-FIXT", "Kitchen", 70, 70, "Fridge 70 x 70", true, [
    rr(0, 0, 70, 70, 0), ln([0, 6], [70, 6]), det(ln([0, 6], [70, 70])), det(ln([70, 6], [0, 70])),
  ]);
  def("KIT_TALL_60", "A-FIXT", "Kitchen", 60, 60, "Tall cupboard 60 x 60", true, [
    rr(0, 0, 60, 60, 0), ln([0, 3], [60, 3]), det(ln([0, 3], [60, 60])), det(ln([60, 3], [0, 60])),
  ]);
  function diningItems(tw, td, perSide) {
    const V = 35, items = [rr(0, V, tw, td, 3)], step = tw / perSide;
    for (let i = 0; i < perSide; i++) {
      const cx = step * (i + 0.5);
      items.push(...chairU(cx, V, 1), ...chairU(cx, V + td, -1));
    }
    return items;
  }
  def("DINING_4", "A-FURN", "Kitchen", 120, 150, "Dining table 120 x 80, 4 chairs", false, diningItems(120, 80, 2));
  def("DINING_6", "A-FURN", "Kitchen", 180, 160, "Dining table 180 x 90, 6 chairs", false, diningItems(180, 90, 3));

  // ---------------------------------------------------------------- bathroom / WC
  def("WC", "A-FIXT", "Bathroom", 40, 70, "WC (western) 40 x 70", false, [
    rr(0, 52, 40, 18, 2), det(circ([20, 61], 3)),                       // cistern + flush button
    pl([[5, 52], [3, 17], [37, 17], [35, 52]], false, [0, 1, 0, 0]),    // bowl (semicircular front)
    det(rr(11, 9, 18, 32, 9)), det(ln([7, 47], [33, 47])),              // opening, seat hinge
  ]);
  {
    const items = [rr(0, 0, 50, 70, 12), rr(16, 30, 18, 34, 9), det(circ([25, 53], 4))];
    for (const x of [5, 32]) {
      items.push(det(rr(x, 6, 13, 22, 3)));                             // foot treads
      for (let y = 10.5; y <= 24.1; y += 4.5) items.push(det(ln([x + 3, y], [x + 10, y])));
    }
    def("WC_EASTERN", "A-FIXT", "Bathroom", 50, 70, "Eastern (squat) toilet 50 x 70", false, items);
  }
  def("BASIN", "A-FIXT", "Bathroom", 55, 45, "Wash basin 55 x 45", false, [
    rr(0, 0, 55, 45, [14, 14, 0, 0]), rr(7, 6, 41, 29, 13), det(circ([27.5, 19], 2)), det(circ([27.5, 40], 2.5)),
  ]);
  def("HAND_BASIN", "A-FIXT", "Bathroom", 40, 30, "Hand basin 40 x 30", false, [
    rr(0, 0, 40, 30, [10, 10, 0, 0]), rr(5, 4, 30, 18, 8), det(circ([20, 12], 1.5)), det(circ([20, 26], 2)),
  ]);
  function showerItems(s) {
    const i = 4, r = 6, c = s / 2, p0 = i + r * (1 - Math.SQRT1_2), dr = 5, e = dr * Math.SQRT1_2;
    return [rr(0, 0, s, s, 0), rr(i, i, s - 2 * i, s - 2 * i, r), circ([c, c], dr), det(circ([c, c], 2)),
      det(ln([p0, p0], [c - e, c - e])), det(ln([s - p0, p0], [c + e, c - e])),
      det(ln([s - p0, s - p0], [c + e, c + e])), det(ln([p0, s - p0], [c - e, c + e]))];
  }
  def("SHOWER_90", "A-FIXT", "Bathroom", 90, 90, "Shower tray 90 x 90", false, showerItems(90));
  def("SHOWER_80", "A-FIXT", "Bathroom", 80, 80, "Shower tray 80 x 80", false, showerItems(80));
  def("BATHTUB", "A-FIXT", "Bathroom", 170, 75, "Bathtub 170 x 75", false, [
    rr(0, 0, 170, 75, 3), rr(8, 8, 150, 59, [26, 12, 12, 26]), det(circ([146, 37.5], 3)), det(circ([164, 37.5], 2.5)),
  ]);

  // ---------------------------------------------------------------- open area / hall
  {
    // 9-lobed canopy; R = 53.2 makes the outline reach x 0.6..119.4, y 0.0..117.7 (measured)
    const items = [scallop(60, 60, 53.2, 9, 0.55), circ([60, 60], 6)];
    for (let k = 0; k < 5; k++) {
      const t = (20 + 72 * k) * Math.PI / 180;
      items.push(det(ln([60 + 9 * Math.cos(t), 60 + 9 * Math.sin(t)], [60 + 34 * Math.cos(t), 60 + 34 * Math.sin(t)])));
    }
    def("TREE", "A-FURN", "Outdoor", 120, 118, "Tree, canopy about 1.20 m", false, items);
  }
  def("PLANTER", "A-FURN", "Outdoor", 60, 60, "Plant pot 60", false, [
    circ([30, 30], 30), det(circ([30, 30], 26)), det(scallop(30, 30, 15, 7, 0.6)),
  ]);
  def("SHOE_CABINET", "A-FURN", "Hall", 100, 35, "Shoe cabinet 100 x 35", false, [
    rr(0, 0, 100, 35, 0), ln([0, 3], [100, 3]), ln([50, 0], [50, 3]),
  ]);
  def("CONSOLE", "A-FURN", "Hall", 100, 35, "Console table 100 x 35", false, [
    rr(0, 0, 100, 35, 2), det(circ([80, 18], 8)), det(circ([80, 18], 2.5)),
  ]);

  // =========================================================================
  // 3. the layout engine (room-local cm: the room is [0,W] x [0,H])
  // =========================================================================
  const SIDES4 = ["N", "E", "S", "W"];
  const OPP = { N: "S", S: "N", E: "W", W: "E" };
  const ALONG_X = { N: true, S: true, E: false, W: false };
  const SIDE_ROT = { N: 0, W: 90, S: 180, E: 270 };        // puts a block's back (local +y) against that side
  const LEFT_OF = { N: "W", W: "S", S: "E", E: "N" };      // standing in the room facing wall X, the wall on your left
  const RIGHT_OF = { N: "E", E: "S", S: "W", W: "N" };
  const COS = { 0: 1, 90: 0, 180: -1, 270: 0 }, SIN = { 0: 0, 90: 1, 180: 0, 270: -1 };
  const EPS = 1e-6;
  const DOOR_CLEAR = 60;      // kept free in front of every door (both faces)
  const WIN_DEPTH = 60;       // tall pieces stay out of this depth in front of a window

  const ov = (a, b) => a[0] < b[2] - EPS && b[0] < a[2] - EPS && a[1] < b[3] - EPS && b[1] < a[3] - EPS;
  const spanOv = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const snap5 = v => Math.round(v / 5) * 5;

  // ---- DXF INSERT transform
  function xf(ins, u, v) {
    const c = COS[ins.rot], s = SIN[ins.rot], uu = ins.sx * u;
    return [ins.x + c * uu - s * v, ins.y + s * uu + c * v];
  }
  function xfRect(ins, r) {
    const p = xf(ins, r[0], r[1]), q = xf(ins, r[2], r[3]);
    return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
  }
  // insert that puts block `name` (rot, sx) exactly into the world box `box`
  function insAt(name, rot, sx, box) {
    const b = BLOCKS[name], r = xfRect({ x: 0, y: 0, rot, sx }, [0, 0, b.w, b.h]);
    return { block: name, x: box[0] - r[0], y: box[1] - r[1], rot, sx };
  }
  function blockBox(ins) { const b = BLOCKS[ins.block]; return xfRect(ins, [0, 0, b.w, b.h]); }
  function blockParts(ins) { const b = BLOCKS[ins.block]; return (b.parts || [[0, 0, b.w, b.h]]).map(r => xfRect(ins, r)); }

  // ---- wall frame: `a` runs along the side (x for N/S, y for E/W), depth runs into the room
  const wallLen = (ctx, s) => (ALONG_X[s] ? ctx.W : ctx.H);
  const depthLen = (ctx, s) => (ALONG_X[s] ? ctx.H : ctx.W);
  function wallBox(ctx, s, a, len, off, dep) {
    switch (s) {
      case "N": return [a, ctx.H - off - dep, a + len, ctx.H - off];
      case "S": return [a, off, a + len, off + dep];
      case "E": return [ctx.W - off - dep, a, ctx.W - off, a + len];
      default:  return [off, a, off + dep, a + len];      // W
    }
  }
  const alongOf = (s, r) => (ALONG_X[s] ? [r[0], r[2]] : [r[1], r[3]]);
  const inRoom = (ctx, r) => r[0] >= -EPS && r[1] >= -EPS && r[2] <= ctx.W + EPS && r[3] <= ctx.H + EPS;
  // the end of wall A that meets wall B (along-coordinate)
  const cornerEnd = (ctx, A, B) => (ALONG_X[A] ? (B === "W" ? 0 : ctx.W) : (B === "S" ? 0 : ctx.H));
  // sx that puts the block's local RIGHT (x = w) at the high-`a` end of side s
  const sxRightHigh = s => (s === "N" || s === "W" ? 1 : -1);

  function makeCtx(W, H, ops) {
    const ctx = { W, H, doors: [], wins: [], hard: [], winZ: [], placed: [] };
    for (const o of ops) {
      const L = wallLen(ctx, o.side), s0 = Math.max(0, o.s0), s1 = Math.min(L, o.s1);
      if (!(s1 > s0 + EPS)) continue;
      if (o.kind === "door") {
        const depth = o.swingInto ? Math.max(o.s1 - o.s0, DOOR_CLEAR) : DOOR_CLEAR;
        const zone = wallBox(ctx, o.side, s0, s1 - s0, 0, depth);
        ctx.doors.push({ side: o.side, s0, s1, zone }); ctx.hard.push(zone);
      } else if (o.kind === "window") {
        const zone = wallBox(ctx, o.side, s0, s1 - s0, 0, WIN_DEPTH);
        ctx.wins.push({ side: o.side, s0, s1, zone }); ctx.winZ.push(zone);
      }
    }
    return ctx;
  }

  function mkPiece(name, rot, sx, box, clears) {
    const ins = insAt(name, rot, sx, box), b = BLOCKS[name];
    const parts = b.parts ? b.parts.map(r => xfRect(ins, r)) : [box];
    return { name, ins, box, parts, clears: clears || [], tall: !!b.tall };
  }
  const put = (ctx, p) => { ctx.placed.push(p); return p; };

  function hitsPlaced(ctx, r) {
    for (const p of ctx.placed) {
      for (const q of p.parts) if (ov(r, q)) return true;
      for (const c of p.clears) if (ov(r, c)) return true;
    }
    return false;
  }
  function hitsParts(ctx, r) {
    for (const p of ctx.placed) for (const q of p.parts) if (ov(r, q)) return true;
    return false;
  }
  // can a piece occupy `box` (with its own access zones `clears`)?
  function fits(ctx, box, clears, tall) {
    if (!inRoom(ctx, box)) return false;
    for (const z of ctx.hard) if (ov(box, z)) return false;
    if (tall) for (const z of ctx.winZ) if (ov(box, z)) return false;
    if (hitsPlaced(ctx, box)) return false;
    if (clears) for (const c of clears) { if (!inRoom(ctx, c) || hitsParts(ctx, c)) return false; }
    return true;
  }
  function fitsPiece(ctx, pc) {
    for (const part of pc.parts) if (!fits(ctx, part, null, pc.tall)) return false;
    for (const c of pc.clears) if (!inRoom(ctx, c) || hitsParts(ctx, c)) return false;
    return true;
  }

  // free stretches along a wall for a band [off, off+depth] in front of it
  function freeIntervals(ctx, side, off, depth, tall) {
    const L = wallLen(ctx, side), band = wallBox(ctx, side, -1e7, 2e7, off, depth), bl = [];
    const add = r => { if (ov(band, r)) { const e = alongOf(side, r); bl.push([Math.max(0, e[0]), Math.min(L, e[1])]); } };
    for (const z of ctx.hard) add(z);
    if (tall) for (const z of ctx.winZ) add(z);
    for (const p of ctx.placed) { for (const q of p.parts) add(q); for (const c of p.clears) add(c); }
    bl.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const out = []; let cur = 0;
    for (const [a, b] of bl) { if (a > cur + EPS) out.push([cur, a]); if (b > cur) cur = b; }
    if (L > cur + EPS) out.push([cur, L]);
    return out;
  }

  // candidate positions `a` for a piece of length `len` against `side`
  function alongCands(ctx, side, len, off, depth, sc, tall, extra, centres) {
    const L = wallLen(ctx, side), out = [], seen = new Set();
    const push = a => {
      if (!(a >= sc - EPS) || a + len > L - sc + EPS) return;
      const k = Math.round(a * 1000);
      if (seen.has(k)) return;
      seen.add(k); out.push(a);
    };
    if (extra) extra.forEach(push);
    push(sc); push(L - len - sc); push((L - len) / 2);
    const band = wallBox(ctx, side, -1e7, 2e7, off, depth);
    const add = r => { if (ov(band, r)) { const e = alongOf(side, r); push(e[1] + sc); push(e[0] - len - sc); } };
    for (const z of ctx.hard) add(z);
    if (tall) for (const z of ctx.winZ) add(z);
    for (const p of ctx.placed) { for (const q of p.parts) add(q); for (const c of p.clears) add(c); }
    if (centres) for (const v of freeIntervals(ctx, side, off, depth, tall)) push((v[0] + v[1] - len) / 2);
    return out;
  }

  /* Best spot for a piece standing against a wall.
     spec = { name, off (gap behind), front (access depth), sideCl (access each side),
              sides, extra(side,L) -> [a], centres, score(side,a,box) -> number, sx(side,a) } */
  function wallBest(ctx, spec) {
    const b = BLOCKS[spec.name], tall = b.tall, off = spec.off || 0, front = spec.front || 0, sc = spec.sideCl || 0;
    let best = null;
    for (const side of spec.sides || SIDES4) {
      const L = wallLen(ctx, side);
      if (b.w + 2 * sc > L + EPS || off + b.h + front > depthLen(ctx, side) + EPS) continue;
      const cands = alongCands(ctx, side, b.w, off, b.h + front, sc, tall, spec.extra ? spec.extra(side, L) : null, spec.centres);
      for (const a of cands) {
        const box = wallBox(ctx, side, a, b.w, off, b.h);
        const clears = (front || sc) ? [wallBox(ctx, side, a - sc, b.w + 2 * sc, off, b.h + front)] : [];
        if (!fits(ctx, box, clears, tall)) continue;
        const s = spec.score ? spec.score(side, a, box) : 0;
        if (!best || s > best.score + 1e-9) best = { side, a, box, clears, score: s };
      }
    }
    if (!best) return null;
    best.piece = mkPiece(spec.name, SIDE_ROT[best.side], spec.sx ? spec.sx(best.side, best.a) : 1, best.box, best.clears);
    return best;
  }

  // centre-most free spot for a free-standing piece (tables, trees)
  function freeBest(ctx, name, rots, ring, score) {
    const b = BLOCKS[name];
    let best = null;
    for (const rot of rots) {
      const w = rot % 180 ? b.h : b.w, h = rot % 180 ? b.w : b.h;
      const xs = [ring, ctx.W - w - ring, (ctx.W - w) / 2], ys = [ring, ctx.H - h - ring, (ctx.H - h) / 2];
      const ex = [0, ctx.W], ey = [0, ctx.H];
      const obs = ctx.hard.slice();
      for (const p of ctx.placed) { obs.push(...p.parts); obs.push(...p.clears); }
      for (const r of obs) {
        xs.push(r[2] + ring, r[0] - w - ring); ys.push(r[3] + ring, r[1] - h - ring);
        ex.push(r[0], r[2]); ey.push(r[1], r[3]);
      }
      ex.sort((p, q) => p - q); ey.sort((p, q) => p - q);
      for (let i = 1; i < ex.length; i++) xs.push((ex[i - 1] + ex[i] - w) / 2);
      for (let i = 1; i < ey.length; i++) ys.push((ey[i - 1] + ey[i] - h) / 2);
      const ux = uniq(xs), uy = uniq(ys);
      for (const x of ux) for (const y of uy) {
        const box = [x, y, x + w, y + h], cl = [x - ring, y - ring, x + w + ring, y + h + ring];
        if (!fits(ctx, box, ring ? [cl] : null, b.tall)) continue;
        const s = score(box, rot);
        if (!best || s > best.score + 1e-9) best = { box, rot, score: s };
      }
    }
    if (!best) return null;
    best.piece = mkPiece(name, best.rot, 1, best.box,
      ring ? [[best.box[0] - ring, best.box[1] - ring, best.box[2] + ring, best.box[3] + ring]] : []);
    return best;
  }
  function uniq(arr) {
    const seen = new Set(), out = [];
    for (const v of arr) { if (!isFinite(v)) continue; const k = Math.round(v * 1000); if (!seen.has(k)) { seen.add(k); out.push(v); } }
    return out;
  }
  // how far a box is from walls, door zones and other pieces (capped)
  const rectDist = (a, b) => Math.hypot(Math.max(0, b[0] - a[2], a[0] - b[2]), Math.max(0, b[1] - a[3], a[1] - b[3]));
  function roominess(ctx, box, cap) {
    let d = Math.min(box[0], box[1], ctx.W - box[2], ctx.H - box[3]);
    for (const z of ctx.hard) d = Math.min(d, rectDist(box, z));
    for (const p of ctx.placed) for (const q of p.parts) d = Math.min(d, rectDist(box, q));
    return Math.min(d, cap);
  }
  // a fridge that found no free end of a counter: against a wall, as near the counter as the rules allow
  function nearCounterFridge(ctx) {
    const counters = ctx.placed.filter(p => p.name.startsWith("KIT_")).map(p => p.box);
    return wallBest(ctx, { name: "FRIDGE", front: 90, centres: true, score: (s, a, box) =>
      counters.length ? -0.1 * Math.min(...counters.map(c => rectDist(box, c))) : 0 });
  }

  // ---- results: completeness (core pieces placed / wanted) then score
  const newRes = () => ({ score: 0, core: 0, got: 0, dropped: [], skipped: [] });
  function gain(res, w, core, s) { res.score += w + (s || 0); if (core) { res.core += w; res.got += w; } }
  function miss(res, w, label, core) { if (core) { res.core += w; res.dropped.push(label); } else res.skipped.push(label); }
  function merge(a, b) {
    a.score += b.score; a.core += b.core; a.got += b.got;
    a.dropped.push(...b.dropped); a.skipped.push(...b.skipped); return a;
  }
  const done = r => (r.core ? r.got / r.core : 1);
  function better(a, b) {
    const ca = done(a), cb = done(b);
    if (Math.abs(ca - cb) > 1e-9) return ca > cb;
    return a.score > b.score + 1e-9;
  }
  // try each option (run() places pieces and returns a res); keep the best one's pieces
  function bestOf(ctx, options, run) {
    const mark = ctx.placed.length;
    let best = null, bestPlaced = null;
    for (const o of options) {
      ctx.placed.length = mark;
      const res = run(o);
      if (res && (!best || better(res, best))) { best = res; bestPlaced = ctx.placed.slice(mark); }
    }
    ctx.placed.length = mark;
    if (best) for (const p of bestPlaced) ctx.placed.push(p);
    return best;
  }
  function topK(list, k) {
    return list.map((o, i) => [o, i]).sort((p, q) => (q[0].score - p[0].score) || (p[1] - q[1])).slice(0, k).map(p => p[0]);
  }
  const winOver = (ctx, side, a0, a1) => {
    let t = 0;
    for (const w of ctx.wins) if (w.side === side) t += spanOv(w.s0, w.s1, a0, a1);
    return t;
  };
  const touchesDoorZone = (ctx, side, a, len) =>
    ctx.doors.some(d => d.side === side && (Math.abs(a - d.s1) < 1 || Math.abs(a + len - d.s0) < 1));
  const atCorner = (ctx, side, a, len) => a < EPS || a + len > wallLen(ctx, side) - EPS;

  // =========================================================================
  // 4. bedroom
  // =========================================================================
  const NS_W = 45, NS_D = 40;
  function bedOptions(ctx, cfg) {
    const bed = BLOCKS[cfg.bed], bw = bed.w, bh = bed.h;
    const gw = cfg.twin ? 2 * bw + 60 : bw;
    const foot = cfg.single ? 0 : 50, acc = cfg.single ? 60 : 55;
    const out = [];
    for (const side of SIDES4) {
      const L = wallLen(ctx, side);
      if (gw > L + EPS || bh + foot > depthLen(ctx, side) + EPS) continue;
      const extra = [NS_W, L - gw - NS_W, 0, L - gw, acc, L - gw - acc];
      const band = wallBox(ctx, side, -1e7, 2e7, 0, bh + foot);
      for (const z of ctx.hard) if (ov(band, z)) {
        const e = alongOf(side, z);
        extra.push(e[1] + NS_W, e[0] - gw - NS_W, e[1] + acc, e[0] - gw - acc);
      }
      for (const a of alongCands(ctx, side, gw, 0, bh + foot, 0, false, extra, true)) {
        const box = wallBox(ctx, side, a, gw, 0, bh);
        const footZ = foot ? wallBox(ctx, side, a, gw, bh, foot) : null;
        if (!fits(ctx, box, footZ ? [footZ] : null, false)) continue;
        const accL = wallBox(ctx, side, a - acc, acc, NS_D, bh - NS_D), accR = wallBox(ctx, side, a + gw, acc, NS_D, bh - NS_D);
        const okL = inRoom(ctx, accL) && !hitsParts(ctx, accL), okR = inRoom(ctx, accR) && !hitsParts(ctx, accR);
        if (!cfg.twin && !okL && !okR) continue;
        // score the head wall
        let s = 0;
        if (winOver(ctx, side, a, a + gw) > 0) s -= 40;                 // bed head under a window
        for (const d of ctx.doors) {
          if (d.side === side) s -= 6;
          if (d.side === OPP[side] && spanOv(d.s0, d.s1, a, a + gw) > 0) s -= 20;   // feet straight at the door
        }
        s -= 0.03 * Math.abs(a + gw / 2 - L / 2);
        if (cfg.single) { if (a < EPS || a + gw > L - EPS) s += 8; }
        else s += 20 * ((okL ? 1 : 0) + (okR ? 1 : 0));
        // pieces
        const pieces = [], clears = [];
        if (footZ) clears.push(footZ);
        if (okL) clears.push(accL);
        if (okR) clears.push(accR);
        if (cfg.twin) {
          const mid = wallBox(ctx, side, a + bw, 60, NS_D, bh - NS_D);
          clears.push(mid);
          pieces.push(mkPiece("BED_SINGLE", SIDE_ROT[side], -sxRightHigh(side), wallBox(ctx, side, a, bw, 0, bh), clears));
          pieces.push(mkPiece("BED_SINGLE", SIDE_ROT[side], sxRightHigh(side), wallBox(ctx, side, a + bw + 60, bw, 0, bh), []));
        } else {
          let sx = 1;
          if (cfg.single) sx = (okR && !okL) ? sxRightHigh(side) : (okL && !okR) ? -sxRightHigh(side) : 1;
          pieces.push(mkPiece(cfg.bed, SIDE_ROT[side], sx, box, clears));
        }
        // nightstands
        const nsSpots = [];
        if (cfg.twin) nsSpots.push(a + bw + 7.5);
        else {
          if (!cfg.single || okL) nsSpots.push(a - NS_W);
          if (!cfg.single || okR) nsSpots.push(a + gw);
          if (cfg.single && nsSpots.length > 1) nsSpots.length = 1;
        }
        const nsWanted = cfg.twin || cfg.single ? 1 : 2;
        const nsP = [];
        for (const na of nsSpots) {
          const nb = wallBox(ctx, side, na, NS_W, 0, NS_D);
          if (fits(ctx, nb, null, false)) nsP.push(mkPiece("NIGHTSTAND", SIDE_ROT[side], 1, nb, []));
        }
        out.push({ side, a, gw, pieces: pieces.concat(nsP), nsWanted, nsGot: nsP.length, score: s + 10 * nsP.length });
        if (nsP.length) out.push({ side, a, gw, pieces, nsWanted, nsGot: 0, score: s });
      }
    }
    return out;
  }
  function wardrobe(ctx, res, bedSide) {
    let best = null;
    for (const [name, bonus] of [["WARDROBE_240", 20], ["WARDROBE_180", 10], ["WARDROBE_120", 0]]) {
      const len = BLOCKS[name].w;
      const r = wallBest(ctx, { name, front: 60, score: (side, a) => {
        let s = bonus;
        if (atCorner(ctx, side, a, len)) s += 10;
        if (touchesDoorZone(ctx, side, a, len)) s += 6;
        if (side === bedSide) s -= 4;
        return s;
      } });
      if (r && (!best || r.score > best.score + 1e-9)) best = r;
    }
    if (best) { put(ctx, best.piece); gain(res, 50, true, best.score); } else miss(res, 50, "wardrobe", true);
  }
  function dresser(ctx, res, bedSide) {
    const r = wallBest(ctx, { name: "DRESSER", front: 60, centres: true, score: (side, a) =>
      (bedSide && side === OPP[bedSide] ? 8 : 0) + (atCorner(ctx, side, a, 100) ? 2 : 0) });
    if (r) { put(ctx, r.piece); gain(res, 15, false, r.score); } else miss(res, 15, "dresser", false);
  }
  function desk(ctx, res, core) {
    const r = wallBest(ctx, { name: "DESK", front: 30, centres: true, extra: side =>
      ctx.wins.filter(w => w.side === side).map(w => (w.s0 + w.s1) / 2 - 60),
      score: (side, a) => (winOver(ctx, side, a, a + 120) >= 40 ? 15 : 0) + (atCorner(ctx, side, a, 120) ? 4 : 0) });
    if (r) { put(ctx, r.piece); gain(res, core ? 30 : 15, core, r.score); } else miss(res, core ? 30 : 15, "desk", core);
  }
  function bedroom(ctx, cfg) {
    const opts = topK(bedOptions(ctx, cfg), 6);
    const rest = (res, bedSide) => {
      wardrobe(ctx, res, bedSide);
      if (cfg.desk === "core") desk(ctx, res, true);
      if (cfg.dresser) dresser(ctx, res, bedSide);
      if (cfg.desk === "extra") desk(ctx, res, false);
      return res;
    };
    if (!opts.length) {
      const res = newRes();
      miss(res, 100, cfg.twin ? "two beds" : "bed", true);
      for (let i = 0; i < (cfg.twin || cfg.single ? 1 : 2); i++) miss(res, 12, "nightstand", true);
      return rest(res, null);
    }
    return bestOf(ctx, opts, o => {
      const res = newRes();
      gain(res, 100, true, o.score);
      o.pieces.forEach(p => put(ctx, p));
      for (let i = 0; i < o.nsWanted; i++) if (i < o.nsGot) gain(res, 12, true); else miss(res, 12, "nightstand", true);
      return rest(res, o.side);
    });
  }

  // =========================================================================
  // 5. living room / reception
  // =========================================================================
  const armRot = (side, low) => (ALONG_X[side] ? (low ? 90 : 270) : (low ? 180 : 0));
  function tvOpposite(ctx, side, c) {
    return wallBest(ctx, { name: "TV_UNIT", front: 60, sides: [OPP[side]], extra: () => [c - 90, snap5(c - 90)],
      score: (s, a) => -0.1 * Math.abs(a + 90 - c) });
  }
  // armchairs either end of a (real or imagined) table box, facing it
  function armchairs(ctx, res, side, tBox, n) {
    const A = BLOCKS.ARMCHAIR.w;
    const [t0, t1] = alongOf(side, tBox), dTop = depthOf(ctx, side, tBox), dc = (dTop[0] + dTop[1]) / 2;
    let got = 0;
    for (const low of [true, false]) {
      if (got >= n) break;
      let pc = null;
      for (const g of [30, 45, 20, 60]) {
        for (const dd of [0, -15, 15, -30, 30]) {
          const p0 = low ? t0 - g - A : t1 + g;
          const box = wallBox(ctx, side, p0, A, dc + dd - A / 2, A);
          if (fits(ctx, box, null, false)) { pc = mkPiece("ARMCHAIR", armRot(side, low), 1, box, []); break; }
        }
        if (pc) break;
      }
      if (pc) { put(ctx, pc); got++; gain(res, 10, false); } else miss(res, 10, "armchair", false);
    }
  }
  function depthOf(ctx, s, r) {
    switch (s) {
      case "N": return [ctx.H - r[3], ctx.H - r[1]];
      case "S": return [r[1], r[3]];
      case "E": return [ctx.W - r[2], ctx.W - r[0]];
      default:  return [r[0], r[2]];
    }
  }
  function sofaOptions(ctx, names) {
    const opts = [];
    for (const side of SIDES4) for (const name of names) {
      const b = BLOCKS[name], L = wallLen(ctx, side);
      if (b.w > L + EPS || b.h + 40 > depthLen(ctx, side) + EPS) continue;
      for (const a of alongCands(ctx, side, b.w, 0, b.h + 40, 0, false, null, true)) {
        const box = wallBox(ctx, side, a, b.w, 0, b.h), clear = wallBox(ctx, side, a, b.w, b.h, 40);
        if (!fits(ctx, box, [clear], false)) continue;
        let s = (name === "SOFA_3" ? 10 : 0) - 0.03 * Math.abs(a + b.w / 2 - L / 2) + 0.01 * L;
        for (const d of ctx.doors) if (d.side === side) s -= 4;
        opts.push({ side, a, name, box, clear, score: s });
      }
    }
    return opts;
  }
  // sofa against a wall, coffee table in front, TV opposite, armchairs at the table ends
  function sofaSet(ctx, o) {
    const opts = topK(sofaOptions(ctx, ["SOFA_3", "SOFA_2"]), 8);
    if (!opts.length) {
      const res = newRes();
      miss(res, 40, "sofa", true); miss(res, 20, "coffee table", true);
      if (o.tv) { const t = wallBest(ctx, { name: "TV_UNIT", front: 60, centres: true }); if (t) { put(ctx, t.piece); gain(res, 30, true); } else miss(res, 30, "TV unit", true); }
      return res;
    }
    return bestOf(ctx, opts, op => {
      const res = newRes();
      put(ctx, mkPiece(op.name, SIDE_ROT[op.side], 1, op.box, [op.clear]));
      gain(res, 40, true, op.score);
      const b = BLOCKS[op.name], c = op.a + b.w / 2, T = BLOCKS.COFFEE_TABLE;
      const tBox = wallBox(ctx, op.side, c - T.w / 2, T.w, b.h + 40, T.h);
      let table = null;
      if (fits(ctx, tBox, null, false)) table = put(ctx, mkPiece("COFFEE_TABLE", SIDE_ROT[op.side], 1, tBox, []));
      if (o.tv) {
        let tv = tvOpposite(ctx, op.side, c);
        if (!tv && table) {                       // a TV matters more than the table
          ctx.placed.pop(); tv = tvOpposite(ctx, op.side, c);
          if (tv) table = null; else put(ctx, table);
        }
        if (tv) { put(ctx, tv.piece); gain(res, 30, true, tv.score); } else miss(res, 30, "TV unit", true);
      }
      if (table) gain(res, 20, true); else miss(res, 20, "coffee table", true);
      armchairs(ctx, res, op.side, tBox, o.chairs);
      return res;
    });
  }
  function lSofaSet(ctx, o) {
    const S = BLOCKS.SOFA_L, T = BLOCKS.COFFEE_TABLE, opts = [];
    for (const A of SIDES4) for (const B of [LEFT_OF[A], RIGHT_OF[A]]) {
      if (S.w > wallLen(ctx, A) + EPS || S.h > depthLen(ctx, A) + EPS) continue;
      const a = cornerEnd(ctx, A, B) === 0 ? 0 : wallLen(ctx, A) - S.w;
      const box = wallBox(ctx, A, a, S.w, 0, S.h), sx = LEFT_OF[A] === B ? 1 : -1;
      const ins = insAt("SOFA_L", SIDE_ROT[A], sx, box);
      const clears = [xfRect(ins, [90, 40, 250, 80]), xfRect(ins, [90, 0, 130, 80])];
      const pc = mkPiece("SOFA_L", SIDE_ROT[A], sx, box, clears);
      if (!fitsPiece(ctx, pc)) continue;
      let s = 0.01 * wallLen(ctx, A);
      for (const d of ctx.doors) if (d.side === A || d.side === B) s -= 3;
      opts.push({ A, pc, ins, score: s });
    }
    if (!opts.length) {
      const res = newRes(); miss(res, 40, "corner sofa", true); miss(res, 20, "coffee table", true);
      if (o.tv) miss(res, 30, "TV unit", true);
      return res;
    }
    return bestOf(ctx, opts, op => {
      const res = newRes();
      put(ctx, op.pc); gain(res, 40, true, op.score);
      const tBox = xfRect(op.ins, [130, -20, 240, 40]);
      const table = fits(ctx, tBox, null, false) ? put(ctx, mkPiece("COFFEE_TABLE", SIDE_ROT[op.A], 1, tBox, [])) : null;
      if (o.tv) {
        const c = (alongOf(op.A, tBox)[0] + alongOf(op.A, tBox)[1]) / 2;
        let tv = tvOpposite(ctx, op.A, c);
        if (!tv && table) {
          ctx.placed.pop(); tv = tvOpposite(ctx, op.A, c);
          if (!tv) put(ctx, table);
        }
        if (tv) { put(ctx, tv.piece); gain(res, 30, true, tv.score); } else miss(res, 30, "TV unit", true);
      }
      if (ctx.placed.includes(table)) gain(res, 20, true); else miss(res, 20, "coffee table", true);
      return res;
    });
  }
  // floor cushions along the walls (Iraqi qa'ada) with low tray tables
  function floorSeating(ctx, o) {
    const res = newRes();
    let tvSide = null;
    if (o.tv) {
      let longest = 0;
      for (const s of SIDES4) longest = Math.max(longest, wallLen(ctx, s));
      const t = wallBest(ctx, { name: "TV_UNIT", front: 120, centres: true, score: (side, a) =>
        (wallLen(ctx, side) >= longest - EPS ? 10 : 0) - 0.05 * Math.abs(a + 90 - wallLen(ctx, side) / 2) - (ctx.doors.some(d => d.side === side) ? 6 : 0) });
      if (t) { put(ctx, t.piece); tvSide = t.side; gain(res, 30, true, t.score); } else miss(res, 30, "TV unit", true);
    }
    const S = 70, seatSides = SIDES4.filter(s => s !== tvSide);
    const cornerRot = { NW: 0, NE: 270, SE: 180, SW: 90 };
    const used = {};
    for (const [A, B] of [["N", "W"], ["N", "E"], ["S", "E"], ["S", "W"]]) {
      if (!seatSides.includes(A) || !seatSides.includes(B)) continue;
      const box = [B === "W" ? 0 : ctx.W - S, A === "S" ? 0 : ctx.H - S, B === "W" ? S : ctx.W, A === "S" ? S : ctx.H];
      if (box[0] < -EPS || box[1] < -EPS || box[2] > ctx.W + EPS || box[3] > ctx.H + EPS) continue;
      if (!fits(ctx, box, null, false)) continue;
      put(ctx, mkPiece("FLOOR_SEAT_CORNER", cornerRot[A + B], 1, box, []));
      used[A + ":" + cornerEnd(ctx, A, B)] = true; used[B + ":" + cornerEnd(ctx, B, A)] = true;
    }
    let seats = 0;
    for (const side of seatSides) {
      if (depthLen(ctx, side) < S - EPS) continue;
      const L = wallLen(ctx, side);
      for (const [i0, i1] of freeIntervals(ctx, side, 0, S, false)) {
        const n = Math.floor((i1 - i0 + EPS) / S);
        if (n < 1) continue;
        let a0;
        if (used[side + ":0"] && Math.abs(i0 - S) < EPS) a0 = i0;
        else if (used[side + ":" + L] && Math.abs(i1 - (L - S)) < EPS) a0 = i1 - n * S;
        else a0 = i0 + ((i1 - i0) - n * S) / 2;
        for (let k = 0; k < n; k++) put(ctx, mkPiece("FLOOR_SEAT", SIDE_ROT[side], 1, wallBox(ctx, side, a0 + k * S, S, 0, S), []));
        seats += n;
      }
    }
    seats += Object.keys(used).length / 2;
    if (seats >= 2) gain(res, 40, true, 2 * seats); else miss(res, 40, "floor seats", true);
    // tray table(s), kept 30 cm from every cushion
    const nT = Math.max(ctx.W, ctx.H) >= 560 ? 2 : 1;
    const ring = 30;
    for (let i = 0; i < nT; i++) {
      const prev = ctx.placed.filter(p => p.name === "FLOOR_TABLE").map(p => p.box);
      const r = freeBest(ctx, "FLOOR_TABLE", [0], ring, box => {
        const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
        const tx = nT === 2 ? (ctx.W >= ctx.H ? ctx.W * (i ? 0.7 : 0.3) : ctx.W / 2) : ctx.W / 2;
        const ty = nT === 2 ? (ctx.W >= ctx.H ? ctx.H / 2 : ctx.H * (i ? 0.7 : 0.3)) : ctx.H / 2;
        let s = -Math.hypot(cx - tx, cy - ty) * 0.1;
        for (const q of prev) s += Math.min(0, Math.hypot(cx - (q[0] + q[2]) / 2, cy - (q[1] + q[3]) / 2) - 200) * 0.2;
        return s;
      });
      if (r) {
        r.piece.clears = [];                       // only cushions keep their distance; walking round it is fine
        put(ctx, r.piece); i === 0 ? gain(res, 20, true) : gain(res, 8, false);
      } else i === 0 ? miss(res, 20, "tray table", true) : miss(res, 8, "second tray table", false);
    }
    return res;
  }
  // reception: sofas round the walls, a table in the middle
  function sofasRound(ctx) {
    const opts = topK(sofaOptions(ctx, ["SOFA_3"]), 4).concat(topK(sofaOptions(ctx, ["SOFA_2"]), 2));
    if (!opts.length) { const res = newRes(); miss(res, 40, "sofa", true); miss(res, 20, "coffee table", true); return res; }
    return bestOf(ctx, opts, op => {
      const res = newRes();
      put(ctx, mkPiece(op.name, SIDE_ROT[op.side], 1, op.box, [op.clear]));
      gain(res, 40, true, op.score + (op.name === "SOFA_3" ? 30 : 20));
      // the other walls: opposite first, then the two sides
      for (const side of [OPP[op.side], LEFT_OF[op.side], RIGHT_OF[op.side]]) {
        let got = null;
        for (const [name, seats] of [["SOFA_3", 3], ["SOFA_2", 2], ["ARMCHAIR", 1]]) {
          const b = BLOCKS[name];
          const r = wallBest(ctx, { name, front: 40, sides: [side], centres: true,
            score: (s, a) => -0.03 * Math.abs(a + b.w / 2 - wallLen(ctx, s) / 2) });
          if (r && (!got || seats * 10 + r.score > got.v)) got = { r, v: seats * 10 + r.score, seats };
          if (got && got.seats === seats) break;   // biggest that fits wins
        }
        if (got) { put(ctx, got.r.piece); gain(res, 10 * got.seats, false); } else miss(res, 20, "sofa", false);
      }
      // coffee table at the middle of the seating, along the main sofa
      const rot = SIDE_ROT[op.side] % 180;
      let t = null;
      for (const name of ["CENTRE_TABLE", "COFFEE_TABLE"]) {   // the big table only where there is room round it
        t = freeBest(ctx, name, [rot], 0, box => roominess(ctx, box, 80) - 0.02 * Math.hypot((box[0] + box[2] - ctx.W) / 2, (box[1] + box[3] - ctx.H) / 2));
        if (t && (name === "COFFEE_TABLE" || roominess(ctx, t.box, 80) >= 50)) break;
        t = null;
      }
      if (t) { put(ctx, t.piece); gain(res, 20, true); } else miss(res, 20, "coffee table", true);
      return res;
    });
  }
  function dining(ctx, names, ring, coreW, label) {
    let r = null;
    for (const name of names) {
      r = freeBest(ctx, name, [0, 90], ring, box => roominess(ctx, box, 100) * 0.5 - 0.01 * Math.hypot((box[0] + box[2] - ctx.W) / 2, (box[1] + box[3] - ctx.H) / 2));
      if (r) break;
    }
    return r;
  }
  function sofasDining(ctx) {
    // dining set at one end (beam over its spots), sofa group in what is left
    const opts = [];
    for (const name of ["DINING_6", "DINING_4"]) {
      const b = BLOCKS[name];
      for (const rot of [0, 90]) {
        const w = rot ? b.h : b.w, h = rot ? b.w : b.h, ring = 40;
        const along = ctx.W >= ctx.H;
        const spots = along
          ? [[ring, (ctx.H - h) / 2], [ctx.W - w - ring, (ctx.H - h) / 2]]
          : [[(ctx.W - w) / 2, ring], [(ctx.W - w) / 2, ctx.H - h - ring]];
        for (const [x, y] of spots) {
          const box = [x, y, x + w, y + h], cl = [x - ring, y - ring, x + w + ring, y + h + ring];
          if (!fits(ctx, box, [cl], false)) continue;
          opts.push({ name, rot, box, cl, score: (name === "DINING_6" ? 8 : 0) + roominess(ctx, box, 100) * 0.05 });
        }
      }
    }
    if (!opts.length) {
      const res = sofaSet(ctx, { tv: false, chairs: 2 });
      miss(res, 30, "dining table", true); return res;
    }
    return bestOf(ctx, topK(opts, 4), op => {
      const res = newRes();
      put(ctx, mkPiece(op.name, op.rot, 1, op.box, [op.cl])); gain(res, 30, true, op.score);
      return merge(res, sofaSet(ctx, { tv: false, chairs: 2 }));
    });
  }

  // =========================================================================
  // 6. kitchen
  // =========================================================================
  const KD = 60, AISLE = 90, MAX_ONE = 480, MAX_ARM = 360;
  function kitchenRuns(ctx, shape) {
    const iv = {}, okD = {};
    for (const s of SIDES4) { iv[s] = freeIntervals(ctx, s, 0, KD, false); okD[s] = depthLen(ctx, s) >= KD + AISLE - EPS; }
    const ivAt = (s, e) => iv[s].find(v => (e === 0 ? v[0] < EPS : v[1] > wallLen(ctx, s) - EPS));
    const endKind = (s, v) => (v < EPS || v > wallLen(ctx, s) - EPS ? "wall" : "open");
    function anchored(s, e, v, M, skip, ct) {
      const L = wallLen(ctx, s);
      if (e === 0) {
        const a0 = skip, a1 = Math.min(v[1], M);
        return a1 - a0 < 30 - EPS ? null : { side: s, a0, a1, lo: ct, hi: endKind(s, a1) };
      }
      const a1 = L - skip, a0 = Math.max(v[0], L - M);
      return a1 - a0 < 30 - EPS ? null : { side: s, a0, a1, lo: endKind(s, a0), hi: ct };
    }
    const out = [];
    if (shape === "one") {
      for (const s of SIDES4) if (okD[s]) for (const v of iv[s]) {
        const len = v[1] - v[0];
        if (len < 120 - EPS) continue;
        if (len <= MAX_ONE + EPS) out.push([{ side: s, a0: v[0], a1: v[1], lo: endKind(s, v[0]), hi: endKind(s, v[1]) }]);
        else {
          out.push([{ side: s, a0: v[0], a1: v[0] + MAX_ONE, lo: endKind(s, v[0]), hi: "open" }]);
          out.push([{ side: s, a0: v[1] - MAX_ONE, a1: v[1], lo: "open", hi: endKind(s, v[1]) }]);
        }
      }
    } else if (shape === "L") {
      for (const A of SIDES4) {
        const B = LEFT_OF[A];
        if (!okD[A] || !okD[B]) continue;
        const eA = cornerEnd(ctx, A, B), eB = cornerEnd(ctx, B, A), vA = ivAt(A, eA), vB = ivAt(B, eB);
        if (!vA || !vB) continue;
        const own = Math.min(vA[1] - vA[0], MAX_ARM) >= Math.min(vB[1] - vB[0], MAX_ARM) ? A : B;
        const rA = anchored(A, eA, vA, MAX_ARM, own === A ? 0 : KD, own === A ? "corner" : "join");
        const rB = anchored(B, eB, vB, MAX_ARM, own === B ? 0 : KD, own === B ? "corner" : "join");
        if (rA && rB) out.push([rA, rB]);
      }
    } else if (shape === "U") {
      for (const C of SIDES4) {
        const A = LEFT_OF[C], B = RIGHT_OF[C], LC = wallLen(ctx, C);
        if (!okD[A] || !okD[B] || !okD[C]) continue;
        if (!iv[C].some(v => v[0] < EPS && v[1] > LC - EPS)) continue;
        const eA = cornerEnd(ctx, A, C), eB = cornerEnd(ctx, B, C), vA = ivAt(A, eA), vB = ivAt(B, eB);
        if (!vA || !vB) continue;
        const rA = anchored(A, eA, vA, MAX_ARM, KD, "join"), rB = anchored(B, eB, vB, MAX_ARM, KD, "join");
        if (rA && rB && LC >= 2 * KD + 30 - EPS) out.push([{ side: C, a0: 0, a1: LC, lo: "corner", hi: "corner" }, rA, rB]);
      }
    }
    return out;
  }
  // 1-D check of one run: spans may not overlap; gaps between pieces 0 or >= 30
  // (filled with cupboards); a short gap is only allowed at a wall or open end
  function gapsOk(r, spans) {
    let cur = r.a0, pen = 0;
    for (let i = 0; i <= spans.length; i++) {
      const nxt = i < spans.length ? spans[i].a : r.a1, g = nxt - cur;
      if (g < -EPS) return -1;
      if (g > EPS && g < 30 - EPS) {
        const end = i === 0 ? r.lo : i === spans.length ? r.hi : null;
        if (end !== "wall" && end !== "open") return -1;
        pen += end === "wall" ? 6 : 1;
      }
      if (i < spans.length) cur = spans[i].a + spans[i].len;
    }
    return pen;
  }
  function insertSorted(arr, s) { const out = arr.slice(); let i = 0; while (i < out.length && out[i].a < s.a) i++; out.splice(i, 0, s); return out; }
  function fillGap(g) {
    const out = []; let rem = g;
    while (rem >= 30 - EPS) {
      let m = KIT_MODS.find(m => m <= rem + EPS && (Math.abs(rem - m) < EPS || rem - m >= 30 - EPS));
      if (!m) m = KIT_MODS.find(m => m <= rem + EPS);
      out.push(m); rem -= m;
    }
    return out;
  }
  function kitchenPlan(ctx, runs) {
    const R = runs.map(r => Object.assign({}, r, { box: wallBox(ctx, r.side, r.a0, r.a1 - r.a0, 0, KD) }));
    for (const r of R) {
      r.f0 = r.a0 + (r.lo === "corner" ? KD : 0); r.f1 = r.a1 - (r.hi === "corner" ? KD : 0);
      r.aisle = r.f1 > r.f0 + EPS ? wallBox(ctx, r.side, r.f0, r.f1 - r.f0, KD, AISLE) : null;
      r.spans = [];
      if (r.lo === "corner") r.spans.push({ a: r.a0, len: KD, name: "KIT_BASE_60" });
      if (r.hi === "corner") r.spans.push({ a: r.a1 - KD, len: KD, name: "KIT_BASE_60" });
    }
    for (const r of R) {
      if (r.aisle && (!inRoom(ctx, r.aisle) || hitsParts(ctx, r.aisle))) return null;
      if (hitsPlaced(ctx, r.box)) return null;
      for (const q of R) if (q !== r && r.aisle && ov(r.aisle, q.box)) return null;
    }
    // fridge at a wall / open end of a run
    const fr = [];
    R.forEach((r, ri) => {
      for (const end of ["lo", "hi"]) {
        if (r[end] !== "wall" && r[end] !== "open") continue;
        const a = end === "lo" ? r.a0 : r.a1 - 70;
        if (a < r.f0 - EPS || a + 70 > r.f1 + EPS) continue;
        const box = wallBox(ctx, r.side, a, 70, 0, 70);
        if (!fits(ctx, box, null, true)) continue;
        if (R.some(q => q !== r && (ov(box, q.box) || (q.aisle && ov(box, q.aisle))))) continue;
        let s = r[end] === "wall" ? 6 : 2;
        if (ctx.doors.some(d => d.side === r.side && Math.min(Math.abs(d.s1 - a), Math.abs(d.s0 - a - 70)) < 1)) s += 3;
        fr.push({ ri, a, len: 70, name: "FRIDGE", box, score: s });
      }
    });
    const frOpts = topK(fr, 3); frOpts.push(null);
    let best = null;
    for (const f of frOpts) {
      const base = R.map((r, ri) => (f && f.ri === ri ? insertSorted(r.spans, f) : r.spans));
      if (base.some((sp, ri) => gapsOk(R[ri], sp) < 0)) continue;
      // sink: under a window when one is over a run, else near a corner / the middle
      const sk = [];
      R.forEach((r, ri) => {
        const lo = r.f0, hi = r.f1 - 120;
        if (hi < lo - EPS) return;
        const cand = [];
        for (const w of ctx.wins) if (w.side === r.side) {
          const c = snap5((w.s0 + w.s1) / 2 - 60);   // centred under the window, then nudged
          for (let k = 0; k <= 60; k += 5) cand.push(c - k, c + k);
        }
        cand.push(lo, hi, snap5((lo + hi) / 2));
        for (const a of uniq(cand)) {
          if (a < lo - EPS || a > hi + EPS) continue;
          const sp = insertSorted(base[ri], { a, len: 120, name: "KIT_SINK" });
          const pen = gapsOk(r, sp);
          if (pen < 0) continue;
          let s = -pen, wb = 0;
          for (const w of ctx.wins) if (w.side === r.side) {
            const o = spanOv(w.s0, w.s1, a, a + 120);
            if (o > 0) wb = Math.max(wb, 30 * o / Math.min(120, w.s1 - w.s0) - 0.05 * Math.abs(a + 60 - (w.s0 + w.s1) / 2));
          }
          sk.push({ ri, a, len: 120, name: "KIT_SINK", score: s + wb });
        }
      });
      for (const s of topK(sk, 3).concat([null])) {
        const withS = base.map((sp, ri) => (s && s.ri === ri ? insertSorted(sp, s) : sp));
        // cooker
        let bc = null;
        R.forEach((r, ri) => {
          const cand = [r.f0, r.f1 - 60];
          for (let k = 1; k <= 4; k++) cand.push(r.f0 + 30 * k, r.f1 - 60 - 30 * k);
          for (const p of withS[ri]) for (const g of [0, 30, 60, 90, 120]) cand.push(p.a + p.len + g, p.a - 60 - g);
          for (const a of uniq(cand)) {
            if (a < r.f0 - EPS || a + 60 > r.f1 + EPS) continue;
            const sp = insertSorted(withS[ri], { a, len: 60, name: "KIT_COOKER" });
            const pen = gapsOk(r, sp);
            if (pen < 0) continue;
            let sc = -pen;
            if (winOver(ctx, r.side, a, a + 60) > 0) sc -= 30;
            if (s) {
              if (s.ri === ri) { const g = Math.max(s.a - (a + 60), a - (s.a + 120)); sc += g < 30 ? -12 : g <= 150 ? 10 : Math.max(0, 10 - 0.03 * (g - 150)); }
              else sc += 4;
            }
            if (f && f.ri === ri && Math.max(f.a - (a + 60), a - (f.a + 70)) < 30) sc -= 12;
            if ((r.lo === "wall" || r.lo === "open") && a - r.a0 < 30 - EPS) sc -= 8;
            if ((r.hi === "wall" || r.hi === "open") && r.a1 - (a + 60) < 30 - EPS) sc -= 8;
            if (!bc || sc > bc.score + 1e-9) bc = { ri, a, len: 60, name: "KIT_COOKER", score: sc };
          }
        });
        const spans = withS.map((sp, ri) => (bc && bc.ri === ri ? insertSorted(sp, bc) : sp));
        let total = (f ? 40 + f.score : 0) + (s ? 60 + s.score : 0) + (bc ? 60 + bc.score : 0);
        let work = 0;
        R.forEach((r, ri) => { work += (r.a1 - r.a0) - spans[ri].reduce((t, p) => t + p.len, 0); });
        total += Math.min(12, 0.04 * work);
        if (!best || total > best.total + 1e-9) best = { total, spans, f, s, c: bc };
      }
    }
    if (!best) return null;
    // pieces: appliances + cupboards filling every gap
    const pieces = [];
    R.forEach((r, ri) => {
      const rot = SIDE_ROT[r.side], sp = best.spans[ri], add = (name, a, len, sx) =>
        pieces.push(mkPiece(name, rot, sx || 1, wallBox(ctx, r.side, a, len, 0, BLOCKS[name].h), []));
      const fill = (g0, g1, fromHigh) => {
        const mods = fillGap(g1 - g0);
        let a = fromHigh ? g1 : g0;
        for (const m of mods) { if (fromHigh) { a -= m; add("KIT_BASE_" + m, a, m); } else { add("KIT_BASE_" + m, a, m); a += m; } }
      };
      let cur = r.a0;
      for (let i = 0; i <= sp.length; i++) {
        const nxt = i < sp.length ? sp[i].a : r.a1;
        if (nxt - cur >= 30 - EPS) {
          // a short left-over stays at a wall / open end, never at a corner join
          const loLoose = r.lo === "wall" || r.lo === "open";
          const fromHigh = (i === 0 && sp.length > 0 && loLoose) ||
                           (sp.length === 0 && loLoose && (r.hi === "join" || r.hi === "corner"));
          fill(cur, nxt, fromHigh);
        }
        if (i < sp.length) {
          const p = sp[i];
          let sx = 1;
          if (p.name === "KIT_SINK") {           // bowl towards the cooker, else towards the run's corner
            const c = best.c && best.c.ri === ri ? best.c.a : (r.lo === "corner" || r.lo === "join" ? -1e9 : 1e9);
            sx = c > p.a ? sxRightHigh(r.side) : -sxRightHigh(r.side);
          }
          add(p.name, p.a, p.len, sx);
          cur = p.a + p.len;
        }
      }
      // the run's working space in front, kept by its first piece
      const first = pieces.find(q => r.box && ov(q.box, r.box));
      if (first && r.aisle) first.clears.push(r.aisle);
    });
    return { pieces, total: best.total, has: { sink: !!best.s, cooker: !!best.c, fridge: !!best.f } };
  }
  function kitchen(ctx, shapes, withTable) {
    let plans = [];
    for (const sh of shapes) {
      for (const runs of kitchenRuns(ctx, sh)) { const k = kitchenPlan(ctx, runs); if (k) { k.shape = sh; plans.push(k); } }
      if (plans.length && !withTable) break;      // the asked-for shape fits; a fallback shape is only for when it does not
    }
    plans = plans.map(p => Object.assign(p, { score: p.total })).filter(Boolean);
    if (!plans.length) {
      const res = newRes();
      miss(res, 60, "sink", true); miss(res, 60, "cooker", true);
      const f = nearCounterFridge(ctx);
      if (f) { put(ctx, f.piece); gain(res, 40, true); } else miss(res, 40, "fridge", true);
      if (withTable) table(res);
      return res;
    }
    function table(res) {
      const r = dining(ctx, ["DINING_6", "DINING_4"].filter(n => n === "DINING_4" || ctx.W * ctx.H >= 160000), 40);
      if (r) { put(ctx, r.piece); gain(res, 30, true, 0.05 * roominess(ctx, r.box, 100)); } else miss(res, 30, "dining table", true);
    }
    return bestOf(ctx, topK(plans, withTable ? 6 : 1), k => {
      const res = newRes();
      k.pieces.forEach(p => put(ctx, p));
      const fallback = !withTable && k.shape !== shapes[0];
      res.score += k.total - (fallback ? 20 : 0);
      for (const [key, w, label] of [["sink", 60, "sink"], ["cooker", 60, "cooker"], ["fridge", 40, "fridge"]]) {
        if (k.has[key]) { res.core += w; res.got += w; } else if (key !== "fridge") miss(res, w, label, true);
      }
      if (fallback) res.skipped.push(shapes[0] + "-shaped counter");
      if (withTable) table(res);                   // the table first: a loose fridge fits in far more places
      if (!k.has.fridge) {                         // no free run end: a fridge on its own against a wall, near the counter
        const f = nearCounterFridge(ctx);
        if (f) { put(ctx, f.piece); gain(res, 40, true, -25); } else miss(res, 40, "fridge", true);
      }
      return res;
    });
  }

  // =========================================================================
  // 7. bathroom, WC, open area, hall
  // =========================================================================
  function wcSpec(name) {
    const east = name === "WC_EASTERN";
    return { name, off: east ? 15 : 0, front: east ? 50 : 60, sideCl: east ? 15 : 20 };
  }
  function doorFacing(ctx, side, a0, a1) { return ctx.doors.some(d => d.side === OPP[side] && spanOv(d.s0, d.s1, a0, a1) > 0); }
  function doorDist(ctx, box) {
    let d = 1e9;
    for (const z of ctx.doors) d = Math.min(d, Math.hypot((box[0] + box[2] - z.zone[0] - z.zone[2]) / 2, (box[1] + box[3] - z.zone[1] - z.zone[3]) / 2));
    return d > 1e8 ? 0 : d;
  }
  function placeWC(ctx, res, name, core) {
    const sp = wcSpec(name), b = BLOCKS[name];
    const r = wallBest(ctx, Object.assign({ score: (side, a, box) =>
      0.03 * doorDist(ctx, box) - (doorFacing(ctx, side, a, a + b.w) ? 10 : 0) + (hitsNear(ctx, box, 40) ? 4 : 0) }, sp));
    if (r) { put(ctx, r.piece); gain(res, 50, core, r.score); } else miss(res, 50, name === "WC" ? "WC" : "eastern WC", core);
    return r;
  }
  function hitsNear(ctx, box, d) { const g = [box[0] - d, box[1] - d, box[2] + d, box[3] + d]; return hitsParts(ctx, g); }
  function placeBasin(ctx, res, name, core) {
    const small = name === "HAND_BASIN";
    const r = wallBest(ctx, { name, front: small ? 50 : 60, sideCl: small ? 5 : 10, score: (side, a, box) => -0.02 * doorDist(ctx, box) });
    if (r) { put(ctx, r.piece); gain(res, small ? 25 : 30, core, r.score); } else miss(res, small ? 25 : 30, small ? "hand basin" : "basin", core);
  }
  function wetOptions(ctx, anchor) {
    const out = [];
    if (anchor === "shower") {
      for (const name of ["SHOWER_90", "SHOWER_80"]) {
        const S = BLOCKS[name].w;
        for (const [cx, cy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
          const x = cx ? ctx.W - S : 0, y = cy ? ctx.H - S : 0, box = [x, y, x + S, y + S];
          // step-out space in front of one open side
          for (const st of [cx ? [x - 60, y, x, y + S] : [x + S, y, x + S + 60, y + S], cy ? [x, y - 60, x + S, y] : [x, y + S, x + S, y + S + 60]]) {
            if (!fits(ctx, box, [st], false)) continue;
            out.push({ pieces: [mkPiece(name, 0, 1, box, [st])], score: 0.03 * doorDist(ctx, box) + (name === "SHOWER_90" ? 6 : 0), label: "shower" });
          }
        }
        if (out.length) break;
      }
    } else {
      const b = BLOCKS.BATHTUB;
      for (const side of SIDES4) {
        const L = wallLen(ctx, side);
        if (b.w > L + EPS) continue;
        for (const a of [0, L - b.w]) {
          const box = wallBox(ctx, side, a, b.w, 0, b.h), cl = wallBox(ctx, side, a, b.w, b.h, 60);
          if (!fits(ctx, box, [cl], false)) continue;
          let s = (L - b.w <= 15 + EPS ? 15 : 0) + 0.02 * doorDist(ctx, box);
          const sx = a < EPS ? -sxRightHigh(side) : sxRightHigh(side);       // taps at the wall end
          out.push({ pieces: [mkPiece("BATHTUB", SIDE_ROT[side], sx, box, [cl])], score: s, label: "bathtub" });
        }
      }
    }
    return out;
  }
  function bathroom(ctx, anchor, wcName) {
    const opts = topK(wetOptions(ctx, anchor), 6);
    const rest = res => { placeWC(ctx, res, wcName, true); placeBasin(ctx, res, "BASIN", true); return res; };
    if (!opts.length) { const res = newRes(); miss(res, 50, anchor === "shower" ? "shower" : "bathtub", true); return rest(res); }
    return bestOf(ctx, opts, o => {
      const res = newRes();
      o.pieces.forEach(p => put(ctx, p)); gain(res, 50, true, o.score);
      return rest(res);
    });
  }
  function wcRoom(ctx, wcName) {
    // beam over the WC spots, then the hand basin
    const sp = wcSpec(wcName), b = BLOCKS[wcName], opts = [];
    for (const side of SIDES4) {
      const L = wallLen(ctx, side);
      if (b.w + 2 * sp.sideCl > L + EPS || sp.off + b.h + sp.front > depthLen(ctx, side) + EPS) continue;
      for (const a of alongCands(ctx, side, b.w, sp.off, b.h + sp.front, sp.sideCl, false, null, true)) {
        const box = wallBox(ctx, side, a, b.w, sp.off, b.h), cl = wallBox(ctx, side, a - sp.sideCl, b.w + 2 * sp.sideCl, sp.off, b.h + sp.front);
        if (!fits(ctx, box, [cl], false)) continue;
        opts.push({ pc: mkPiece(wcName, SIDE_ROT[side], 1, box, [cl]), score: 0.03 * doorDist(ctx, box) - (doorFacing(ctx, side, a, a + b.w) ? 10 : 0) });
      }
    }
    if (!opts.length) { const res = newRes(); miss(res, 50, wcName === "WC" ? "WC" : "eastern WC", true); placeBasin(ctx, res, "HAND_BASIN", true); return res; }
    return bestOf(ctx, topK(opts, 6), o => {
      const res = newRes();
      put(ctx, o.pc); gain(res, 50, true, o.score);
      placeBasin(ctx, res, "HAND_BASIN", true);
      return res;
    });
  }
  function trees(ctx) {
    const res = newRes();
    const n = Math.max(ctx.W, ctx.H) >= 400 && ctx.W * ctx.H >= 60000 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const prev = ctx.placed.map(p => p.box);
      let r = null;
      for (const name of ["TREE", "PLANTER"]) {
        r = freeBest(ctx, name, [0], 0, box => {
          const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
          let s = 0;
          const corner = (box[0] < EPS || box[2] > ctx.W - EPS) && (box[1] < EPS || box[3] > ctx.H - EPS);
          const edge = box[0] < EPS || box[2] > ctx.W - EPS || box[1] < EPS || box[3] > ctx.H - EPS;
          if (corner) s += 20; else if (edge) s += 8;
          for (const z of ctx.winZ) if (ov(box, z)) s -= 8;
          s += 0.02 * Math.min(300, doorDist(ctx, box));
          for (const q of prev) s += 0.05 * Math.min(600, Math.hypot(cx - (q[0] + q[2]) / 2, cy - (q[1] + q[3]) / 2));
          return s;
        });
        if (r) break;
      }
      if (r) { put(ctx, r.piece); gain(res, 10, false); } else miss(res, 10, "tree", false);
    }
    return res;
  }
  function hallPiece(ctx, name) {
    const res = newRes();
    const r = wallBest(ctx, { name, front: 50, centres: true, score: (side, a) =>
      name === "SHOE_CABINET" ? (touchesDoorZone(ctx, side, a, 100) ? 10 : 0) + (atCorner(ctx, side, a, 100) ? 3 : 0)
        : 0.02 * wallLen(ctx, side) - 0.03 * Math.abs(a + 50 - wallLen(ctx, side) / 2) });
    const label = name === "SHOE_CABINET" ? "shoe cabinet" : "console table";
    if (r) { put(ctx, r.piece); gain(res, 20, true, r.score); } else miss(res, 20, label, true);
    return res;
  }

  // =========================================================================
  // 8. variants and the public API
  // =========================================================================
  const AUTO = { key: "auto", label: "Automatic" };
  const VARIANTS = {
    bedroom:   [AUTO, { key: "double", label: "Double bed" }, { key: "king", label: "King bed" },
                { key: "twin", label: "Two single beds" }, { key: "single-desk", label: "Single bed + desk" }],
    living:    [AUTO, { key: "sofas", label: "Sofa set" }, { key: "l-sofa", label: "L-shaped sofa" },
                { key: "floor", label: "Floor seating" }],
    reception: [AUTO, { key: "sofas-round", label: "Sofas round a table" }, { key: "floor", label: "Floor seating" },
                { key: "sofas-dining", label: "Sofas + dining table" }],
    kitchen:   [AUTO, { key: "l-counter", label: "L-shaped counter" }, { key: "one-wall", label: "One-wall counter" },
                { key: "u-counter", label: "U-shaped counter" }, { key: "counter-dining", label: "Counter + dining table" }],
    bath:      [AUTO, { key: "shower-wc", label: "Shower + WC" }, { key: "tub-wc", label: "Bathtub + WC" },
                { key: "shower-eastern", label: "Shower + eastern WC" }],
    wc:        [AUTO, { key: "western", label: "Western WC" }, { key: "eastern", label: "Eastern WC" }],
    open:      [AUTO, { key: "trees", label: "Trees" }, { key: "empty", label: "Empty" }],
    hall:      [AUTO, { key: "empty", label: "Empty" }, { key: "shoes", label: "Shoe cabinet" },
                { key: "console", label: "Console table" }],
  };
  function variants(type) { return (VARIANTS[type] || [AUTO]).map(v => ({ key: v.key, label: v.label })); }

  function runVariant(type, key, ctx) {
    switch (type + ":" + key) {
      case "bedroom:double":      return bedroom(ctx, { bed: "BED_DOUBLE", dresser: true, desk: "extra" });
      case "bedroom:king":        return bedroom(ctx, { bed: "BED_KING", dresser: true, desk: "extra" });
      case "bedroom:twin":        return bedroom(ctx, { bed: "BED_SINGLE", twin: true, desk: "extra" });
      case "bedroom:single-desk": return bedroom(ctx, { bed: "BED_SINGLE", single: true, desk: "core", dresser: true });
      case "living:sofas":        return sofaSet(ctx, { tv: true, chairs: 2 });
      case "living:l-sofa":       return lSofaSet(ctx, { tv: true });
      case "living:floor":        return floorSeating(ctx, { tv: true });
      case "reception:sofas-round": return sofasRound(ctx);
      case "reception:floor":     return floorSeating(ctx, { tv: false });
      case "reception:sofas-dining": return sofasDining(ctx);
      case "kitchen:l-counter":   return kitchen(ctx, ["L", "one"], false);
      case "kitchen:one-wall":    return kitchen(ctx, ["one"], false);
      case "kitchen:u-counter":   return kitchen(ctx, ["U", "L", "one"], false);
      case "kitchen:counter-dining": return kitchen(ctx, ["L", "one"], true);
      case "bath:shower-wc":      return bathroom(ctx, "shower", "WC");
      case "bath:tub-wc":         return bathroom(ctx, "tub", "WC");
      case "bath:shower-eastern": return bathroom(ctx, "shower", "WC_EASTERN");
      case "wc:western":          return wcRoom(ctx, "WC");
      case "wc:eastern":          return wcRoom(ctx, "WC_EASTERN");
      case "open:trees":          return trees(ctx);
      case "hall:shoes":          return hallPiece(ctx, "SHOE_CABINET");
      case "hall:console":        return hallPiece(ctx, "CONSOLE");
      default:                    return newRes();      // 'empty' variants
    }
  }
  // what Automatic tries, best first; the first one that places everything it needs wins
  function autoOrder(type, W, H) {
    const mn = Math.min(W, H), area = W * H;
    switch (type) {
      case "bedroom":   return mn >= 370 && area >= 150000 ? ["king", "double", "single-desk"]
                          : mn >= 280 ? ["double", "single-desk", "king"] : ["single-desk", "double"];
      case "living":    return ["sofas", "l-sofa", "floor"];
      case "reception": return ["sofas-round", "floor"];
      case "kitchen":   return area >= 110000 && mn >= 280 ? ["counter-dining", "l-counter", "u-counter", "one-wall"]
                          : mn >= 210 ? ["l-counter", "u-counter", "one-wall"] : ["one-wall", "l-counter"];
      case "bath":      return mn >= 170 && area >= 50000 ? ["tub-wc", "shower-wc", "shower-eastern"] : ["shower-wc", "shower-eastern", "tub-wc"];
      case "wc":        return ["western", "eastern"];
      case "open":      return ["trees"];
      case "hall":      return ["shoes", "empty"];
      default:          return [];
    }
  }

  function toLocal(room, o) {
    if (!o || !SIDES4.includes(o.side) || (o.kind !== "door" && o.kind !== "window")) return null;
    const base = ALONG_X[o.side] ? room.x : room.y;
    let s0, s1;
    if (isFinite(o.s0) && isFinite(o.s1)) { s0 = o.s0 - base; s1 = o.s1 - base; }
    else if (isFinite(o.at) && isFinite(o.w)) { s0 = o.at; s1 = o.at + o.w; }    // a plan opening (at from the side start)
    else return null;
    const swingInto = o.swingInto != null ? !!o.swingInto : (o.kind === "door" && o.swing !== "out");
    return { kind: o.kind, side: o.side, s0, s1, swingInto: o.kind === "door" && swingInto };
  }

  const cache = new Map();
  const CACHE_MAX = 4000;
  let cacheOn = true;

  function layoutLocal(type, idx, W, H, ops) {
    const vars = VARIANTS[type];
    const finish = (key, ctx, res) => ({
      key, used: vars.findIndex(v => v.key === key), label: (vars.find(v => v.key === key) || AUTO).label,
      inserts: ctx.placed.map(p => p.ins), dropped: res.dropped.slice(), skipped: res.skipped.slice(),
    });
    if (idx > 0) {
      const ctx = makeCtx(W, H, ops), key = vars[idx].key;
      return finish(key, ctx, runVariant(type, key, ctx));
    }
    let best = null;
    for (const key of autoOrder(type, W, H)) {
      const ctx = makeCtx(W, H, ops), res = runVariant(type, key, ctx);
      if (!best || done(res) > done(best.res) + 1e-9) best = { key, ctx, res };
      if (done(res) >= 1 - 1e-9) break;
    }
    if (!best) return { key: "auto", used: 0, label: AUTO.label, inserts: [], dropped: [], skipped: [] };
    return finish(best.key, best.ctx, best.res);
  }

  function layout(room, roomOpenings, furn, opts) {
    const type = room && room.type, vars = VARIANTS[type];
    if (!vars || !(room.w > 0) || !(room.h > 0)) return { inserts: [], used: 0, key: "auto", label: AUTO.label, dropped: [], skipped: [] };
    let idx = furn | 0;
    if (idx < 0 || idx >= vars.length) idx = 0;
    const ops = (roomOpenings || []).map(o => toLocal(room, o)).filter(Boolean);
    const useCache = cacheOn && !(opts && opts.cache === false);
    let L = null, key = null;
    if (useCache) {
      key = type + "|" + room.w + "|" + room.h + "|" + idx + "|" +
        ops.map(o => o.kind[0] + o.side + o.s0 + "," + o.s1 + (o.swingInto ? "i" : "")).join(";");
      L = cache.get(key);
    }
    if (!L) {
      L = layoutLocal(type, idx, room.w, room.h, ops);
      if (useCache) { if (cache.size >= CACHE_MAX) cache.clear(); cache.set(key, L); }
    }
    return {
      inserts: L.inserts.map(i => ({ block: i.block, x: i.x + room.x, y: i.y + room.y, rot: i.rot, sx: i.sx })),
      used: L.used, key: L.key, label: L.label, dropped: L.dropped.slice(), skipped: L.skipped.slice(),
    };
  }

  HP.furniture = {
    BLOCKS, variants, layout,
    // extras (not in the contract): the world box / footprint of an insert, the INSERT transform,
    // and the rule constants, for the tests, the dev sheet and anyone hit-testing furniture
    blockBox, blockParts, transform: xf,
    RULES: { DOOR_CLEAR, WIN_DEPTH },
    clearCache: () => cache.clear(),
    setCache: on => { cacheOn = !!on; },
  };
})(globalThis.HP = globalThis.HP || {});

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.HP;
