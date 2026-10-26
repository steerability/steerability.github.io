"""Headless checks of "Sign in with Hugging Face" against the local preview: the competition page's button, and
the leaderboard pop-up (competition/leaderboard/) where sign-in and the private view live.

    scripts/preview.sh                      # in one terminal
    python3 scripts/check-login.py          # in another (needs: pip install playwright && playwright install chromium)

Huggingface.co is never contacted: the authorize, token and userinfo endpoints are mocked (the authorize stub sends
Cross-Origin-Opener-Policy: same-origin like the real page, then approves or denies by redirecting back), and
hf-login.js is served with a test client id and CONFIG.enabled forced on (step 18 forces it off), whatever the
committed values, and CONFIG.pendingProgress as committed (step 13f sets it to 'detailed'). Nor is the results API (a Hugging Face Space): hf-login.js is served with CONFIG.api pointing at a
fake origin whose /runs, /board/<run> and /me answer from the fixtures in competition/leaderboard/mock/ (or with an
error), and any request to *.hf.space is refused and fails the check; so does a request for the competition page from
the pop-up, which renders the board itself. Screenshots land in tmp/shots/. Exit status 1 on any failed check.
"""
import base64
import hashlib
import json
import os
import re
import sys
from urllib.parse import parse_qs, urlencode, urlparse

from playwright.sync_api import sync_playwright

BASE = os.environ.get("PREVIEW_BASE", "http://localhost:8000/competition/")
LB = BASE + "leaderboard/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tmp", "shots")
CLIENT_ID = "test-client-id-123"
API = "https://results-api.invalid"   # CONFIG.api as the check serves hf-login.js: a fake origin, routed below
ORG_API = "https://organisms-api.invalid"   # CONFIG.organismsApi likewise: the organisms gateway, answered from the fixture
MOCK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "competition", "leaderboard", "mock")

os.makedirs(OUT, exist_ok=True)

failures = []
def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)

def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")

def query(url):
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}

def shot(page, name, top="#lb-private", bottom="#lb-private", pad=20):
    """Full-width screenshot from `top` to `bottom`. bounding_box() is viewport-relative but a full_page
    clip is page-relative, so add scrollY (the context has reduced motion: no smooth scroll mid-shot)."""
    scroll_y = page.evaluate("scrollY")
    t, b = page.locator(top).bounding_box(), page.locator(bottom).bounding_box()
    y0 = max(0, t["y"] + scroll_y - pad)
    y1 = b["y"] + b["height"] + scroll_y + pad
    page.screenshot(path=f"{OUT}/{name}.png", full_page=True,
                    clip={"x": 0, "y": y0, "width": page.viewport_size["width"], "height": y1 - y0})

def local(page, key):
    """A localStorage value of the page's origin, parsed as JSON (None if absent)."""
    raw = page.evaluate(f"localStorage.getItem({json.dumps(key)})")
    return json.loads(raw) if raw is not None else None

def org_hash(handle):
    """The public table's data-org for an organization handle: the first 12 hex characters of its SHA-256."""
    return hashlib.sha256(handle.encode()).hexdigest()[:12]

def set_pending(page, state, age_ms=0):
    page.evaluate("([state, age]) => localStorage.setItem('sc:hf-pending', JSON.stringify("
                  "{state: state, verifier: 'v-' + state, redirectUri: 'x', createdAt: Date.now() - age}))", [state, age_ms])

with sync_playwright() as p:
    browser = p.chromium.launch()
    console_errors = []
    captured = {"authorize": [], "token": [], "userinfo_headers": None, "me": [], "me_runs": [], "runs": 0, "boards": [],
                "healthz": 0, "space": [], "page": [], "mock_boards": [], "mock_views": []}
    hf = {"authorize": "approve", "token": "ok"}   # how the mocked huggingface.co answers
    # how the fake results API answers: /runs and /board/<run> "ok" or an error; /me a fixture's name or an error;
    # markup puts tags into the participant-authored strings (see api_endpoint)
    # pending: how the index names the week after the latest published one: "pulled" (the fixture as is), "unpulled" (the same
    # block before its pull: pulled false, pull_finished and n_pulled null), or None (no pending run)
    # phase: the pending run's phase as the index and the pending week's /me (and mock mode's fixtures) send it: None (the
    # fixtures as they are), a phase code (intake_done false for "pulled", else true), or "absent" (an older API: neither field)
    api = {"runs": "ok", "board": "ok", "me": "organizer", "markup": False, "pending": "pulled", "phase": None}

    def watch(pg):
        pg.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: console_errors.append(str(e)))

    # Serve hf-login.js with a test client id and CONFIG.enabled set as asked, so the real flow can be exercised
    # however the committed file ships (it ships dark: enabled false); CONFIG.pendingProgress as committed, or as asked.
    def serve_js(enabled, progress=None):
        def handler(route, request):
            resp = route.fetch()
            body = re.sub(r"clientId: '[^']*'", f"clientId: '{CLIENT_ID}'", resp.text(), count=1)
            body = re.sub(r"enabled: (true|false),", f"enabled: {'true' if enabled else 'false'},", body, count=1)
            if progress is not None:
                body, n = re.subn(r"pendingProgress: '[^']*'", f"pendingProgress: '{progress}'", body, count=1)
                if n != 1:
                    failures.append("CONFIG.pendingProgress not found in hf-login.js")
            body, n = re.subn(r"api: (null|'[^']*')", f"api: '{API}'", body, count=1)
            body = re.sub(r"organismsApi: (null|'[^']*')", f"organismsApi: '{ORG_API}'", body, count=1)
            if n != 1:   # never serve the committed CONFIG.api: the pop-up would call the real results server
                failures.append("CONFIG.api not found in hf-login.js")
                route.abort()
                return
            route.fulfill(response=resp, body=body)
        return handler

    # The authorize page: like huggingface.co it sends COOP same-origin (which severs the pop-up's window.opener),
    # then approves or denies by redirecting back to redirect_uri, or holds (stays on the page).
    def authorize(route, request):
        captured["authorize"].append(request.url)
        q = query(request.url)
        if hf["authorize"] == "approve":
            back = q["redirect_uri"] + "?" + urlencode({"code": "CODE123", "state": q["state"]})
        elif hf["authorize"] == "deny":
            back = q["redirect_uri"] + "?" + urlencode({"error": "access_denied", "error_description": "The user denied the request",
                                                        "state": q["state"]})
        else:
            back = None
        script = f"<script>setTimeout(function () {{ location.replace({json.dumps(back)}); }}, 50)</script>" if back else ""
        route.fulfill(status=200, headers={"Content-Type": "text/html", "Cross-Origin-Opener-Policy": "same-origin"},
                      body="<title>hf authorize stub</title>" + script)

    def token_endpoint(route, request):
        captured["token"].append({"body": {k: v[0] for k, v in parse_qs(request.post_data).items()}, "headers": request.headers})
        if hf["token"] != "ok":
            route.fulfill(status=400, content_type="application/json", body='{"error":"invalid_grant"}')
            return
        route.fulfill(status=200, content_type="application/json", body=json.dumps({
            "access_token": "hf_oauth_mock_token", "token_type": "bearer", "expires_in": 28800,
            "id_token": "x.y.z", "scope": "openid profile read-memberships"}))

    def userinfo_endpoint(route, request):
        captured["userinfo_headers"] = request.headers
        route.fulfill(status=200, content_type="application/json", body=json.dumps({
            "sub": "u1", "name": "steerability-challenge-evaluator", "preferred_username": "steerability-challenge-evaluator",
            "picture": "https://huggingface.co/avatars/x.svg", "profile": "https://huggingface.co/steerability-challenge-evaluator",
            "isPro": False,
            "orgs": [
                {"sub": "o1", "name": "Steerability Challenge Evals", "preferred_username": "steerability-challenge-evals",
                 "picture": "", "roleInOrg": "admin"},
                {"sub": "o2", "name": "Example Team", "preferred_username": "example-team", "picture": "", "roleInOrg": "read"},
            ]}))

    # The fake results API: /healthz answers like the real one; /runs, /board/<run> and /me?run=<run> serve the fixtures
    # (runs.json, board.<run>.json, <kind>.<run>.json or, for the index's latest run, <kind>.json), or an error.
    def fixture(name):
        path = os.path.join(MOCK, name + ".json")
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    RUNS = fixture("runs")
    PENDING = RUNS["pending"]["name"]
    def phased(run):   # a pending run block in the phase api["phase"] asks for
        if api["phase"] is None:
            return run
        if api["phase"] == "absent":
            return {k: v for k, v in run.items() if k not in ("phase", "intake_done")}
        return {**run, "intake_done": api["phase"] != "pulled", "phase": api["phase"]}
    def index_body():
        if api["pending"] == "unpulled":
            return {**RUNS, "pending": {**RUNS["pending"], "pulled": False, "pull_finished": None, "n_pulled": None,
                                        "intake_done": False, "phase": "upcoming"}}
        return {**RUNS, "pending": phased(RUNS["pending"])} if api["pending"] == "pulled" else {**RUNS, "pending": None}

    # The fake organisms gateway (organisms-api.js): /api/me answers from the organisms-me fixture, with the bearer
    # token it was asked with recorded; POST /api/me/key answers the same with a new key. organisms["answer"] can be
    # "401" / "403" / "refused" to test the panel's messages. The real gateway is never called.
    organisms = {"answer": None, "me": [], "rotate": 0}
    def organisms_endpoint(route, request):
        url = urlparse(request.url)
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization"}
        if request.method == "OPTIONS":
            route.fulfill(status=204, headers=cors); return
        auth = request.headers.get("authorization", "")
        if organisms["answer"] == "refused":
            route.abort("connectionrefused"); return
        if organisms["answer"] in ("401", "403"):
            route.fulfill(status=int(organisms["answer"]), headers=cors, content_type="application/json",
                          body=json.dumps({"detail": "nope"})); return
        body = fixture("organisms/me")
        if url.path == "/api/me" and request.method == "GET":
            organisms["me"].append(auth)
        elif url.path == "/api/me/key" and request.method == "POST":
            organisms["rotate"] += 1
            body = {**body, "api_key": "org-rotatedKEY0123456789abcdefghijklmnopqrst", "key_fresh": True}
        else:
            route.fulfill(status=404, headers=cors, content_type="application/json", body='{"detail":"not found"}'); return
        route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(body))
    def refuse_organisms(route, request):
        captured.setdefault("organisms", []).append(request.url)
        route.abort("connectionrefused")

    def api_endpoint(route, request):
        url = urlparse(request.url)
        path, q = url.path, {k: v[0] for k, v in parse_qs(url.query).items()}
        cors = {"Access-Control-Allow-Origin": "*"}
        def reply(status, body):
            route.fulfill(status=status, headers=cors, content_type="application/json", body=json.dumps(body))
        def fail(answer):   # refused (no answer at all), 401, 404, or a 503 with its error code
            if answer == "refused":
                route.abort("connectionrefused")
            elif answer == "401":
                reply(401, {"error": "invalid_token"})
            elif answer == "404":
                reply(404, {"error": "not_found"})
            else:
                reply(503, {"error": answer})
        if request.method == "OPTIONS":   # a CORS preflight, if it reaches the route at all
            route.fulfill(status=204, headers={**cors, "Access-Control-Allow-Headers": "Authorization"})
        elif path == "/healthz":
            captured["healthz"] += 1
            reply(200, {"run": "week_02", "date": "2026-10-09"})
        elif path == "/runs":
            captured["runs"] += 1
            if api["runs"] != "ok":
                fail(api["runs"])
            else:
                reply(200, index_body())
        elif path.startswith("/board/"):
            run = path[len("/board/"):]
            captured["boards"].append(run)
            board = fixture("board." + run)
            if api["board"] != "ok":
                fail(api["board"])
            elif board is None:
                fail("404")
            else:
                if api["markup"]:
                    board["rows"][0]["team"] = "<b>bold</b> team"
                reply(200, board)
        elif path == "/me":
            captured["me"].append(request.headers.get("authorization"))
            captured["me_runs"].append(q.get("run"))
            answer = api["me"]
            if answer in ("refused", "401", "404", "no_board", "archive_unavailable"):
                fail(answer)
                return
            run = q.get("run", RUNS["latest"])
            body = fixture(answer + "." + run) or (fixture(answer) if run == RUNS["latest"] else None)
            if body is None:
                fail("404")
                return
            if api["markup"]:   # markup in the participant-authored strings: a record line and the method card
                entry = body["teams"][0]["entry"]
                entry["record"].append(["card", "<b>bold</b> card"])
                entry["method_card"]["text"] = "<b>bold</b> card\n" + entry["method_card"]["text"]
            if run == PENDING:
                body["run"] = phased(body["run"])
            reply(200, body)
        else:
            fail("404")

    def page_guard(route, request):   # the competition page: a navigation is fine, a fetch from the pop-up is not
        if request.resource_type != "document":
            captured["page"].append(request.url)
        route.continue_()

    def mock_board_guard(route, request):   # mock mode's board fixtures, to see that a week is fetched once
        captured["mock_boards"].append(urlparse(request.url).path.split("/")[-1])
        route.continue_()

    def mock_index(route, request):   # mock mode's index: the fixture as is, or the fake API's variant of it
        if api["pending"] == "pulled" and api["phase"] is None:
            route.continue_()
        else:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(index_body()))

    def mock_view_guard(route, request):   # mock mode's per-week private views, to see that the pending week's is fetched each time
        name = urlparse(request.url).path.split("/")[-1]
        captured["mock_views"].append(name)
        body = fixture(name[:-len(".json")]) if api["phase"] is not None and name.endswith(f".{PENDING}.json") else None
        if body is None:
            route.continue_()
        else:   # the pending week's fixture in the phase asked for
            route.fulfill(status=200, content_type="application/json", body=json.dumps({**body, "run": phased(body["run"])}))

    def refuse_space(route, request):
        captured["space"].append(request.url)
        route.abort()

    def new_context(enabled=True, avail_height=1600, retry_ms=None, star_seen=False, motion="reduce", progress=None):
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, reduced_motion=motion)
        # A 1600px-tall screen by default, so the pop-up can fit the whole board (Playwright's screen emulation doesn't
        # reach pop-ups, where screen = the window); resizeTo/moveTo are recorded, since headless can't resize anyway.
        ctx.add_init_script("Object.defineProperty(screen, 'availHeight', { get: function () { return %d; }, configurable: true });"
                            "Object.defineProperty(screen, 'availTop', { get: function () { return 0; }, configurable: true });"
                            "window.__resizes = []; window.resizeTo = function (w, h) { window.__resizes.push(h); };"
                            "window.moveTo = function () {};" % avail_height)
        if retry_ms is not None:   # the private view's one retry, after this long instead of 20 s
            ctx.add_init_script("window.__scRetryMs = %d;" % retry_ms)
        if star_seen:   # the star-the-repo ask would cover the page (a modal) for participants
            ctx.add_init_script("try { localStorage.setItem('sc:star-ask', 'visited'); } catch (e) {}")
        ctx.on("page", watch)
        ctx.route("**/competition/hf-login.js*", serve_js(enabled, progress))
        ctx.route("https://huggingface.co/oauth/authorize*", authorize)
        ctx.route("https://huggingface.co/oauth/token", token_endpoint)
        ctx.route("https://huggingface.co/oauth/userinfo", userinfo_endpoint)
        ctx.route(API + "/**", api_endpoint)
        ctx.route(ORG_API + "/**", organisms_endpoint)
        ctx.route(re.compile(r"^https?://organisms\.api\.ndif\.us(/|$)"), refuse_organisms)
        ctx.route(re.compile(r"^https?://[^/]*\.hf\.space(/|$)"), refuse_space)
        ctx.route(BASE, page_guard)
        ctx.route(re.compile(r"/mock/board\.[^/]+\.json$"), mock_board_guard)
        ctx.route(re.compile(r"/mock/(?!board\.)[^/.]+\.week_\d+\.json$"), mock_view_guard)
        ctx.route("**/mock/runs.json", mock_index)
        # Avatar image: serve a tiny svg so the <img> doesn't error.
        ctx.route("https://huggingface.co/avatars/*", lambda route, req: route.fulfill(
            status=200, content_type="image/svg+xml", body='<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><rect width="28" height="28" fill="#1F3BD3"/></svg>'))
        ctx.route("https://github.com/**", lambda route, req: route.fulfill(status=200, content_type="text/html",
                                                                           body="<title>github stub</title>"))
        # MailerLite + fonts: block, we're offline.
        for pattern in ("https://assets.mailerlite.com/**", "https://fonts.googleapis.com/**", "https://fonts.gstatic.com/**"):
            ctx.route(pattern, lambda route, req: route.abort())
        return ctx

    def launcher_says(page, label):
        page.wait_for_function("label => document.getElementById('hf-open').textContent === label", arg=label)

    ctx = new_context()
    page = ctx.new_page()
    btn = page.locator("#hf-open")

    # ---- 1. competition page, signed out: one button row under the table, nothing else
    page.goto(BASE + "#leaderboard")
    page.wait_for_selector("#lb-private:not([hidden])")
    check(btn.inner_text() == "Sign in with Hugging Face", "page: sign-in button shown")
    check(page.inner_text("#hf-open-note") == "to see your team's private results", "page: soft phrase next to it")
    check(page.locator("#lb-who, #lb-private-content").count() == 0, "page: no who line or private view on the competition page")
    reg = page.locator("a.btn", has_text="Register")
    bs, rs = btn.evaluate("e => getComputedStyle(e)"), reg.evaluate("e => getComputedStyle(e)")
    for prop in ("backgroundColor", "color", "fontFamily", "fontSize", "fontWeight", "boxShadow", "borderTopColor", "paddingLeft"):
        check(bs[prop] == rs[prop], f"button style matches Register: {prop} = {bs[prop]!r}")
    shot(page, "01-page-signed-out", top="#leaderboard", pad=40)

    # ---- 2. the button opens the pop-up, which goes straight to huggingface.co and back, signed in
    with page.expect_popup() as info:
        btn.click()
    win = info.value
    win.wait_for_selector("#lb-who a[href*='steerability-challenge-evaluator']")
    check(len(captured["authorize"]) == 1, "pop-up: went straight to /oauth/authorize (one trip)")
    q = query(captured["authorize"][0])
    check(q.get("client_id") == CLIENT_ID, "authorize: client_id")
    check(q.get("redirect_uri") == LB, f"authorize: redirect_uri = {q.get('redirect_uri')}")
    check(q.get("response_type") == "code", "authorize: response_type=code")
    check(q.get("scope") == "openid profile read-memberships", "authorize: scopes")
    check(q.get("code_challenge_method") == "S256", "authorize: S256")
    tok = captured["token"][-1]
    body = tok["body"]
    check(body.get("grant_type") == "authorization_code", "token: grant_type")
    check(body.get("client_id") == CLIENT_ID, "token: client_id posted")
    check(body.get("code") == "CODE123", "token: code posted")
    check(body.get("redirect_uri") == LB, "token: redirect_uri posted")
    verifier = body.get("code_verifier", "")
    check(43 <= len(verifier) <= 128, f"token: verifier length {len(verifier)} within PKCE bounds")
    check(q.get("code_challenge") == b64url(hashlib.sha256(verifier.encode()).digest()),
          "token: code_challenge == base64url(sha256(code_verifier)) (Python reference)")
    check(tok["headers"].get("content-type") == "application/x-www-form-urlencoded", "token: form-encoded request")
    check(captured["userinfo_headers"].get("authorization") == "Bearer hf_oauth_mock_token", "userinfo: bearer token sent")
    check(win.url == LB, f"pop-up: URL cleaned to {win.url}")
    check(win.evaluate("window.opener === null"), "pop-up: the COOP page severed window.opener, as huggingface.co does")
    check(local(win, "sc:hf-pending") is None, "pop-up: pending sign-in removed")
    who = win.inner_text("#lb-who")
    check("@steerability-challenge-evaluator" in who and "organizer" in who and "team:" not in who, f"pop-up: who line = {who!r}")
    win.wait_for_selector("#lb-public .lb-expand")   # the private view is in (it refits the window after this)
    check(captured["me"] and captured["me"][-1] == "Bearer hf_oauth_mock_token" and captured["me_runs"][-1] == "week_02",
          "results API: /me?run=week_02 asked with the session's bearer token (the fake Space, never the real one)")
    check(captured["healthz"] >= 1, "results API: woken with /healthz on the way to huggingface.co")
    check(win.locator("#lb-public .lb-expand").count() == 2 and win.inner_text("#lb-private-content") == "",
          "pop-up: organizer view rendered from the results API: the team rows are expandable, nothing above the board")
    sess = local(win, "sc:hf-session")
    check(sess["user"]["username"] == "steerability-challenge-evaluator" and sess["accessToken"] == "hf_oauth_mock_token",
          "pop-up: session stored (localStorage)")
    check(abs(sess["expiresAt"] - (win.evaluate("Date.now()") + 28800 * 1000)) < 60_000, "pop-up: expiresAt from expires_in")
    # the board: rendered from the results API's index and week_02 board, never from the competition page
    brows = win.locator("#lb-public .leaderboard > table > tbody > tr:not(.lb-detail)")
    check(captured["runs"] >= 1 and captured["boards"][-1] == "week_02" and brows.count() == len(fixture("board.week_02")["rows"]),
          f"pop-up: the board is rendered from /runs and /board/week_02 ({brows.count()} rows, as the fixture)")
    first = brows.first.locator("td").all_inner_texts()
    check(first == ["01", "reg0x00", "+0.714", "+0.801", "0.017", "0.012"] and brows.first.get_attribute("data-org") == "d7205fd631a5",
          f"pop-up: a row's rank, team and four numbers; data-org from org_hash ({first})")
    base = win.locator("#lb-public .lb-baseline")
    check(base.count() == 3 and base.first.locator("td.lb-rank").inner_text() == "–" and base.first.get_attribute("data-org") is None
          and base.first.locator("td").first.evaluate("e => getComputedStyle(e).backgroundColor") != "rgba(0, 0, 0, 0)",
          "pop-up: three baseline rows, an en dash for the rank, no data-org, shaded")
    check(win.inner_text("#public") == "Leaderboard", "pop-up: the heading reads 'Leaderboard'")
    check(win.is_visible("#lb-weeks") and win.inner_text("#lb-week") == "Week 2" and win.is_enabled("#lb-later") and win.is_enabled("#lb-earlier"),
          "pop-up: the picker reads 'Week 2', ← enabled, → enabled (a week is being evaluated after it)")
    check(win.is_hidden("#lb-caption") and win.locator(".lb-status").count() == 0
          and win.locator("#lb-public ~ :not(.lb-detail-standalone):not(#lb-caption):not(#lb-api)").count() == 0,
          "pop-up: nothing under a published board but the blocks and the organisms panel (the pending week's line is hidden), no status block above it")
    arrow, a_s = win.locator("#lb-earlier"), win.locator("#lb-earlier").evaluate("e => getComputedStyle(e)")
    check(all(a_s[k] == rs[k] for k in ("backgroundColor", "color", "fontFamily", "fontWeight", "boxShadow", "borderTopColor"))
          and arrow.inner_text() == "←" and win.inner_text("#lb-later") == "→",
          "pop-up: the arrows are the Register button's style, the ← and → characters")
    hb, pb, h2b = win.locator(".lb-head").bounding_box(), win.locator("#lb-weeks").bounding_box(), win.locator("#public").bounding_box()
    check(abs((pb["x"] + pb["width"]) - (hb["x"] + hb["width"])) < 1 and pb["y"] < h2b["y"] + h2b["height"] and pb["y"] + pb["height"] > h2b["y"],
          "pop-up: the picker sits at the right end of the heading line")
    # the pop-up's layout: no visible title, who line across the top with Sign out at its right end, no accent
    # square on "Leaderboard", table as wide as the window, and the window sized to fit it all
    check("visually-hidden" in win.locator("h1").get_attribute("class") and win.locator("#lb-who").bounding_box()["y"] < 30,
          "pop-up layout: no visible title; the who line is at the top")
    wl, so = win.locator("#lb-who").bounding_box(), win.locator(".lb-signout").bounding_box()
    signed = win.locator("#lb-who > span").first.bounding_box()
    check(abs(signed["x"] - wl["x"]) < 40 and abs((so["x"] + so["width"]) - (wl["x"] + wl["width"])) < 1
          and abs(so["y"] - signed["y"]) < 10 and "·" not in who,
          "pop-up layout: 'Signed in as …' at the left, 'Sign out' at the right end of the same line")
    check(win.locator("#public").evaluate("e => getComputedStyle(e, '::before').content") == "none",
          "pop-up layout: no accent square before 'Leaderboard'")
    vw = win.evaluate("document.documentElement.clientWidth")
    tw = win.locator("#lb-public .leaderboard").bounding_box()["width"]
    check(abs(tw - (vw - 40)) <= 1, f"pop-up layout: table spans the window ({tw:.0f}px of {vw}px, 20px gutters)")
    win.wait_for_function("window.__resizes.length > 0")
    asked = win.evaluate("window.__resizes[window.__resizes.length - 1]")
    need = win.evaluate("Math.ceil(document.querySelector('main').getBoundingClientRect().bottom + scrollY)"
                        " + Math.max(0, outerHeight - innerHeight)")
    check(asked == min(need, 1600) and need > win.evaluate("innerHeight"),
          f"pop-up: resizes itself to its content, up to the screen's height ({asked}px of {need}px, was {win.evaluate('outerHeight')}px)")
    launcher_says(page, "Open private results")
    check(page.inner_text("#hf-open-note") == "signed in as @steerability-challenge-evaluator",
          "page: the button follows the pop-up's sign-in (storage event), no reload")
    win.screenshot(path=f"{OUT}/02-window-organizer.png", full_page=True)
    shot(page, "02-page-signed-in")

    # ---- 3. the session survives a reload and a fresh pop-up, with no second trip to huggingface.co
    win.reload()
    win.wait_for_selector("#lb-who:not([hidden])")
    check("@steerability-challenge-evaluator" in win.inner_text("#lb-who"), "pop-up reload: still signed in")
    win.close()
    with page.expect_popup() as info:
        btn.click()
    win = info.value
    win.wait_for_selector("#lb-who:not([hidden])")
    check(len(captured["authorize"]) == 1 and win.url == LB, f"reopened pop-up: signed in at {win.url} without another sign-in")

    # ---- 4. sign out in the pop-up; the competition page's button follows
    win.wait_for_selector("#lb-detail-example-missing")
    check(win.locator("#lb-public .lb-expand").count() == 2 and win.locator(".lb-detail-standalone").count() == 2,
          "organizer: two expandable rows and two blocks under the table")
    win.click("#hf-logout")
    win.wait_for_selector("#hf-login:visible")
    check(local(win, "sc:hf-session") is None, "sign out: session removed")
    check(win.locator(".lb-detail, .lb-detail-standalone, .lb-expand, .lb-expandable").count() == 0
          and win.locator("#lb-public .leaderboard tbody tr").count() == 17 and win.is_visible("#lb-weeks")
          and win.inner_text("#lb-private-content") == "",
          "sign out: the private detail is gone; the board and the picker stay")
    launcher_says(page, "Sign in with Hugging Face")
    check(page.inner_text("#hf-open-note") == "to see your team's private results", "sign out: the page's button is back to 'Sign in'")

    # ---- 5. Back from huggingface.co never bounces there again. After the automatic ?signin trip, Chromium skips
    # the page on Back (it left without a click in that window); other browsers land on it, and ?signin is gone.
    win.close()
    hf["authorize"] = "hold"
    with page.expect_popup() as info:
        btn.click()
    win = info.value
    win.wait_for_url("https://huggingface.co/oauth/authorize*")
    win.go_back()
    win.wait_for_timeout(800)
    check(len(captured["authorize"]) == 2 and (win.url == LB or win.url.startswith("https://huggingface.co/")),
          f"back after the automatic trip: no second redirect (now at {win.url.split('?')[0]})")
    win.goto(LB)
    win.click("#hf-login")
    win.wait_for_url("https://huggingface.co/oauth/authorize*")
    win.go_back()
    win.wait_for_selector("#hf-login:visible")
    win.wait_for_timeout(500)
    check(win.url == LB and len(captured["authorize"]) == 3, f"back after clicking Sign in: on {win.url} with the button, no redirect")

    # ---- 6. cancel on huggingface.co, crafted error links, state mismatch, token failure
    hf["authorize"] = "deny"
    win.click("#hf-login")
    win.wait_for_selector("#hf-login-error:not([hidden])")
    check("denied" in win.inner_text("#hf-login-error"), "cancel: provider's message shown")
    check(win.url == LB, "cancel: URL cleaned")
    check(local(win, "sc:hf-pending") is None, "cancel: pending sign-in removed")
    win.goto(LB + "?error=x&error_description=Your+team+is+disqualified")
    win.wait_for_selector("#hf-login-error:not([hidden])")
    err = win.inner_text("#hf-login-error")
    check("disqualified" not in err and "didn't go through" in err, f"crafted error link: generic message only ({err!r})")
    set_pending(win, "s0", age_ms=3600 * 1000)
    win.goto(LB + "?error=x&error_description=Your+team+is+disqualified&state=s0")
    win.wait_for_selector("#hf-login-error:not([hidden])")
    check("disqualified" not in win.inner_text("#hf-login-error"), "crafted error link: an hour-old unfinished sign-in doesn't count")
    n_token = len(captured["token"])
    set_pending(win, "right")
    win.goto(LB + "?code=CODE&state=wrong")
    win.wait_for_selector("#hf-login-error:not([hidden])")
    check("verified" in win.inner_text("#hf-login-error") and len(captured["token"]) == n_token,
          "state mismatch: error shown, no token request")
    hf["token"] = "fail"
    set_pending(win, "s2")
    win.goto(LB + "?code=CODE&state=s2")
    win.wait_for_selector("#hf-login-error:not([hidden])")
    check("didn't go through" in win.inner_text("#hf-login-error"), "token failure: friendly error")
    check(win.is_visible("#hf-login"), "token failure: still signed out")
    hf["token"] = "ok"

    # ---- 7. expired session is dropped
    win.evaluate("localStorage.setItem('sc:hf-session', JSON.stringify({accessToken:'t', expiresAt: Date.now()-1, user:{username:'x',name:'x'}, orgs:[]}))")
    win.goto(LB)
    win.wait_for_selector("#hf-login:visible")
    check(local(win, "sc:hf-session") is None, "expired session dropped")

    # ---- 8. the star-the-repo ask: participants only, until they've gone to the repo; "Go away" rests it 14 days
    def asked(pg):
        pg.wait_for_timeout(900)   # the ask comes 400 ms after the window has fitted itself
        return pg.evaluate("document.getElementById('star-ask').open")
    def fortnight_ago(pg):
        pg.evaluate("localStorage.setItem('sc:star-ask', String(Date.now() - 15 * 24 * 3600 * 1000))")
    win.evaluate("localStorage.removeItem('sc:star-ask')")
    for kind, who_ in [("organizer", "organizers"), ("noteam", "accounts without a team org")]:
        win.goto(f"{LB}?mock={kind}")
        win.wait_for_selector("#lb-who:not([hidden])")
        check(not asked(win), f"star ask: not shown to {who_}")
    win.goto(f"{LB}?mock=none")
    win.wait_for_selector("#hf-login:visible")
    check(not asked(win), "star ask: not shown when signed out")
    win.goto(f"{LB}?mock=participant")
    win.wait_for_selector("#star-ask[open]")
    check("starring our toolkit repo" in win.inner_text("#star-ask"), "star ask: shown to a participant")
    check(win.get_attribute("#star-go", "href") == "https://github.com/generative-computing/steerability/",
          "star ask: 'Take me to the repo' links to the toolkit repo")
    win.screenshot(path=f"{OUT}/05-star-ask.png")
    win.click("#star-dismiss")
    win.wait_for_function("!document.getElementById('star-ask').open")
    check(abs(int(win.evaluate("localStorage.getItem('sc:star-ask')")) - win.evaluate("Date.now()")) < 60_000,
          "star ask: 'Go away' closes it and remembers when")
    win.reload()
    win.wait_for_selector("#lb-who:not([hidden])")
    check(not asked(win), "star ask: not shown again after 'Go away'")
    fortnight_ago(win)
    win.reload()
    win.wait_for_selector("#star-ask[open]")
    win.keyboard.press("Escape")
    win.wait_for_function("!document.getElementById('star-ask').open")
    check(abs(int(win.evaluate("localStorage.getItem('sc:star-ask')")) - win.evaluate("Date.now()")) < 60_000,
          "star ask: back after 14 days; Esc counts as 'Go away'")
    phone = ctx.new_page()
    phone.set_viewport_size({"width": 390, "height": 844})
    fortnight_ago(win)
    phone.goto(f"{LB}?mock=participant")
    phone.wait_for_selector("#star-ask[open]")
    sb = phone.locator("#star-ask").bounding_box()
    check(sb["x"] >= 0 and sb["x"] + sb["width"] <= 390, "star ask: fits a phone screen")
    phone.screenshot(path=f"{OUT}/05-star-ask-phone.png")
    phone.close()
    fortnight_ago(win)
    win.reload()
    win.wait_for_selector("#star-ask[open]")
    with ctx.expect_page() as gh:
        win.click("#star-go")
    repo = gh.value
    repo.wait_for_load_state()
    check(repo.url == "https://github.com/generative-computing/steerability/", f"star ask: the repo opens in a new tab ({repo.url})")
    repo.close()
    win.wait_for_function("!document.getElementById('star-ask').open")
    check(win.evaluate("localStorage.getItem('sc:star-ask')") == "visited", "star ask: 'Take me to the repo' closes it for good")
    win.reload()
    win.wait_for_selector("#lb-who:not([hidden])")
    check(not asked(win), "star ask: never shown again after visiting the repo")

    # ---- 9. mock sessions (localhost only): in the pop-up, and on the competition page
    for kind, expect in [("participant", "team: example-team"), ("organizer", "organizer"), ("noteam", "not a member")]:
        win.goto(f"{LB}?mock={kind}")
        win.wait_for_selector("#lb-who:not([hidden])")
        check(expect in win.inner_text("#lb-private"), f"pop-up mock={kind}: {expect!r} rendered")
        check(win.url == LB, f"pop-up mock={kind}: URL cleaned")
        shot(win, f"03-window-{kind}", top="main", bottom="#lb-private")
    win.goto(f"{LB}?mock=none")
    win.wait_for_selector("#hf-login:visible")
    check(local(win, "sc:hf-session") is None, "pop-up mock=none: signed out")
    page.goto(f"{BASE}?mock=participant")
    launcher_says(page, "Open private results")
    check(page.inner_text("#hf-open-note") == "signed in as @ada" and page.url == BASE + "#leaderboard",
          "page mock=participant: button shows the session, URL cleaned")
    win.close()

    # ---- 10. pop-ups blocked: the leaderboard opens in the same tab instead, and sign-in works there
    hf["authorize"] = "approve"
    page.goto(f"{BASE}?mock=none")
    launcher_says(page, "Sign in with Hugging Face")
    page.evaluate("window.open = function () { return null; }")
    btn.click()
    page.wait_for_selector("#lb-who:not([hidden])")
    check(page.url == LB, f"pop-up blocked: signed in on {page.url} in the same tab")

    # ---- 11. phone width
    mobile = ctx.new_page()
    mobile.set_viewport_size({"width": 390, "height": 844})
    mobile.goto(f"{LB}?mock=participant")
    mobile.wait_for_selector("#lb-who:not([hidden])")
    bb = mobile.locator("#lb-private").bounding_box()
    check(bb["x"] + bb["width"] <= 390, "phone: the pop-up's sign-in area fits (the 6-column table's overflow predates this change)")
    shot(mobile, "04-phone-window-participant", top="main", bottom="#lb-private", pad=10)
    mobile.goto(f"{BASE}?mock=none")
    mobile.wait_for_selector("#lb-private:not([hidden])")
    bb = mobile.locator("#lb-private").bounding_box()
    check(bb["x"] + bb["width"] <= 390, "phone: the competition page's button row fits")
    shot(mobile, "04-phone-page-signed-out", pad=10)
    ctx.close()

    # ---- the private view (steps 12-17), in mock mode: the board and the views come from the fixtures via the preview
    EXAMPLE_HASH = org_hash("example-team")
    ROW = f'#lb-public tr[data-org="{EXAMPLE_HASH}"]'
    P = fixture("participant")["teams"][0]
    LINES = "ls => ls.map(l => [l.querySelector('.lb-key').textContent, l.querySelector('.lb-text').textContent])"
    PROGRESS = "rs => rs.map(r => Array.from(r.cells).map(c => c.textContent))"
    SPINS = "rs => rs.map(r => r.querySelectorAll('.lb-spin').length)"
    # the pending week's progress table for the participant fixture's team: what each setting shows
    COARSE = [["gemma-4-31B-it", "in progress"], ["granite-4.2-30b", "in progress"], ["Qwen3.8-27B", "in progress"]]
    DETAILED = [["gemma-4-31B-it", "completed"], ["granite-4.2-30b", "in progress"], ["Qwen3.8-27B", "in progress"]]
    # the pending week's line under the table, by phase (the fixtures: 15 submissions pulled Oct 13, 12:41 UTC, intake_done true)
    PULLED = "Week 3 is being evaluated: 15 submissions were pulled at the intake, Oct 13, 12:41 UTC"
    PUBLISHED = " Results appear here when the board is published."
    CAPTIONS = {
        "pulled": PULLED + ", and are being checked." + PUBLISHED,
        "evaluating": PULLED + ", and checked; the evaluation is running." + PUBLISHED,
        "finishing": PULLED + ", and checked; the evaluation runs have finished and the results are being scored." + PUBLISHED,
        "absent": PULLED + "." + PUBLISHED,
    }
    RUNNING = "; the evaluation is running." + PUBLISHED

    def private_view(pg, kind, wait, width=1040, progress=None):
        pg.set_viewport_size({"width": width, "height": 860 if width > 600 else 844})
        pg.goto(f"{LB}?mock={kind}" + (f"&progress={progress}" if progress else ""))
        pg.wait_for_selector(wait)

    def progress_of(pg, org):
        """A team's progress table on the pending week: [model, status] per row, and the spinners per row."""
        rows = pg.locator(f"#lb-detail-{org} .lb-progress tr")
        return rows.evaluate_all(PROGRESS), rows.evaluate_all(SPINS)

    def pinned(pg):
        return pg.evaluate("localStorage.getItem('sc:progress')")

    def visible_text(loc):
        """The text as shown: without the screen-reader-only spans (and so without their copy of a title)."""
        return loc.evaluate("e => { const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); const out = []; let n;"
                            " while ((n = w.nextNode())) if (!n.parentElement.closest('.visually-hidden')) out.push(n.textContent);"
                            " return out.join(' '); }")

    def rows_of(group):
        """A breakdown group's rows as [label, value] pairs, the value without its screen-reader text."""
        return group.locator(".lb-row").evaluate_all("rows => rows.map(r => [r.querySelector('dt').textContent, r.querySelector('dd').firstChild.textContent])")

    def red(pg):
        """Elements of main shown in the error red, other than the sign-in error line."""
        return pg.evaluate("Array.from(document.querySelectorAll('main *')).filter(e => e.id !== 'hf-login-error'"
                           " && getComputedStyle(e).color === 'rgb(179, 38, 30)').map(e => e.tagName + '.' + e.className)")

    def top(loc):
        return loc.bounding_box()["y"]

    def text_top(loc):
        """Where an element's text starts: under its top padding (a boxed section's gutter label is padded onto the box's first line)."""
        return loc.evaluate("e => e.getBoundingClientRect().top + parseFloat(getComputedStyle(e).paddingTop)")

    def left(loc):
        return loc.bounding_box()["x"]

    def frames(pg, n=2):
        """Wait for n animation frames (the status wheels are restarted on the frame after a drawer toggle)."""
        pg.evaluate("n => new Promise(r => { const f = k => k ? requestAnimationFrame(() => f(k - 1)) : r(); f(n); })", n)

    def turning(pg, loc):
        """Whether a status wheel turns: its animation's clock advances and two pictures of it 250 ms apart differ. The
        pictures are clipped page screenshots: locator.screenshot() waits for the element to hold still, which never comes."""
        clock = "e => { const a = e.getAnimations()[0]; return a ? a.currentTime : null; }"
        b = loc.bounding_box()
        clip = {"x": b["x"] - 2, "y": b["y"] - 2, "width": b["width"] + 4, "height": b["height"] + 4}
        t0, s0 = loc.evaluate(clock), pg.screenshot(clip=clip, animations="allow")
        pg.wait_for_timeout(250)
        t1, s1 = loc.evaluate(clock), pg.screenshot(clip=clip, animations="allow")
        return t0 is not None and t1 is not None and t1 > t0 and s0 != s1

    # ---- 12. participant, in their own row; a tall screen, so the window can grow when the drawer opens
    tall = new_context(avail_height=4000, star_seen=True)
    pv = tall.new_page()
    private_view(pv, "participant", wait=f"{ROW} .lb-expand")
    check(pv.locator(".lb-entry").count() == 0 and "Your entry" not in pv.inner_text("main") and pv.inner_text("#lb-private-content") == "",
          "participant: nothing above the board describes the entry")
    row = pv.locator(ROW)
    ex = row.locator(".lb-expand")
    check(row.evaluate("e => e.classList.contains('lb-expandable') && getComputedStyle(e).cursor === 'pointer'")
          and ex.inner_text() == "Example Team" and ex.get_attribute("aria-expanded") == "false"
          and ex.get_attribute("aria-controls") == "lb-detail-example-team",
          "participant: their row (data-org = hash of the handle) is expandable; the name is the button with the ARIA state")
    check(ex.evaluate("e => getComputedStyle(e, '::before').content") in ("none", "normal", '""')
          and ex.evaluate("e => getComputedStyle(e).color") == "rgb(31, 59, 211)",
          "participant: no caret before the name; the name is in the accent colour")
    check(pv.locator(".lb-expand").count() == 1 and pv.locator(".lb-detail-standalone").count() == 0,
          "participant: no other row is expandable, and no block under the table")
    detail = pv.locator("#lb-detail-example-team")
    check(detail.evaluate("e => e.tagName === 'TR' && e.hidden && e.previousElementSibling.getAttribute('data-org')") == EXAMPLE_HASH
          and detail.evaluate("e => e.cells.length === 1 && e.cells[0].colSpan") == 6,
          "participant: a hidden drawer row, one cell across, right under it")
    pv.wait_for_function("window.__resizes.length > 0")
    before = pv.evaluate("window.__resizes[window.__resizes.length - 1]")
    row.locator("td.lb-score").first.click()
    check(detail.is_visible() and ex.get_attribute("aria-expanded") == "true" and row.evaluate("e => e.classList.contains('is-open')"),
          "participant: a click on a score cell of the row opens the drawer")
    board_el = pv.locator("#lb-public .leaderboard")
    other = pv.locator('#lb-public tr[data-org="d7205fd631a5"] td.lb-team')
    check(board_el.evaluate("e => e.classList.contains('has-open')")
          and other.evaluate("e => getComputedStyle(e).color") == "rgb(162, 164, 173)"
          and row.locator("td").first.evaluate("e => getComputedStyle(e).backgroundColor") == "rgb(255, 255, 255)"
          and detail.locator(":scope > td").evaluate("e => getComputedStyle(e).backgroundColor") == "rgb(244, 245, 250)"
          and "inset" in detail.locator(":scope > td").evaluate("e => getComputedStyle(e).boxShadow"),
          "open: the board has has-open, the other rows recede, the open row stays white, the drawer is shaded with an inset shadow")
    # the results table: under the board's own columns, one line per model, then the overall row
    heads = detail.locator(".lb-models th").all_inner_texts()
    check(heads == ["results", "model", "95% CI", "S", "delta", "r_side", "r_guard"], f"results: the header row ({heads})")
    mrows = detail.locator(".lb-models tbody tr:not(.lb-overall)")
    heights = [mrows.nth(i).bounding_box()["height"] for i in range(mrows.count())]
    check(len(heights) == 3 and all(abs(h - heights[0]) < 1 for h in heights), f"results: three model rows, each one line high ({heights})")
    gemma = mrows.first.locator("td").all_inner_texts()
    check(gemma == ["", "gemma-4-31B-it", "[+0.44, +0.58]", "+0.512", "+0.620", "0.020", "0.017"], f"results: a model's row ({gemma})")
    overall = detail.locator(".lb-models tr.lb-overall td").all_inner_texts()
    check(overall == ["", "overall", "[+0.39, +0.49]", "+0.438", "", "", ""], f"results: the overall row ({overall})")
    inner_th, outer_th = detail.locator(".lb-models thead th"), pv.locator("#lb-public .leaderboard > table > thead th")
    check(abs(left(inner_th.nth(3)) - left(outer_th.nth(2))) <= 1 and abs(left(inner_th.nth(6)) - left(outer_th.nth(5))) <= 1,
          "results: the S column starts where the board's 'Overall score' does, r_guard under r_guard (within 1px)")
    # the breakdown: three groups, the gutter label on the first heading's line
    bd = detail.locator(".lb-sec", has=pv.locator(".lb-groups"))
    h3 = bd.locator("h3").all_inner_texts()
    check(h3 == ["dishonesty (g per family)", "side effects (regression)", "guards (regression)"], f"breakdown: the three headings ({h3})")
    check(bd.locator(".lb-k").inner_text() == "breakdown" and abs(top(bd.locator(".lb-k")) - top(bd.locator("h3").first)) <= 1,
          "breakdown: the gutter label sits on the line of the first heading")
    groups = bd.locator(".lb-group")
    dis = rows_of(groups.nth(0))
    check(dis == [["Instructed deception", "+0.70"], ["Incentives & sandbagging", "+0.45"], ["User pressure & sycophancy", "+0.12"]],
          f"breakdown: the dishonesty rows, family label and g ({dis})")
    title = groups.nth(0).locator("dd").first.get_attribute("title")
    check(title == "g is the improvement over the unsteered model, per model: gemma-4-31B-it +0.74, granite-4.2-30b +0.66, Qwen3.8-27B +0.70",
          f"breakdown: the per-model values are the value's title ({title!r})")
    check(["Knowledge", "0.01"] in rows_of(groups.nth(1)) and ["Refusal behaviour", "0.05"] in rows_of(groups.nth(2)),
          "breakdown: side-effect and guard rows with the mean over the models")
    shown = visible_text(detail)
    absent = [x for x in ("instructed_lie", "▲", "g is the", "truncation above the reference", "Truncation above", "rank 4 of 14",
                          "week_01 +0.31", "·", "per model:") if x in shown]
    check(not absent, f"drawer: no dim ids, marks, legend, flag text, rank text, history or dot separators ({absent})")
    # the record: the fixture's lines verbatim, then the run's diagnostics per model
    rec = detail.locator(".lb-sec.lb-boxed", has=pv.locator(".lb-record"))
    lines = rec.locator(".lb-line").evaluate_all(LINES)
    n_rec = len(P["entry"]["record"])
    check(lines[:n_rec] == P["entry"]["record"], f"record: every line of the fixture's record, key and text verbatim ({lines[:3]}…)")
    run_lines = lines[n_rec:]
    check([l[0] for l in run_lines] == ["run", "", ""] and run_lines[0][1].startswith("gemma-4-31B-it  declines 8% (reference 5%)  truncated 1% (1%)")
          and "judge failures 2" in run_lines[0][1] and "truncated 4% (2%), above the reference" in run_lines[1][1]
          and "judge refusals 1" in run_lines[1][1] and run_lines[2][1] == "Qwen3.8-27B  declines 6% (reference 5%)  truncated 1% (1%)  judge failures 1",
          f"record: the run's diagnostics per model after the record ({run_lines})")
    check(rec.locator(".lb-k").inner_text() == "record" and abs(text_top(rec.locator(".lb-k")) - top(rec.locator(".lb-line").first)) <= 1,
          "record: the gutter label sits on the box's first line")
    # the method card, as submitted, after the record
    card = detail.locator(".lb-sec.lb-boxed", has=pv.locator(".lb-card"))
    check(card.locator(".lb-k").inner_text() == "method card"
          and card.locator(".lb-card").evaluate("e => e.firstChild.textContent") == P["entry"]["method_card"]["text"]
          and P["entry"]["method_card"]["text"].startswith("---") and card.locator(".lb-card").evaluate("e => getComputedStyle(e).whiteSpace") == "pre-wrap"
          and card.locator(".lb-card b, .lb-card h1").count() == 0,
          "method card: the fixture's text verbatim in a box, nothing rendered as markdown")
    order = detail.locator(".lb-drawer > *").evaluate_all("ns => ns.map(n => n.className)")
    check(order == ["lb-models", "lb-sec", "lb-sec lb-boxed", "lb-sec lb-boxed"], f"drawer: results, breakdown, record, method card and nothing else ({order})")
    pv.wait_for_function("b => window.__resizes[window.__resizes.length - 1] !== b", arg=before)
    after = pv.evaluate("window.__resizes[window.__resizes.length - 1]")
    check(after > before, f"participant: the window grew with the drawer ({before}px -> {after}px)")
    pv.screenshot(path=f"{OUT}/06-drawer-participant.png", full_page=True)
    row.locator("td.lb-score").first.click()
    check(detail.is_hidden() and ex.get_attribute("aria-expanded") == "false" and not board_el.evaluate("e => e.classList.contains('has-open')"),
          "participant: clicking the row again closes the drawer")
    ex.focus()
    pv.keyboard.press("Enter")
    check(detail.is_visible() and ex.get_attribute("aria-expanded") == "true", "participant: Enter on the focused name toggles it once")

    # ---- 12b. the week picker: ← loads Week 1 (the example team at rank 6), → comes back with the drawer closed
    pv.click("#lb-earlier")
    pv.wait_for_function("document.getElementById('lb-week').textContent === 'Week 1' && !document.getElementById('lb-later').disabled")
    pv.wait_for_selector(f"{ROW} .lb-expand")
    check(pv.is_disabled("#lb-earlier") and pv.is_enabled("#lb-later")
          and pv.locator("#lb-earlier").evaluate("e => getComputedStyle(e).backgroundColor") == "rgb(90, 92, 102)",
          "week 1: ← disabled at the start of the index (in the soft grey), → enabled")
    check(pv.locator("#lb-public .leaderboard > table > tbody > tr:not(.lb-detail)").count() == 14
          and pv.locator(f"{ROW} td.lb-rank").inner_text() == "06",
          "week 1: 14 rows (11 + 3), the example team at rank 06")
    pv.locator(ROW).click()
    d1 = pv.locator("#lb-detail-example-team")
    check(d1.is_visible() and d1.locator(".lb-models tr.lb-overall td").nth(3).inner_text() == "+0.310"
          and ["intake", "PASS (0 error(s), 0 warning(s)) track white-box (detected)"] in d1.locator(".lb-line").evaluate_all(LINES)
          and "version: v2" in d1.locator(".lb-card").inner_text(),
          "week 1: the drawer shows the week's results, record and card")
    n_boards = len(captured["mock_boards"])
    pv.click("#lb-later")
    pv.wait_for_function("document.getElementById('lb-week').textContent === 'Week 2' && !document.getElementById('lb-earlier').disabled")
    pv.wait_for_selector(f"{ROW} .lb-expand")
    check(pv.locator("#lb-public tr.is-open, #lb-public tr.lb-detail:not([hidden])").count() == 0
          and pv.locator(f"{ROW} td.lb-rank").inner_text() == "04" and len(captured["mock_boards"]) == n_boards,
          "week 2: back (from the cache) with the earlier drawer closed")

    # ---- 12c. the pending week: → from the latest published week shows the skeleton, the own row with the spinner, the drawer
    check(pv.is_enabled("#lb-later"), "week 2: → enabled, a week is being evaluated")
    n_views = len(captured["mock_views"])
    pv.click("#lb-later")
    pv.wait_for_function("document.getElementById('lb-week').textContent === 'Week 3'")
    pv.wait_for_selector(f"{ROW}.lb-expandable .lb-expand")
    check(pv.is_disabled("#lb-later") and pv.is_enabled("#lb-earlier"), "week 3: → disabled at the end, ← enabled")
    prows = pv.locator("#lb-public .leaderboard > table > tbody > tr:not(.lb-detail)")
    own = prows.first
    scores = own.locator("td.lb-score")
    check(prows.count() == 1 and own.evaluate("e => e.classList.contains('lb-expandable') && e.getAttribute('data-org')") == EXAMPLE_HASH
          and own.locator(".lb-expand").inner_text() == "Example Team" and own.locator("td.lb-rank").inner_text() == ""
          and scores.first.locator(".lb-spin").count() == 1 and scores.first.locator(".lb-spin").get_attribute("aria-label") == "being evaluated"
          and scores.first.locator(".lb-spin").get_attribute("role") == "img" and scores.all_inner_texts() == ["", "", "", ""],
          "week 3: the own row alone: the name button, an empty rank, the spinner in the Overall score cell, empty cells")
    spin = scores.first.locator(".lb-spin")
    check(spin.evaluate("e => getComputedStyle(e).animationName") == "none"
          and spin.evaluate("e => getComputedStyle(e).backgroundColor") == "rgb(31, 59, 211)"
          and spin.evaluate("e => getComputedStyle(e).borderTopColor") == "rgb(31, 59, 211)"
          and spin.evaluate("e => getComputedStyle(e).borderRadius") == "50%",
          "week 3: under reduced motion the wheel does not turn and is a filled accent dot")
    sb, cb = spin.bounding_box(), scores.first.bounding_box()
    check(abs((sb["x"] + sb["width"]) - (cb["x"] + cb["width"] - 20)) <= 1, "week 3: the spinner is right-aligned where the number would be")
    check(pv.locator("#lb-public tr.lb-hidden, #lb-public .bar").count() == 0, "week 3: no placeholder rows for the other submissions")
    check(not re.search(r"\d", "".join(pv.locator("#lb-public td.lb-score").all_inner_texts())), "week 3: no digit in any score cell")
    cap3 = pv.inner_text("#lb-caption")
    check(cap3 == CAPTIONS["evaluating"], f"week 3: the line under the table says the evaluation is running ({cap3!r})")
    own.click()
    frames(pv)
    check(spin.count() == 1 and spin.evaluate("e => getComputedStyle(e).animationName") == "none"
          and spin.evaluate("e => getComputedStyle(e).backgroundColor") == "rgb(31, 59, 211)",
          "week 3: with the drawer open, the row's wheel is still one filled dot that does not turn (reduced motion)")
    d3 = pv.locator("#lb-detail-example-team")
    secs = d3.locator(".lb-drawer > .lb-sec > .lb-k").all_inner_texts()
    check(d3.is_visible() and secs == ["progress", "record", "method card"] and d3.locator(".lb-models, .lb-groups").count() == 0
          and d3.locator(".lb-drawer > *").count() == 3,
          f"week 3 drawer: progress, record, method card and nothing else ({secs})")
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "competition", "hf-login.js"), encoding="utf-8") as f:
        shipped = re.findall(r"pendingProgress: '([^']*)'", f.read())
    check(shipped == ["coarse"], f"hf-login.js ships CONFIG.pendingProgress 'coarse' ({shipped})")
    prog, spins = progress_of(pv, "example-team")
    ptext = d3.locator(".lb-progress").inner_text()
    check(prog == COARSE and spins == [1, 1, 1] and "completed" not in ptext and "not started" not in ptext,
          f"week 3 drawer, coarse (the site's default): every model in progress with the spinner, the completed one too ({prog}, {spins})")
    check(["pulled", "2026-10-13 12:08 UTC"] in d3.locator(".lb-line").evaluate_all(LINES) and "version: v4" in d3.locator(".lb-card").inner_text(),
          "week 3 drawer: the record of what was taken at the intake, the card as submitted")
    pv.screenshot(path=f"{OUT}/08-pending-participant.png", full_page=True)
    pv.click("#lb-earlier")
    pv.wait_for_function("document.getElementById('lb-week').textContent === 'Week 2' && !document.getElementById('lb-later').disabled")
    pv.wait_for_selector(f"{ROW} .lb-expand")
    check(pv.locator(f"{ROW} td.lb-score").first.inner_text() == "+0.438" and pv.is_hidden("#lb-caption")
          and pv.locator("#lb-public tr.lb-hidden, .lb-spin").count() == 0,
          "← returns to Week 2 with its numbers, no line under the table, nothing of the pending week")
    pv.click("#lb-later")
    pv.wait_for_selector(f"{ROW}.lb-expandable .lb-expand")
    check(captured["mock_views"][n_views:] == ["participant.week_03.json"] * 2, "week 3: the private view is fetched again on a second visit")
    # with motion allowed, the square turns
    mo = new_context(avail_height=4000, star_seen=True, motion="no-preference")
    mp = mo.new_page()
    private_view(mp, "participant", wait=f"{ROW} .lb-expand")
    mp.click("#lb-later")
    mp.wait_for_selector(f"{ROW}.lb-expandable .lb-spin")
    mspin = mp.locator(f"{ROW} .lb-spin")
    check(mspin.evaluate("e => getComputedStyle(e).animationName") == "lb-spin" and mspin.evaluate("e => getComputedStyle(e).backgroundColor") == "rgba(0, 0, 0, 0)"
          and mspin.evaluate("e => getComputedStyle(e).borderTopColor") == "rgb(31, 59, 211)" and mspin.evaluate("e => getComputedStyle(e).borderLeftColor") == "rgb(228, 228, 232)",
          "week 3: with motion allowed the wheel turns: a hairline ring with one accent arc")
    # ... and keeps turning when its drawer opens, closes and reopens, and when the window resizes: the wheels are
    # restarted (new nodes), never added
    mrow, mwheel = mp.locator(ROW), mp.locator("#lb-detail-example-team .lb-progress .lb-spin")
    mrow.click()
    mp.wait_for_timeout(300)
    n_wheels = mwheel.count()
    check(mp.is_visible("#lb-detail-example-team") and n_wheels >= 1 and turning(mp, mspin) and turning(mp, mwheel.first),
          f"week 3, motion allowed: with the drawer open, the row's wheel and the drawer's ({n_wheels}) keep turning")
    mrow.click()
    mrow.click()
    frames(mp)
    mspin.evaluate("e => { e.__before_resize = true; }")
    mp.set_viewport_size({"width": 1000, "height": 860})
    mp.wait_for_timeout(300)   # the restart comes 150 ms after the last resize event
    wheels = "ws => ws.map(w => [w.getAttribute('role'), w.getAttribute('aria-label')])"
    check(mspin.evaluate_all(wheels) == [["img", "being evaluated"]] and mwheel.evaluate_all(wheels) == [["img", "being evaluated"]] * n_wheels
          and mp.locator("#lb-detail-example-team .lb-progress tr").evaluate_all("rs => rs.every(r => r.querySelectorAll('.lb-spin').length <= 1)"),
          "week 3, motion allowed: after closing, reopening and a resize, the row still holds one wheel and the drawer as many as before, each with its role and label")
    check(not mspin.evaluate("e => !!e.__before_resize") and turning(mp, mspin) and turning(mp, mwheel.first),
          "week 3, motion allowed: the resize restarted the wheels (new nodes), and they keep turning")
    mo.close()

    # ---- 13. an unscored model; a team without an entry (a block under the table); a week without a fixture
    std = new_context(star_seen=True)
    sp = std.new_page()
    private_view(sp, "participant-unscored", wait=f"{ROW} .lb-expand")
    sp.locator(ROW).click()
    du = sp.locator("#lb-detail-example-team")
    granite = du.locator(".lb-models tbody tr", has_text="granite")
    cells = granite.locator("td").all_inner_texts()
    check(cells == ["", "granite-4.2-30b not scored", "—", "—", "—", "—", "—"]
          and abs(granite.bounding_box()["height"] - du.locator(".lb-models tbody tr").first.bounding_box()["height"]) < 1,
          f"unscored: the model's row reads 'not scored' on one line, its interval and scores — ({cells})")
    ov = du.locator(".lb-models tr.lb-overall td").all_inner_texts()
    check(ov[2:4] == ["—", "—"], f"unscored: the overall S and interval are — ({ov})")
    check(["", "granite-4.2-30b  not scored: A request exceeded the run's time limit"] in du.locator(".lb-line").evaluate_all(LINES),
          "unscored: the run line says why")
    dg = du.locator(".lb-group").first
    check(["User pressure & sycophancy", "—"] in rows_of(dg)
          and all("granite-4.2-30b —" in t for t in dg.locator("dd").evaluate_all("ds => ds.map(d => d.title)")),
          "unscored: a family with g null shows —; every title gives — for the unscored model")
    private_view(sp, "participant-noentry", wait=".lb-detail-standalone")
    block = sp.locator(".lb-detail-standalone")
    check(sp.locator(".lb-expand, .lb-expandable, .lb-detail").count() == 0 and block.count() == 1
          and block.locator(".lb-standalone-name").inner_text() == "example-team"
          and block.locator(".lb-standalone-note").inner_text() == "No entry for this organization in Week 2. The next intake is on the competition page's countdown."
          and block.evaluate("e => e.previousElementSibling.id === 'lb-public' && e.nextElementSibling.id === 'lb-caption'")
          and block.evaluate("e => getComputedStyle(e).backgroundColor") == "rgb(244, 245, 250)"
          and sp.inner_text("#lb-private-content") == "",
          "no entry: one shaded block under the table, with the handle and the line; no expandable row")
    check(not red(sp), f"no entry: no red text anywhere ({red(sp)})")
    sp.click("#lb-earlier")
    sp.wait_for_function("(document.querySelector('.lb-detail-standalone .lb-standalone-note') || {}).textContent"
                         " === \"No entry for this organization in Week 1. The next intake is on the competition page's countdown.\"")
    check(sp.locator(".lb-detail-standalone").count() == 1, "mock: a week without a fixture for the kind shows as a week without an entry")

    # ---- 13b. the pending week for a team without an entry, and signed out
    private_view(sp, "participant-noentry", wait=".lb-detail-standalone")
    sp.click("#lb-later")
    sp.wait_for_function("(document.querySelector('.lb-detail-standalone .lb-standalone-note') || {}).textContent"
                         " === \"No entry for this organization in Week 3. The next intake is on the competition page's countdown.\"")
    check(sp.locator("#lb-public table, #lb-public tr, .lb-spin").count() == 0 and sp.inner_text("#lb-board-note") == "Week 3 is being evaluated."
          and sp.locator(".lb-detail-standalone").count() == 1 and sp.inner_text("#lb-week") == "Week 3"
          and sp.inner_text("#lb-caption").startswith("Week 3 is being evaluated") and sp.inner_text("#lb-caption").endswith(RUNNING),
          "week 3, no entry: no table, the line, the block saying so, and the phase under the table")
    sp.goto(f"{LB}?mock=none")
    sp.wait_for_selector("#hf-login:visible")
    sp.wait_for_selector("#lb-later:not([disabled])")
    sp.click("#lb-later")
    sp.wait_for_function("(document.getElementById('lb-board-note') || {}).textContent === 'Week 3 is being evaluated.'")
    check(sp.locator("#lb-public table, .lb-spin, .lb-detail-standalone, .lb-expand").count() == 0 and sp.is_disabled("#lb-later")
          and sp.locator("#lb-board-note").evaluate("e => e.tagName === 'P' && e.classList.contains('soft')")
          and sp.inner_text("#lb-caption").startswith("Week 3 is being evaluated") and sp.inner_text("#lb-caption").endswith(RUNNING),
          "week 3, signed out: the picker reaches it; the line, no table, no spinner; the phase under the table (from /runs)")

    # ---- 13c. the pending week before its pull: a participant's team as a row with the spinner, nothing to open, nothing fetched;
    # anyone else a line; and an index without a pending run
    api["pending"] = "unpulled"
    n_views = len(captured["mock_views"])
    private_view(sp, "participant", wait=f"{ROW} .lb-expand")
    sp.click("#lb-later")
    sp.wait_for_function("document.getElementById('lb-week').textContent === 'Week 3' && document.querySelector('#lb-public tbody tr td.lb-team')")
    urows = sp.locator("#lb-public .leaderboard > table > tbody > tr")
    check(urows.count() == 1 and urows.first.get_attribute("data-org") == EXAMPLE_HASH and urows.first.locator("td.lb-team").inner_text() == "Example Team"
          and sp.locator(".lb-expand, tr.lb-expandable, tr.lb-hidden, tr.lb-detail, .lb-detail-standalone").count() == 0
          and urows.first.locator("td.lb-rank").inner_text() == "" and urows.first.locator("td.lb-score").first.locator(".lb-spin").count() == 1
          and urows.first.locator("td.lb-score").all_inner_texts() == ["", "", "", ""] and sp.is_disabled("#lb-later"),
          "week 3 before the pull: one row, the team's name as plain text, the spinner where the score will be, nothing hidden")
    check(len(captured["mock_views"]) == n_views and sp.inner_text("#lb-private-content") == "", "week 3 before the pull: no private view is requested")
    cap_u = sp.inner_text("#lb-caption")
    check(cap_u == "Week 3 has not been pulled yet. Submissions are pulled at the next intake, on the competition page's countdown; "
                   "results appear here when the board is published.", f"week 3 before the pull: the line under the table ({cap_u!r})")
    sp.screenshot(path=f"{OUT}/09-pending-unpulled.png", full_page=True)
    for kind in ("none", "organizer"):
        sp.goto(f"{LB}?mock={kind}")
        sp.wait_for_selector("#lb-later:not([disabled])")
        sp.click("#lb-later")
        sp.wait_for_function("(document.getElementById('lb-board-note') || {}).textContent === 'Week 3 has not been pulled yet.'")
        check(sp.locator("#lb-public .leaderboard, #lb-public table, .lb-spin, .lb-detail-standalone").count() == 0
              and sp.locator("#lb-board-note").evaluate("e => e.tagName === 'P' && e.classList.contains('soft')")
              and sp.inner_text("#lb-caption").startswith("Week 3 has not been pulled yet.") and sp.inner_text("#lb-private-content") == "",
              f"week 3 before the pull, mock={kind}: the line and no table")
    api["pending"] = None
    private_view(sp, "participant", wait=f"{ROW} .lb-expand")
    check(sp.is_disabled("#lb-later") and sp.inner_text("#lb-week") == "Week 2" and "Week 3" not in sp.inner_text("main"),
          "index without a pending run: → disabled on Week 2, no Week 3")
    api["pending"] = "pulled"

    # ---- 13d. the line under the pending week's table follows the run's phase; without one (an older API) it is the plain
    # sentence. The drawer's rule does not depend on the phase: a model not started reads in progress
    for phase in ("pulled", "finishing", "absent"):
        api["phase"] = phase
        private_view(sp, "participant", wait=f"{ROW} .lb-expand")   # a fresh page load: the index is read once per load
        sp.click("#lb-later")
        sp.wait_for_selector(f"{ROW}.lb-expandable .lb-expand")
        cap_p = sp.inner_text("#lb-caption")
        check(cap_p == CAPTIONS[phase], f"week 3, phase {phase}: the line under the table ({cap_p!r})")
        if phase == "pulled":
            sp.locator(ROW).click()
            prog = sp.locator("#lb-detail-example-team .lb-progress tr").evaluate_all(PROGRESS)
            check(prog[2] == ["Qwen3.8-27B", "in progress"] and sp.locator("#lb-detail-example-team .lb-progress tr").nth(2).locator(".lb-spin").count() == 1,
                  f"week 3, phase pulled: the drawer still reads in progress, with the spinner, on the model not started ({prog})")
    api["phase"] = None

    # ---- 13e. the pending week for a submission that did not pass the intake checks: its row with the spinner, and one line
    # in the drawer instead of the progress table
    private_view(sp, "participant-unscored", wait=f"{ROW} .lb-expand")
    sp.click("#lb-later")
    sp.wait_for_selector(f"{ROW}.lb-expandable .lb-expand")
    check(sp.locator(f"{ROW} td.lb-score").first.locator(".lb-spin").count() == 1 and sp.locator(".lb-detail-standalone").count() == 0,
          "week 3, intake failed: the own row with the spinner, no block under the table")
    sp.locator(ROW).click()
    df = sp.locator("#lb-detail-example-team")
    psec = df.locator(".lb-drawer > .lb-sec", has=sp.locator(".lb-k", has_text="progress"))
    check(psec.count() == 1 and psec.locator("table, .lb-progress, .lb-spin").count() == 0
          and psec.locator("p.soft").inner_text() == "Not evaluated: the submission did not pass the intake checks (see the record)."
          and "not started" not in df.inner_text() and "in progress" not in df.inner_text(),
          "week 3, intake failed: the drawer's progress is one line saying the submission is not evaluated, no table")
    flines = df.locator(".lb-line").evaluate_all(LINES)
    check(flines[-2:] == [["intake", "FAIL (1 error(s), 0 warning(s)) track unassigned"],
                          ["", "error: google__gemma-4-31B-it.spipe: the bundle is not frozen (no lock section)"]]
          and df.locator(".lb-card").count() == 0,
          f"week 3, intake failed: the record ends with the verdict and the error; no method card ({flines[-2:]})")
    check(not red(sp), f"week 3, intake failed: no red text anywhere ({red(sp)})")
    sp.screenshot(path=f"{OUT}/08-pending-intake-failed.png", full_page=True)

    # ---- 13f. the progress setting. A participant's browser that pinned ?progress=detailed still gets the site's coarse
    # view (the pin is an organizer's); under CONFIG.pendingProgress 'detailed' a participant's drawer tells the models
    # apart, whatever the browser pinned; ?progress=site drops the pin
    private_view(sp, "participant", wait=f"{ROW} .lb-expand", progress="detailed")
    sp.click("#lb-later")
    sp.wait_for_selector(f"{ROW}.lb-expandable .lb-expand")
    sp.locator(ROW).click()
    prog, spins = progress_of(sp, "example-team")
    check(pinned(sp) == "detailed" and prog == COARSE and spins == [1, 1, 1],
          f"week 3, a participant who pinned ?progress=detailed: the site's coarse view all the same ({prog}, {spins})")
    sp.goto(f"{LB}?progress=site")
    sp.wait_for_selector(f"{ROW} .lb-expand")
    check(pinned(sp) is None, "?progress=site drops the browser's pin")
    dc = new_context(star_seen=True, progress="detailed")
    dp = dc.new_page()
    for pin in (None, "coarse"):
        private_view(dp, "participant", wait=f"{ROW} .lb-expand", progress=pin)
        dp.click("#lb-later")
        dp.wait_for_selector(f"{ROW}.lb-expandable .lb-expand")
        dp.locator(ROW).click()
        prog, spins = progress_of(dp, "example-team")
        check(prog == DETAILED and spins == [0, 1, 1] and "not started" not in dp.inner_text("#lb-detail-example-team .lb-progress"),
              f"week 3, site 'detailed', participant (pinned {pin}): completed, or in progress with the spinner; never 'not started' ({prog}, {spins})")
    dp.screenshot(path=f"{OUT}/08-pending-participant-detailed.png", full_page=True)
    # ... and an organizer's pin wins over the site's: coarse here, until ?progress=site gives the raw codes back
    for pin in ("coarse", "site"):
        private_view(dp, "organizer", wait="#lb-detail-example-missing", progress=pin)
        dp.click("#lb-later")
        dp.wait_for_function("document.querySelectorAll('#lb-public tr.lb-expandable').length === 15")
        dp.locator("#lb-public tr.lb-expandable", has=dp.locator(".lb-expand", has_text="Coxswains")).click()
        prog, spins = progress_of(dp, "coxswains")
        want = ([["in progress"] * 3, [1, 1, 1]] if pin == "coarse" else [["not started"] * 3, [0, 0, 0]])
        check([s for _, s in prog] == want[0] and spins == want[1],
              f"week 3, site 'detailed', organizer pinned {pin}: Coxswains reads {want[0][0]} ({prog}, {spins})")
    dc.close()

    # ---- 14. organizer: every submission row with a team file expandable, any number open, a block for every other file,
    # nothing above the board
    oc = new_context()
    op = oc.new_page()
    private_view(op, "organizer", wait="#lb-detail-example-missing")
    exp = op.locator("#lb-public tr.lb-expandable")
    names = exp.locator(".lb-expand").all_inner_texts()
    check(exp.count() == 2 and sorted(names) == ["Example Team", "Second Example"] and op.locator("#lb-public .lb-baseline.lb-expandable").count() == 0,
          f"organizer: exactly the two submission rows with a team file are expandable ({names})")
    check(op.inner_text("#lb-private-content") == "" and op.locator(".lb-status, .lb-run-status").count() == 0,
          "organizer: nothing above the board (no status block)")
    exp.nth(0).click()
    exp.nth(1).click()
    check(op.locator("#lb-public tr.lb-detail:not([hidden])").count() == 2 and op.locator("#lb-public tr.is-open").count() == 2,
          "organizer: any number of drawers open at once")
    second = op.locator("#lb-detail-second-example")
    check(["Incentives & sandbagging", "—"] in rows_of(second.locator(".lb-group").first)
          and "ibm-granite__granite-4.2-30b.spipe  —" in second.inner_text() and "declines — (reference —)" in second.inner_text(),
          "organizer: g null, a null size and null decline shares as —")
    blocks = op.locator(".lb-detail-standalone").evaluate_all("bs => bs.map(b => b.id)")
    check(blocks == ["lb-detail-example-missing", "lb-detail-example-review"],
          f"organizer: a block per team file without a row, whatever its status, in the payload's order ({blocks})")
    review = op.locator("#lb-detail-example-review")
    rl = review.locator(".lb-line .lb-text").all_inner_texts()
    check(rl[-1] == "warning: google__gemma-4-31B-it.spipe has custom controls; it is scored after a code review"
          and review.locator(".lb-models, .lb-groups").count() == 0 and review.locator(".lb-card").inner_text().startswith("# Example Review"),
          "organizer: the review block's record ends with the needs-review warning; no results; its card")
    missing = op.locator("#lb-detail-example-missing")
    ml = missing.locator(".lb-line").evaluate_all(LINES)
    check(ml == [["repo", "example-missing/submission"],
                 ["status", "missing: no example-missing/submission repository readable by the evaluator"],
                 ["warning", "example-missing/submission is public"],
                 ["warning", "steerability-challenge-evaluator has the write role; the guide asks for read"]]
          and missing.locator(".lb-models, .lb-groups, .lb-card").count() == 0
          and missing.locator(".lb-standalone-name").inner_text() == "Example Missing",
          f"organizer: the missing team's block is its record alone: the status line and both warnings ({ml})")
    check(not red(op), f"organizer: no red text anywhere ({red(op)})")
    op.screenshot(path=f"{OUT}/07-organizer-open.png", full_page=True)

    # ---- 14b. the organizer on the pending week: every pulled team a named row with the spinner, no hidden rows
    op.click("#lb-later")
    op.wait_for_function("document.getElementById('lb-week').textContent === 'Week 3' && document.querySelectorAll('#lb-public tr.lb-expandable').length === 15")
    prow = op.locator("#lb-public tr.lb-expandable")
    check(op.locator("#lb-public tr.lb-hidden").count() == 0 and op.locator("#lb-public td.lb-score .lb-spin").count() == 15
          and prow.first.locator(".lb-expand").inner_text() == "reg0x00" and "Third Example" in prow.locator(".lb-expand").all_inner_texts()
          and op.locator(".lb-detail-standalone").evaluate_all("bs => bs.map(b => b.id)") == ["lb-detail-example-missing"]
          and op.inner_text("#lb-private-content") == "",
          "week 3, organizer: 15 named expandable rows with spinners in the payload's order, no hidden rows, a block for the missing team, nothing above the board")
    prow.nth(0).click()
    prow.nth(1).click()
    check(op.locator("#lb-public tr.lb-detail:not([hidden])").count() == 2 and op.locator("#lb-public tr.lb-detail:not([hidden]) .lb-progress").count() == 2,
          "week 3, organizer: two drawers open at once, each with the evaluation's progress")
    op.locator("#lb-public tr.lb-expandable", has=op.locator(".lb-expand", has_text="Coxswains")).click()
    (first_prog, first_spins), (cox_prog, cox_spins) = progress_of(op, "reg0x00"), progress_of(op, "coxswains")
    check([s for _, s in first_prog] == ["in progress"] * 3 and first_spins == [1, 1, 1] and op.is_visible("#lb-detail-coxswains")
          and [s for _, s in cox_prog] == ["in progress"] * 3 and cox_spins == [1, 1, 1],
          f"week 3, organizer, the site's coarse default: what a participant sees, every model in progress with the spinner ({first_prog}, {cox_prog})")
    op.screenshot(path=f"{OUT}/08-pending-organizer.png", full_page=True)
    # pinned with ?progress=detailed, this browser shows the raw codes
    op.goto(f"{LB}?progress=detailed")
    op.wait_for_selector("#lb-detail-example-missing")
    op.click("#lb-later")
    op.wait_for_function("document.querySelectorAll('#lb-public tr.lb-expandable').length === 15")
    prow.nth(0).click()
    op.locator("#lb-public tr.lb-expandable", has=op.locator(".lb-expand", has_text="Coxswains")).click()
    (first_prog, first_spins), (cox_prog, cox_spins) = progress_of(op, "reg0x00"), progress_of(op, "coxswains")
    check(pinned(op) == "detailed" and [s for _, s in first_prog] == ["completed"] * 3 and first_spins == [0, 0, 0]
          and [s for _, s in cox_prog] == ["not started"] * 3 and cox_spins == [0, 0, 0],
          f"week 3, organizer pinned ?progress=detailed: the raw codes: reg0x00 completed on every model, Coxswains not started with no spinner ({first_prog}, {cox_prog})")
    op.screenshot(path=f"{OUT}/08-pending-organizer-detailed.png", full_page=True)
    op.goto(f"{LB}?progress=site")
    op.wait_for_selector("#lb-detail-example-missing")

    # ---- 15. results API errors, from the fake Space. The board: 503 no_board, a refused connection (one retry, then the
    # failure copy, whose "try again" works), a later week that fails. The private view: 401 signs out, 404 is a week
    # without files, archive_unavailable and a refused connection (one retry, then the failure copy), markup as text.
    ec = new_context(retry_ms=600, star_seen=True)
    ep = ec.new_page()
    ep.goto(LB)
    ep.wait_for_selector("#hf-login:visible")
    def sign_in_as_participant():
        ep.evaluate("localStorage.setItem('sc:hf-session', JSON.stringify({accessToken: 'hf_oauth_mock_token', "
                    "scope: 'openid profile read-memberships', expiresAt: Date.now() + 3600e3, "
                    "user: {username: 'ada', name: 'Ada', picture: '', profile: 'https://huggingface.co/ada'}, "
                    "orgs: [{handle: 'example-team', name: 'Example Team', role: 'write'}]}))")
    def content_says(phrase):
        ep.wait_for_function("p => document.getElementById('lb-private-content').innerText.includes(p)", arg=phrase)
    def board_says(phrase):
        ep.wait_for_function("p => (document.getElementById('lb-board-note') || {innerText: ''}).innerText.includes(p)", arg=phrase)
    api["runs"] = "no_board"
    sign_in_as_participant()
    n_me = len(captured["me"])
    ep.goto(LB)
    board_says("No results have been published yet.")
    ep.wait_for_timeout(300)
    check(ep.locator("#lb-public .leaderboard, #lb-public a").count() == 0 and ep.is_hidden("#lb-weeks")
          and ep.inner_text("#lb-private-content") == "" and len(captured["me"]) == n_me,
          "API 503 no_board: 'No results have been published yet.' and nothing else (no /me request)")
    api["runs"] = "refused"
    n = captured["runs"]
    ep.goto(LB)
    board_says("Loading the leaderboard…")
    board_says("Couldn't load the leaderboard (the results server may be waking up) — try again in a minute.")
    check(captured["runs"] - n == 2 and ep.locator("#lb-board-note a").inner_text() == "try again" and ep.inner_text("#lb-private-content") == "",
          "API refused: 'Loading the leaderboard…', one retry, then the failure copy with its link; the private view waits")
    api["runs"] = "ok"
    ep.click("#lb-board-note a")
    ep.wait_for_selector(f"{ROW} .lb-expand")
    check(ep.inner_text("#lb-week") == "Week 2" and ep.locator("#lb-public .leaderboard tbody tr").count() >= 17,
          "failure copy: 'try again' loads the board, and the private view decorates it")
    api["board"] = "refused"
    ep.click("#lb-earlier")
    board_says("Couldn't load the leaderboard")
    check(ep.is_enabled("#lb-later") and ep.is_disabled("#lb-earlier") and ep.inner_text("#lb-private-content") == "",
          "a week that fails to load: the failure copy, the picker still usable")
    api["board"] = "ok"
    ep.click("#lb-later")
    ep.wait_for_selector(f"{ROW} .lb-expand")
    check(ep.inner_text("#lb-week") == "Week 2" and ep.locator(f"{ROW} td.lb-rank").inner_text() == "04", "…and → brings back the week that had loaded")
    api["me"] = "401"
    ep.goto(LB)
    ep.wait_for_selector("#hf-login-error:not([hidden])")
    check(ep.inner_text("#hf-login-error") == "Your sign-in expired — sign in again." and ep.is_visible("#hf-login")
          and local(ep, "sc:hf-session") is None and captured["me"][-1] == "Bearer hf_oauth_mock_token"
          and ep.locator("#lb-public .leaderboard tbody tr").count() >= 17,
          "API 401: the session is dropped; the sign-in row shows the expiry message; the board stays")
    api["me"] = "404"
    sign_in_as_participant()
    ep.goto(LB)
    content_says("No results for your organizations in Week 2.")
    check(ep.locator(".lb-expand, .lb-detail-standalone, #lb-private-content a").count() == 0, "API 404: 'No results for your organizations in Week 2.'")
    for answer in ("archive_unavailable", "refused"):
        api["me"] = answer
        n = len(captured["me"])
        ep.goto(LB)
        content_says("Loading your results…")
        content_says("Couldn't load your results (the results server may be waking up) — try again in a minute.")
        check(len(captured["me"]) - n == 2, f"API {answer}: 'Loading your results…', one retry, then the failure copy")
    api["me"] = "participant"
    ep.click("#lb-private-content a")
    ep.wait_for_selector(f"{ROW} .lb-expand")
    check(ep.inner_text("#lb-private-content") == "", "failure copy: 'try again' loads the results")
    api["markup"] = True
    ep.goto(LB)
    ep.wait_for_selector(f"{ROW} .lb-expand")
    ep.locator(ROW).click()
    dm = ep.locator("#lb-detail-example-team")
    check(ep.locator("main b, main img").count() == 0 and ["card", "<b>bold</b> card"] in dm.locator(".lb-line").evaluate_all(LINES)
          and dm.locator(".lb-card").inner_text().startswith("<b>bold</b> card")
          and ep.locator("#lb-public tbody tr").first.locator(".lb-team").inner_text() == "<b>bold</b> team",
          "API strings are text, never markup (a record line, the method card, a team's name on the board)")
    api["markup"] = False
    api["me"] = "organizer"

    # the pending week from the fake API: /me?run=week_03 is asked, /board/week_03 never; an index without pending has no Week 3
    api["me"] = "participant"
    ep.goto(LB)
    ep.wait_for_selector(f"{ROW} .lb-expand")
    n_boards = len(captured["boards"])
    ep.click("#lb-later")
    ep.wait_for_selector(f"{ROW}.lb-expandable .lb-expand")
    check(ep.inner_text("#lb-week") == "Week 3" and captured["me_runs"][-1] == "week_03" and len(captured["boards"]) == n_boards
          and ep.locator("#lb-public .leaderboard > table > tbody > tr:not(.lb-detail)").count() == 1,
          "API: the pending week asks /me?run=week_03 and never /board/week_03")
    api["pending"] = "unpulled"
    n_me = len(captured["me"])
    ep.goto(LB)
    ep.wait_for_selector(f"{ROW} .lb-expand")
    ep.click("#lb-later")
    ep.wait_for_function("document.getElementById('lb-week').textContent === 'Week 3' && document.querySelector('#lb-public tbody tr td.lb-team')")
    check(ep.locator("#lb-public tbody tr").count() == 1 and ep.locator("#lb-public tbody tr .lb-spin").count() == 1
          and ep.locator(".lb-expand, tr.lb-hidden").count() == 0 and len(captured["me"]) - n_me == 1 and captured["me_runs"][-1] == "week_02",
          "API: before the pull, the signed-in team's row with the spinner, and no /me?run=week_03 request")
    api["pending"] = None
    ep.goto(LB)
    ep.wait_for_selector(f"{ROW} .lb-expand")
    check(ep.is_disabled("#lb-later") and ep.inner_text("#lb-week") == "Week 2" and "Week 3" not in ep.inner_text("main"),
          "API: without a pending run in the index, → is disabled on the latest week and there is no Week 3")
    api["pending"] = "pulled"
    api["me"] = "organizer"

    # ---- 16. the fixtures are public: only the schema's keys, no dim ids, well-formed records and hashes
    SCHEMA_KEYS = {
        "role", "run", "teams", "missing", "board", "pull", "progress", "failures",   # the API's two envelopes
        "runs", "latest", "rows", "kind", "org_hash",                                 # the index and a board
        "orgs", "org", "status", "warnings",                                         # pull manifest, internal board
        "schema", "team", "entry", "history",
        "name", "label", "layer", "date", "deadline", "pull_finished", "n_ranked", "n_baselines", "models",
        "commit", "commit_time", "pulled_at", "repo_private", "evaluator_role", "files", "path", "bytes",
        "card", "version", "summary", "intake", "ok", "errors", "track", "track_source", "needs_review",
        "reviewed", "engines", "record", "method_card", "file", "text", "truncated",
        "pending", "pulled", "n_pulled", "intake_done", "phase", "evaluation",       # the week being evaluated
        "rank", "S", "ci", "delta", "r_side", "r_guard", "backend", "declines", "arm", "reference", "flag",
        "judge", "failed", "refused", "flags", "unscored", "reason", "families", "g", "side_effects", "guards",
        "delta_comparable", "S_comparable", "in_delta", "running"}
    MAPS = {   # maps whose keys are data: what they may be
        "families": {"instructed_deception", "incentives_and_sandbagging", "user_pressure", "fabrication", "owning_up", "harm_denial"},
        "side_effects": {"knowledge", "reasoning", "problem_solving", "instruction_following"},
        "guards": {"helpfulness", "pushback_and_feedback", "refusals", "over_conservativeness", "confidentiality_and_persona"},
    }
    CODES = {"flags": {"truncation", "gpu_mismatch", "no_dim_scored"},
             "reason": {"build_failed", "timeout", "suite_failed", "reference_pending", "not_run"},
             "backend": {"vllm", "huggingface"}, "kind": {"submission", "baseline"},
             "status": {"pulled", "missing", "oversize", "failed"},
             "phase": {"upcoming", "pulled", "checked", "evaluating", "finishing"}}
    RECORD_KEYS = {"repo", "commit", "pulled", "status", "files", "card", "warning", "intake", ""}
    problems = []
    pending_file = False
    def walk(node, key, models, where):
        if key == "record":
            if not (isinstance(node, list) and all(isinstance(p, list) and len(p) == 2 and all(isinstance(x, str) for x in p) for p in node)):
                problems.append(f"{where}: not a list of [key, text] pairs")
            else:
                for i, (k, _) in enumerate(node):
                    if k not in RECORD_KEYS:
                        problems.append(f"{where}[{i}]: {k!r} is not a record key")
            return
        if key == "org_hash" and node is not None and not re.fullmatch(r"[0-9a-f]{12}", str(node)):
            problems.append(f"{where}: {node!r} is not 12 lowercase hex characters")
        if key == "deadline" and node is not None:
            problems.append(f"{where}: a deadline ({node!r}); the pull has none")
        if isinstance(node, list):   # a list's objects are records; its strings may be codes (flags)
            for i, item in enumerate(node):
                walk(item, None if isinstance(item, (dict, list)) else key, models, f"{where}[{i}]")
            return
        if key in CODES and node is not None and node not in CODES[key]:
            problems.append(f"{where}: {node!r} is not a {key} code")
        if not isinstance(node, dict):
            return
        if key in ("models", "engines", "teams", "evaluation") or key in MAPS:   # (a participant's teams is a list, not a map)
            allowed = models if key in ("models", "engines", "evaluation") else MAPS.get(key)
            for k, v in node.items():
                if allowed is not None and k not in allowed:
                    problems.append(f"{where}: {k!r} is not one of the {key} the schema allows")
                if key == "teams" and (not isinstance(v, dict) or v.get("org") != k):
                    problems.append(f"{where}.{k}: the key is not the team file's org")
                if key == "engines" and v not in CODES["backend"]:
                    problems.append(f"{where}.{k}: {v!r} is not an engine")
                if key == "evaluation" and v not in {"not_started", "in_progress", "completed", "error"}:
                    problems.append(f"{where}.{k}: {v!r} is not an evaluation status")
                walk(v, None, models, f"{where}.{k}")
            return
        if key == "entry":
            if "late" in node or not isinstance(node.get("record"), list):
                problems.append(f"{where}: an entry has no 'late' and always a record")
        if key is None and "schema" in node and "entry" in node and not pending_file and node["schema"] not in (2, 3, 4):
            problems.append(f"{where}: a team file of schema {node['schema']!r}")
        if key is None and "evaluation" in node and "board" in node:
            problems.append(f"{where}: a pending file with a board")
        for k, v in node.items():
            if k not in SCHEMA_KEYS:
                problems.append(f"{where}.{k}: not a key of the schema")
            walk(v, k, models, f"{where}.{k}")
    def model_lists(node, out):   # every run block's models, so the per-model maps can be checked against them
        if isinstance(node, dict):
            if isinstance(node.get("models"), list):
                out.update(node["models"])
            for v in node.values():
                model_lists(v, out)
        elif isinstance(node, list):
            for v in node:
                model_lists(v, out)
        return out
    fixtures = sorted(f for f in os.listdir(MOCK) if f.endswith(".json"))
    for name in fixtures:
        with open(os.path.join(MOCK, name), encoding="utf-8") as f:
            raw = f.read()
        for bad in ("dims", "direction", "instructed_lie", "concealment", "implicit_incentive", "false_premise", '"late"', "harm_motivated_denial"):
            if bad in raw:
                problems.append(f"{name}: contains {bad!r}")
        data = json.loads(raw)
        pending_file = data.get("pending") is True   # a pending week's files carry schema 1 (a team file's entry, no board)
        walk(data, None, model_lists(data, set()) or None, name)
    check(fixtures == ["board.week_01.json", "board.week_02.json", "organizer.json", "organizer.week_03.json", "participant-noentry.json",
                       "participant-noentry.week_03.json", "participant-unscored.json", "participant-unscored.week_03.json",
                       "participant.json", "participant.week_01.json",
                       "participant.week_03.json", "runs.json"] and not problems,
          f"fixtures: {len(fixtures)} files, every key in the schema's list, records and hashes well formed, no dim ids ({problems})")

    # ---- 17. phone width: the open drawer doesn't widen the page; the breakdown stacks; the block fits
    ph = tall.new_page()
    private_view(ph, "participant", wait=f"{ROW} .lb-expand", width=390)
    page_width = ph.evaluate("document.documentElement.scrollWidth")
    ph.locator(ROW).click()
    pgroups = ph.locator("#lb-detail-example-team .lb-group")
    lefts = [pgroups.nth(i).bounding_box()["x"] for i in range(pgroups.count())]
    check(ph.evaluate("document.documentElement.scrollWidth") <= page_width and ph.locator("#lb-detail-example-team").is_visible(),
          f"phone: opening the drawer doesn't widen the page ({page_width}px, as wide as the board already is)")
    check(len(lefts) == 3 and max(lefts) - min(lefts) < 1 and pgroups.nth(1).bounding_box()["y"] > pgroups.nth(0).bounding_box()["y"],
          f"phone: the breakdown's groups stack into one column ({lefts})")
    shot(ph, "04-phone-drawer", top="main", bottom="#lb-public", pad=10)
    ph2 = std.new_page()
    private_view(ph2, "participant-noentry", wait=".lb-detail-standalone", width=390)
    bb = ph2.locator(".lb-detail-standalone").bounding_box()
    check(bb["x"] >= 0 and bb["x"] + bb["width"] <= 390, "phone: the block under the table fits the screen")
    for c in (tall, std, oc, ec):
        c.close()

    # ---- 18. shipped dark: CONFIG.enabled=false hides the competition page's button unless ?preview or ?mock
    dark = new_context(enabled=False)
    pg = dark.new_page()
    pg.goto(BASE)
    pg.wait_for_load_state("networkidle")
    check(not pg.is_visible("#lb-private"), "dark: button hidden when enabled=false")
    pg.goto(BASE + "?preview")
    pg.wait_for_selector("#lb-private:not([hidden])")
    check(pg.is_visible("#hf-open"), "dark: ?preview shows the button")
    pg.goto(BASE)
    pg.wait_for_selector("#lb-private:not([hidden])")
    check(pg.is_visible("#hf-open"), "dark: preview flag sticks (localStorage)")
    dark.close()
    dark = new_context(enabled=False)
    pg = dark.new_page()
    pg.goto(f"{BASE}?mock=participant")
    pg.wait_for_selector("#lb-private:not([hidden])")
    check(pg.inner_text("#hf-open") == "Open private results", "dark: ?mock on localhost shows the button without ?preview")
    pg.goto(f"{LB}?mock=organizer")
    pg.wait_for_selector("#lb-who:not([hidden])")
    check("organizer" in pg.inner_text("#lb-who"), "dark: the pop-up page itself still works (nothing links to it yet)")
    dark.close()

    # ---- 19. the model-organisms API panel (organisms-api.js): collapsed under the who line; opened, it asks the
    # organisms gateway for /api/me with the session's bearer token and shows the key (masked, Show reveals it), the
    # meters, the 14-day bars and the recent requests; Rotate posts /api/me/key; the errors have their messages; it goes
    # with the session. In mock mode it reads the fixture and never asks the gateway.
    oc = new_context()
    pg = oc.new_page()
    pg.goto(f"{LB}?mock=participant")
    pg.wait_for_selector("#lb-api-panel")
    check(not pg.locator("#lb-api-panel").evaluate("e => e.open"), "organisms: the panel starts collapsed")
    pg.click("#lb-api-panel > summary")
    pg.wait_for_selector(".lb-api-key")
    check(pg.inner_text(".lb-api-key") == "org-mock…stuv", "organisms (mock): the fixture key, masked")
    pg.click(".lb-api-keyrow .link-btn:has-text('Show')")
    check(pg.inner_text(".lb-api-key").startswith("org-mockKEY0123456789"), "organisms (mock): Show reveals it")
    check(pg.locator(".lb-api-meter").count() == 2 and pg.locator(".lb-api-hist-bar").count() == 14,
          "organisms (mock): two meters and fourteen bars")
    pg.click(".lb-api-recent > summary")
    check(pg.locator(".lb-api-recent tbody tr").count() == 9, "organisms (mock): the recent requests")
    check(not organisms["me"], "organisms (mock): the gateway was not asked")
    shot(pg, "19-organisms-mock", "#lb-api", "#lb-api")
    pg.click("#hf-logout")
    pg.wait_for_selector("#hf-login")
    check(pg.locator("#lb-api-panel").count() == 0, "organisms: the panel goes with the session")
    oc.close()
    # signed in for real (the fake endpoints): the gateway is asked with the token, Rotate posts, errors have copy
    oc = new_context()
    pg = oc.new_page()
    pg.goto(f"{LB}?mock=off")
    pg.wait_for_selector("#hf-login")
    pg.evaluate("localStorage.setItem('sc:api-open', '1')")
    pg.click("#hf-login")
    pg.wait_for_selector(".lb-api-key", timeout=15000)
    check(len(organisms["me"]) == 1 and organisms["me"][0] == "Bearer hf_oauth_mock_token",
          "organisms: /api/me asked once, with the session's bearer token")
    check(pg.inner_text(".lb-api-key") == "org-mock…stuv", "organisms: the key from the gateway, masked")
    pg.once("dialog", lambda d: d.accept())
    pg.click(".lb-api-rotate")
    pg.wait_for_function("document.querySelector('.lb-api-key') && document.querySelector('.lb-api-key').textContent === 'org-rota…qrst'")
    check(organisms["rotate"] == 1, "organisms: Rotate posts /api/me/key (after confirming) and shows the new key")
    for answer, text in (("401", "no longer accepted"), ("403", "not enabled"), ("refused", "didn't answer")):
        organisms["answer"] = answer
        pg.evaluate("SCOrganismsApi.refresh()")
        pg.wait_for_function(f"document.querySelector('.lb-api-body').textContent.includes({json.dumps(text)})", timeout=15000)
        check(True, f"organisms: {answer} shows its message")
    organisms["answer"] = None
    oc.close()
    check(not captured.get("organisms"), f"the real organisms gateway was never called ({captured.get('organisms')})")

    check(not captured["space"], f"the real results server was never called ({captured['space']})")
    check(not captured["page"], f"the pop-up never asked for the competition page ({captured['page']})")
    # the 400 from step 6; the 401, 404, 503s and refused connections of step 15; and mock mode's 404 for a week without a
    # fixture, are deliberate
    noise = [e for e in console_errors if "mailerlite" not in e.lower() and "net::ERR_FAILED" not in e and "fonts" not in e.lower()
             and "400" not in e and "status of 401" not in e and "status of 403" not in e and "status of 404" not in e and "status of 503" not in e
             and "ERR_CONNECTION_REFUSED" not in e]
    check(not noise, f"no unexpected console errors: {noise}")
    browser.close()

print()
print("FAILURES:", failures if failures else "none")
sys.exit(1 if failures else 0)
