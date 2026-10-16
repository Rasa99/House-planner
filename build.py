"""House Planner - build.py

Makes the ONE file Rasa's dad uses, `House Planner.html`, by inlining every
<link rel="stylesheet" href="src/..."> and <script src="src/..."></script> of
index.html. No dependencies; run with:  py -3 build.py

Fails (exit 1) when a referenced file is missing or anything would load from
the network - the result must work offline from file://.
"""
import datetime
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "index.html"
OUT = HERE / "House Planner.html"


def main() -> int:
    html = SRC.read_text(encoding="utf-8")
    problems = []

    def css(m):
        p = HERE / m.group(1)
        if not p.exists():
            problems.append(f"missing {m.group(1)}")
            return m.group(0)
        return f"<style>/* {m.group(1)} */\n{p.read_text(encoding='utf-8')}\n</style>"

    def js(m):
        p = HERE / m.group(1)
        if not p.exists():
            problems.append(f"missing {m.group(1)}")
            return m.group(0)
        code = p.read_text(encoding="utf-8").replace("</script", "<\\/script")
        return f"<script>/* {m.group(1)} */\n{code}\n</script>"

    html = re.sub(r'<link rel="stylesheet" href="(src/[^"]+\.css)">', css, html)
    html = re.sub(r'<script src="(src/[^"]+\.js)"></script>', js, html)

    for bad in re.findall(r'<(?:script|link|img|iframe)[^>]+(?:src|href)="(?:https?:)?//[^"]+"', html):
        problems.append(f"network resource: {bad[:80]}")
    if re.search(r'<script src=|<link rel="stylesheet"', html):
        problems.append("a script or stylesheet was not inlined")
    if problems:
        print("BUILD FAILED\n  " + "\n  ".join(problems))
        return 1

    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    html = html.replace("<title>House Planner</title>",
                        f"<title>House Planner</title>\n<meta name=\"build\" content=\"{stamp}\">", 1)
    OUT.write_text(html, encoding="utf-8")
    print(f"built {OUT.name}  {OUT.stat().st_size // 1024} KB  ({stamp})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
