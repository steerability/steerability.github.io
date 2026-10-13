#!/usr/bin/env python3
"""Write the competition page's leaderboard table from the results API.

    python3 scripts/update-board.py              # the latest published week
    python3 scripts/update-board.py --dry-run    # show what would change, write nothing
    python3 scripts/update-board.py --run week_01

Fetches GET /runs and GET /board/<run> from the results API (CONFIG.api in competition/hf-login.js), renders the rows
in the page's own markup, and replaces the rows of the table in competition/index.html; nothing else on the page is
touched, and nothing is written when the API cannot be reached or answers something unexpected. Review the diff and
commit: pushing main deploys it. (The leaderboard pop-up reads the API itself and needs no update.)
"""
import argparse
import difflib
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGE = ROOT / "competition" / "index.html"
LOGIN = ROOT / "competition" / "hf-login.js"
RETRY_S = 20   # a sleeping Space takes up to a minute to answer: one more try after this long
INDENT = "        "
# The table's rows: everything between <tbody> and </tbody> of the page's one .leaderboard table
TABLE = re.compile(r'(<div class="leaderboard">.*?<tbody>\n)(.*?)([ \t]*</tbody>)', re.DOTALL)


def api_base():
    m = re.search(r"api: '([^']+)'", LOGIN.read_text(encoding="utf-8"))
    if not m:
        sys.exit(f"could not find CONFIG.api in {LOGIN}")
    return m.group(1)


def get(url):
    """GET a JSON object, trying twice for a server waking from sleep."""
    for attempt in (1, 2):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as res:
                body = json.load(res)
            if not isinstance(body, dict):
                raise ValueError("not a JSON object")
            return body
        except (urllib.error.URLError, ValueError) as e:
            if attempt == 2:
                sys.exit(f"{url}: {e}")
            print(f"{url}: {e}; trying once more in {RETRY_S}s", file=sys.stderr)
            time.sleep(RETRY_S)


def num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and x == x and abs(x) != float("inf")


def signed(x):   # +0.714, -0.291, never -0.000
    if not num(x):
        return "—"
    s = f"{x:.3f}"
    if float(s) == 0:
        s = s.lstrip("-")
    return s if s.startswith("-") else "+" + s


def unsigned(x):
    return f"{x:.3f}" if num(x) else "—"


def is_hash(x):
    return isinstance(x, str) and re.fullmatch(r"[0-9a-f]{12}", x) is not None


def checked(board, run_name):
    """The board's rows, or exit: a wrong shape must never reach the page."""
    run, rows = board.get("run"), board.get("rows")
    if not isinstance(run, dict) or run.get("name") != run_name or not isinstance(rows, list) or not rows:
        sys.exit(f"/board/{run_name}: unexpected shape")
    for i, r in enumerate(rows):
        if not isinstance(r, dict) or r.get("kind") not in ("submission", "baseline") \
                or not isinstance(r.get("team"), str) or not r["team"].strip():
            sys.exit(f"/board/{run_name}: row {i} has an unexpected shape")
        if r["kind"] == "submission" and (not num(r.get("rank")) or not is_hash(r.get("org_hash"))):
            sys.exit(f"/board/{run_name}: row {i} ({r['team']}) has no rank or no org_hash")
    ranks = [r["rank"] for r in rows if r["kind"] == "submission"]
    if ranks != list(range(1, len(ranks) + 1)):
        sys.exit(f"/board/{run_name}: the ranks are not 1..{len(ranks)} in order")
    for key, kind in (("n_ranked", "submission"), ("n_baselines", "baseline")):
        n = sum(r["kind"] == kind for r in rows)
        if num(run.get(key)) and run[key] != n:
            sys.exit(f"/board/{run_name}: {key} is {run[key]} but the board has {n} {kind} rows")
    return run, rows


def row_html(r):
    baseline = r["kind"] == "baseline"
    rank = "&ndash;" if baseline else f"{int(r['rank']):02d}"
    attrs = ' class="lb-baseline"' if baseline else f' data-org="{r["org_hash"]}"'
    return (f'<tr{attrs}><td class="lb-rank">{rank}</td><td class="lb-team">{html.escape(r["team"].strip(), quote=False)}</td>'
            f'<td class="lb-score">{signed(r.get("S"))}</td><td class="lb-score">{signed(r.get("delta"))}</td>'
            f'<td class="lb-score">{unsigned(r.get("r_side"))}</td><td class="lb-score">{unsigned(r.get("r_guard"))}</td></tr>')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--run", help="a run of the index (default: the latest published week)")
    ap.add_argument("--api", help="the results API (default: CONFIG.api in competition/hf-login.js)")
    ap.add_argument("--dry-run", action="store_true", help="show the change and write nothing")
    args = ap.parse_args()

    api = (args.api or api_base()).rstrip("/")
    index = get(f"{api}/runs")
    names = [r.get("name") for r in index.get("runs", []) if isinstance(r, dict)]
    run_name = args.run or index.get("latest")
    if run_name not in names:
        sys.exit(f"/runs: {run_name!r} is not a published run ({', '.join(map(str, names)) or 'none'})")
    run, rows = checked(get(f"{api}/board/{run_name}"), run_name)

    n_sub, n_base = sum(r["kind"] == "submission" for r in rows), sum(r["kind"] == "baseline" for r in rows)
    label = run.get("label") or run_name
    note = (f"<!-- {html.escape(str(label), quote=False)} ({run_name}), rendered {run.get('date') or '?'}: {n_sub} submissions ranked, "
            f"{n_base} baselines. Written by scripts/update-board.py from the results API; run it rather than editing these rows -->")
    body = "".join(INDENT + line + "\n" for line in [note] + [row_html(r) for r in rows])

    page = PAGE.read_text(encoding="utf-8")
    m = TABLE.search(page)
    if not m:
        sys.exit(f"no leaderboard table in {PAGE}")
    old = m.group(2)
    new_page = page[:m.start(2)] + body + page[m.end(2):]

    top = "  ".join(f"{r['rank']} {r['team']} {signed(r.get('S'))}" for r in rows if r["kind"] == "submission")[:200]
    print(f"{label} ({run_name}), rendered {run.get('date') or '?'}: {n_sub} submissions ranked, {n_base} baselines")
    print(f"  {top}…" if len(top) == 200 else f"  {top}")
    if old == body:
        print(f"{PAGE.relative_to(ROOT)}: already up to date")
        return
    was = sum(1 for line in old.splitlines() if line.strip().startswith("<tr"))
    if args.dry_run:
        sys.stdout.writelines(difflib.unified_diff(old.splitlines(True), body.splitlines(True), "current rows", "rows from the API"))
        print(f"{PAGE.relative_to(ROOT)}: would write {len(rows)} rows (now {was}); nothing written (--dry-run)")
        return
    PAGE.write_text(new_page, encoding="utf-8")
    print(f"{PAGE.relative_to(ROOT)}: {len(rows)} rows written (was {was}). Review the diff and commit.")


if __name__ == "__main__":
    main()
