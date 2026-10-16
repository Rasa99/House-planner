"use strict";
/* ============================================================================
   House Planner - model.js   (model agent)
   ----------------------------------------------------------------------------
   Every edit of a plan. All ops are PURE: they never change the plan they are
   given; they return { state, ok, reason, id, note } where `state` is a new
   plan (or the very same object when nothing changed). See CONTRACT.md s.6.

   ONE LEGALITY RULE for rooms, used by every op (codes: 0 fine, 1 a gap that
   must snap shut or open, 2 impossible):
     - x, y, w, h integers on the 5 cm grid; each side >= the type's hardMin
     - the room grown by walls.ext lies inside the land
     - two rooms never overlap; where their clear rectangles face each other
       the gap is exactly walls.int (a shared wall) or at least
       2*walls.ext + RULES.minGap (a real passage). Rooms that only meet
       corner to corner must either be that far apart on one axis or touch
       as a clean wall joint (walls.int on both axes).
     - a room's outer wall face and an axis-aligned land edge are 0 apart or
       at least RULES.minGap apart.
   Code 1 ("soft") positions are what an edit snaps away from: drags look
   past them to the nearest allowed value. Code 2 ("hard") stops a drag.
============================================================================ */
(function (HP) {
  const R = HP.RULES;
  const SIDES = ["N", "E", "S", "W"];
  const SIGN = { N: 1, E: 1, S: -1, W: -1 };
  const OPP = { N: "S", S: "N", E: "W", W: "E" };
  const m2 = cm => HP.fmtM(cm);
  const typeOf = r => HP.ROOM_TYPES[r.type] || null;
  const isRoofed = r => { const T = typeOf(r); return T ? T.roofed !== false : true; };
  const findRoom = (s, id) => s.rooms.find(r => r.id === id) || null;
  const findOpening = (s, id) => s.openings.find(o => o.id === id) || null;
  const findSection = (s, id) => s.sections.find(o => o.id === id) || null;
  const sideLen = (r, side) => (side === "N" || side === "S" ? r.w : r.h);
  const onGrid = v => Number.isInteger(v) && v % HP.GRID === 0;
  const word = k => (k === "door" ? "door" : "window");
  const A_NAME = { bedroom: "a bedroom", living: "a living room", reception: "a reception room", kitchen: "a kitchen",
                   bath: "a bathroom", wc: "a toilet", open: "an open area", hall: "a hall" };
  const aName = type => A_NAME[type] || "a room";
  const capital = t => t.charAt(0).toUpperCase() + t.slice(1);

  function res(state, ok, reason, id, note) {
    return { state, ok: !!ok, reason: reason || "", id: id || null, note: note || "" };
  }
  const done = (state, id, note) => res(state, true, "", id, note);
  const fail = (state, reason) => res(state, false, reason);
  const joinNotes = notes => Array.from(new Set(notes.filter(Boolean))).join(" ");

  // ================================================================ legality
  function plotInfo(plan) {
    const pts = plan.plot.pts;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const P = { pts, x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys),
                x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys), vEdges: [], hEdges: [], rect: false };
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (a[0] === b[0] && a[1] !== b[1]) P.vEdges.push({ x: a[0], y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
      else if (a[1] === b[1] && a[0] !== b[0]) P.hEdges.push({ y: a[1], x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]) });
    }
    P.rect = pts.length === 4 && P.vEdges.length === 2 && P.hEdges.length === 2 &&
             Math.abs(HP.polyArea(pts)) === (P.x1 - P.x0) * (P.y1 - P.y0);
    return P;
  }

  function selfCode(r) {
    const T = typeOf(r);
    if (!T || !onGrid(r.x) || !onGrid(r.y) || !onGrid(r.w) || !onGrid(r.h)) return 2;
    return r.w < T.hardMin || r.h < T.hardMin ? 2 : 0;
  }

  /* two rooms on their own: 0 fine, 1 a narrow space between them (a slot -
     unless other rooms fill it, see pairCode), 2 they overlap */
  function rawPair(a, b, W) {
    const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
    const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
    if (dx < 0 && dy < 0) return 2;
    const far = 2 * W.ext + R.minGap;
    if (dy < 0) return dx === W.int || dx >= far ? 0 : 1;
    if (dx < 0) return dy === W.int || dy >= far ? 0 : 1;
    if (dx >= far || dy >= far) return 0;
    return dx === W.int && dy === W.int ? 0 : 1;
  }
  /* the space between two rooms' walls, [x0, y0, x1, y1]: on each axis the gap
     between the rooms grown by walls.ext, or where those overlap */
  function between(a, b, e) {
    const p0 = Math.max(a.x, b.x) - e, p1 = Math.min(a.x + a.w, b.x + b.w) + e;
    const q0 = Math.max(a.y, b.y) - e, q1 = Math.min(a.y + a.h, b.y + b.h) + e;
    return [Math.min(p0, p1), Math.min(q0, q1), Math.max(p0, p1), Math.max(q0, q1)];
  }
  /* Is box (it must have area) inside the union of the grown rectangles of
     `rooms` (and `extra`), leaving out the rooms with ids skipA and skipB? */
  function covered(box, rooms, e, skipA, skipB, extra) {
    if (!(box[2] > box[0] && box[3] > box[1])) return false;
    const rs = [];
    const take = r => {
      if (!r || r.id === skipA || r.id === skipB) return;
      const g = [r.x - e, r.y - e, r.x + r.w + e, r.y + r.h + e];
      if (g[0] >= box[2] || g[2] <= box[0] || g[1] >= box[3] || g[3] <= box[1]) return;
      rs.push(g);
    };
    for (let k = 0; k < rooms.length; k++) take(rooms[k]);
    take(extra);
    if (!rs.length) return false;
    for (const g of rs) if (g[0] <= box[0] && g[1] <= box[1] && g[2] >= box[2] && g[3] >= box[3]) return true;
    const cut = (lo, hi, k0, k1) => Array.from(new Set([lo, hi].concat(rs.map(g => g[k0]), rs.map(g => g[k1]))
      .filter(v => v >= lo && v <= hi))).sort((p, q) => p - q);
    const xs = cut(box[0], box[2], 0, 2), ys = cut(box[1], box[3], 1, 3);
    for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      if (!rs.some(g => g[0] < cx && cx < g[2] && g[1] < cy && cy < g[3])) return false;
    }
    return true;
  }
  /* 0 / 1 / 2 as rawPair, but a narrow space that other rooms (with their
     walls) fill completely is no slot at all. `rooms` = every room to ask. */
  function pairCode(a, b, W, rooms, extra) {
    const c = rawPair(a, b, W);
    if (c !== 1 || !rooms) return c;
    return covered(between(a, b, W.ext), rooms, W.ext, a.id, b.id, extra) ? 0 : 1;
  }

  /* room r and the land: 2 outside, 1 a slot of less than minGap between its
     wall and an axis-aligned land edge (unless other rooms fill that slot),
     0 fine. rooms = null asks only about r itself. */
  function plotCode(r, P, W, rooms, extra) {
    const gx0 = r.x - W.ext, gy0 = r.y - W.ext, gx1 = r.x + r.w + W.ext, gy1 = r.y + r.h + W.ext;
    if (P.rect) {
      if (gx0 < P.x0 || gy0 < P.y0 || gx1 > P.x1 || gy1 > P.y1) return 2;
    } else if (gx0 < P.x0 || gy0 < P.y0 || gx1 > P.x1 || gy1 > P.y1 ||
               !HP.rectInPoly({ x: gx0, y: gy0, w: gx1 - gx0, h: gy1 - gy0 }, P.pts)) return 2;
    const g = R.minGap;
    const slot = box => !rooms || !covered(box, rooms, W.ext, r.id, null, extra);
    for (const e of P.vEdges) {
      const a0 = Math.max(e.y0, gy0), a1 = Math.min(e.y1, gy1);
      if (a1 <= a0) continue;
      const d1 = e.x - gx1, d2 = gx0 - e.x;
      if (d1 > 0 && d1 < g && slot([gx1, a0, e.x, a1])) return 1;
      if (d2 > 0 && d2 < g && slot([e.x, a0, gx0, a1])) return 1;
    }
    for (const e of P.hEdges) {
      const a0 = Math.max(e.x0, gx0), a1 = Math.min(e.x1, gx1);
      if (a1 <= a0) continue;
      const d1 = e.y - gy1, d2 = gy0 - e.y;
      if (d1 > 0 && d1 < g && slot([a0, gy1, a1, e.y])) return 1;
      if (d2 > 0 && d2 < g && slot([a0, e.y, a1, gy0])) return 1;
    }
    return 0;
  }

  /* Narrow spaces among `list` that are fine only because some room fills
     them now (in `all`). If an edit moves that room away they open up, so an
     edit must check them again (fragileOk). */
  function fragileOf(list, all, P, W) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++)
        if (rawPair(list[i], list[j], W) === 1 && pairCode(list[i], list[j], W, all) === 0) out.push([list[i], list[j]]);
      if (plotCode(list[i], P, W, null) === 1 && plotCode(list[i], P, W, all) === 0) out.push([list[i], null]);
    }
    return out;
  }
  function fragileOk(items, rooms, P, W, extra) {
    for (const [a, b] of items) {
      if (b) { if (!covered(between(a, b, W.ext), rooms, W.ext, a.id, b.id, extra)) return false; }
      else if (plotCode(a, P, W, rooms, extra) !== 0) return false;
    }
    return true;
  }

  /* worst code of room t (not in `others`) against `others` and the land */
  function codeOne(t, others, P, W, fragile) {
    if (selfCode(t)) return 2;
    let worst = 0;
    for (let k = 0; k < others.length; k++) {
      const c = pairCode(t, others[k], W, others);
      if (c === 2) return 2;
      if (c > worst) worst = c;
    }
    const p = plotCode(t, P, W, others);
    if (p > worst) worst = p;
    if (!worst && fragile && fragile.length && !fragileOk(fragile, others, P, W, t)) worst = 1;
    return worst;
  }

  /* worst code of the rooms at indexes `changed` (a Set) against everything */
  function codeChanged(rooms, changed, P, W, fragile) {
    let worst = 0;
    for (const i of changed) {
      const r = rooms[i];
      if (selfCode(r)) return 2;
      const p = plotCode(r, P, W, rooms);
      if (p === 2) return 2;
      if (p > worst) worst = p;
      for (let j = 0; j < rooms.length; j++) {
        if (j === i || (changed.has(j) && j < i)) continue;
        const c = pairCode(r, rooms[j], W, rooms);
        if (c === 2) return 2;
        if (c > worst) worst = c;
      }
    }
    if (!worst && fragile && fragile.length && !fragileOk(fragile, rooms, P, W, null)) worst = 1;
    return worst;
  }

  /* The whole-plan check: { ok, reason, bad:[ids] }. Every op keeps it true
     when it was true before. Also checks every opening sits on its wall. */
  function legal(plan) {
    const W = plan.walls, P = plotInfo(plan), rooms = plan.rooms;
    let reason = "";
    const bad = new Set();
    const say = (t, ids) => { if (!reason) reason = t; (ids || []).forEach(i => bad.add(i)); };
    if (!onGrid(W.ext) || !onGrid(W.int) || W.ext <= 0 || W.int <= 0) say("Wall thickness must be on the 5 cm grid.");
    if (W.int > 2 * W.ext) say("Inside walls can't be more than twice as thick as outside walls.");
    for (const r of rooms) {
      const T = typeOf(r);
      if (!T) say(r.name + " has an unknown room type.", [r.id]);
      else if (!onGrid(r.x) || !onGrid(r.y) || !onGrid(r.w) || !onGrid(r.h)) say(r.name + " is not on the 5 cm grid.", [r.id]);
      else if (r.w < T.hardMin || r.h < T.hardMin) say(r.name + " is smaller than " + m2(T.hardMin) + " m.", [r.id]);
      const pc = plotCode(r, P, W, rooms);
      if (pc === 2) say(r.name + " goes outside the land.", [r.id]);
      else if (pc === 1) say(r.name + " is less than " + m2(R.minGap) + " m from the land edge.", [r.id]);
    }
    for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
      const c = pairCode(rooms[i], rooms[j], W, rooms);
      if (c === 2) say(rooms[i].name + " overlaps " + rooms[j].name + ".", [rooms[i].id, rooms[j].id]);
      else if (c === 1) say(rooms[i].name + " and " + rooms[j].name + " are too close: share a wall or leave " +
                            m2(R.minGap) + " m between them.", [rooms[i].id, rooms[j].id]);
    }
    for (const o of plan.openings) {
      const h = findRoom(plan, o.room);
      if (!h || !SIGN[o.side]) { say("A " + word(o.kind) + " belongs to a room that is gone.", [o.id]); continue; }
      if (!onGrid(o.at) || !onGrid(o.w) || o.w <= 0 || o.at < 0 || o.at + o.w > sideLen(h, o.side))
        say("A " + word(o.kind) + " in " + h.name + " is off its wall.", [o.id]);
    }
    return { ok: !reason, reason, bad: Array.from(bad) };
  }

  // ================================================================ openings upkeep
  /* nearest allowed window width for a room type (null = this room takes no windows) */
  function fitWindowWidth(w, type) {
    const T = HP.ROOM_TYPES[type];
    if (!T || !T.win || T.roofed === false) return null;
    if (w >= T.win[0] && w <= T.win[1]) return w;
    const ok = HP.WINDOW_SIZES.filter(v => v >= T.win[0] && v <= T.win[1]);
    if (!ok.length) return HP.clamp(w, T.win[0], T.win[1]);
    return ok.reduce((best, v) => (Math.abs(v - w) < Math.abs(best - w) ? v : best), ok[0]);
  }
  function rangeTxt(win) {
    return win[0] === win[1] ? m2(win[0]) + " m" : m2(win[0]) + " to " + m2(win[1]) + " m";
  }
  function widthNote(type, w) {
    const T = HP.ROOM_TYPES[type];
    return T.label + " windows are " + rangeTxt(T.win) + " - set to " + m2(w) + ".";
  }

  /* Keep the openings of one room on their walls. When a wall got too short
     for what is on it, windows step down to a smaller size (one the room type
     allows if there is one, else any size from HP.WINDOW_SIZES - the rules
     panel then says so) and a 1.00 door becomes 0.80; only what still can't
     fit is taken out. Then every opening keeps RULES.endClear from the
     corners and RULES.openingGap from its neighbours on that side. */
  function settleRoom(s, id, notes) {
    const r = findRoom(s, id);
    if (!r) return;
    const EC = R.endClear, GAP = R.openingGap, T = typeOf(r);
    const smaller = o => {                       // the next size down, or null
      if (o.kind !== "window") return o.w > HP.DOORS.interior ? HP.DOORS.interior : null;
      const inRange = T && T.win ? HP.WINDOW_SIZES.filter(v => v >= T.win[0] && v <= T.win[1] && v < o.w) : [];
      const pool = inRange.length ? inRange : HP.WINDOW_SIZES.filter(v => v < o.w);
      return pool.length ? pool[pool.length - 1] : null;
    };
    for (const side of SIDES) {
      let list = s.openings.filter(o => o.room === id && o.side === side);
      if (!list.length) continue;
      const L = sideLen(r, side);
      const need = () => list.reduce((t, o) => t + o.w, 0) + GAP * (list.length - 1) + 2 * EC;
      const shrink = o => {
        o.w = smaller(o);
        notes.push(o.kind === "window" ? "A window was made smaller to fit its wall." : "A door was made " + m2(o.w) + " m to fit its wall.");
      };
      for (const o of list) while (o.w + 2 * EC > L && smaller(o) != null) shrink(o);
      while (need() > L) {
        const c = list.filter(o => smaller(o) != null).sort((a, b) => b.w - a.w)[0];
        if (!c) break;
        shrink(c);
      }
      const drop = o => {
        s.openings.splice(s.openings.indexOf(o), 1);
        notes.push("A " + word(o.kind) + " no longer fitted on its wall and was taken out.");
      };
      list.filter(o => o.w + 2 * EC > L).forEach(drop);
      list = list.filter(o => o.w + 2 * EC <= L).sort((a, b) => a.at - b.at || a.w - b.w);
      while (list.length && need() > L) drop(list.pop());
      let pos = EC;
      for (const o of list) { if (o.at < pos) o.at = pos; pos = o.at + o.w + GAP; }
      let lim = L - EC;
      for (let k = list.length - 1; k >= 0; k--) {
        const o = list[k];
        if (o.at + o.w > lim) o.at = lim - o.w;
        lim = o.at - GAP;
      }
    }
  }

  /* After rooms changed shape: openings on a side whose start moved keep their
     place on the ground, then every changed room is settled. */
  function refitOpenings(s, oldRects, notes) {
    for (const [id, o] of oldRects) {
      const r = findRoom(s, id);
      if (!r) continue;
      const dx = r.x - o.x, dy = r.y - o.y;
      if (!dx && !dy && r.w === o.w && r.h === o.h) continue;
      for (const op of s.openings) {
        if (op.room !== id) continue;
        if (op.side === "N" || op.side === "S") op.at -= dx; else op.at -= dy;
      }
      settleRoom(s, id, notes);
    }
  }

  /* Windows of rooms whose type changed: refit the width to the new type; a
     window now hosted by an open area moves to the roofed room across the wall
     or is taken out. */
  function fixWindows(s, ids, notes) {
    const touched = new Set(ids);
    for (const o of s.openings.slice()) {
      if (o.kind !== "window" || !ids.includes(o.room)) continue;
      let host = findRoom(s, o.room);
      if (!isRoofed(host)) {
        const si = HP.sideInfo(host, o.side), sg = SIGN[o.side];
        const a = si.s0 + o.at, b = a + o.w;
        const across = s.rooms.find(q => {
          if (q.id === host.id || !isRoofed(q)) return false;
          const qi = HP.sideInfo(q, OPP[o.side]);
          return qi.fixed === si.fixed + sg * s.walls.int && qi.s0 <= a && qi.s1 >= b;
        });
        if (!across) {
          s.openings.splice(s.openings.indexOf(o), 1);
          notes.push("Open areas have no windows - a window was taken out.");
          continue;
        }
        o.room = across.id; o.side = OPP[o.side]; o.at = a - HP.sideInfo(across, o.side).s0;
        host = across; touched.add(across.id);
      }
      const ww = fitWindowWidth(o.w, host.type);
      if (ww != null && ww !== o.w) {
        const centre = o.at + o.w / 2;
        o.w = ww; o.at = HP.snap(centre - ww / 2);
        notes.push(widthNote(host.type, ww));
      }
    }
    touched.forEach(id => settleRoom(s, id, notes));
  }

  /* After an edit: every door or window that was allowed before and is not
     now moves to the nearest legal place in its own room. Windows first (they
     have fewer walls to go to), then doors, each in plan order. A window tries
     its own wall first, then open area > yard > street; a door first keeps the
     same connection (same room / the outside), then its own wall, then the same
     order. It keeps its width or steps down within what the room type allows.
     When nothing legal exists it stays, and the rules panel flags it.       */
  const SIDE_WORD = { N: "north", E: "east", S: "south", W: "west" };
  const FACE_RANK = { open: 0, yard: 1, street: 2, room: 3 };
  function rescueOpenings(before, s, notes) {
    if (!s.openings.length || !before.openings.length) return;
    const A0 = HP.analyze(before);
    const was = new Map(A0.openings.filter(g => g.ok).map(g => [g.id, g]));
    if (!was.size) return;
    const A = HP.analyze(s);
    const broken = A.openings.filter(g => !g.ok && was.has(g.id));
    if (!broken.length) return;
    broken.sort((p, q) => (p.kind === q.kind ? 0 : p.kind === "window" ? -1 : 1));
    for (const g of broken) {
      const o = findOpening(s, g.id), host = o && findRoom(s, o.room);
      if (!host) continue;
      const prev = was.get(g.id);
      const centre = g.axis === "x" ? [(g.s0 + g.s1) / 2, g.fixed] : [g.fixed, (g.s0 + g.s1) / 2];
      const widths = [o.w];
      if (o.kind === "window") {
        const T = typeOf(host);
        if (T && T.win) HP.WINDOW_SIZES.filter(v => v < o.w && v >= T.win[0] && v <= T.win[1]).reverse().forEach(v => widths.push(v));
      } else if (o.w > HP.DOORS.interior) widths.push(HP.DOORS.interior);
      let pick = null;
      for (const w of widths) {
        for (const side of SIDES) {
          const si = HP.sideInfo(host, side);
          const along = si.axis === "x" ? centre[0] : centre[1];
          for (const sl of HP.analyze.slots(s, A, host.id, side, o.kind, w, o.id)) {
            const at = HP.clamp(HP.snap(along - w / 2 - si.s0), sl.a0, sl.a1);
            const c = si.axis === "x" ? [si.s0 + at + w / 2, si.fixed] : [si.fixed, si.s0 + at + w / 2];
            const key = [
              o.kind === "door" && !(sl.facing === prev.facing && sl.other === prev.other) ? 1 : 0,
              side === o.side ? 0 : 1,
              FACE_RANK[sl.facing] != null ? FACE_RANK[sl.facing] : 9,
              Math.hypot(c[0] - centre[0], c[1] - centre[1]),
            ];
            let better = !pick;
            for (let k = 0; !better && k < key.length; k++) {
              if (key[k] < pick.key[k] - 1e-9) better = true;
              else if (key[k] > pick.key[k] + 1e-9) break;
            }
            if (better) pick = { key, side, at, w };
          }
        }
        if (pick) break;
      }
      if (!pick) continue;
      const other = pick.side !== o.side, narrower = pick.w !== o.w;
      o.side = pick.side; o.at = pick.at; o.w = pick.w;
      const k = A.openings.findIndex(x => x.id === o.id);
      A.openings[k] = HP.analyze.openingGeom(s, host, A.sides, o);
      notes.push("Moved the " + host.name + " " + word(o.kind) + (other ? " to the " + SIDE_WORD[pick.side] + " wall" : " along its wall") +
                 (narrower ? " and made it " + m2(o.w) + " m" : "") + ".");
    }
  }

  // ================================================================ placing a room
  function axisCands(others, P, W, axis, len) {
    const mag = [], extra = [];
    const far = 2 * W.ext + R.minGap;
    for (const b of others) {
      const b0 = axis === "x" ? b.x : b.y, b1 = b0 + (axis === "x" ? b.w : b.h);
      mag.push(b1 + W.int, b0 - W.int - len, b0, b1 - len);
      extra.push(b1 + far, b0 - far - len);
    }
    for (const v of P.pts) {
      const c = axis === "x" ? v[0] : v[1];
      mag.push(c + W.ext, c - W.ext - len);
      extra.push(c + W.ext + R.minGap, c - W.ext - R.minGap - len);
    }
    const lo = (axis === "x" ? P.x0 : P.y0) + W.ext, hi = (axis === "x" ? P.x1 : P.y1) - W.ext - len;
    const keep = v => v >= lo && v <= hi && onGrid(v);
    return { mag: mag.filter(keep), all: mag.concat(extra).filter(keep), lo, hi };
  }
  function magnet(v, list, dist) {
    let best = v, bd = dist + 1e-9;
    for (const c of list) { const d = Math.abs(c - v); if (d < bd || (d === bd && c < best)) { bd = d; best = c; } }
    return best;
  }
  /* combos of xs x ys in increasing distance from (rx, ry): a lazy min-heap walk */
  function nearestCombo(xs, ys, rx, ry, fits) {
    xs = Array.from(new Set(xs)).sort((a, b) => Math.abs(a - rx) - Math.abs(b - rx) || a - b);
    ys = Array.from(new Set(ys)).sort((a, b) => Math.abs(a - ry) - Math.abs(b - ry) || a - b);
    const nx = xs.length, ny = ys.length;
    if (!nx || !ny) return null;
    const dx = xs.map(x => (x - rx) * (x - rx)), dy = ys.map(y => (y - ry) * (y - ry));
    const seen = new Uint8Array(nx * ny);
    const hk = [], hv = [];
    const less = (i, j) => hk[i] < hk[j] || (hk[i] === hk[j] && hv[i] < hv[j]);
    const swap = (i, j) => { let t = hk[i]; hk[i] = hk[j]; hk[j] = t; t = hv[i]; hv[i] = hv[j]; hv[j] = t; };
    const push = (i, j) => {
      const id = i * ny + j;
      if (seen[id]) return;
      seen[id] = 1;
      hk.push(dx[i] + dy[j]); hv.push(id);
      let c = hk.length - 1;
      while (c > 0) { const p = (c - 1) >> 1; if (!less(c, p)) break; swap(c, p); c = p; }
    };
    const pop = () => {
      const top = hv[0], lastK = hk.pop(), lastV = hv.pop();
      if (hk.length) {
        hk[0] = lastK; hv[0] = lastV;
        let c = 0;
        for (;;) {
          const l = 2 * c + 1, r = l + 1;
          let m = c;
          if (l < hk.length && less(l, m)) m = l;
          if (r < hk.length && less(r, m)) m = r;
          if (m === c) break;
          swap(c, m); c = m;
        }
      }
      return top;
    };
    push(0, 0);
    while (hk.length) {
      const id = pop(), i = (id / ny) | 0, j = id % ny;
      if (fits(xs[i], ys[j])) return [xs[i], ys[j]];
      if (i + 1 < nx) push(i + 1, j);
      if (j + 1 < ny) push(i, j + 1);
    }
    return null;
  }
  /* Where a room of this type and size goes when asked for lower-left (rx, ry):
     the magnet spot if legal, else the nearest legal spot. null = nowhere.
     box = {x0, x1, y0, y1}: only lower-left corners inside it (addRoom uses it
     to keep the room on the point where it was dropped). */
  function placeRoom(plan, spec, rx, ry, snapDist, excludeId, box) {
    const W = plan.walls, P = plotInfo(plan);
    const others = plan.rooms.filter(r => r.id !== excludeId);
    const fragile = excludeId ? fragileOf(others, plan.rooms, P, W) : null;   // a new room only fills space
    const t = { id: excludeId || "\u0000new", type: spec.type, x: 0, y: 0, w: spec.w, h: spec.h };
    const inX = x => !box || (x >= box.x0 && x <= box.x1), inY = y => !box || (y >= box.y0 && y <= box.y1);
    const fits = (x, y) => {
      if (!inX(x) || !inY(y)) return false;
      t.x = x; t.y = y;
      return codeOne(t, others, P, W, fragile) === 0;
    };
    const cx = axisCands(others, P, W, "x", spec.w), cy = axisCands(others, P, W, "y", spec.h);
    const tx = snapDist > 0 ? magnet(rx, cx.mag.filter(inX), snapDist) : rx;
    const ty = snapDist > 0 ? magnet(ry, cy.mag.filter(inY), snapDist) : ry;
    for (const [x, y] of [[tx, ty], [tx, ry], [rx, ty]]) if (fits(x, y)) return { x, y, exact: true };
    const hit = nearestCombo(cx.all.concat([rx, tx].filter(v => v >= cx.lo && v <= cx.hi)).filter(inX),
                             cy.all.concat([ry, ty].filter(v => v >= cy.lo && v <= cy.hi)).filter(inY), rx, ry, fits);
    return hit ? { x: hit[0], y: hit[1], exact: false } : null;
  }

  // ================================================================ rooms
  function moveRoom(plan, id, x, y, opts) {
    const r = findRoom(plan, id);
    if (!r) return fail(plan, "That room is not in the plan.");
    const snapDist = opts && opts.snap != null ? opts.snap : 25;
    const rx = HP.snap(x), ry = HP.snap(y);
    const spot = placeRoom(plan, r, rx, ry, snapDist, id);
    if (!spot) return fail(plan, "There is no free space for " + r.name + " here.");
    const why = spot.exact ? "" : "That spot is taken - " + r.name + " went to the nearest free spot.";
    if (spot.x === r.x && spot.y === r.y) return res(plan, spot.exact, why);
    const s = HP.clone(plan), rr = findRoom(s, id);
    rr.x = spot.x; rr.y = spot.y;
    const notes = [];
    rescueOpenings(plan, s, notes);
    return res(s, spot.exact, why, null, joinNotes(notes));
  }

  function swapRooms(plan, a, b) {
    const ra = findRoom(plan, a), rb = findRoom(plan, b);
    if (!ra || !rb) return fail(plan, "That room is not in the plan.");
    if (a === b) return done(plan);
    const Ta = typeOf(ra), Tb = typeOf(rb);
    if (rb.w < Ta.hardMin || rb.h < Ta.hardMin)
      return fail(plan, ra.name + " can't fit in the space of " + rb.name + " (it needs " + m2(Ta.hardMin) + " m each way).");
    if (ra.w < Tb.hardMin || ra.h < Tb.hardMin)
      return fail(plan, rb.name + " can't fit in the space of " + ra.name + " (it needs " + m2(Tb.hardMin) + " m each way).");
    const s = HP.clone(plan), A = findRoom(s, a), B = findRoom(s, b);
    for (const k of ["x", "y", "w", "h"]) { const t = A[k]; A[k] = B[k]; B[k] = t; }
    // the walls stay where they are, so do the doors and windows: they now belong to the
    // room that owns that wall
    for (const o of s.openings) {
      if (o.room === a) o.room = b; else if (o.room === b) o.room = a;
    }
    const notes = [];
    fixWindows(s, [a, b], notes);
    rescueOpenings(plan, s, notes);
    return done(s, null, joinNotes(notes));
  }

  /* Move room edges together. members = [{room, side}], delta cm along the
     edges' normal axis (+ = towards +x / +y). Looks at every 5 cm step from 0
     outward, stops at the first impossible one, and takes the allowed value
     nearest to delta. Returns res() plus `achieved`. */
  function moveEdges(plan, members, delta) {
    const D = HP.snap(delta);
    const out0 = r => Object.assign(r, { achieved: 0 });
    if (!D || !members.length) return out0(done(plan));
    const W = plan.walls, P = plotInfo(plan);
    const rooms = plan.rooms.map(r => ({ id: r.id, type: r.type, name: r.name, x: r.x, y: r.y, w: r.w, h: r.h }));
    const idx = new Map(rooms.map((r, i) => [r.id, i]));
    const per = new Map();               // room index -> [sides]
    for (const m of members) {
      const i = idx.get(m.room);
      if (i == null || !SIGN[m.side]) continue;
      if (!per.has(i)) per.set(i, []);
      if (!per.get(i).includes(m.side)) per.get(i).push(m.side);
    }
    if (!per.size) return out0(fail(plan, "That wall is not there any more."));
    const changed = new Set(per.keys());
    const base = new Map(Array.from(changed).map(i => [i, Object.assign({}, rooms[i])]));
    const apply = (list, d) => {
      for (const [i, sides] of per) {
        const r = list[i], o = base.get(i);
        r.x = o.x; r.y = o.y; r.w = o.w; r.h = o.h;
        for (const sd of sides) {
          if (sd === "E") r.w += d;
          else if (sd === "W") { r.x += d; r.w -= d; }
          else if (sd === "N") r.h += d;
          else { r.y += d; r.h -= d; }
        }
      }
    };
    const sgn = Math.sign(D), want = Math.abs(D);
    const fragile = fragileOf(rooms.filter((r, i) => !changed.has(i)), rooms, P, W);
    let best = codeChanged(rooms, changed, P, W, fragile) === 0 ? 0 : null;
    let bestErr = best === 0 ? want : Infinity;
    const maxK = (want + 2 * W.ext + R.minGap) / HP.GRID;
    for (let k = 1; k <= maxK; k++) {
      const d = sgn * k * HP.GRID;
      if (Math.abs(d) - want >= bestErr) break;
      apply(rooms, d);
      const c = codeChanged(rooms, changed, P, W, fragile);
      if (c === 2) break;
      if (c === 0) {
        const err = Math.abs(Math.abs(d) - want);
        if (err < bestErr) { best = d; bestErr = err; }
        if (Math.abs(d) >= want) break;
      }
    }
    if (best === null) return out0(fail(plan, "This wall can't move."));
    if (best === 0) return out0(fail(plan, "This wall can't move that way."));
    const s = HP.clone(plan);
    const oldRects = new Map();
    for (const i of changed) oldRects.set(rooms[i].id, Object.assign({}, base.get(i)));
    apply(s.rooms, best);
    const notes = [];
    refitOpenings(s, oldRects, notes);
    rescueOpenings(plan, s, notes);
    const r = best === D ? done(s, null, joinNotes(notes))
                         : res(s, false, "The wall can only move " + m2(Math.abs(best)) + " m that way.", null, joinNotes(notes));
    r.achieved = best;
    return r;
  }

  function dragWall(plan, key, delta, opts) {
    opts = opts || {};
    const h = HP.analyze.handles(plan).find(x => x.key === key);
    if (!h) return fail(plan, "That wall is not there any more.");
    let members = h.members;
    if (opts.only) {
      members = members.filter(m => m.room === opts.only);
      if (!members.length) return fail(plan, "That room is not on this wall.");
    }
    const r = moveEdges(plan, members, delta);
    delete r.achieved;
    return r;
  }

  /* the edges that move when one room's side moves: that side plus the sides
     of the rooms right across a shared wall (whole = the whole wall line) */
  function edgeMembers(plan, id, side, whole) {
    if (whole) {
      const h = HP.analyze.handles(plan).find(x => x.members.some(m => m.room === id && m.side === side));
      return h ? h.members : [{ room: id, side }];
    }
    const r = findRoom(plan, id), si = HP.sideInfo(r, side);
    const list = [{ room: id, side }];
    for (const b of plan.rooms) {
      if (b.id === id) continue;
      const bi = HP.sideInfo(b, OPP[side]);
      if (bi.fixed === si.fixed + SIGN[side] * plan.walls.int && HP.spanOverlap(si.s0, si.s1, bi.s0, bi.s1) > 0)
        list.push({ room: b.id, side: OPP[side] });
    }
    return list;
  }

  function setRoomSize(plan, id, w, h) {
    const r = findRoom(plan, id);
    if (!r) return fail(plan, "That room is not in the plan.");
    const T = typeOf(r);
    w = HP.snap(w); h = HP.snap(h);
    if (!(w > 0 && h > 0)) return fail(plan, "Type a size in metres, for example 3.60.");
    if (w < T.hardMin || h < T.hardMin) return fail(plan, capital(aName(r.type)) + " must be at least " + m2(T.hardMin) + " m each way.");
    let s = plan;
    const notes = [];
    const grow = (cur, target, hi, lo) => {
      let need = target - cur;
      for (const [side, sg, whole] of [[hi, 1, false], [lo, -1, false], [hi, 1, true], [lo, -1, true]]) {
        if (!need) break;
        const m = moveEdges(s, edgeMembers(s, id, side, whole), sg * need);
        if (m.achieved) { s = m.state; need -= sg * m.achieved; if (m.note) notes.push(m.note); }
      }
    };
    grow(r.w, w, "E", "W");
    grow(r.h, h, "N", "S");
    // each wall move above rescues what it blocks; a window one move blocked may only find a
    // free wall after a later one, so look once more against the plan we started from
    if (s !== plan) rescueOpenings(plan, s, notes);
    const rr = findRoom(s, id);
    if (rr.w === w && rr.h === h) return done(s, null, joinNotes(notes));
    return res(s, false, r.name + " can only be " + m2(rr.w) + " x " + m2(rr.h) + " m here.", null, joinNotes(notes));
  }

  // ---------------------------------------------------------------- default openings
  const DOOR_PREF = { hall: 0, living: 1, reception: 2, kitchen: 3, bedroom: 4, bath: 5, wc: 6 };
  function nearestAt(slotList, want) {
    let best = null, bd = Infinity;
    for (const sl of slotList) {
      const at = HP.clamp(want, sl.a0, sl.a1), d = Math.abs(at - want);
      if (d < bd) { bd = d; best = { at, slot: sl }; }
    }
    return best;
  }
  function defaultSwing(s, roomId, facing) {
    const host = findRoom(s, roomId);
    return !isRoofed(host) && facing === "room" ? "out" : "in";
  }
  /* door + window for a newly placed room */
  function addDefaultOpenings(s, id) {
    const r = findRoom(s, id), T = typeOf(r), roofed = isRoofed(r);
    const A = HP.analyze(s);
    const runsOf = kinds => {
      const out = [];
      for (const side of SIDES) for (const run of A.sides[id][side]) if (kinds.includes(run.kind)) out.push({ side, run });
      return out;
    };
    const within = (sl, host, side, run) => {   // slots of host/side that lie inside this run
      const s0 = HP.sideInfo(host, side).s0;
      return sl.filter(x => x.a0 + s0 >= run.s0 && x.a1 + s0 <= run.s1);
    };
    let door = null;
    // 1. a shared wall with a roofed room -> inside door; 2. an open area; 3. the yard or street -> entrance
    const steps = [
      { kinds: ["room"], w: HP.DOORS.interior },
      { kinds: ["open"], w: HP.DOORS.interior },
      { kinds: ["yard", "street"], w: HP.DOORS.entrance },
    ];
    for (const st of steps) {
      if (door) break;
      if (st.kinds[0] === "open" && !roofed) continue;          // no door between two open areas
      const cands = runsOf(st.kinds).sort((p, q) => {
        const tp = p.run.other != null && findRoom(s, p.run.other), tq = q.run.other != null && findRoom(s, q.run.other);
        const pp = tp ? (DOOR_PREF[tp.type] ?? 9) : (p.run.kind === "yard" ? 0 : 1);
        const pq = tq ? (DOOR_PREF[tq.type] ?? 9) : (q.run.kind === "yard" ? 0 : 1);
        return pp - pq || (q.run.s1 - q.run.s0) - (p.run.s1 - p.run.s0);
      });
      for (const { side, run } of cands) {
        // a door between a roofed room and an open area is hosted by the roofed room
        const hostRoom = !roofed && run.kind === "room" ? findRoom(s, run.other) : r;
        const hostSide = hostRoom === r ? side : OPP[side];
        const sl = within(HP.analyze.slots(s, A, hostRoom.id, hostSide, "door", st.w, null), hostRoom, hostSide, run);
        const si = HP.sideInfo(hostRoom, hostSide);
        const pick = nearestAt(sl, HP.snap(run.s0 + 20 - si.s0));
        if (!pick) continue;
        door = { id: HP.newId(s, "o"), kind: "door", room: hostRoom.id, side: hostSide, at: pick.at, w: st.w,
                 hinge: "start", swing: "in" };
        s.openings.push(door);
        A.openings.push(HP.analyze.openingGeom(s, hostRoom, A.sides, door));
        break;
      }
    }
    // window: open > yard > street, the longest such wall, centred
    if (T.needsWindow && T.win && roofed) {
      let placed = false;
      for (const kind of ["open", "yard", "street"]) {
        if (placed) break;
        const cands = runsOf([kind]).sort((p, q) => (q.run.s1 - q.run.s0) - (p.run.s1 - p.run.s0));
        for (const { side, run } of cands) {
          const w = T.winDef, si = HP.sideInfo(r, side);
          const sl = within(HP.analyze.slots(s, A, id, side, "window", w, null), r, side, run);
          const pick = nearestAt(sl, HP.snap((run.s0 + run.s1) / 2 - w / 2 - si.s0));
          if (!pick) continue;
          s.openings.push({ id: HP.newId(s, "o"), kind: "window", room: id, side, at: pick.at, w });
          placed = true;
          break;
        }
      }
    }
  }

  function sizeLadder(T) {
    const [w0, h0] = T.size, m = T.hardMin;
    const out = [[w0, h0], [h0, w0]];
    for (const f of [0.85, 0.7, 0.55, 0.4]) {
      out.push([Math.max(m, HP.snap(w0 * f)), Math.max(m, HP.snap(h0 * f))]);
    }
    const seen = new Set();
    return out.filter(s => { const k = s.join("x"); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  /* does the rule panel accept a room of this type at w x h? */
  function sizeOk(type, w, h) {
    const T = HP.ROOM_TYPES[type], lo = Math.min(w, h), hi = Math.max(w, h);
    if (type === "bedroom") return lo >= R.bedroom.min && hi <= R.bedroom.max;
    if (type === "open") return lo >= R.openArea.shortMin && hi >= R.openArea.longMin;
    if (T.needsWindow && T.win) return hi >= T.win[0] + 2 * R.endClear;
    return true;
  }
  /* The biggest room of this type that fits in the free space AT pt (the room
     still contains pt): no bigger than its default size either way round, no
     smaller than its hard minimum. Sizes the rules accept come first. Edges
     are tried at contact with a neighbour's wall, at a full passage, or at the
     land edge, so whatever it ends up as is on the 5 cm grid. null = none. */
  function fitAt(plan, type, pt) {
    const T = HP.ROOM_TYPES[type], W = plan.walls, P = plotInfo(plan), rooms = plan.rooms;
    const [w0, h0] = T.size, big = Math.max(w0, h0), far = 2 * W.ext + R.minGap;
    const spans = axis => {
      const c = axis === "x" ? pt[0] : pt[1];
      const L = [], Rt = [];
      for (const b of rooms) {
        const b0 = axis === "x" ? b.x : b.y, b1 = b0 + (axis === "x" ? b.w : b.h);
        L.push(b1 + W.int, b1 + far); Rt.push(b0 - W.int, b0 - far);
      }
      for (const v of P.pts) {
        const q = axis === "x" ? v[0] : v[1];
        L.push(q + W.ext, q + W.ext + R.minGap); Rt.push(q - W.ext, q - W.ext - R.minGap);
      }
      const lefts = Array.from(new Set(L.filter(v => v <= c && onGrid(v)))).sort((a, b) => b - a).slice(0, 6);
      const rights = Array.from(new Set(Rt.filter(v => v >= c && onGrid(v)))).sort((a, b) => a - b).slice(0, 6);
      const out = [];
      for (const a of lefts) for (const b of rights) if (b - a >= T.hardMin && b - a <= big) out.push([a, b - a]);
      for (const len of [w0, h0]) {               // room to spare this way: full length, on pt or against a side
        out.push([HP.snap(c - len / 2), len]);
        for (const a of lefts) if (a + len >= c) out.push([a, len]);
        for (const b of rights) if (b - len <= c) out.push([b - len, len]);
      }
      const seen = new Set();
      return out.filter(([p, len]) => {
        const k = p + ":" + len;
        if (seen.has(k) || p > c || p + len < c) return false;
        seen.add(k); return true;
      });
    };
    const xs = spans("x"), ys = spans("y"), combos = [];
    for (const [x, w] of xs) for (const [y, h] of ys) {
      if (!((w <= w0 && h <= h0) || (w <= h0 && h <= w0))) continue;
      combos.push({ x, y, w, h, ok: sizeOk(type, w, h) ? 0 : 1, area: w * h,
                    d: Math.hypot(x + w / 2 - pt[0], y + h / 2 - pt[1]) });
    }
    combos.sort((p, q) => p.ok - q.ok || q.area - p.area || p.d - q.d || q.w - p.w || p.x - q.x || p.y - q.y);
    const t = { id: "\u0000new", type, x: 0, y: 0, w: 0, h: 0 };
    for (const c of combos) {
      Object.assign(t, { x: c.x, y: c.y, w: c.w, h: c.h });
      if (codeOne(t, rooms, P, W, null) === 0) return c;
    }
    return null;
  }

  /* A room dropped at pt: (a) its default size (either way round) on or near
     pt, still covering pt; (b) made smaller to fit the space at pt; (c) only
     then the nearest free spot anywhere. Then a door, a window, and any door or
     window of the neighbours that the new room blocks is moved. */
  function addRoom(plan, type, pt) {
    const T = HP.ROOM_TYPES[type];
    if (!T) return fail(plan, "That kind of room is not known.");
    const [w0, h0] = T.size;
    let spot = null, size = null, how = "";
    for (const [w, h] of w0 === h0 ? [[w0, h0]] : [[w0, h0], [h0, w0]]) {
      const box = { x0: HP.snapUp(pt[0] - w), x1: HP.snapDown(pt[0]), y0: HP.snapUp(pt[1] - h), y1: HP.snapDown(pt[1]) };
      spot = placeRoom(plan, { type, w, h }, HP.snap(pt[0] - w / 2), HP.snap(pt[1] - h / 2), 25, null, box);
      if (spot) { size = [w, h]; spot.exact = true; break; }
    }
    if (!spot) {
      const f = fitAt(plan, type, pt);
      if (f) { spot = { x: f.x, y: f.y, exact: true }; size = [f.w, f.h]; how = "fit"; }
    }
    if (!spot) {
      for (const [w, h] of sizeLadder(T)) {
        spot = placeRoom(plan, { type, w, h }, HP.snap(pt[0] - w / 2), HP.snap(pt[1] - h / 2), 25, null);
        if (spot) { size = [w, h]; how = "far"; break; }
      }
    }
    if (!spot) return fail(plan, "There is no free space for " + aName(type) + " here.");
    const s = HP.clone(plan);
    const id = HP.newId(s, "r");
    const name = HP.nextName(s, type);
    s.rooms.push({ id, type, name, x: spot.x, y: spot.y, w: size[0], h: size[1], furn: 0 });
    const notes = [];
    const The = capital(aName(type)).replace(/^An? /, "The ");
    if (how === "fit") notes.push(The + " was made " + m2(size[0]) + " x " + m2(size[1]) + " m to fit here.");
    else if (how === "far" && size[0] * size[1] < w0 * h0)
      notes.push("There was only room for a smaller " + T.label.toLowerCase() + " (" + m2(size[0]) + " x " + m2(size[1]) + " m), at the nearest free spot.");
    else if (how === "far") notes.push(The + " went to the nearest free spot.");
    // the neighbours' doors and windows the new room covers move first, so the shared
    // walls are free when the new room picks its own door
    rescueOpenings(plan, s, notes);
    addDefaultOpenings(s, id);
    return done(s, id, joinNotes(notes));
  }

  function removeRoom(plan, id) {
    const r = findRoom(plan, id);
    if (!r) return fail(plan, "That room is not in the plan.");
    const s = HP.clone(plan);
    s.rooms = s.rooms.filter(q => q.id !== id);
    s.openings = s.openings.filter(o => o.room !== id);
    // a narrow space that only this room filled would open up
    const after = legal(s);
    if (!after.ok && legal(plan).ok)
      return fail(plan, "Taking out " + r.name + " would leave a gap that is too narrow. " + after.reason);
    const notes = [];
    rescueOpenings(plan, s, notes);
    return done(s, null, joinNotes(notes));
  }

  function renameRoom(plan, id, name) {
    const r = findRoom(plan, id);
    if (!r) return fail(plan, "That room is not in the plan.");
    const t = String(name == null ? "" : name).trim().slice(0, 40);
    if (!t) return fail(plan, "A room needs a name.");
    if (t === r.name) return done(plan);
    const s = HP.clone(plan);
    findRoom(s, id).name = t;
    return done(s);
  }

  function setRoomType(plan, id, type) {
    const r = findRoom(plan, id), T = HP.ROOM_TYPES[type];
    if (!r) return fail(plan, "That room is not in the plan.");
    if (!T) return fail(plan, "That kind of room is not known.");
    if (r.type === type) return done(plan);
    if (r.w < T.hardMin || r.h < T.hardMin)
      return fail(plan, capital(aName(type)) + " must be at least " + m2(T.hardMin) + " m each way.");
    const s = HP.clone(plan), rr = findRoom(s, id);
    const old = typeOf(r);
    const auto = old && (rr.name === old.label || new RegExp("^" + old.label.replace(/[()]/g, "\\$&") + " \\d+$").test(rr.name));
    if (auto) rr.name = HP.nextName(s, type);
    rr.type = type; rr.furn = 0;
    const notes = [];
    fixWindows(s, [id], notes);
    rescueOpenings(plan, s, notes);
    return done(s, null, joinNotes(notes));
  }

  function setFurniture(plan, id, index) {
    const r = findRoom(plan, id);
    if (!r) return fail(plan, "That room is not in the plan.");
    const i = Math.max(0, Math.floor(+index) || 0);
    if ((r.furn | 0) === i) return done(plan);
    const s = HP.clone(plan);
    findRoom(s, id).furn = i;
    return done(s);
  }

  // ================================================================ doors and windows
  /* Where would an opening dropped at pt go? { ok, reason, placement, note } - no change.
     opts: tol (cm, default 40), exclude (id of an opening being moved), analysis,
     prefer (room id: on a shared wall this room keeps a door on a tie, and until pt is
     more than 5 cm past the wall's centre line - so a door slid along its wall stays put). */
  function checkOpening(plan, kind, w, pt, opts) {
    opts = opts || {};
    if (kind !== "door" && kind !== "window") return { ok: false, reason: "Only doors and windows go on walls.", placement: null, note: "" };
    const tol = opts.tol != null ? opts.tol : 40;
    const A = opts.analysis || HP.analyze(plan);
    const exclude = opts.exclude || null, prefer = opts.prefer || null;
    const W = plan.walls, thickMax = Math.max(W.ext, W.int);
    w = HP.snap(w);
    if (!(w > 0)) return { ok: false, reason: "That size is not possible.", placement: null, note: "" };
    let best = null, near = null;
    for (const r of plan.rooms) for (const side of SIDES) {
      const si = HP.sideInfo(r, side), sg = SIGN[side];
      const along = si.axis === "x" ? pt[0] : pt[1], across = si.axis === "x" ? pt[1] : pt[0];
      const b0 = Math.min(si.fixed, si.fixed + sg * thickMax), b1 = Math.max(si.fixed, si.fixed + sg * thickMax);
      const dA = along < si.s0 ? si.s0 - along : along > si.s1 ? along - si.s1 : 0;
      const dX = across < b0 ? b0 - across : across > b1 ? across - b1 : 0;
      const dist = Math.hypot(dA, dX);
      if (dist > tol) continue;
      const own = (across - si.fixed) * sg <= W.int / 2;            // pt on this room's half of the wall
      let ww = w, why = null;
      if (kind === "window") {
        ww = fitWindowWidth(w, r.type);
        if (ww == null) why = "Windows go in rooms, not in an open area.";
      }
      let found = false;
      if (!why) {
        for (const sl of HP.analyze.slots(plan, A, r.id, side, kind, ww, exclude)) {
          if (kind === "door" && (sl.facing === "room" || sl.facing === "open")) {
            const past = (across - (si.fixed + sg * W.int / 2)) * sg;      // > 0: pt is on the far room's half
            if (past > (r.id === prefer ? HP.GRID : 0)) continue;         // the room across hosts it
          }
          const at = HP.clamp(HP.snap(along - ww / 2 - si.s0), sl.a0, sl.a1);
          const d = Math.hypot(si.s0 + at + ww / 2 - along, si.fixed + sg * sl.thick / 2 - across);
          found = true;
          const tie = best && Math.abs(d - best.d) <= 1e-9;
          if (!best || d < best.d - 1e-9 || (tie && r.id === prefer && best.room !== prefer))
            best = { d, room: r.id, side, at, w: ww, facing: sl.facing, type: r.type };
        }
      }
      if (!found) {
        if (!why) {
          const runs = A.sides[r.id][side];
          const s = HP.clamp(along, si.s0, si.s1 - 0.001);
          const run = runs.find(x => x.s0 <= s && s < x.s1) || runs[0];
          const f = run ? run.kind : "blocked";
          why = !(HP.analyze.ALLOW[f] || {})[kind] ? HP.analyze.reasonFor(f, kind)
              : "There is no space for a " + m2(ww) + " m " + word(kind) + " on this wall.";
        }
        if (!near || dist < near.dist - 1e-9 || (Math.abs(dist - near.dist) < 1e-9 && own && !near.own)) near = { dist, own, why };
      }
    }
    if (best) {
      const note = kind === "window" && best.w !== w ? widthNote(best.type, best.w) : "";
      return { ok: true, reason: "", placement: { room: best.room, side: best.side, at: best.at, w: best.w },
               facing: best.facing, note };
    }
    return { ok: false, reason: near ? near.why : "Drop the " + word(kind) + " onto a wall.", placement: null, note: "" };
  }

  function addOpening(plan, kind, w, pt, opts) {
    const c = checkOpening(plan, kind, w, pt, opts);
    if (!c.ok) return fail(plan, c.reason);
    const s = HP.clone(plan), p = c.placement;
    const id = HP.newId(s, "o");
    const o = { id, kind, room: p.room, side: p.side, at: p.at, w: p.w };
    if (kind === "door") { o.hinge = "start"; o.swing = defaultSwing(s, p.room, c.facing); }
    s.openings.push(o);
    return done(s, id, c.note);
  }

  function moveOpening(plan, id, pt, opts) {
    const o = findOpening(plan, id);
    if (!o) return fail(plan, "That door or window is not in the plan.");
    const c = checkOpening(plan, o.kind, o.w, pt, Object.assign({}, opts || {}, { exclude: id, prefer: o.room }));
    if (!c.ok) return fail(plan, c.reason);
    const p = c.placement;
    if (p.room === o.room && p.side === o.side && p.at === o.at && p.w === o.w) return done(plan);
    const s = HP.clone(plan), oo = findOpening(s, id);
    if (oo.kind === "door" && p.room !== o.room) {
      // the hinge always stays. Pulled across to the other face of the SAME wall, the swing
      // flips so the leaf still opens into the same room; on another wall it starts fresh.
      const was = HP.sideInfo(findRoom(plan, o.room), o.side), now = HP.sideInfo(findRoom(plan, p.room), p.side);
      const sameWall = p.side === OPP[o.side] && now.fixed === was.fixed + SIGN[o.side] * plan.walls.int;
      oo.swing = sameWall ? (o.swing === "out" ? "in" : "out") : defaultSwing(s, p.room, c.facing);
    }
    oo.room = p.room; oo.side = p.side; oo.at = p.at; oo.w = p.w;
    return done(s, null, c.note);
  }

  function setOpening(plan, id, props) {
    const o = findOpening(plan, id);
    if (!o) return fail(plan, "That door or window is not in the plan.");
    props = props || {};
    const s = HP.clone(plan), oo = findOpening(s, id);
    let note = "";
    if (o.kind === "door") {
      if (props.hinge === "start" || props.hinge === "end") oo.hinge = props.hinge;
      if (props.swing === "in" || props.swing === "out") oo.swing = props.swing;
    }
    if (props.w != null && HP.snap(props.w) !== o.w) {
      const nw = HP.snap(props.w);
      if (!(nw > 0)) return fail(plan, "That size is not possible.");
      const host = findRoom(plan, o.room);
      const A = HP.analyze(plan), g = A.openings.find(x => x.id === id);
      const si = HP.sideInfo(host, o.side), L = sideLen(host, o.side);
      const want = HP.snap(g.s0 + g.w / 2 - nw / 2 - si.s0);
      if (g.ok) {
        const pick = nearestAt(HP.analyze.slots(plan, A, o.room, o.side, o.kind, nw, id), want);
        if (!pick) return fail(plan, "A " + m2(nw) + " m " + word(o.kind) + " does not fit here.");
        oo.at = pick.at;
      } else {
        if (nw > L) return fail(plan, "A " + m2(nw) + " m " + word(o.kind) + " does not fit on this wall.");
        oo.at = HP.clamp(want, 0, L - nw);
      }
      oo.w = nw;
      const T = typeOf(host);
      if (o.kind === "window" && T && T.win && (nw < T.win[0] || nw > T.win[1]))
        note = T.label + " windows should be " + rangeTxt(T.win) + ".";
    }
    if (JSON.stringify(oo) === JSON.stringify(o)) return done(plan);
    return done(s, null, note);
  }

  function flipDoor(plan, id, what) {
    const o = findOpening(plan, id);
    if (!o || o.kind !== "door") return fail(plan, "Only doors can be flipped.");
    const s = HP.clone(plan), oo = findOpening(s, id);
    if (what === "hinge") oo.hinge = o.hinge === "end" ? "start" : "end";
    else oo.swing = o.swing === "out" ? "in" : "out";
    return done(s);
  }

  function removeOpening(plan, id) {
    if (!findOpening(plan, id)) return fail(plan, "That door or window is not in the plan.");
    const s = HP.clone(plan);
    s.openings = s.openings.filter(o => o.id !== id);
    return done(s);
  }

  // ================================================================ sections
  function houseBox(plan) {
    const e = plan.walls.ext;
    if (!plan.rooms.length) {
      const P = plotInfo(plan);
      return { x0: P.x0, y0: P.y0, x1: P.x1, y1: P.y1 };
    }
    return {
      x0: Math.min.apply(null, plan.rooms.map(r => r.x - e)), y0: Math.min.apply(null, plan.rooms.map(r => r.y - e)),
      x1: Math.max.apply(null, plan.rooms.map(r => r.x + r.w + e)), y1: Math.max.apply(null, plan.rooms.map(r => r.y + r.h + e)),
    };
  }
  function freeLabel(s) {
    const taken = new Set(s.sections.map(x => x.label));
    const AZ = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const c of AZ) if (!taken.has(c)) return c;
    for (const a of AZ) for (const b of AZ) if (!taken.has(a + b)) return a + b;
    return "S" + s.seq;
  }
  const snapPt = p => [HP.snap(p[0]), HP.snap(p[1])];

  /* how far a section line reaches: the house (or the land when there are no
     rooms) plus 1.50 m at each end, along x (k = 0) or y (k = 1) */
  const SECTION_OVER = 150;
  function sectionExtent(plan, k) {
    const B = houseBox(plan);
    return k ? [HP.snap(B.y0 - SECTION_OVER), HP.snap(B.y1 + SECTION_OVER)]
             : [HP.snap(B.x0 - SECTION_OVER), HP.snap(B.x1 + SECTION_OVER)];
  }

  function addSection(plan, pt) {
    const x = HP.snap(pt[0]), [y0, y1] = sectionExtent(plan, 1);
    const s = HP.clone(plan);
    const id = HP.newId(s, "s");
    s.sections.push({ id, label: freeLabel(s), a: [x, y0], b: [x, y1], look: 1 });
    return done(s, id);
  }

  function moveSection(plan, id, change) {
    const sec = findSection(plan, id);
    if (!sec) return fail(plan, "That section is not in the plan.");
    change = change || {};
    let a = sec.a.slice(), b = sec.b.slice();
    if (change.dx || change.dy) {
      const dx = HP.snap(change.dx || 0), dy = HP.snap(change.dy || 0);
      a = [a[0] + dx, a[1] + dy]; b = [b[0] + dx, b[1] + dy];
    }
    if (change.a) a = snapPt(change.a);
    if (change.b) b = snapPt(change.b);
    if (a[0] !== b[0] && a[1] !== b[1]) {            // keep it horizontal or vertical
      const horiz = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
      if (change.a && !change.b) { if (horiz) a[1] = b[1]; else a[0] = b[0]; }
      else { if (horiz) b[1] = a[1]; else b[0] = a[0]; }
    }
    if (a[0] === b[0] && a[1] === b[1]) return fail(plan, "A section line needs some length.");
    if (a[0] === sec.a[0] && a[1] === sec.a[1] && b[0] === sec.b[0] && b[1] === sec.b[1]) return done(plan);
    const s = HP.clone(plan), ss = findSection(s, id);
    ss.a = a; ss.b = b;
    return done(s);
  }
  function flipSection(plan, id) {
    const sec = findSection(plan, id);
    if (!sec) return fail(plan, "That section is not in the plan.");
    const s = HP.clone(plan);
    findSection(s, id).look = sec.look === -1 ? 1 : -1;
    return done(s);
  }
  function turnSection(plan, id) {
    const sec = findSection(plan, id);
    if (!sec) return fail(plan, "That section is not in the plan.");
    const v = [-(sec.b[1] - sec.a[1]), sec.b[0] - sec.a[0]];          // a->b turned 90 degrees CCW
    const mid = [(sec.a[0] + sec.b[0]) / 2, (sec.a[1] + sec.b[1]) / 2];
    const a = snapPt([mid[0] - v[0] / 2, mid[1] - v[1] / 2]), b = [a[0] + v[0], a[1] + v[1]];
    // turned about its middle a long line can stick out past the land: keep it to the same
    // reach addSection gives (the house + 1.50 m each end); if that leaves too little of it,
    // it takes the whole reach
    const k = a[0] === b[0] ? 1 : 0, up = b[k] >= a[k];
    const [lo, hi] = sectionExtent(plan, k);
    let s0 = Math.max(Math.min(a[k], b[k]), lo), s1 = Math.min(Math.max(a[k], b[k]), hi);
    if (s1 - s0 < 100) { s0 = lo; s1 = hi; }
    a[k] = up ? s0 : s1; b[k] = up ? s1 : s0;
    const s = HP.clone(plan), ss = findSection(s, id);
    ss.a = a; ss.b = b;
    return done(s);
  }
  function removeSection(plan, id) {
    if (!findSection(plan, id)) return fail(plan, "That section is not in the plan.");
    const s = HP.clone(plan);
    s.sections = s.sections.filter(x => x.id !== id);
    return done(s);
  }
  function setSectionLabel(plan, id, label) {
    const sec = findSection(plan, id);
    if (!sec) return fail(plan, "That section is not in the plan.");
    const t = String(label == null ? "" : label).trim().toUpperCase();
    if (!t) return fail(plan, "A section needs a letter.");
    if (t.length > 3) return fail(plan, "Use one to three letters.");
    if (t === sec.label) return done(plan);
    if (plan.sections.some(x => x.id !== id && x.label === t)) return fail(plan, "There is already a section " + t + ".");
    const s = HP.clone(plan);
    findSection(s, id).label = t;
    return done(s);
  }

  // ================================================================ land
  function segsTouch(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    const on = (p, q, r) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) &&
                            Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
    const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
    if (o1 !== o2 && o3 !== o4 && o1 * o2 <= 0 && o3 * o4 <= 0 && (o1 || o2) && (o3 || o4)) return true;
    return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
  }
  /* why a land outline is not usable, or "" */
  function badOutline(pts) {
    const n = pts.length;
    if (n < 3) return "The land needs at least 3 corners.";
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
      if (a[0] === b[0] && a[1] === b[1]) return "Two land corners are on the same spot.";
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
      if (cr === 0 && dot < 0) return "The land outline can't fold back on itself.";
    }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segsTouch(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return "The land outline can't cross itself.";
    }
    if (HP.polyArea(pts) <= 0) return "That corner can't go there - the land would fold over.";
    return "";
  }
  function withPlot(plan, pts, edges, label) {
    const why = badOutline(pts);
    if (why) return fail(plan, why);
    const s = HP.clone(plan);
    s.plot.pts = pts; s.plot.edges = edges;
    const P = plotInfo(s), W = s.walls;
    for (const r of s.rooms) {
      const c = plotCode(r, P, W, s.rooms);
      if (c === 2) return fail(plan, r.name + " would end up outside the land.");
      if (c === 1) return fail(plan, r.name + " would be less than " + m2(R.minGap) + " m from the land edge.");
    }
    const notes = [];
    rescueOpenings(plan, s, notes);
    return done(s, null, joinNotes(notes));
  }

  /* street/neighbour for the 4 sides of a new rectangle (bottom, right, top,
     left): each takes the kind of the longest old side that faces the same way */
  function rectEdges(plan) {
    const pts = plan.plot.pts, kinds = plan.plot.edges || [], n = pts.length;
    const turn = HP.polyArea(pts) >= 0 ? 1 : -1;
    return [[0, -1], [1, 0], [0, 1], [-1, 0]].map(([nx, ny]) => {
      let kind = "neighbour", longest = 0;
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        if (!len) continue;
        if ((turn * dy * nx - turn * dx * ny) / len < 0.7) continue;   // outward normal not this way
        if (len > longest) { longest = len; kind = kinds[i] === "street" ? "street" : "neighbour"; }
      }
      return kind;
    });
  }
  /* The land as a w x d rectangle. Its lower-left corner stays where the
     land's lower-left (of its bounding box) is now, so "make it a rectangle"
     on a land with a corner at y = -1.00 still starts at -1.00. */
  function setPlotRect(plan, w, d) {
    w = HP.snap(w); d = HP.snap(d);
    if (!(w >= 300 && d >= 300)) return fail(plan, "The land must be at least 3.00 x 3.00 m.");
    if (w > 20000 || d > 20000) return fail(plan, "The land can be at most 200 m each way.");
    const P = plotInfo(plan), x0 = P.x0, y0 = P.y0;
    const pts = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + d], [x0, y0 + d]];
    const same = plan.plot.pts.length === 4 && pts.every((p, i) => p[0] === plan.plot.pts[i][0] && p[1] === plan.plot.pts[i][1]);
    if (same) return done(plan);
    return withPlot(plan, pts, rectEdges(plan));
  }
  function movePlotCorner(plan, i, pt) {
    const n = plan.plot.pts.length;
    if (!(i >= 0 && i < n)) return fail(plan, "That corner is not there.");
    const q = snapPt(pt);
    const old = plan.plot.pts[i];
    if (q[0] === old[0] && q[1] === old[1]) return done(plan);
    const pts = plan.plot.pts.map((p, k) => (k === i ? q : p.slice()));
    return withPlot(plan, pts, plan.plot.edges.slice());
  }
  function addPlotCorner(plan, edgeIndex, pt) {
    const n = plan.plot.pts.length;
    if (!(edgeIndex >= 0 && edgeIndex < n)) return fail(plan, "That side of the land is not there.");
    const pts = plan.plot.pts.map(p => p.slice()), edges = plan.plot.edges.slice();
    while (edges.length < n) edges.push("neighbour");
    pts.splice(edgeIndex + 1, 0, snapPt(pt));
    edges.splice(edgeIndex + 1, 0, edges[edgeIndex]);
    return withPlot(plan, pts, edges);
  }
  function removePlotCorner(plan, i) {
    const n = plan.plot.pts.length;
    if (!(i >= 0 && i < n)) return fail(plan, "That corner is not there.");
    if (n <= 3) return fail(plan, "The land needs at least 3 corners.");
    const pts = plan.plot.pts.map(p => p.slice()), edges = plan.plot.edges.slice();
    while (edges.length < n) edges.push("neighbour");
    pts.splice(i, 1);
    edges.splice(i, 1);                     // the edge from the corner before now runs to the corner after
    return withPlot(plan, pts, edges);
  }
  function setEdgeKind(plan, i, kind) {
    if (!(i >= 0 && i < plan.plot.pts.length)) return fail(plan, "That side of the land is not there.");
    if (kind !== "street" && kind !== "neighbour") return fail(plan, "A side of the land is a street or a neighbour.");
    if (plan.plot.edges[i] === kind) return done(plan);
    const s = HP.clone(plan);
    while (s.plot.edges.length < s.plot.pts.length) s.plot.edges.push("neighbour");
    s.plot.edges[i] = kind;
    const notes = [];
    rescueOpenings(plan, s, notes);
    return done(s, null, joinNotes(notes));
  }
  function setRoad(plan, cm) {
    const v = HP.clamp(HP.snap(+cm || 0), 0, 5000);
    if (v === plan.plot.road) return done(plan);
    const s = HP.clone(plan);
    s.plot.road = v;
    return done(s);
  }

  /* New wall thicknesses. Every shared wall keeps its rooms walls.int apart by
     moving the edge of the room on its east/north side; rooms that stand on
     the land edge keep their outer face on it. Refused when the plan would
     not stay legal. */
  function setWalls(plan, ext, int) {
    ext = HP.snap(ext); int = HP.snap(int);
    if (!(ext >= 10 && int >= 10)) return fail(plan, "Walls must be at least 0.10 m thick.");
    if (ext > 100 || int > 100) return fail(plan, "Walls can be at most 1.00 m thick.");
    if (int > 2 * ext) return fail(plan, "Inside walls can't be more than twice as thick as outside walls.");
    const W0 = plan.walls;
    if (ext === W0.ext && int === W0.int) return done(plan);
    const dI = int - W0.int, dE = ext - W0.ext;
    const rooms = plan.rooms;
    const moveW = new Set(), moveS = new Set();
    for (const a of rooms) for (const b of rooms) {
      if (a === b) continue;
      const yOv = HP.spanOverlap(a.y, a.y + a.h, b.y, b.y + b.h), xOv = HP.spanOverlap(a.x, a.x + a.w, b.x, b.x + b.w);
      const gapX = b.x - (a.x + a.w), gapY = b.y - (a.y + a.h);
      const gapYabs = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h)), gapXabs = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
      if (gapX === W0.int && (yOv > 0 || gapYabs === W0.int)) moveW.add(b.id);
      if (gapY === W0.int && (xOv > 0 || gapXabs === W0.int)) moveS.add(b.id);
    }
    const P = plotInfo(plan);
    const s = HP.clone(plan);
    const oldRects = new Map(rooms.map(r => [r.id, { x: r.x, y: r.y, w: r.w, h: r.h }]));
    for (const r of s.rooms) {
      const o = oldRects.get(r.id);
      const gx0 = o.x - W0.ext, gx1 = o.x + o.w + W0.ext, gy0 = o.y - W0.ext, gy1 = o.y + o.h + W0.ext;
      const onV = x => P.vEdges.some(e => e.x === x && HP.spanOverlap(e.y0, e.y1, gy0, gy1) > 0);
      const onH = y => P.hEdges.some(e => e.y === y && HP.spanOverlap(e.x0, e.x1, gx0, gx1) > 0);
      let dW = moveW.has(r.id) ? dI : 0, dS = moveS.has(r.id) ? dI : 0, dEast = 0, dN = 0;
      if (onV(gx0)) dW += dE;
      if (onH(gy0)) dS += dE;
      if (onV(gx1)) dEast -= dE;
      if (onH(gy1)) dN -= dE;
      r.x = o.x + dW; r.w = o.w - dW + dEast;
      r.y = o.y + dS; r.h = o.h - dS + dN;
    }
    s.walls = { ext, int };
    const L = legal(s);
    if (!L.ok) return fail(plan, "Walls that thick don't fit this plan: " + L.reason.charAt(0).toLowerCase() + L.reason.slice(1));
    const notes = [];
    refitOpenings(s, oldRects, notes);
    rescueOpenings(plan, s, notes);
    return done(s, null, joinNotes(notes));
  }

  function setTitle(plan, title) {
    const t = String(title == null ? "" : title).trim().slice(0, 80) || "House plan";
    if (plan.meta && plan.meta.title === t) return done(plan);
    const s = HP.clone(plan);
    s.meta = Object.assign({}, s.meta, { title: t });
    return done(s);
  }

  HP.model = {
    legal, fitWindowWidth,
    addRoom, moveRoom, swapRooms, dragWall, setRoomSize, removeRoom, renameRoom, setRoomType, setFurniture,
    checkOpening, addOpening, moveOpening, setOpening, flipDoor, removeOpening,
    addSection, moveSection, flipSection, turnSection, removeSection, setSectionLabel,
    setPlotRect, movePlotCorner, addPlotCorner, removePlotCorner, setEdgeKind, setRoad, setWalls, setTitle,
    _internal: { pairCode, plotCode, plotInfo, moveEdges, placeRoom, settleRoom, badOutline },
  };
})(globalThis.HP = globalThis.HP || {});

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.HP;
