# House Planner - start here

Read `README.md` (what it is, what is verified, known limits) and `CONTRACT.md`
(units, plan format, every module's API and who owns what) before changing anything.

- Plain browser JS, no dependencies, no build tools beyond `py -3 build.py`
  (or `python3 build.py`), which inlines `src/*` into the one file
  `House Planner.html` that Rasa's dad uses offline. Rebuild after every change.
- Tests: `node --test` run inside this folder (Node 20+). All must pass.
- Everything in a plan is integer centimetres on a 5 cm grid; only
  `src/drawing.js` converts to metres. Model ops are pure and return
  `{state, ok, reason, id, note}`.
- Rasa is a senior AutoCAD drafter; his dad is not a programmer. Plain English
  in the UI. Say plainly what you ran vs only read.
- DXF checks in AutoCAD (`dev/dxf-acad.ps1`) only work on Rasa's Windows PC;
  in the cloud use `dev/dxf-check.py` (needs `pip install ezdxf`).
- Update README.md when you finish work.
