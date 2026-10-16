"""
dev/dxf-check.py  (drafting agent)

Reads a DXF written by House Planner back with ezdxf and checks it:
  - ezdxf.readfile + doc.audit(): 0 errors expected (fixes are listed too)
  - modelspace entity counts by type == the drawing's items (from <out>.summary.json)
  - every HATCH: the pattern name, real pattern definition lines for ANSI31/DOTS/GRASS,
    solid fill for SOLID, boundary paths present
  - every DIMENSION: its anonymous block exists and holds lines + the text
  - layers carry their true colour; $INSUNITS; "m²" survived
  - optional: render the DXF to SVG with ezdxf's drawing add-on, and to PNG with
    Edge headless (--png out.png [--px 2400])

  py -3 dev/dxf-check.py <file.dxf> [--png out.png] [--px 2400]

Exit code 0 only if every check passed.
"""
import json
import os
import subprocess
import sys
import tempfile

import ezdxf
from ezdxf import recover  # noqa: F401  (kept for manual use)

args = sys.argv[1:]
if not args:
    print(__doc__)
    sys.exit(2)
path = args[0]
png = args[args.index("--png") + 1] if "--png" in args else None
px = int(args[args.index("--px") + 1]) if "--px" in args else 2400

fails = []
def check(ok, what):
    print(("  ok    " if ok else "  FAIL  ") + what)
    if not ok:
        fails.append(what)

doc = ezdxf.readfile(path)
auditor = doc.audit()
print("ezdxf %s  file %s  dxfversion %s" % (ezdxf.__version__, os.path.basename(path), doc.dxfversion))
print("audit: %d errors, %d fixes" % (len(auditor.errors), len(auditor.fixes)))
for e in auditor.errors:
    print("   error:", e.code, e.message)
for e in auditor.fixes:
    print("   fix:  ", e.code, e.message)
check(len(auditor.errors) == 0, "ezdxf audit: 0 errors")
check(len(auditor.fixes) == 0, "ezdxf audit: 0 fixes")

msp = doc.modelspace()
counts = {}
for e in msp:
    counts[e.dxftype()] = counts.get(e.dxftype(), 0) + 1
print("modelspace:", json.dumps(counts, sort_keys=True))

summ_path = os.path.splitext(path)[0] + ".summary.json"
summ = json.load(open(summ_path, encoding="utf8")) if os.path.exists(summ_path) else None
if summ:
    check(counts == summ["entities"], "entity counts by type equal the drawing's items %s" % json.dumps(summ["entities"], sort_keys=True))

# ---- hatches
expect_lines = {"ANSI31": 1, "DOTS": 1, "GRASS": 3}
hatches = msp.query("HATCH")
for i, h in enumerate(hatches):
    name = h.dxf.pattern_name
    if h.dxf.solid_fill:
        check(name == "SOLID", "hatch %d: SOLID fill" % i)
    else:
        pl = h.pattern.lines if h.pattern else []
        check(len(pl) == expect_lines.get(name, -1), "hatch %d: %s with %d pattern line(s), scale %.4g" % (i, name, len(pl), h.dxf.pattern_scale))
    check(len(h.paths) > 0 and h.dxf.associative == 0, "hatch %d: %d boundary path(s), not associative" % (i, len(h.paths)))
if summ:
    names = sorted(x["pattern"] for x in summ["hatches"])
    check(sorted(h.dxf.pattern_name for h in hatches) == names, "hatch patterns match the drawing: %s" % ", ".join(sorted(set(names))))

# ---- dimensions
dims = msp.query("DIMENSION")
bad = []
for d in dims:
    blk = doc.blocks.get(d.dxf.geometry) if d.dxf.hasattr("geometry") else None
    if blk is None:
        bad.append(d.dxf.handle + " no block")
        continue
    kinds = [e.dxftype() for e in blk]
    if kinds.count("LINE") < 3 or not any(k in ("TEXT", "MTEXT") for k in kinds):
        bad.append(d.dxf.handle + " block holds " + ",".join(kinds))
    if d.dxf.dimstyle != "HP":
        bad.append(d.dxf.handle + " dimstyle " + d.dxf.dimstyle)
check(not bad, "%d dimensions, each with its *D block (lines + text) and dimstyle HP%s" % (len(dims), "" if not bad else ": " + "; ".join(bad[:5])))
ds = doc.dimstyles.get("HP")
check(ds is not None and ds.dxf.dimtsz > 0 and ds.dxf.dimdec == 2, "dimstyle HP: oblique ticks (DIMTSZ %.4g), 2 decimals" % (ds.dxf.dimtsz if ds else 0))

# ---- blocks / inserts
for ins in msp.query("INSERT"):
    if doc.blocks.get(ins.dxf.name) is None:
        check(False, "INSERT %s has no block" % ins.dxf.name)
if summ:
    check(len(msp.query("INSERT")) == summ["entities"].get("INSERT", 0), "%d furniture INSERTs" % len(msp.query("INSERT")))

# ---- layers, units, text
missing_tc = [l.dxf.name for l in doc.layers if l.dxf.name not in ("0", "Defpoints") and l.rgb is None]
check(not missing_tc, "every House Planner layer has a true colour" + (": missing " + ", ".join(missing_tc) if missing_tc else ""))
check(doc.header.get("$INSUNITS") in (4, 5, 6), "$INSUNITS = %s" % doc.header.get("$INSUNITS"))
texts = [t.dxf.text for t in msp.query("TEXT")]
check(any("m²" in t for t in texts), 'the area text "m²" survived (UTF-8)')
if summ:
    want = sorted(t.replace("%", "%%%") for t in summ["texts"] if t)
    check(sorted(texts) == want, "every TEXT string is as drawn (%d)" % len(texts))

# ---- render
if png:
    from ezdxf.addons.drawing import Frontend, RenderContext, svg, layout, config
    cfg = config.Configuration(
        background_policy=config.BackgroundPolicy.CUSTOM,
        custom_bg_color="#0f1620",
        color_policy=config.ColorPolicy.COLOR,
        lineweight_policy=config.LineweightPolicy.ABSOLUTE,
        lineweight_scaling=1.0,
        hatch_policy=config.HatchPolicy.NORMAL,
    )
    backend = svg.SVGBackend()
    Frontend(RenderContext(doc), backend, config=cfg).draw_layout(msp)
    page = layout.Page(0, 0, layout.Units.mm, margins=layout.Margins.all(4))
    svg_text = backend.get_string(page, settings=layout.Settings(fit_page=False, scale=10))
    svg_path = os.path.splitext(png)[0] + ".svg"
    with open(svg_path, "w", encoding="utf8") as fh:
        fh.write(svg_text)
    # Edge headless turns the SVG into a PNG
    import re
    m = re.search(r'width="([\d.]+)mm"\s+height="([\d.]+)mm"', svg_text)
    ar = float(m.group(2)) / float(m.group(1)) if m else 1.4
    w, h = px, int(px * ar)
    html = os.path.splitext(png)[0] + ".html"
    with open(html, "w", encoding="utf8") as fh:
        fh.write('<!doctype html><html><body style="margin:0;background:#0f1620">'
                 '<img src="%s" style="width:%dpx;height:%dpx;display:block"></body></html>' % (os.path.basename(svg_path), w, h))
    edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    prof = tempfile.mkdtemp(prefix="edge-")
    subprocess.run([edge, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--user-data-dir=" + prof,
                    "--window-size=%d,%d" % (w, h), "--screenshot=" + os.path.abspath(png),
                    "file:///" + os.path.abspath(html).replace("\\", "/")], timeout=120,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    check(os.path.exists(png) and os.path.getsize(png) > 10000, "rendered %s (%dx%d)" % (png, w, h))

print("RESULT:", "PASS" if not fails else "FAIL (%d)" % len(fails))
sys.exit(0 if not fails else 1)
