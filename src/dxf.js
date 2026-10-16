"use strict";
/* ============================================================================
   House Planner - dxf.js   (drafting agent)
   ----------------------------------------------------------------------------
   HP.dxf.write(drawing, opts) -> string      an AutoCAD 2018+ DXF (AC1032)

   drawing = HP.drawing.build(...)  (metres).  opts.units 'm' (default) | 'cm' |
   'mm' scales every length, the hatch patterns, the linetypes and the
   dimension style; dimension text always reads in metres (DIMLFAC).

   The file skeleton (header, classes, tables, handles, block records, layouts,
   objects) is a port of Inkline's Dxf.cs, which AutoCAD 2027 opened with
   AUDIT 0 errors. Extended with:
     - layers with their true colour (420) + nearest ACI (62), linetype,
       lineweight (370) and the layer description from core.js
     - linetypes DASHED and DASHDOT in metres, text style HP (Arial)
     - LWPOLYLINE, LINE, ARC, CIRCLE, TEXT
     - HATCH with the real pattern definition lines (acadiso.pat ANSI31, DOTS,
       GRASS) and SOLID; associativity off; boundaries as polyline paths
     - DIMENSION (rotated linear) with dimstyle "HP" (oblique ticks, cyan, 2
       decimals) AND its anonymous *D block holding the drawn dimension, so
       every reader shows it exactly as on screen
     - furniture as BLOCK + INSERT
   Text is UTF-8 (AC1032 is a UTF-8 format): "m²" survives as it is.
============================================================================ */
(function (HP) {
  const UNITS = { m: { f: 1, ins: 6 }, cm: { f: 100, ins: 5 }, mm: { f: 1000, ins: 4 } };
  const LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
  const TEXT_COLOR_DIM = (HP.LAYERS && HP.LAYERS["A-ANNO-DIMS"] && HP.LAYERS["A-ANNO-DIMS"].text) || "#8fe6f0";
  const DIM_LINE_COLOR = (HP.LAYERS && HP.LAYERS["A-ANNO-DIMS"] && HP.LAYERS["A-ANNO-DIMS"].color) || "#16b6c9";

  // ---------------------------------------------------------------- numbers
  /* up to `d` decimals, never exponent form, never "-0" */
  function num(v, d) {
    d = d == null ? 6 : d;
    v = +v;
    if (!isFinite(v) || Math.abs(v) < 0.5 * Math.pow(10, -d)) return "0.0";
    let s = v.toFixed(d);
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "");
    if (s.endsWith(".")) s += "0";
    if (s.indexOf(".") < 0) s += ".0";
    return s === "-0.0" ? "0.0" : s;
  }

  // ---------------------------------------------------------------- colours
  /* The AutoCAD Color Index palette: 1-9 fixed, 10-249 = 24 hues x (5 shades x
     full/half saturation), 250-255 greys. Only used for the fallback ACI next
     to the true colour (420), which is what AutoCAD shows.                   */
  const ACI = (function () {
    const t = [[0, 0, 0], [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255],
      [255, 255, 255], [128, 128, 128], [192, 192, 192]];
    const V = [1, 0.65, 0.5, 0.3, 0.15];
    for (let i = 10; i < 250; i++) {
      const hue = Math.floor((i - 10) / 10) * 15, k = (i - 10) % 10, v = V[k >> 1], s = (k & 1) ? 0.5 : 1;
      const c = v * s, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = v - c;
      const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
      t.push([Math.floor((r + m) * 255), Math.floor((g + m) * 255), Math.floor((b + m) * 255)]);
    }
    for (const g of [51, 80, 105, 130, 190, 255]) t.push([g, g, g]);
    return t;
  })();
  function rgbOf(hex) {
    const h = String(hex || "").replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
    return isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 255, 255];
  }
  const trueColor = hex => { const [r, g, b] = rgbOf(hex); return (r << 16) | (g << 8) | b; };
  function aciOf(hex) {
    const [r, g, b] = rgbOf(hex);
    let best = 7, bd = Infinity;
    for (let i = 1; i < 256; i++) {
      const c = ACI[i], d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function lwCode(mm) {
    if (mm == null || !isFinite(+mm)) return -1;                     // ByLayer
    const v = Math.round(+mm * 100);
    let best = LINEWEIGHTS[0];
    for (const w of LINEWEIGHTS) if (Math.abs(w - v) < Math.abs(best - v)) best = w;
    return best;
  }

  // ---------------------------------------------------------------- strings
  function str(s) {
    return String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").replace(/\^/g, "^ ");
  }
  // TEXT: %% starts a control code; %%% is a literal percent sign
  const textStr = s => str(s).replace(/%/g, "%%%");
  // a valid symbol-table name
  const symName = s => String(s || "X").replace(/[<>\/\\":;?*|=,`\r\n]/g, "_").slice(0, 255) || "X";
  const ltName = n => {
    const u = String(n || "").toUpperCase();
    return u === "CONTINUOUS" || u === "" ? "Continuous" : u === "BYLAYER" ? "ByLayer" : u === "BYBLOCK" ? "ByBlock" : u;
  };

  // ================================================================= write
  function write(drawing, opts) {
    opts = opts || {};
    const U = UNITS[opts.units] || UNITS.m, f = U.f;
    const D = HP.drawing;
    const items = (drawing && drawing.items) || [];
    const blocksIn = (drawing && drawing.blocks) || {};
    const ex = (drawing && drawing.extents) || { x0: 0, y0: 0, x1: 1, y1: 1 };
    const X = v => num(v * f);                                       // a length

    // ---- output
    const out = [];
    const g = (code, value) => {
      out.push(code < 10 ? "  " + code : code < 100 ? " " + code : String(code));
      out.push(typeof value === "number" ? (Number.isInteger(value) ? String(value) : num(value)) : String(value));
    };
    const gi = (code, v) => g(code, String(v | 0));                // integer group
    const gn = (code, v, d) => g(code, num(v, d));                 // real group
    const gs = (code, s) => g(code, str(s));

    // ---- handles: the skeleton keeps Inkline's fixed ones, the rest count up from 0x60
    let next = 0x60;
    const H = () => (next++).toString(16).toUpperCase();
    const MODEL = "17", PAPER = "1B";

    // ---- layers
    const layerNames = ["0", "Defpoints"].concat(Object.keys(HP.LAYERS || {}));
    const extraLayers = new Set();
    const seeLayer = n => { if (n && layerNames.indexOf(n) < 0) extraLayers.add(n); };
    items.forEach(it => seeLayer(it.layer));
    Object.values(blocksIn).forEach(b => seeLayer(b.layer));
    extraLayers.forEach(n => layerNames.push(n));
    const layerH = {}; layerNames.forEach(n => layerH[n] = n === "0" ? "44" : H());

    // ---- linetypes, styles, dimstyle, appids
    const LT = (D && D.LTYPES) || {};
    const ltH = {}; Object.keys(LT).forEach(n => ltH[n] = H());
    const styleHP = H(), dimstyleHP = H(), appLayerStd = H();

    // ---- blocks: furniture first, then one anonymous *D block per dimension
    const blocks = [];
    const blockName = {};
    for (const name of Object.keys(blocksIn)) {
      let nm = symName(name), k = 1;
      while (blocks.some(b => b.name.toUpperCase() === nm.toUpperCase())) nm = symName(name) + "_" + (++k);
      blockName[name] = nm;
      blocks.push({ name: nm, src: blocksIn[name], br: H(), begin: H(), end: H(), anon: false });
    }
    const dimBlock = new Map();
    let dn = 0;
    for (const it of items) if (it.kind === "dim") {
      const b = { name: "*D" + (++dn), dim: it, br: H(), begin: H(), end: H(), anon: true };
      blocks.push(b); dimBlock.set(it, b);
    }

    // ================================================================ HEADER
    const w = Math.max(1e-6, ex.x1 - ex.x0), h = Math.max(1e-6, ex.y1 - ex.y0);
    g(0, "SECTION"); g(2, "HEADER");
    g(9, "$ACADVER"); g(1, "AC1032");
    g(9, "$ACADMAINTVER"); gi(90, 4);
    g(9, "$DWGCODEPAGE"); g(3, "ANSI_1252");
    g(9, "$INSBASE"); gn(10, 0); gn(20, 0); gn(30, 0);
    g(9, "$EXTMIN"); g(10, X(ex.x0)); g(20, X(ex.y0)); gn(30, 0);
    g(9, "$EXTMAX"); g(10, X(ex.x1)); g(20, X(ex.y1)); gn(30, 0);
    g(9, "$LIMMIN"); g(10, X(ex.x0)); g(20, X(ex.y0));
    g(9, "$LIMMAX"); g(10, X(ex.x1)); g(20, X(ex.y1));
    g(9, "$ORTHOMODE"); gi(70, 0);
    g(9, "$REGENMODE"); gi(70, 1);
    g(9, "$FILLMODE"); gi(70, 1);
    g(9, "$QTEXTMODE"); gi(70, 0);
    g(9, "$MIRRTEXT"); gi(70, 0);
    g(9, "$LTSCALE"); gn(40, 1);
    g(9, "$ATTMODE"); gi(70, 1);
    g(9, "$TEXTSIZE"); g(40, X(0.25));
    g(9, "$TRACEWID"); g(40, X(0.05));
    g(9, "$TEXTSTYLE"); g(7, "HP");
    g(9, "$CLAYER"); g(8, "0");
    g(9, "$CELTYPE"); g(6, "ByLayer");
    g(9, "$CECOLOR"); gi(62, 256);
    g(9, "$CELTSCALE"); gn(40, 1);
    g(9, "$DISPSILH"); gi(70, 0);
    g(9, "$DIMSTYLE"); g(2, "HP");
    g(9, "$LUNITS"); gi(70, 2);
    g(9, "$LUPREC"); gi(70, 4);
    g(9, "$AUNITS"); gi(70, 0);
    g(9, "$AUPREC"); gi(70, 2);
    g(9, "$ELEVATION"); gn(40, 0);
    g(9, "$PELEVATION"); gn(40, 0);
    g(9, "$THICKNESS"); gn(40, 0);
    g(9, "$LIMCHECK"); gi(70, 0);
    g(9, "$ANGBASE"); gn(50, 0);
    g(9, "$ANGDIR"); gi(70, 0);
    g(9, "$PDMODE"); gi(70, 0);
    g(9, "$PDSIZE"); gn(40, 0);
    g(9, "$PLINEWID"); gn(40, 0);
    g(9, "$HANDSEED"); g(5, "@@HANDSEED@@");
    g(9, "$UCSBASE"); g(2, "");
    g(9, "$UCSNAME"); g(2, "");
    g(9, "$UCSORG"); gn(10, 0); gn(20, 0); gn(30, 0);
    g(9, "$UCSXDIR"); gn(10, 1); gn(20, 0); gn(30, 0);
    g(9, "$UCSYDIR"); gn(10, 0); gn(20, 1); gn(30, 0);
    g(9, "$WORLDVIEW"); gi(70, 1);
    g(9, "$TILEMODE"); gi(70, 1);
    g(9, "$MAXACTVP"); gi(70, 64);
    g(9, "$PINSBASE"); gn(10, 0); gn(20, 0); gn(30, 0);
    g(9, "$PLIMCHECK"); gi(70, 0);
    g(9, "$PLIMMIN"); gn(10, 0); gn(20, 0);
    g(9, "$PLIMMAX"); gn(10, 420); gn(20, 297);
    g(9, "$UNITMODE"); gi(70, 0);
    g(9, "$VISRETAIN"); gi(70, 1);
    g(9, "$PLINEGEN"); gi(70, 0);
    g(9, "$PSLTSCALE"); gi(70, 1);
    g(9, "$TREEDEPTH"); gi(70, 3020);
    g(9, "$CMLSTYLE"); g(2, "Standard");
    g(9, "$CMLJUST"); gi(70, 0);
    g(9, "$CMLSCALE"); gn(40, 1);
    g(9, "$PROXYGRAPHICS"); gi(70, 1);
    g(9, "$MEASUREMENT"); gi(70, 1);                 // metric: acadiso.pat / acadiso.lin
    g(9, "$CELWEIGHT"); gi(370, -1);
    g(9, "$ENDCAPS"); gi(280, 0);
    g(9, "$JOINSTYLE"); gi(280, 0);
    g(9, "$LWDISPLAY"); gi(290, 0);
    g(9, "$INSUNITS"); gi(70, U.ins);                // 6 metres, 5 cm, 4 mm
    g(9, "$EXTNAMES"); gi(290, 1);
    g(9, "$PSTYLEMODE"); gi(290, 1);
    g(9, "$SORTENTS"); gi(280, 127);
    g(9, "$HIDETEXT"); gi(280, 1);
    g(9, "$DIMASSOC"); gi(280, 2);
    g(9, "$DWFFRAME"); gi(280, 2);
    g(9, "$DGNFRAME"); gi(280, 2);
    g(9, "$REALWORLDSCALE"); gi(290, 1);
    g(0, "ENDSEC");

    // ================================================================ CLASSES
    g(0, "SECTION"); g(2, "CLASSES");
    for (const [dxfName, cpp] of [["ACDBDICTIONARYWDFLT", "AcDbDictionaryWithDefault"], ["ACDBPLACEHOLDER", "AcDbPlaceHolder"], ["LAYOUT", "AcDbLayout"]]) {
      g(0, "CLASS"); g(1, dxfName); g(2, cpp); g(3, "ObjectDBX Classes"); gi(90, 0); gi(91, 0); gi(280, 0); gi(281, 0);
    }
    g(0, "ENDSEC");

    // ================================================================ TABLES
    g(0, "SECTION"); g(2, "TABLES");

    // VPORT
    g(0, "TABLE"); g(2, "VPORT"); g(5, "8"); g(330, "0"); g(100, "AcDbSymbolTable"); gi(70, 1);
    g(0, "VPORT"); g(5, "40"); g(330, "8"); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbViewportTableRecord");
    g(2, "*Active"); gi(70, 0);
    gn(10, 0); gn(20, 0); gn(11, 1); gn(21, 1);
    g(12, X((ex.x0 + ex.x1) / 2)); g(22, X((ex.y0 + ex.y1) / 2)); gn(13, 0); gn(23, 0);
    g(14, X(0.05)); g(24, X(0.05)); g(15, X(1)); g(25, X(1));
    gn(16, 0); gn(26, 0); gn(36, 1); gn(17, 0); gn(27, 0); gn(37, 0);
    g(40, X(Math.max(h, w / 1.5) * 1.08)); gn(41, 1.5); gn(42, 50); gn(43, 0); gn(44, 0);
    gn(50, 0); gn(51, 0); gi(71, 0); gi(72, 1000); gi(73, 1); gi(74, 3); gi(75, 0); gi(76, 0); gi(77, 0); gi(78, 0);
    gi(281, 0); gi(65, 0); gn(146, 0);
    g(0, "ENDTAB");

    // LTYPE
    g(0, "TABLE"); g(2, "LTYPE"); g(5, "2"); g(330, "0"); g(100, "AcDbSymbolTable"); gi(70, 3 + Object.keys(LT).length);
    for (const [hd, nm] of [["41", "ByBlock"], ["42", "ByLayer"], ["43", "Continuous"]]) {
      g(0, "LTYPE"); g(5, hd); g(330, "2"); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbLinetypeTableRecord");
      g(2, nm); gi(70, 0); g(3, nm === "Continuous" ? "Solid line" : ""); gi(72, 65); gi(73, 0); gn(40, 0);
    }
    for (const nm of Object.keys(LT)) {
      const pat = LT[nm].pat;
      g(0, "LTYPE"); g(5, ltH[nm]); g(330, "2"); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbLinetypeTableRecord");
      g(2, nm); gi(70, 0); gs(3, LT[nm].desc || nm); gi(72, 65); gi(73, pat.length);
      g(40, X(pat.reduce((t, v) => t + Math.abs(v), 0)));
      for (const e of pat) { g(49, X(e)); gi(74, 0); }
    }
    g(0, "ENDTAB");

    // LAYER
    g(0, "TABLE"); g(2, "LAYER"); g(5, "1"); g(330, "0"); g(100, "AcDbSymbolTable"); gi(70, layerNames.length);
    for (const nm of layerNames) {
      const L = (HP.LAYERS && HP.LAYERS[nm]) || null;
      g(0, "LAYER"); g(5, layerH[nm]); g(330, "1"); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbLayerTableRecord");
      gs(2, nm); gi(70, 0);
      if (L) { gi(62, aciOf(L.color)); gi(420, trueColor(L.color)); } else gi(62, 7);
      g(6, L ? ltName(L.ltype) : "Continuous");
      if (nm === "Defpoints") gi(290, 0);
      gi(370, L ? lwCode(L.lw) : -3);
      g(390, "13");
      if (L && L.desc) { g(1001, "AcAecLayerStandard"); g(1000, ""); gs(1000, L.desc); }
    }
    g(0, "ENDTAB");

    // STYLE
    g(0, "TABLE"); g(2, "STYLE"); g(5, "5"); g(330, "0"); g(100, "AcDbSymbolTable"); gi(70, 2);
    g(0, "STYLE"); g(5, "46"); g(330, "5"); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbTextStyleTableRecord");
    g(2, "Standard"); gi(70, 0); gn(40, 0); gn(41, 1); gn(50, 0); gi(71, 0); g(42, X(0.25)); g(3, "txt"); g(4, "");
    g(0, "STYLE"); g(5, styleHP); g(330, "5"); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbTextStyleTableRecord");
    g(2, "HP"); gi(70, 0); gn(40, 0); gn(41, 1); gn(50, 0); gi(71, 0); g(42, X(0.25)); g(3, "arial.ttf"); g(4, "");
    g(1001, "ACAD"); g(1000, "Arial"); gi(1071, 34);
    g(0, "ENDTAB");

    // VIEW, UCS
    g(0, "TABLE"); g(2, "VIEW"); g(5, "7"); g(330, "0"); g(100, "AcDbSymbolTable"); gi(70, 0); g(0, "ENDTAB");
    g(0, "TABLE"); g(2, "UCS"); g(5, "6"); g(330, "0"); g(100, "AcDbSymbolTable"); gi(70, 0); g(0, "ENDTAB");

    // APPID
    g(0, "TABLE"); g(2, "APPID"); g(5, "3"); g(330, "0"); g(100, "AcDbSymbolTable"); gi(70, 2);
    g(0, "APPID"); g(5, "47"); g(330, "3"); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbRegAppTableRecord"); g(2, "ACAD"); gi(70, 0);
    g(0, "APPID"); g(5, appLayerStd); g(330, "3"); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbRegAppTableRecord"); g(2, "AcAecLayerStandard"); gi(70, 0);
    g(0, "ENDTAB");

    // DIMSTYLE: Standard (as Inkline) + HP
    const DS = (D && D.DIM) || { text: 0.18, small: 0.12, tick: 0.06, exo: 0.06, exe: 0.08, gap: 0.05 };
    const lane = (D && D.SIZES && D.SIZES.laneStep) || 0.6;
    g(0, "TABLE"); g(2, "DIMSTYLE"); g(5, "4"); g(330, "0"); g(100, "AcDbSymbolTable"); gi(70, 2); g(100, "AcDbDimStyleTable");
    g(0, "DIMSTYLE"); g(105, "48"); g(330, "4"); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbDimStyleTableRecord");
    g(2, "Standard"); gi(70, 0); gn(40, 1); gn(41, 2.5); gn(42, 0.625); gn(43, 3.75); gn(44, 1.25);
    gn(45, 0); gn(46, 0); gn(47, 0); gn(48, 0); gn(49, 2.5); gn(140, 2.5); gn(141, 2.5); gn(142, 0);
    g(143, "0.03937007874"); gn(144, 1); gn(145, 0); gn(146, 1); gn(147, 0.625); gn(148, 0);
    gi(71, 0); gi(72, 0); gi(73, 0); gi(74, 0); gi(75, 0); gi(76, 0); gi(77, 1); gi(78, 8); gi(79, 3);
    gi(170, 0); gi(171, 3); gi(172, 1); gi(173, 0); gi(174, 0); gi(175, 0); gi(176, 0); gi(177, 0); gi(178, 0); gi(179, 2);
    gi(271, 2); gi(272, 2); gi(273, 2); gi(274, 3); gi(275, 0); gi(276, 0); gi(277, 2); gi(278, 44); gi(279, 0);
    gi(280, 0); gi(281, 0); gi(282, 0); gi(283, 0); gi(284, 8); gi(285, 0); gi(286, 0); gi(288, 0); gi(289, 3);
    g(340, "46"); gi(371, -2); gi(372, -2);
    g(0, "DIMSTYLE"); g(105, dimstyleHP); g(330, "4"); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbDimStyleTableRecord");
    g(2, "HP"); gi(70, 0);
    gn(40, 1);                 // DIMSCALE
    g(41, X(0.10));            // DIMASZ (not drawn: ticks replace arrows)
    g(42, X(DS.exo));          // DIMEXO  extension line offset from the object
    g(43, X(lane));            // DIMDLI  baseline spacing = the chain lanes
    g(44, X(DS.exe));          // DIMEXE  extension line past the dimension line
    gn(45, 0);                 // DIMRND
    gn(46, 0);                 // DIMDLE
    gn(47, 0); gn(48, 0);      // DIMTP DIMTM
    gn(49, 2.5);
    g(140, X(DS.text));        // DIMTXT
    gn(141, 0);                // DIMCEN
    g(142, X(DS.tick));        // DIMTSZ  > 0: oblique ticks instead of arrows
    g(143, "39.37007874");     // DIMALTF
    gn(144, 1 / f, 10);        // DIMLFAC: the text always reads in metres
    gn(145, 0); gn(146, 1);
    g(147, X(DS.gap));         // DIMGAP
    gn(148, 0);
    gi(71, 0); gi(72, 0);
    gi(73, 0); gi(74, 0);      // DIMTIH DIMTOH: text along the line
    gi(75, 0); gi(76, 0);
    gi(77, 1);                 // DIMTAD: text above the line
    gi(78, 0);                 // DIMZIN: keep "0.20" and "4.20"
    gi(79, 0);
    gi(170, 0); gi(171, 2); gi(172, 1);
    gi(173, 0); gi(174, 1);    // DIMTIX: text between the extension lines, even on a 0.20 wall
    gi(175, 0);
    /* AutoCAD 2027 REBUILDS every dimension block from this style when it opens
       the file (measured), so the style must draw the same picture: lines
       ByLayer = the layer's true cyan; text the nearest ACI (141) to #8fe6f0. */
    gi(176, 256); gi(177, 256);                                        // DIMCLRD DIMCLRE ByLayer
    gi(178, aciOf(TEXT_COLOR_DIM));
    gi(179, 2);
    gi(271, 2); gi(272, 2);    // DIMDEC DIMTDEC
    gi(273, 2); gi(274, 2); gi(275, 0); gi(276, 0);
    gi(277, 2);                // DIMLUNIT decimal
    gi(278, 46);               // DIMDSEP '.'
    gi(279, 0); gi(280, 0); gi(281, 0); gi(282, 0); gi(283, 0); gi(284, 0); gi(285, 0); gi(286, 0); gi(288, 0);
    gi(289, 3);
    g(340, styleHP);           // DIMTXSTY
    gi(371, -2); gi(372, -2);
    g(0, "ENDTAB");

    // BLOCK_RECORD
    g(0, "TABLE"); g(2, "BLOCK_RECORD"); g(5, "9"); g(330, "0"); g(100, "AcDbSymbolTable"); gi(70, 2 + blocks.length);
    g(0, "BLOCK_RECORD"); g(5, MODEL); g(330, "9"); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbBlockTableRecord");
    g(2, "*Model_Space"); g(340, "1A"); gi(70, 0); gi(280, 1); gi(281, 0);
    g(0, "BLOCK_RECORD"); g(5, PAPER); g(330, "9"); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbBlockTableRecord");
    g(2, "*Paper_Space"); g(340, "1E"); gi(70, 0); gi(280, 1); gi(281, 0);
    for (const b of blocks) {
      g(0, "BLOCK_RECORD"); g(5, b.br); g(330, "9"); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbBlockTableRecord");
      gs(2, b.name); g(340, "0"); gi(70, b.anon ? 0 : U.ins); gi(280, 1); gi(281, 0);
    }
    g(0, "ENDTAB");
    g(0, "ENDSEC");

    // ================================================================ entities
    /* ctx.block: entities inside a block go on layer 0 and take colour,
       linetype and lineweight from the INSERT / DIMENSION (ByBlock), unless the
       primitive sets its own.                                                   */
    function head(type, it, owner, inBlock, layer) {
      g(0, type); g(5, H()); g(330, owner); g(100, "AcDbEntity");
      gs(8, layer != null ? layer : (inBlock ? "0" : (it.layer || "0")));
      if (it.ltype) g(6, ltName(it.ltype)); else if (inBlock) g(6, "ByBlock");
      if (it.color) gi(62, aciOf(it.color)); else if (inBlock) gi(62, 0);
      if (it.lw != null) gi(370, lwCode(it.lw)); else if (inBlock) gi(370, -2);
      if (it.color) gi(420, trueColor(it.color));
    }
    const P2 = (c1, c2, p) => { g(c1, X(p[0])); g(c2, X(p[1])); };
    const P3 = (c1, c2, c3, p) => { g(c1, X(p[0])); g(c2, X(p[1])); gn(c3, 0); };
    const JUST = { mc: [1, 2], bc: [1, 0], tc: [1, 3], ml: [0, 2], mr: [2, 2], bl: [0, 0], bm: [1, 1] };

    function text(it, owner, inBlock, layer) {
      head("TEXT", it, owner, inBlock, layer);
      g(100, "AcDbText");
      P3(10, 20, 30, it.p); g(40, X(it.h)); g(1, textStr(it.text));
      if (it.rot) gn(50, ((+it.rot % 360) + 360) % 360);
      g(7, "HP");
      const [hj, vj] = JUST[it.align || "bl"] || [0, 0];
      if (hj) gi(72, hj);
      if (hj || vj) P3(11, 21, 31, it.p);
      g(100, "AcDbText");
      if (vj) gi(73, vj);
    }
    function hatch(it, owner, inBlock) {
      head("HATCH", it, owner, inBlock);
      g(100, "AcDbHatch");
      gn(10, 0); gn(20, 0); gn(30, 0); gn(210, 0); gn(220, 0); gn(230, 1);
      const pat = String(it.pattern || "SOLID").toUpperCase();
      const solid = pat === "SOLID";
      gs(2, pat); gi(70, solid ? 1 : 0); gi(71, 0);
      const loops = (it.loops || []).filter(l => l && l.length >= 3);
      gi(91, loops.length);
      loops.forEach((l, i) => {
        const bul = it.bulges && it.bulges[i];
        const hasB = !!(bul && bul.some(b => Math.abs(b) > 1e-12));
        gi(92, depth(l, loops) === 0 ? 3 : 2);                         // 2 polyline, +1 external
        gi(72, hasB ? 1 : 0); gi(73, 1); gi(93, l.length);
        l.forEach((p, k) => { P2(10, 20, p); if (hasB) gn(42, bul[k] || 0, 9); });
        gi(97, 0);
      });
      gi(75, 0);                 // normal style = odd parity (even-odd)
      gi(76, 1);                 // predefined pattern
      if (!solid) {
        const sc = (+it.scale || 1) * f, an = +it.angle || 0;
        const lines = D.patternLines(pat, sc, an);
        gn(52, an); gn(41, sc, 10); gi(77, 0); gi(78, lines.length);
        for (const ln of lines) {
          gn(53, ln.angle, 10); gn(43, ln.base[0], 10); gn(44, ln.base[1], 10);
          gn(45, ln.offset[0], 10); gn(46, ln.offset[1], 10);
          gi(79, ln.dashes.length);
          for (const d of ln.dashes) gn(49, d, 10);
        }
      }
      gi(98, 0);
    }
    function entity(it, owner, inBlock) {
      switch (it.kind) {
        case "pline": {
          if (!it.pts || it.pts.length < 2) return;
          head("LWPOLYLINE", it, owner, inBlock);
          g(100, "AcDbPolyline"); gi(90, it.pts.length); gi(70, it.closed ? 1 : 0);
          if (it.width) g(43, X(it.width));
          it.pts.forEach((p, k) => {
            P2(10, 20, p);
            const b = it.bulges && it.bulges[k];
            if (b && Math.abs(b) > 1e-12) gn(42, b, 9);
          });
          return;
        }
        case "line":
          head("LINE", it, owner, inBlock); g(100, "AcDbLine"); P3(10, 20, 30, it.a); P3(11, 21, 31, it.b); return;
        case "arc":
          head("ARC", it, owner, inBlock); g(100, "AcDbCircle"); P3(10, 20, 30, it.c); g(40, X(it.r));
          g(100, "AcDbArc"); gn(50, ((+it.a0 % 360) + 360) % 360); gn(51, ((+it.a1 % 360) + 360) % 360); return;
        case "circle":
          head("CIRCLE", it, owner, inBlock); g(100, "AcDbCircle"); P3(10, 20, 30, it.c); g(40, X(it.r)); return;
        case "text":
          if (String(it.text || "") === "") return;
          text(it, owner, inBlock); return;
        case "hatch":
          hatch(it, owner, inBlock); return;
        case "insert": {
          const nm = blockName[it.block];
          if (!nm) return;
          head("INSERT", it, owner, inBlock);
          g(100, "AcDbBlockReference"); gs(2, nm); P3(10, 20, 30, it.p);
          const sx = it.sx === -1 ? -1 : 1;
          if (sx !== 1) { gn(41, sx); gn(42, 1); gn(43, 1); }
          if (it.rot) gn(50, ((+it.rot % 360) + 360) % 360);
          return;
        }
        case "dim": {
          const b = dimBlock.get(it);
          if (!b) return;
          const geo = D.dimGeometry(it);
          head("DIMENSION", it, owner, inBlock);
          g(100, "AcDbDimension"); gi(280, 0); gs(2, b.name); g(3, "HP");
          P3(10, 20, 30, geo.pb); P3(11, 21, 31, geo.text.p);
          gi(70, 32 | (it.tp ? 128 : 0)); gi(71, 5);
          g(42, X(geo.measure));
          g(1, "");
          g(100, "AcDbAlignedDimension"); P3(13, 23, 33, it.a); P3(14, 24, 34, it.b); gn(50, +it.rot || 0);
          g(100, "AcDbRotatedDimension");
          if (it.small || it.h) {            // per-dimension text height (the small 0.20 wall texts)
            const th = geo.text.h;
            if (Math.abs(th - DS.text) > 1e-9) {
              g(1001, "ACAD"); g(1000, "DSTYLE"); g(1002, "{"); gi(1070, 140); g(1040, X(th)); g(1002, "}");
            }
          }
          return;
        }
      }
    }
    // nesting depth of a loop among the others (0 = outermost)
    function depth(l, all) {
      const a = l[0], b = l[1];
      // a point just inside the loop beside its first edge
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      let area = 0;
      for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; area += p[0] * q[1] - q[0] * p[1]; }
      const s = area >= 0 ? 1 : -1, e = 1e-4;
      const pt = [(a[0] + b[0]) / 2 - s * dy / L * e, (a[1] + b[1]) / 2 + s * dx / L * e];
      let k = 0;
      for (const o of all) if (o !== l && HP.pointInPoly(pt, o)) k++;
      return k;
    }

    // ================================================================ BLOCKS
    g(0, "SECTION"); g(2, "BLOCKS");
    const blockHead = (beginH, owner, name, flags) => {
      g(0, "BLOCK"); g(5, beginH); g(330, owner); g(100, "AcDbEntity"); g(8, "0"); g(100, "AcDbBlockBegin");
      gs(2, name); gi(70, flags); gn(10, 0); gn(20, 0); gn(30, 0); gs(3, name); g(1, "");
    };
    const blockEnd = (endH, owner) => { g(0, "ENDBLK"); g(5, endH); g(330, owner); g(100, "AcDbEntity"); g(8, "0"); g(100, "AcDbBlockEnd"); };
    blockHead("18", MODEL, "*Model_Space", 0); blockEnd("19", MODEL);
    blockHead("1C", PAPER, "*Paper_Space", 0); blockEnd("1D", PAPER);
    for (const b of blocks) {
      blockHead(b.begin, b.br, b.name, b.anon ? 1 : 0);
      if (b.anon) {
        /* explicit colours in the dimension block: a reader that does not pass
           ByBlock through a DIMENSION (ezdxf's renderer, many viewers) still
           shows the cyan lines; AutoCAD regenerates with DIMCLRD/DIMCLRT.     */
        const geo = D.dimGeometry(b.dim);
        for (const ln of geo.lines.concat(geo.ticks)) entity({ kind: "line", a: ln[0], b: ln[1], color: DIM_LINE_COLOR }, b.br, true);
        text({ p: geo.text.p, h: geo.text.h, text: b.dim.text, align: "mc", rot: readable(geo.text.rot), color: TEXT_COLOR_DIM }, b.br, true);
        for (const p of [geo.pb, b.dim.a, b.dim.b]) {
          g(0, "POINT"); g(5, H()); g(330, b.br); g(100, "AcDbEntity"); g(8, "Defpoints"); g(100, "AcDbPoint"); P3(10, 20, 30, p);
        }
      } else {
        for (const it of b.src.items || []) entity(it, b.br, true);
      }
      blockEnd(b.end, b.br);
    }
    g(0, "ENDSEC");

    // ================================================================ ENTITIES
    g(0, "SECTION"); g(2, "ENTITIES");
    for (const it of items) entity(it, MODEL, false);
    g(0, "ENDSEC");

    // ================================================================ OBJECTS (as Inkline)
    g(0, "SECTION"); g(2, "OBJECTS");
    g(0, "DICTIONARY"); g(5, "A"); g(330, "0"); g(100, "AcDbDictionary"); gi(281, 1);
    g(3, "ACAD_GROUP"); g(350, "C"); g(3, "ACAD_LAYOUT"); g(350, "D"); g(3, "ACAD_MLINESTYLE"); g(350, "10");
    g(3, "ACAD_PLOTSETTINGS"); g(350, "11"); g(3, "ACAD_PLOTSTYLENAME"); g(350, "12");
    g(0, "DICTIONARY"); g(5, "C"); g(330, "A"); g(100, "AcDbDictionary"); gi(281, 1);
    g(0, "DICTIONARY"); g(5, "D"); g(330, "A"); g(100, "AcDbDictionary"); gi(281, 1);
    g(3, "Model"); g(350, "1A"); g(3, "Layout1"); g(350, "1E");
    g(0, "DICTIONARY"); g(5, "10"); g(330, "A"); g(100, "AcDbDictionary"); gi(281, 1);
    g(3, "Standard"); g(350, "22");
    g(0, "DICTIONARY"); g(5, "11"); g(330, "A"); g(100, "AcDbDictionary"); gi(281, 1);
    g(0, "ACDBDICTIONARYWDFLT"); g(5, "12"); g(330, "A"); g(100, "AcDbDictionary"); gi(281, 1);
    g(3, "Normal"); g(350, "13"); g(100, "AcDbDictionaryWithDefault"); g(340, "13");
    g(0, "ACDBPLACEHOLDER"); g(5, "13"); g(330, "12");
    layout("1A", "Model", 1024, 0, MODEL);
    layout("1E", "Layout1", 0, 1, PAPER);
    g(0, "MLINESTYLE"); g(5, "22"); g(102, "{ACAD_REACTORS"); g(330, "10"); g(102, "}"); g(330, "10");
    g(100, "AcDbMlineStyle"); g(2, "Standard"); gi(70, 0); g(3, ""); gi(62, 256); gn(51, 90); gn(52, 90); gi(71, 2);
    gn(49, 0.5); gi(62, 256); g(6, "BYLAYER"); gn(49, -0.5); gi(62, 256); g(6, "BYLAYER");
    g(0, "ENDSEC");
    g(0, "EOF");

    function layout(hd, name, plotFlags, tabOrder, br) {
      g(0, "LAYOUT"); g(5, hd); g(330, "D"); g(100, "AcDbPlotSettings"); g(1, ""); g(4, "A3"); g(6, "");
      gn(40, 7.5); gn(41, 20); gn(42, 7.5); gn(43, 20); gn(44, 420); gn(45, 297);
      gn(46, 0); gn(47, 0); gn(48, 0); gn(49, 0); gn(140, 0); gn(141, 0); gn(142, 1); gn(143, 1);
      gi(70, plotFlags); gi(72, 1); gi(73, 0); gi(74, 5); g(7, ""); gi(75, 16); gi(76, 0); gi(77, 2); gi(78, 300);
      gn(147, 1); gn(148, 0); gn(149, 0);
      g(100, "AcDbLayout"); gs(1, name); gi(70, 1); gi(71, tabOrder);
      gn(10, 0); gn(20, 0); gn(11, 420); gn(21, 297); gn(12, 0); gn(22, 0); gn(32, 0);
      g(14, "1e+20"); g(24, "1e+20"); g(34, "1e+20"); g(15, "-1e+20"); g(25, "-1e+20"); g(35, "-1e+20");
      gn(146, 0); gn(13, 0); gn(23, 0); gn(33, 0);
      gn(16, 1); gn(26, 0); gn(36, 0); gn(17, 0); gn(27, 1); gn(37, 0);
      gi(76, 1); g(330, br);
    }

    const seed = (next + 0x10).toString(16).toUpperCase();
    const k = out.indexOf("@@HANDSEED@@");
    if (k >= 0) out[k] = seed;
    return out.join("\r\n") + "\r\n";
  }

  function readable(deg) {
    let a = ((+deg % 360) + 360) % 360;
    if (a > 90 && a <= 270) a -= 180; else if (a > 270) a -= 360;
    return Math.abs(a) < 1e-9 ? 0 : a;
  }

  HP.dxf = { write, num, aciOf, trueColor, lwCode, UNITS, ACI };
})(globalThis.HP = globalThis.HP || {});

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.HP;
