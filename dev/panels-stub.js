"use strict";
/* ============================================================================
   House Planner - dev/panels-stub.js   (panels agent, DEV ONLY)
   ----------------------------------------------------------------------------
   Stand-ins for modules the panels call, written against CONTRACT.md, so the
   panels can be exercised before the real modules exist. Each stand-in is
   installed ONLY when the real module is missing (load this after the real
   src/*.js files). Never loaded by index.html or House Planner.html.
   HP.__stubs lists what was stood in.
============================================================================ */
(function (HP) {
  const stubs = [];
  // ?stub=canvas,model forces a stand-in even when the real module loaded
  const forced = ((typeof location !== "undefined" && /[?&]stub=([^&]*)/.exec(location.search)) || [, ""])[1].split(",");
  for (const f of forced) if (f && HP[f]) { HP["__real_" + f] = HP[f]; delete HP[f]; }
  const res = (state, ok, reason, id, note) => ({ state, ok: ok !== false, reason: reason || "", id: id || null, note: note || "" });
  const findRoom = (P, id) => P.rooms.find(r => r.id === id);
  const fm = cm => HP.fmtM(cm);

  // ------------------------------------------------------------ model
  if (!HP.model) {
    stubs.push("model");
    const fitsLand = (P, r) => HP.rectInPoly(HP.grow(r, P.walls.ext), P.plot.pts);
    HP.model = {
      setTitle(P, t) { const s = HP.clone(P); s.meta.title = String(t); return res(s); },
      setPlotRect(P, w, d) {
        w = HP.snap(w); d = HP.snap(d);
        if (w < 300 || d < 300) return res(P, false, "The land must be at least 3.00 m each way.");
        const s = HP.clone(P);
        s.plot.pts = HP.rectPlot(w, d);
        if (s.plot.edges.length !== 4) s.plot.edges = ["street", "neighbour", "neighbour", "neighbour"];
        if (s.rooms.some(r => !fitsLand(s, r))) return res(P, false, "The land can't be smaller than the house.");
        return res(s);
      },
      movePlotCorner(P, i, pt) {
        const s = HP.clone(P); s.plot.pts[i] = [HP.snap(pt[0]), HP.snap(pt[1])];
        if (HP.polyArea(s.plot.pts) <= 0) return res(P, false, "The land would turn inside out.");
        if (s.rooms.some(r => !fitsLand(s, r))) return res(P, false, "That corner would cut through the house.");
        return res(s);
      },
      addPlotCorner(P, i, pt) {
        const s = HP.clone(P);
        s.plot.pts.splice(i + 1, 0, [HP.snap(pt[0]), HP.snap(pt[1])]);
        s.plot.edges.splice(i + 1, 0, s.plot.edges[i]);
        return res(s, true, "", null, "Corner added. Drag it on the drawing.");
      },
      removePlotCorner(P, i) {
        if (P.plot.pts.length <= 3) return res(P, false, "Land needs at least 3 corners.");
        const s = HP.clone(P); s.plot.pts.splice(i, 1); s.plot.edges.splice(i, 1);
        if (s.rooms.some(r => !fitsLand(s, r))) return res(P, false, "Removing that corner would cut through the house.");
        return res(s);
      },
      setEdgeKind(P, i, kind) {
        if (P.plot.edges[i] === kind) return res(P);
        const s = HP.clone(P); s.plot.edges[i] = kind;
        let note = "";
        if (kind === "neighbour") {
          const n = (P.openings || []).length;   // the real model re-checks the openings; this stub only says so
          if (n) note = "Check the doors and windows on that side.";
        }
        return res(s, true, "", null, note);
      },
      setRoad(P, cm) {
        const v = HP.clamp(HP.snap(cm), 300, 3000);
        const s = HP.clone(P); s.plot.road = v;
        return res(s, v === HP.snap(cm), v !== HP.snap(cm) ? "A road is 3.00 to 30.00 m wide." : "");
      },
      setWalls(P, ext, int) { const s = HP.clone(P); s.walls = { ext, int }; return res(s); },
      setRoomSize(P, id, w, h) {
        const r0 = findRoom(P, id); if (!r0) return res(P, false, "That room is gone.");
        const T = HP.ROOM_TYPES[r0.type];
        let ok = true, reason = "";
        if (w < T.hardMin || h < T.hardMin) { ok = false; reason = "A " + T.label.toLowerCase() + " can't be smaller than " + fm(T.hardMin) + " m."; }
        const s = HP.clone(P), r = findRoom(s, id);
        r.w = Math.max(T.hardMin, HP.snap(w)); r.h = Math.max(T.hardMin, HP.snap(h));
        if (!fitsLand(s, r)) return res(P, false, "There is no room for that on the land.");
        if (s.rooms.some(o => o.id !== id && HP.rectsOverlap(HP.grow(o, 10), HP.grow(r, 10)))) return res(P, false, "It would run into another room.");
        return res(s, ok, reason);
      },
      renameRoom(P, id, name) { const s = HP.clone(P); findRoom(s, id).name = name; return res(s); },
      setRoomType(P, id, type) {
        const s = HP.clone(P), r = findRoom(s, id); r.type = type; r.furn = 0;
        return res(s, true, "", null, "It is a " + HP.ROOM_TYPES[type].label.toLowerCase() + " now.");
      },
      setFurniture(P, id, i) { const s = HP.clone(P); findRoom(s, id).furn = i; return res(s); },
      removeRoom(P, id) {
        const s = HP.clone(P);
        s.rooms = s.rooms.filter(r => r.id !== id); s.openings = s.openings.filter(o => o.room !== id);
        return res(s);
      },
      addRoom(P, type, pt) {
        const T = HP.ROOM_TYPES[type], s = HP.clone(P);
        const [w, h] = T.size;
        const r = { id: HP.newId(s, "r"), type, name: HP.nextName(s, type), x: HP.snap(pt[0] - w / 2), y: HP.snap(pt[1] - h / 2), w, h, furn: 0 };
        s.rooms.push(r);
        if (T.roofed) {
          s.openings.push({ id: HP.newId(s, "o"), kind: "door", room: r.id, side: "S", at: 20, w: 80, hinge: "start", swing: "in" });
          if (T.win) s.openings.push({ id: HP.newId(s, "o"), kind: "window", room: r.id, side: "N", at: 30, w: T.winDef });
        }
        return res(s, true, "", r.id);
      },
      addOpening(P, kind, w, pt) {
        let best = null;
        for (const r of P.rooms) for (const side of HP.SIDES) {
          const si = HP.sideInfo(r, side), along = si.axis === "x" ? pt[0] : pt[1], across = si.axis === "x" ? pt[1] : pt[0];
          const d = Math.abs(across - si.fixed) + Math.max(0, si.s0 - along, along - si.s1);
          if (si.s1 - si.s0 >= w + 20 && (!best || d < best.d)) best = { d, r, side, si, along };
        }
        if (!best) return res(P, false, "Drop it on a wall.");
        const s = HP.clone(P);
        const at = HP.clamp(HP.snap(best.along - best.si.s0 - w / 2), 10, best.si.s1 - best.si.s0 - w - 10);
        const o = { id: HP.newId(s, "o"), kind, room: best.r.id, side: best.side, at, w };
        if (kind === "door") Object.assign(o, { hinge: "start", swing: "in" });
        s.openings.push(o);
        return res(s, true, "", o.id);
      },
      setOpening(P, id, ch) {
        const s = HP.clone(P), o = s.openings.find(x => x.id === id); if (!o) return res(P, false, "That is gone.");
        Object.assign(o, ch);
        const r = findRoom(s, o.room), si = HP.sideInfo(r, o.side);
        if (o.at + o.w > si.s1 - si.s0 - 10) {
          if (o.w > si.s1 - si.s0 - 20) return res(P, false, "That is wider than the wall.");
          o.at = si.s1 - si.s0 - 10 - o.w;
        }
        return res(s);
      },
      flipDoor(P, id, what) {
        const s = HP.clone(P), o = s.openings.find(x => x.id === id);
        if (what === "hinge") o.hinge = o.hinge === "end" ? "start" : "end"; else o.swing = o.swing === "out" ? "in" : "out";
        return res(s);
      },
      removeOpening(P, id) { const s = HP.clone(P); s.openings = s.openings.filter(o => o.id !== id); return res(s); },
      addSection(P, pt) {
        const s = HP.clone(P), used = new Set(s.sections.map(x => x.label));
        let L = "A"; while (used.has(L)) L = String.fromCharCode(L.charCodeAt(0) + 1);
        const x = HP.snap(pt[0]);
        const sc = { id: HP.newId(s, "s"), label: L, a: [x, HP.snap(pt[1] - 600)], b: [x, HP.snap(pt[1] + 600)], look: 1 };
        s.sections.push(sc); return res(s, true, "", sc.id);
      },
      setSectionLabel(P, id, label) {
        if (!/^[A-Z]{1,2}$/.test(label)) return res(P, false, "Use one or two letters, like A.");
        if (P.sections.some(x => x.id !== id && x.label === label)) return res(P, false, "Another section already uses " + label + ".");
        const s = HP.clone(P); s.sections.find(x => x.id === id).label = label; return res(s);
      },
      flipSection(P, id) { const s = HP.clone(P), x = s.sections.find(q => q.id === id); x.look = -x.look; return res(s); },
      turnSection(P, id) {
        const s = HP.clone(P), x = s.sections.find(q => q.id === id);
        const cx = (x.a[0] + x.b[0]) / 2, cy = (x.a[1] + x.b[1]) / 2;
        const rot = p => [HP.snap(cx - (p[1] - cy)), HP.snap(cy + (p[0] - cx))];
        x.a = rot(x.a); x.b = rot(x.b); return res(s);
      },
      removeSection(P, id) { const s = HP.clone(P); s.sections = s.sections.filter(x => x.id !== id); return res(s); },
    };
  }

  // ------------------------------------------------------------ furniture
  if (!HP.furniture) {
    stubs.push("furniture");
    const V = {
      bedroom: ["Bed on the back wall", "Bed on the side wall", "Two single beds"],
      living: ["Sofas in an L", "Sofas facing"], reception: ["Sofas round the room", "Two groups"],
      kitchen: ["L counter", "One wall", "Two walls"], bath: ["Bath", "Shower"], wc: ["Toilet and basin"],
    };
    HP.furniture = { variants: t => [{ key: "auto", label: "Automatic" }].concat((V[t] || []).map((l, i) => ({ key: "v" + i, label: l }))) };
  }

  // ------------------------------------------------------------ dxf (a tiny R12 file, enough to test the button)
  if (!HP.dxf) {
    stubs.push("dxf");
    HP.dxf = {
      write(drawing, opts) {
        const k = { m: 1, cm: 100, mm: 1000 }[(opts && opts.units) || "m"];
        const out = ["0", "SECTION", "2", "HEADER", "999", "STUB DXF from dev/panels-stub.js", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"];
        for (const it of drawing.items || []) {
          if (it.kind === "line") out.push("0", "LINE", "8", it.layer || "0", "10", it.a[0] * k, "20", it.a[1] * k, "11", it.b[0] * k, "21", it.b[1] * k);
        }
        out.push("0", "ENDSEC", "0", "EOF");
        return out.join("\r\n") + "\r\n";
      },
    };
  }
  if (!HP.drawing) {
    stubs.push("drawing");
    HP.drawing = {
      build(P) {
        const items = [];
        for (const r of P.rooms) {
          const x0 = r.x / 100, y0 = r.y / 100, x1 = (r.x + r.w) / 100, y1 = (r.y + r.h) / 100;
          items.push({ kind: "line", layer: "A-WALL", a: [x0, y0], b: [x1, y0] }, { kind: "line", layer: "A-WALL", a: [x1, y0], b: [x1, y1] },
                     { kind: "line", layer: "A-WALL", a: [x1, y1], b: [x0, y1] }, { kind: "line", layer: "A-WALL", a: [x0, y1], b: [x0, y0] });
        }
        return { items, blocks: {}, extents: null };
      },
    };
  }

  // ------------------------------------------------------------ canvas (draws with the real render/drawing when present)
  if (!HP.canvas) {
    stubs.push("canvas");
    let stage, cv, ctx, view = { scale: 30, ox: 0, oy: 0 }, flash = null;
    const toWorld = (cx, cy) => {
      const b = cv.getBoundingClientRect();
      return [((cx - b.left) - view.ox) / view.scale * 100, (view.oy - (cy - b.top)) / view.scale * 100];
    };
    function emitView() { HP.store.emit("view", { scale: view.scale }); }
    function size() {
      const b = stage.getBoundingClientRect();
      cv.width = Math.max(1, b.width); cv.height = Math.max(1, b.height);
      cv.style.width = b.width + "px"; cv.style.height = b.height + "px";
    }
    function redraw() {
      if (!cv) return;
      size();
      const P = HP.store.get();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#0f1620"; ctx.fillRect(0, 0, cv.width, cv.height);
      const sel = HP.store.selection();
      const hi = new Set(flash || []); if (sel && sel.id != null) hi.add(sel.id);
      let drew = false;
      if (HP.render && HP.drawing && HP.analyze && !stubs.includes("drawing")) {
        try {
          const d = HP.drawing.build(P, HP.store.analysis(), {});
          HP.render.draw(ctx, d, { scale: view.scale, ox: view.ox, oy: view.oy, dpr: 1, w: cv.width, h: cv.height }, { highlight: hi });
          drew = true;
        } catch (e) { console.warn("[stub canvas] real drawing failed, plain view", e); }
      }
      if (!drew) {
        const X = x => view.ox + x / 100 * view.scale, Y = y => view.oy - y / 100 * view.scale;
        ctx.strokeStyle = "#5a6b82"; ctx.setLineDash([6, 4]); ctx.beginPath();
        P.plot.pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
        for (const r of P.rooms) {
          ctx.fillStyle = (HP.ROOM_TYPES[r.type] || {}).tint + "33"; ctx.fillRect(X(r.x), Y(r.y + r.h), r.w / 100 * view.scale, r.h / 100 * view.scale);
          ctx.strokeStyle = hi.has(r.id) ? "#46e0f0" : "#a04040"; ctx.lineWidth = hi.has(r.id) ? 2.5 : 1.2;
          ctx.strokeRect(X(r.x), Y(r.y + r.h), r.w / 100 * view.scale, r.h / 100 * view.scale);
          ctx.fillStyle = "#9a9ae4"; ctx.font = "12px Segoe UI"; ctx.textAlign = "center";
          ctx.fillText(r.name.toUpperCase(), X(r.x + r.w / 2), Y(r.y + r.h / 2));
        }
      }
      ctx.fillStyle = "rgba(224,165,66,.85)"; ctx.font = "11px Consolas"; ctx.textAlign = "left";
      ctx.fillText("DEV STAND-IN CANVAS (stubs: " + stubs.join(", ") + ")", 10, cv.height - 10);
    }
    function fit() {
      if (!stage) return;
      size();
      const pts = HP.store.get().plot.pts;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      const m = 90, wM = (x1 - x0) / 100, hM = (y1 - y0) / 100 + 9;      // + room for the street
      view.scale = Math.max(4, Math.min((cv.width - 2 * m) / wM, (cv.height - 2 * m) / hM));
      view.ox = cv.width / 2 - ((x0 + x1) / 200) * view.scale;
      view.oy = cv.height / 2 + ((y0 + y1) / 200 - 4) * view.scale;
      redraw(); emitView();
    }
    function hit(pt) {
      const P = HP.store.get();
      for (const o of P.openings) {
        const r = findRoom(P, o.room); if (!r) continue;
        const si = HP.sideInfo(r, o.side), a0 = si.s0 + o.at, a1 = a0 + o.w;
        const along = si.axis === "x" ? pt[0] : pt[1], across = si.axis === "x" ? pt[1] : pt[0];
        if (along >= a0 && along <= a1 && Math.abs(across - (si.fixed + si.n[si.axis === "x" ? 1 : 0] * 10)) < 25) return { kind: "opening", id: o.id };
      }
      for (const s of P.sections) {
        const d = Math.abs((s.b[0] - s.a[0]) * (s.a[1] - pt[1]) - (s.a[0] - pt[0]) * (s.b[1] - s.a[1])) / Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
        if (d < 25) return { kind: "section", id: s.id };
      }
      const r = P.rooms.find(q => HP.containsPt(q, pt));
      return r ? { kind: "room", id: r.id } : null;
    }
    function drop(item, pt) {
      const M = HP.model, P = HP.store.get(); let r;
      if (item.kind === "room") r = M.addRoom(P, item.type, pt);
      else if (item.kind === "door" || item.kind === "window") r = M.addOpening(P, item.kind, item.w, pt);
      else if (item.kind === "section") r = M.addSection(P, pt);
      if (!r) return;
      if (r.state !== P) HP.store.commit(r.state, "Add " + (item.type || item.kind));
      if (!r.ok) HP.store.toast(r.reason, "warn");
      if (r.id) HP.store.select({ kind: item.kind === "room" ? "room" : item.kind === "section" ? "section" : "opening", id: r.id });
    }
    HP.canvas = {
      init(el) {
        stage = el; cv = document.createElement("canvas"); cv.style.display = "block"; stage.appendChild(cv);
        ctx = cv.getContext("2d");
        HP.store.on("state", redraw); HP.store.on("select", redraw);
        window.addEventListener("resize", fit);
        cv.addEventListener("pointerdown", e => { HP.store.select(hit(toWorld(e.clientX, e.clientY))); });
        cv.addEventListener("wheel", e => { e.preventDefault(); HP.canvas.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
        HP.store.on("palette:start", ({ item, event }) => {
          HP.canvas.lastPaletteStart = { item, x: event.clientX, y: event.clientY, type: event.type };
          const up = e => {
            window.removeEventListener("pointerup", up);
            const b = cv.getBoundingClientRect();
            if (e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom) drop(item, toWorld(e.clientX, e.clientY));
          };
          window.addEventListener("pointerup", up);
        });
        HP.store.on("palette:click", ({ item }) => {
          HP.canvas.lastPaletteClick = item;
          const bb = HP.store.get().plot.pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
          const n = HP.store.get().plot.pts.length;
          drop(item, [bb[0] / n, bb[1] / n]);
        });
        window.addEventListener("keydown", e => {
          if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
          if (e.key === "f" || e.key === "F") fit();
        });
      },
      fit, redraw, toWorld,
      zoomBy(f) { const cx = cv.width / 2, cy = cv.height / 2; view.ox = cx + (view.ox - cx) * f; view.oy = cy + (view.oy - cy) * f; view.scale *= f; redraw(); emitView(); },
      focus(ids) { HP.canvas.lastFocus = ids.slice(); flash = ids.slice(); redraw(); setTimeout(() => { flash = null; redraw(); }, 1200); },
    };
  }

  HP.__stubs = stubs;
})(globalThis.HP = globalThis.HP || {});
