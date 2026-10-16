"use strict";
/* ============================================================================
   House Planner - dev/canvas-stub.js  (canvas agent, DEV ONLY - never in src/)
   ----------------------------------------------------------------------------
   Stand-ins for modules the canvas needs that may not exist yet, so the board
   can be exercised. Each one is installed ONLY when the real module is
   missing: HP.model (rough, contract-shaped ops) and HP.furniture (a handful
   of blocks and a naive layout). They are NOT the real behaviour - they exist
   to drive the canvas: previews, ghosts, read-outs, commits.
============================================================================ */
(function (HP) {
  const STUBS = [];
  const res = (state, ok, reason, id, note) => ({ state, ok: ok !== false, reason: reason || "", id: id || null, note: note || "" });
  const snap = v => HP.snap(v);
  const an = p => (HP.store && HP.store.analysis ? HP.store.analysis(p) : HP.analyze(p));

  // ===================================================================== model
  if (!HP.model) {
    STUBS.push("model");
    const plotBox = pts => ({ x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) });
    function legal(plan, r, skip) {
      const ext = plan.walls.ext, int = plan.walls.int;
      if (r.w < 50 || r.h < 50) return false;
      if (!HP.rectInPoly(HP.grow(r, ext), plan.plot.pts)) return false;
      for (const q of plan.rooms) {
        if (skip.has(q.id)) continue;
        const gx = Math.max(q.x - (r.x + r.w), r.x - (q.x + q.w));
        const gy = Math.max(q.y - (r.y + r.h), r.y - (q.y + q.h));
        if (gx < int && gy < int) return false;
        // the no-artifacts gap rule (rough): a gap is int, or at least 2*ext + minGap
        if (gy < 0 && gx > int && gx < 2 * ext + HP.RULES.minGap) return false;
        if (gx < 0 && gy > int && gy < 2 * ext + HP.RULES.minGap) return false;
      }
      return true;
    }
    function nearestLegal(plan, r, skip, x, y, maxD) {
      const box = plotBox(plan.plot.pts), ext = plan.walls.ext;
      const cl = (v, a, b) => Math.max(a, Math.min(b, v));
      x = cl(x, box.x0 + ext, box.x1 - ext - r.w); y = cl(y, box.y0 + ext, box.y1 - ext - r.h);
      x = snap(x); y = snap(y);
      if (legal(plan, { x, y, w: r.w, h: r.h }, skip)) return [x, y];
      for (let d = 10; d <= (maxD || 250); d += 10) {
        let best = null, bd = Infinity;
        for (let i = -d; i <= d; i += 10) {
          for (const [dx, dy] of [[i, -d], [i, d], [-d, i], [d, i]]) {
            const c = { x: x + dx, y: y + dy, w: r.w, h: r.h };
            const dd = dx * dx + dy * dy;
            if (dd < bd && legal(plan, c, skip)) { bd = dd; best = [c.x, c.y]; }
          }
        }
        if (best) return best;
      }
      return null;
    }
    function snapTo(plan, r, x, y, dist) {
      const int = plan.walls.int, ext = plan.walls.ext, box = plotBox(plan.plot.pts);
      const cx = [box.x0 + ext, box.x1 - ext - r.w], cy = [box.y0 + ext, box.y1 - ext - r.h];
      for (const q of plan.rooms) {
        if (q.id === r.id) continue;
        cx.push(q.x + q.w + int, q.x - int - r.w, q.x, q.x + q.w - r.w);
        cy.push(q.y + q.h + int, q.y - int - r.h, q.y, q.y + q.h - r.h);
      }
      const near = (v, list) => { let b = v, bd = dist + 1e-9; for (const c of list) { const d = Math.abs(c - v); if (d <= bd) { bd = d; b = c; } } return b; };
      return [near(x, cx), near(y, cy)];
    }
    function moveRoom(plan, id, x, y, opts) {
      const r = plan.rooms.find(q => q.id === id);
      if (!r) return res(plan, false, "That room is gone.");
      const sn = opts && opts.snap != null ? opts.snap : 25;
      let [tx, ty] = sn > 0 ? snapTo(plan, r, x, y, sn) : [x, y];
      tx = snap(tx); ty = snap(ty);
      const spot = nearestLegal(plan, r, new Set([id]), tx, ty);
      if (!spot) return res(plan, false, "There is no free space for this room near here.");
      if (spot[0] === r.x && spot[1] === r.y) return res(plan, spot[0] === tx && spot[1] === ty, "It can't go there.");
      const p = HP.clone(plan), q = p.rooms.find(z => z.id === id);
      q.x = spot[0]; q.y = spot[1];
      const exact = spot[0] === tx && spot[1] === ty;
      return res(p, exact, exact ? "" : "It does not fit there - this is the nearest free spot.");
    }
    function swapRooms(plan, a, b) {
      const p = HP.clone(plan);
      const A = p.rooms.find(q => q.id === a), B = p.rooms.find(q => q.id === b);
      if (!A || !B) return res(plan, false, "That room is gone.");
      for (const k of ["x", "y", "w", "h"]) { const t = A[k]; A[k] = B[k]; B[k] = t; }
      for (const o of p.openings) {
        if (o.room === a) o.room = b; else if (o.room === b) o.room = a;
        if (o.kind === "window") {
          const T = HP.ROOM_TYPES[p.rooms.find(q => q.id === o.room).type];
          if (!T.win) o.dead = true; else o.w = Math.max(T.win[0], Math.min(T.win[1], o.w));
        }
      }
      p.openings = p.openings.filter(o => !o.dead);
      return res(p, true, "", null, "");
    }
    function applyWall(plan, h, members, d) {
      const p = HP.clone(plan);
      const moved = new Set();
      for (const m of members) {
        const r = p.rooms.find(q => q.id === m.room);
        if (!r) continue;
        moved.add(r.id);
        if (m.side === "E") r.w += d;
        else if (m.side === "N") r.h += d;
        else if (m.side === "W") { r.x += d; r.w -= d; p.openings.forEach(o => { if (o.room === r.id && (o.side === "N" || o.side === "S")) o.at = Math.max(0, o.at - d); }); }
        else if (m.side === "S") { r.y += d; r.h -= d; p.openings.forEach(o => { if (o.room === r.id && (o.side === "E" || o.side === "W")) o.at = Math.max(0, o.at - d); }); }
        const T = HP.ROOM_TYPES[r.type];
        if (r.w < T.hardMin || r.h < T.hardMin) return null;
      }
      for (const id of moved) {
        const r = p.rooms.find(q => q.id === id);
        const others = { rooms: p.rooms.filter(q => !moved.has(q.id) || q.id === id), walls: p.walls, plot: p.plot };
        if (!legal(others, r, new Set([id]))) return null;
      }
      return p;
    }
    function dragWall(plan, key, delta, opts) {
      const A = an(plan), h = (A.handles || []).find(q => q.key === key);
      if (!h) return res(plan, false, "That wall is gone.");
      const members = opts && opts.only ? h.members.filter(m => m.room === opts.only) : h.members;
      const step = delta > 0 ? -5 : 5;
      for (let d = snap(delta); d !== 0; d += step) {
        const p = applyWall(plan, h, members, d);
        if (p) return res(p, d === snap(delta), d === snap(delta) ? "" : "The wall can't go further.");
      }
      return res(plan, delta === 0, delta === 0 ? "" : "The wall can't go further.");
    }
    function placeOpening(plan, kind, w, pt, excludeId) {
      const A = an(plan);
      const cands = [];
      for (const r of plan.rooms) {
        if (kind === "window" && HP.ROOM_TYPES[r.type].roofed === false) continue;
        for (const side of HP.SIDES) {
          const si = HP.sideInfo(r, side);
          const al = si.axis === "x" ? pt[0] : pt[1], ac = si.axis === "x" ? pt[1] : pt[0];
          const face = si.fixed + (si.axis === "x" ? si.n[1] : si.n[0]) * 10;
          const da = al < si.s0 ? si.s0 - al : al > si.s1 ? al - si.s1 : 0;
          const d = Math.hypot(da, ac - face);
          if (d < 70) cands.push({ r, side, si, d, al });
        }
      }
      cands.sort((a, b) => a.d - b.d);
      let why = "";
      for (const c of cands) {
        let ww = w;
        const T = HP.ROOM_TYPES[c.r.type];
        let note = "";
        if (kind === "window" && T.win) {
          const f = Math.max(T.win[0], Math.min(T.win[1], w));
          if (f !== w) { note = T.label + " windows are " + HP.fmtM(T.win[0]) + (T.win[1] !== T.win[0] ? "-" + HP.fmtM(T.win[1]) : "") + " m - set to " + HP.fmtM(f) + "."; ww = f; }
        }
        const sl = HP.analyze.slots(plan, A, c.r.id, c.side, kind, ww, excludeId);
        if (!sl.length) {
          if (!why) {
            const run = ((A.sides[c.r.id] || {})[c.side] || []).find(q => q.s0 <= c.al && c.al <= q.s1);
            why = run && HP.analyze.reasonFor ? HP.analyze.reasonFor(run.kind, kind) : "There is no room for it on this wall.";
            if (!why) why = "There is no room for it on this wall.";
          }
          continue;
        }
        const want = snap(c.al - c.si.s0 - ww / 2);
        let best = null, bd = Infinity;
        for (const s of sl) { const at = Math.max(s.a0, Math.min(s.a1, want)); const d = Math.abs(at - want); if (d < bd) { bd = d; best = at; } }
        if (bd > 120) { if (!why) why = "Too close to another door or window."; continue; }
        return { ok: true, placement: { room: c.r.id, side: c.side, at: best, w: ww }, note };
      }
      return { ok: false, reason: why || (kind === "door" ? "Doors go on a wall." : "Windows go on a wall.") };
    }
    function checkOpening(plan, kind, w, pt) {
      const r = placeOpening(plan, kind, w, pt, null);
      return { ok: r.ok, reason: r.reason || "", placement: r.placement || null };
    }
    function addOpening(plan, kind, w, pt) {
      const r = placeOpening(plan, kind, w, pt, null);
      if (!r.ok) return res(plan, false, r.reason);
      const p = HP.clone(plan), id = HP.newId(p, "o");
      const o = Object.assign({ id, kind }, r.placement);
      if (kind === "door") { o.hinge = "start"; o.swing = "in"; }
      p.openings.push(o);
      return res(p, true, "", id, r.note);
    }
    function moveOpening(plan, id, pt) {
      const o0 = plan.openings.find(o => o.id === id);
      if (!o0) return res(plan, false, "That opening is gone.");
      const r = placeOpening(plan, o0.kind, o0.w, pt, id);
      if (!r.ok) return res(plan, false, r.reason);
      const pl = r.placement;
      if (pl.room === o0.room && pl.side === o0.side && pl.at === o0.at && pl.w === o0.w) return res(plan, true);
      const p = HP.clone(plan), o = p.openings.find(q => q.id === id);
      Object.assign(o, pl);
      return res(p, true, "", null, r.note);
    }
    function setOpening(plan, id, v) { const p = HP.clone(plan), o = p.openings.find(q => q.id === id); if (!o) return res(plan, false); Object.assign(o, v); return res(p, true); }
    function flipDoor(plan, id, what) {
      const p = HP.clone(plan), o = p.openings.find(q => q.id === id);
      if (!o || o.kind !== "door") return res(plan, false, "Only doors can be turned.");
      if (what === "hinge") o.hinge = o.hinge === "end" ? "start" : "end"; else o.swing = o.swing === "out" ? "in" : "out";
      return res(p, true);
    }
    function removeOpening(plan, id) { const p = HP.clone(plan); p.openings = p.openings.filter(o => o.id !== id); return res(p, true); }
    function removeRoom(plan, id) { const p = HP.clone(plan); p.rooms = p.rooms.filter(r => r.id !== id); p.openings = p.openings.filter(o => o.room !== id); return res(p, true); }
    function setFurniture(plan, id, i) { const p = HP.clone(plan), r = p.rooms.find(q => q.id === id); if (!r) return res(plan, false); r.furn = i; return res(p, true); }
    function addRoom(plan, type, pt) {
      const T = HP.ROOM_TYPES[type];
      if (!T) return res(plan, false, "Unknown room.");
      const r = { id: "?", type, x: 0, y: 0, w: T.size[0], h: T.size[1] };
      const [sx, sy] = snapTo(plan, r, snap(pt[0] - r.w / 2), snap(pt[1] - r.h / 2), 30);
      const spot = nearestLegal(plan, r, new Set(), sx, sy, 300);
      if (!spot) return res(plan, false, "There is no free space for a " + T.label.toLowerCase() + " here.");
      const p = HP.clone(plan);
      const id = HP.newId(p, "r");
      p.rooms.push({ id, type, name: HP.nextName(p, type), x: spot[0], y: spot[1], w: r.w, h: r.h, furn: 0 });
      // a door and a window where a legal wall exists
      const A = HP.analyze(p);
      const pick = (kind, w, pref) => {
        for (const want of pref) for (const side of HP.SIDES) {
          const sl = HP.analyze.slots(p, A, id, side, kind, w, null).filter(s => !want || want.includes(s.facing));
          if (sl.length) return { side, at: sl[0].a0 };
        }
        return null;
      };
      const d = pick("door", 80, [["room"], ["open"]]) || pick("door", 100, [["yard", "street"]]);
      if (d) p.openings.push({ id: HP.newId(p, "o"), kind: "door", room: id, side: d.side, at: d.at, w: d.w || (d ? 80 : 100), hinge: "start", swing: "in" });
      if (T.win) {
        const A2 = HP.analyze(p);
        for (const side of HP.SIDES) {
          const sl = HP.analyze.slots(p, A2, id, side, "window", T.winDef, null);
          if (sl.length) { p.openings.push({ id: HP.newId(p, "o"), kind: "window", room: id, side, at: Math.round((sl[0].a0 + sl[0].a1) / 2 / 5) * 5, w: T.winDef }); break; }
        }
      }
      const exact = Math.abs(spot[0] - (pt[0] - r.w / 2)) < 40 && Math.abs(spot[1] - (pt[1] - r.h / 2)) < 40;
      return res(p, true, "", id, exact ? "" : "");
    }
    const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    function addSection(plan, pt) {
      const p = HP.clone(plan), box = plotBox(p.plot.pts);
      const used = new Set(p.sections.map(s => s.label));
      const label = [...LETTERS].find(l => !used.has(l)) || "Z";
      const id = HP.newId(p, "s");
      const x = snap(pt[0]);
      p.sections.push({ id, label, a: [x, box.y0 - 150], b: [x, box.y1 + 150], look: 1 });
      return res(p, true, "", id);
    }
    function moveSection(plan, id, v) {
      const p = HP.clone(plan), s = p.sections.find(q => q.id === id);
      if (!s) return res(plan, false);
      const vert = s.a[0] === s.b[0];
      if (v.dx != null || v.dy != null) { const dx = snap(v.dx || 0), dy = snap(v.dy || 0); s.a = [s.a[0] + dx, s.a[1] + dy]; s.b = [s.b[0] + dx, s.b[1] + dy]; }
      for (const k of ["a", "b"]) if (v[k]) {
        const o = k === "a" ? s.b : s.a;
        s[k] = vert ? [o[0], snap(v[k][1])] : [snap(v[k][0]), o[1]];
      }
      if (Math.hypot(s.a[0] - s.b[0], s.a[1] - s.b[1]) < 100) return res(plan, false, "A section must be at least 1 m long.");
      return res(p, true);
    }
    function flipSection(plan, id) { const p = HP.clone(plan), s = p.sections.find(q => q.id === id); if (!s) return res(plan, false); s.look = s.look === -1 ? 1 : -1; return res(p, true); }
    function turnSection(plan, id) {
      const p = HP.clone(plan), s = p.sections.find(q => q.id === id); if (!s) return res(plan, false);
      const cx = (s.a[0] + s.b[0]) / 2, cy = (s.a[1] + s.b[1]) / 2;
      const rot = q => [snap(cx - (q[1] - cy)), snap(cy + (q[0] - cx))];
      s.a = rot(s.a); s.b = rot(s.b); return res(p, true);
    }
    function removeSection(plan, id) { const p = HP.clone(plan); p.sections = p.sections.filter(s => s.id !== id); return res(p, true); }
    function roomsInside(p) { return p.rooms.every(r => HP.rectInPoly(HP.grow(r, p.walls.ext), p.plot.pts)); }
    function movePlotCorner(plan, i, pt) {
      const p = HP.clone(plan); p.plot.pts[i] = [snap(pt[0]), snap(pt[1])];
      if (HP.polyArea(p.plot.pts) <= 0) return res(plan, false, "The land can't fold over itself.");
      if (!roomsInside(p)) return res(plan, false, "A room would end up outside the land.");
      return res(p, true);
    }
    function addPlotCorner(plan, i, pt) {
      const p = HP.clone(plan);
      p.plot.pts.splice(i + 1, 0, [snap(pt[0]), snap(pt[1])]);
      p.plot.edges.splice(i + 1, 0, p.plot.edges[i]);
      if (!roomsInside(p)) return res(plan, false, "A room would end up outside the land.");
      return res(p, true);
    }
    function removePlotCorner(plan, i) {
      if (plan.plot.pts.length <= 3) return res(plan, false, "The land needs at least three corners.");
      const p = HP.clone(plan);
      p.plot.pts.splice(i, 1); p.plot.edges.splice(i, 1);
      if (!roomsInside(p)) return res(plan, false, "A room would end up outside the land.");
      return res(p, true);
    }
    HP.model = {
      moveRoom, swapRooms, dragWall, addRoom, removeRoom, setFurniture,
      checkOpening, addOpening, moveOpening, setOpening, flipDoor, removeOpening,
      addSection, moveSection, flipSection, turnSection, removeSection,
      movePlotCorner, addPlotCorner, removePlotCorner,
      renameRoom: (p, id, name) => { const q = HP.clone(p); q.rooms.find(r => r.id === id).name = name; return res(q, true); },
      _stub: true,
    };
  }

  // ===================================================================== furniture
  if (!HP.furniture) {
    STUBS.push("furniture");
    const rect = (x, y, w, h) => ({ kind: "pline", pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true });
    const line = (a, b) => ({ kind: "line", a, b });
    const circ = (c, r) => ({ kind: "circle", c, r });
    const BLOCKS = {
      BED_D: { layer: "A-FURN", w: 160, h: 200, items: [rect(0, 0, 160, 200), rect(12, 160, 62, 32), rect(86, 160, 62, 32), line([0, 140], [160, 140]), line([0, 140], [40, 120])] },
      WARDROBE: { layer: "A-FURN", w: 120, h: 60, items: [rect(0, 0, 120, 60), line([60, 0], [60, 60]), line([0, 0], [60, 60]), line([60, 0], [120, 60])] },
      SOFA_3: { layer: "A-FURN", w: 210, h: 85, items: [rect(0, 0, 210, 85), rect(0, 60, 210, 25), rect(0, 0, 20, 60), rect(190, 0, 20, 60), line([77, 0], [77, 60]), line([133, 0], [133, 60])] },
      ARMCHAIR: { layer: "A-FURN", w: 85, h: 85, items: [rect(0, 0, 85, 85), rect(0, 60, 85, 25), rect(0, 0, 15, 60), rect(70, 0, 15, 60)] },
      TABLE_C: { layer: "A-FURN", w: 100, h: 100, items: [circ([50, 50], 50), circ([50, 50], 38)] },
      COUNTER: { layer: "A-FIXT", w: 240, h: 60, items: [rect(0, 0, 240, 60), line([0, 5], [240, 5])] },
      STOVE: { layer: "A-FIXT", w: 60, h: 60, items: [rect(0, 0, 60, 60), circ([16, 16], 9), circ([44, 16], 9), circ([16, 44], 9), circ([44, 44], 9)] },
      SINK: { layer: "A-FIXT", w: 80, h: 50, items: [rect(0, 0, 80, 50), { kind: "pline", pts: [[8, 8], [72, 8], [72, 42], [8, 42]], closed: true, bulges: [0, 0.2, 0, 0.2] }, { kind: "hatch", pattern: "SOLID", loops: [[[38, 22], [42, 22], [42, 26], [38, 26]]] }] },
      WC: { layer: "A-FIXT", w: 40, h: 65, items: [rect(0, 47, 40, 18), { kind: "pline", pts: [[4, 47], [36, 47], [36, 20], [4, 20]], closed: true, bulges: [0, 0, 1, 0] }] },
      BASIN: { layer: "A-FIXT", w: 55, h: 42, items: [rect(0, 30, 55, 12), { kind: "arc", c: [27.5, 30], r: 24, a0: 180, a1: 360 }, line([3.5, 30], [51.5, 30]), circ([27.5, 20], 2)] },
      SHOWER: { layer: "A-FIXT", w: 90, h: 90, items: [rect(0, 0, 90, 90), line([0, 0], [90, 90]), line([0, 90], [90, 0]), circ([45, 45], 5)] },
      FRIDGE: { layer: "A-FIXT", w: 70, h: 70, items: [rect(0, 0, 70, 70), rect(5, 0, 60, 6)] },
    };
    const PLAN = {
      bedroom: r => [["BED_D", r.x + r.w / 2 - 80, r.y + r.h - 210], ["WARDROBE", r.x + r.w - 130, r.y + 10]],
      living: r => [["SOFA_3", r.x + r.w / 2 - 105, r.y + r.h - 95], ["TABLE_C", r.x + r.w / 2 - 50, r.y + r.h / 2 - 70], ["ARMCHAIR", r.x + 10, r.y + r.h / 2 - 40]],
      reception: r => [["SOFA_3", r.x + r.w / 2 - 105, r.y + r.h - 95], ["ARMCHAIR", r.x + 10, r.y + r.h / 2 - 40], ["ARMCHAIR", r.x + r.w - 95, r.y + r.h / 2 - 40]],
      kitchen: r => [["COUNTER", r.x + 10, r.y + r.h - 70], ["STOVE", r.x + 30, r.y + r.h - 70], ["SINK", r.x + 150, r.y + r.h - 65], ["FRIDGE", r.x + r.w - 80, r.y + 120]],
      bath: r => [["WC", r.x + r.w - 55, r.y + r.h - 75], ["BASIN", r.x + r.w - 125, r.y + r.h - 52], ["SHOWER", r.x + 10, r.y + r.h - 100]],
      wc: r => [["WC", r.x + r.w - 55, r.y + r.h - 75], ["BASIN", r.x + 10, r.y + r.h - 52]],
    };
    function variants(type) {
      return PLAN[type] ? [{ key: "auto", label: "Automatic" }, { key: "mirror", label: "Mirrored" }] : [{ key: "auto", label: "Automatic" }];
    }
    function layout(room, ro, furn) {
      const f = PLAN[room.type];
      if (!f) return { inserts: [], used: 0 };
      const cx = room.x + room.w / 2;
      const out = [];
      for (const [block, x, y] of f(room)) {
        const B = BLOCKS[block];
        if (x < room.x - 0.1 || y < room.y - 0.1 || x + B.w > room.x + room.w + 0.1 || y + B.h > room.y + room.h + 0.1) continue;
        if (furn === 1) out.push({ block, x: 2 * cx - x, y, rot: 0, sx: -1 });
        else out.push({ block, x, y, rot: 0, sx: 1 });
      }
      return { inserts: out, used: furn | 0 };
    }
    HP.furniture = { BLOCKS, variants, layout, _stub: true };
  }

  HP._canvasStubs = STUBS;
  if (STUBS.length && typeof console !== "undefined") console.info("[canvas-stub] stand-ins in use: " + STUBS.join(", "));
})(globalThis.HP = globalThis.HP || {});
