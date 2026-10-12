"""Headless checks of "Sign in with Hugging Face" against the local preview: the competition page's button, and
the leaderboard pop-up (competition/leaderboard/) where sign-in and the private view live.

    scripts/preview.sh                      # in one terminal
    python3 scripts/check-login.py          # in another (needs: pip install playwright && playwright install chromium)

Huggingface.co is never contacted: the authorize, token and userinfo endpoints are mocked (the authorize stub sends
Cross-Origin-Opener-Policy: same-origin like the real page, then approves or denies by redirecting back), and
hf-login.js is served with a test client id and CONFIG.enabled forced on (step 18 forces it off), whatever the
committed values. Nor is the results API (a Hugging Face Space): hf-login.js is served with CONFIG.api pointing at a
fake origin whose /me answers from the fixtures in competition/leaderboard/mock/ (or with an error), and any request
to *.hf.space is refused and fails the check. Screenshots land in tmp/shots/. Exit status 1 on any failed check.
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
    captured = {"authorize": [], "token": [], "userinfo_headers": None, "me": [], "healthz": 0, "space": []}
    hf = {"authorize": "approve", "token": "ok"}   # how the mocked huggingface.co answers
    api = {"me": "organizer"}   # how the fake results API answers /me: a fixture's name, or an error (see api_endpoint)

    def watch(pg):
        pg.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: console_errors.append(str(e)))

    # Serve hf-login.js with a test client id and CONFIG.enabled set as asked, so the real flow can be exercised
    # however the committed file ships (it ships dark: enabled false).
    def serve_js(enabled):
        def handler(route, request):
            resp = route.fetch()
            body = re.sub(r"clientId: '[^']*'", f"clientId: '{CLIENT_ID}'", resp.text(), count=1)
            body = re.sub(r"enabled: (true|false),", f"enabled: {'true' if enabled else 'false'},", body, count=1)
            body, n = re.subn(r"api: (null|'[^']*')", f"api: '{API}'", body, count=1)
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

    # The fake results API: /healthz answers like the real one; /me serves a fixture from disk, or an error.
    def api_endpoint(route, request):
        path = urlparse(request.url).path
        cors = {"Access-Control-Allow-Origin": "*"}
        if path == "/healthz":
            captured["healthz"] += 1
            route.fulfill(status=200, headers=cors, content_type="application/json",
                          body=json.dumps({"run": "week_02", "date": "2026-10-09"}))
            return
        if path != "/me":
            route.fulfill(status=404, headers=cors, content_type="application/json", body='{"error": "not_found"}')
            return
        if request.method == "OPTIONS":   # a CORS preflight, if it reaches the route at all
            route.fulfill(status=204, headers={**cors, "Access-Control-Allow-Headers": "Authorization"})
            return
        captured["me"].append(request.headers.get("authorization"))
        answer = api["me"]
        if answer == "refused":
            route.abort("connectionrefused")
        elif answer == "401":
            route.fulfill(status=401, headers=cors, content_type="application/json", body='{"error": "invalid_token"}')
        elif answer in ("no_board", "archive_unavailable"):
            route.fulfill(status=503, headers=cors, content_type="application/json", body=json.dumps({"error": answer}))
        else:   # a fixture; "<name>+markup" puts markup into its participant-authored strings
            with open(os.path.join(MOCK, answer.split("+")[0] + ".json"), encoding="utf-8") as f:
                body = json.load(f)
            if answer.endswith("+markup"):
                entry = body["teams"][0]["entry"]
                entry["label"] = "<b>bold</b> label"
                entry["intake"]["warnings"] = ["<img src=x onerror=alert(1)> warning"]
            route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(body))

    def refuse_space(route, request):
        captured["space"].append(request.url)
        route.abort()

    def new_context(enabled=True, avail_height=1600, board=None, retry_ms=None, star_seen=False):
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
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
        ctx.route("**/competition/hf-login.js*", serve_js(enabled))
        ctx.route("https://huggingface.co/oauth/authorize*", authorize)
        ctx.route("https://huggingface.co/oauth/token", token_endpoint)
        ctx.route("https://huggingface.co/oauth/userinfo", userinfo_endpoint)
        ctx.route(API + "/**", api_endpoint)
        ctx.route(re.compile(r"^https?://[^/]*\.hf\.space(/|$)"), refuse_space)
        if board:   # the pop-up's copy of the competition page (its fetch('../'))
            ctx.route(BASE, board)
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
    win.wait_for_selector("#lb-caption.lb-caption")   # the private view is done (it refits the window after this)
    check(captured["me"] and captured["me"][-1] == "Bearer hf_oauth_mock_token",
          "results API: /me asked with the session's bearer token (the fake Space, never the real one)")
    check(captured["healthz"] >= 1, "results API: woken with /healthz on the way to huggingface.co")
    check("Organizer view · week_02" in win.inner_text("#lb-private-content .lb-status"),
          "pop-up: organizer view rendered from the results API")
    sess = local(win, "sc:hf-session")
    check(sess["user"]["username"] == "steerability-challenge-evaluator" and sess["accessToken"] == "hf_oauth_mock_token",
          "pop-up: session stored (localStorage)")
    check(abs(sess["expiresAt"] - (win.evaluate("Date.now()") + 28800 * 1000)) < 60_000, "pop-up: expiresAt from expires_in")
    win.wait_for_selector("#lb-public .leaderboard tbody tr")
    n_page = page.locator(".leaderboard tbody tr").count()
    n_win = win.locator("#lb-public .leaderboard > table > tbody > tr:not(.lb-detail)").count()
    check(n_page > 0 and n_win == n_page, f"pop-up: public table copied from the competition page ({n_win} of {n_page} rows)")
    check(win.locator("#lb-public .lb-baseline").count() == page.locator(".lb-baseline").count() > 0
          and win.locator("#lb-public .lb-baseline td").first.evaluate("e => getComputedStyle(e).backgroundColor") != "rgba(0, 0, 0, 0)",
          "pop-up: baseline rows keep their shading (style now in styles.css)")
    # the pop-up's layout: no visible title, who line across the top with Sign out at its right end, no accent
    # square on "Public leaderboard", table as wide as the window, and the window sized to fit it all
    check("visually-hidden" in win.locator("h1").get_attribute("class") and win.locator("#lb-who").bounding_box()["y"] < 30,
          "pop-up layout: no visible title; the who line is at the top")
    wl, so = win.locator("#lb-who").bounding_box(), win.locator(".lb-signout").bounding_box()
    signed = win.locator("#lb-who > span").first.bounding_box()
    check(abs(signed["x"] - wl["x"]) < 40 and abs((so["x"] + so["width"]) - (wl["x"] + wl["width"])) < 1
          and abs(so["y"] - signed["y"]) < 10 and "·" not in who,
          "pop-up layout: 'Signed in as …' at the left, 'Sign out' at the right end of the same line")
    check(win.locator("#public").evaluate("e => getComputedStyle(e, '::before').content") == "none",
          "pop-up layout: no accent square before 'Public leaderboard'")
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
    win.wait_for_selector("#lb-caption.lb-caption")
    check(win.locator(".lb-detail-standalone").count() == 3, "organizer: the fixture's pulled teams (none in the real table) as blocks")
    win.click("#hf-logout")
    win.wait_for_selector("#hf-login:visible")
    check(local(win, "sc:hf-session") is None, "sign out: session removed")
    check(win.locator(".lb-detail, .lb-detail-standalone, .lb-expand").count() == 0
          and win.inner_text("#lb-caption") == "Scores are for the previous intake.",
          "sign out: the private view's blocks are gone and the caption is back")
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

    # ---- the private view (steps 12-17): pages the pop-up's copy of the competition page can be swapped for
    EXAMPLE_HASH = org_hash("example-team")
    HEAD = "".join(f'<th class="{c}" scope="col">{h}</th>' for c, h in [
        ("lb-rank", "Rank"), ("lb-team", "Team"), ("lb-score", "Overall score"), ("lb-score", "delta"),
        ("lb-score", "r_side"), ("lb-score", "r_guard")])

    def board_row(rank, team, org=None, baseline=False, scores=("+0.438", "+0.563", "0.020", "0.022")):
        attrs = (' class="lb-baseline"' if baseline else "") + (f' data-org="{org_hash(org)}"' if org else "")
        return (f'<tr{attrs}><td class="lb-rank">{rank}</td><td class="lb-team">{team}</td>'
                + "".join(f'<td class="lb-score">{s}</td>' for s in scores) + "</tr>")

    def with_example_row(route, request):
        """The competition page with one extra row, the fixture team's (the real table has no such team)."""
        resp = route.fetch()
        route.fulfill(response=resp, body=resp.text().replace("</tbody>", board_row("04", "Example Team", "example-team") + "</tbody>", 1))

    def fixture_board(route, request):
        """A competition page whose table has the organizer fixture's two ranked teams and a baseline."""
        rows = (board_row("04", "Example Team", "example-team")
                + board_row("&ndash;", "example-baseline", baseline=True, scores=("+0.201", "+0.301", "0.012", "0.040"))
                + board_row("09", "Second Example", "second-example", scores=("+0.177", "+0.293", "0.020", "0.022")))
        route.fulfill(status=200, content_type="text/html", body='<!doctype html><title>board stub</title><div class="leaderboard">'
                      f"<table><thead><tr>{HEAD}</tr></thead><tbody>{rows}</tbody></table></div>")

    def private_view(pg, kind, width=1040):
        pg.set_viewport_size({"width": width, "height": 860 if width > 600 else 844})
        pg.goto(f"{LB}?mock={kind}")
        pg.wait_for_selector("#lb-caption.lb-caption")   # set right before the view decorates the table and refits

    # ---- 12. participant, in their own row (the injected one); a tall screen, so the window can grow when it opens
    tall = new_context(avail_height=4000, board=with_example_row, star_seen=True)
    pv = tall.new_page()
    private_view(pv, "participant")
    line = pv.inner_text("#lb-private-content .lb-entry")
    check(line.startswith("Your entry in this board: “CAA-honesty v3” · commit a1b2c3d (Oct 4, 10:12 UTC) · pulled Oct 6, 12:03 UTC, on time")
          and "intake passed · white-box" in line, f"participant: the 'your entry' line ({line!r})")
    ex = pv.locator(f'#lb-public tr[data-org="{EXAMPLE_HASH}"] .lb-expand')
    check(ex.count() == 1 and ex.inner_text() == "Example Team" and ex.get_attribute("aria-expanded") == "false"
          and ex.get_attribute("aria-controls") == "lb-detail-example-team",
          "participant: the name in their row (data-org = hash of the handle) is the expand button")
    check(pv.locator(".lb-expand").count() == 1 and pv.locator(".lb-detail-standalone").count() == 0,
          "participant: no other row gets a button, and no block under the table")
    detail = pv.locator("#lb-detail-example-team")
    check(detail.evaluate("e => e.tagName === 'TR' && e.hidden && e.previousElementSibling.getAttribute('data-org')") == EXAMPLE_HASH
          and detail.evaluate("e => e.cells.length === 1 && e.cells[0].colSpan") == 6,
          "participant: a hidden detail row, one cell across, right under it")
    pv.wait_for_function("window.__resizes.length > 0")
    before = pv.evaluate("window.__resizes[window.__resizes.length - 1]")
    ex.click()
    check(detail.is_visible() and ex.get_attribute("aria-expanded") == "true", "participant: clicking the name opens the detail")
    text = detail.inner_text()
    check(detail.locator(".lb-grid tbody tr:not(.lb-overall)").count() == 3, "detail: three model rows")
    check("[+0.44, +0.58]" in text and "14% (6%)" in text and "Truncation above the reference" in text and "rank 4 of 14" in text,
          "detail: per-model numbers, decline shares, the truncation flag, the overall rank")
    check(bool(re.search(r"Instructed deception\s+\+0\.70\s+instructed_lie ▲▲▲", text)) and "concealment ▲●▲" in text
          and "false_premise ●●●" in text, "detail: family rows with a direction per model (an all-flat family too)")
    check("Knowledge 0.01 · Reasoning 0.04" in text and "Helpfulness & compliance 0.00 · Refusal behaviour 0.05" in text,
          "detail: side-effect and guard rows")
    check("week_01 +0.31 (#6) [delta not comparable, S not comparable] → week_02 +0.44 (#4)" in text, "detail: history line")
    check("passed with 1 warning" in text and "frozen with toolkit 0.5.4; the evaluation runs 0.5.5" in text
          and "track white-box (detected)" in text and "method_card.md 3 KB" in text,
          "detail: intake verdict and warning, track and engines, files")
    caption = pv.inner_text("#lb-caption")
    check(caption.startswith("Board: intake of Oct 5, 2026 AoE (week_02) · rendered Oct 9 · 14 submissions ranked, 3 baselines")
          and "The final evaluation overrides these scores." in caption, f"caption: the run, its intake and render date ({caption!r})")
    pv.wait_for_function("b => window.__resizes[window.__resizes.length - 1] !== b", arg=before)
    after = pv.evaluate("window.__resizes[window.__resizes.length - 1]")
    check(after > before, f"participant: the window grew with the detail ({before}px -> {after}px)")
    ex.click()
    check(detail.is_hidden() and ex.get_attribute("aria-expanded") == "false", "participant: clicking again closes it")
    ex.focus()
    pv.keyboard.press("Enter")
    check(detail.is_visible() and ex.get_attribute("aria-expanded") == "true", "participant: the button works from the keyboard")

    # ---- 13. no row for the team (the real table): the detail as a block under it; the unscored, late, no-entry states
    std = new_context(star_seen=True)
    sp = std.new_page()
    private_view(sp, "participant")
    block = sp.locator(".lb-detail-standalone")
    check(block.count() == 1 and block.get_attribute("id") == "lb-detail-example-team" and block.is_visible()
          and block.evaluate("e => e.previousElementSibling.id === 'lb-public' && e.nextElementSibling.id === 'lb-caption'")
          and sp.locator(".lb-expand").count() == 0, "no row: the detail is a block between the table and the caption, no button")
    check(block.locator(".lb-grid tbody tr:not(.lb-overall)").count() == 3 and "Example Team" in block.inner_text(),
          "no row: the block has the same detail, under the team's name")
    private_view(sp, "participant-unscored")
    line = sp.inner_text("#lb-private-content .lb-entry")
    check(line.endswith(" · scored on 2 of 3 models"), f"unscored: the entry line says 'scored on 2 of 3 models' ({line!r})")
    cells = sp.locator(".lb-detail-standalone .lb-grid tbody tr", has_text="granite-4.2-30b").locator("td").all_inner_texts()
    check(cells[1:6] == ["—"] * 5 and cells[-1] == "A request exceeded the run's time limit", f"unscored: the model's row is — and the reason ({cells})")
    overall = sp.locator(".lb-detail-standalone .lb-overall td").all_inner_texts()
    check(overall[1:4] == ["—", "—", "rank —"], f"unscored: overall S and rank are — ({overall})")
    text = sp.inner_text(".lb-detail-standalone")
    check(bool(re.search(r"User pressure & sycophancy\s+—\s+false_premise ●●", text)) and "per model: gemma-4-31B-it · Qwen3.8-27B" in text,
          "unscored: a family with g null shows —, and only the scored models get directions")
    for kind, expect in [
            ("participant-late", "Not evaluated this intake: your latest commit (Oct 6, 13:02 UTC) was after the deadline (Oct 6, 12:00 UTC). "
                                 "Late commits are not pulled; the next intake takes the repository as it is then."),
            ("participant-noentry", "No entry for example-team in this board. The next intake is on the competition page's countdown.")]:
        private_view(sp, kind)
        content = sp.inner_text("#lb-private-content")
        check(expect in content and sp.locator(".lb-expand, .lb-detail, .lb-detail-standalone").count() == 0,
              f"{kind}: the right copy, no button and no block")
    private_view(sp, "participant-late")
    warns = sp.locator("#lb-private-content .lb-warn").all_inner_texts()
    check(warns == ["Your submission repository is public — make it private.",
                    "The evaluator's role in your organization is write; set it to Read."]
          and sp.locator(".lb-entry-block > :first-child").get_attribute("class") == "lb-warn"
          and sp.locator(".lb-warn").first.evaluate("e => getComputedStyle(e).color") == "rgb(179, 38, 30)",
          f"late: the red warnings come first ({warns})")
    check("week_01 +0.31 (#6)" in sp.inner_text("#lb-private-content"), "late: the history is shown")

    # ---- 14. organizer: a button on every submission row that has a team file, the status block, the run status
    oc = new_context(board=fixture_board)
    op = oc.new_page()
    private_view(op, "organizer")
    rows = op.locator("#lb-public .leaderboard > table > tbody > tr:not(.lb-baseline):not(.lb-detail)")
    check(rows.count() == 2 and all(rows.nth(i).locator(".lb-expand").count() == 1 for i in range(rows.count()))
          and op.locator("#lb-public .lb-baseline .lb-expand").count() == 0,
          "organizer: every non-baseline row has a button, the baseline none")
    status = op.inner_text(".lb-status")
    check("Organizer view · week_02 · 3 of 4 organizations pulled" in status and "example-late: not pulled (late)" in status
          and "example-review: awaiting code review" in status and "example warning:" in status,
          "organizer: the status block lists the late org, the submission awaiting review, the board's warnings")
    check(op.locator(".lb-status details.lb-run-status > summary").inner_text() == "Run status"
          and op.locator(".lb-run-status pre").count() == 2, "organizer: progress and failures behind 'Run status'")
    op.locator(".lb-expand").nth(0).click()
    op.locator(".lb-expand").nth(1).click()
    check(op.locator("#lb-public tr.lb-detail:not([hidden])").count() == 2, "organizer: any number of rows open at once")
    second = op.inner_text("#lb-detail-second-example")
    check(bool(re.search(r"Incentives & sandbagging\s+—", second)) and not re.search("[▲●▼]", second)
          and "per model" not in second and "ibm-granite__granite-4.2-30b.spipe —" in second
          and op.locator("#lb-detail-second-example .lb-grid tbody tr").first.locator("td").nth(6).inner_text() == "—",
          "organizer: no directions in a run without them (dims {}), g null and null sizes and shares as —")
    check(op.locator("#lb-detail-example-review.lb-detail-standalone").count() == 1
          and "awaiting code review (custom controls)" in op.inner_text("#lb-detail-example-review")
          and op.locator("#lb-detail-example-late").count() == 0,
          "organizer: a pulled team with no row gets the block under the table; a team not pulled gets none")

    # ---- 15. results API errors, from the fake Space: 401 signs out, 503 no_board and archive_unavailable, a refused
    # connection (one retry, then the failure copy, whose "try again" works)
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
    api["me"] = "401"
    sign_in_as_participant()
    ep.goto(LB)
    ep.wait_for_selector("#hf-login-error:not([hidden])")
    check(ep.inner_text("#hf-login-error") == "Your sign-in expired — sign in again." and ep.is_visible("#hf-login")
          and local(ep, "sc:hf-session") is None and captured["me"][-1] == "Bearer hf_oauth_mock_token",
          "API 401: the session is dropped; the sign-in row shows the expiry message")
    api["me"] = "no_board"
    sign_in_as_participant()
    ep.goto(LB)
    content_says("No results have been published yet.")
    check(ep.locator("#lb-private-content a").count() == 0, "API 503 no_board: 'No results have been published yet.'")
    for answer in ("archive_unavailable", "refused"):
        api["me"] = answer
        n = len(captured["me"])
        ep.goto(LB)
        content_says("Loading your results…")
        content_says("Couldn't load your results (the results server may be waking up) — try again in a minute.")
        check(len(captured["me"]) - n == 2, f"API {answer}: 'Loading your results…', one retry, then the failure copy")
    api["me"] = "participant+markup"
    ep.click("#lb-private-content a")
    ep.wait_for_selector("#lb-caption.lb-caption")
    check("Your entry in this board" in ep.inner_text("#lb-private-content"), "failure copy: 'try again' loads the results")
    check("“<b>bold</b> label”" in ep.inner_text("#lb-private-content") and ep.locator("main b, main img").count() == 0
          and "<img src=x onerror=alert(1)> warning" in ep.inner_text(".lb-detail-standalone"),
          "API strings are text, never markup (a label and a warning with tags in them)")
    api["me"] = "organizer"

    # ---- 16. the fixtures are public: only the schema's keys, only the example's four dim ids
    SCHEMA_KEYS = {
        "role", "run", "teams", "missing", "board", "pull", "progress", "failures",   # the API's two envelopes
        "orgs", "org", "status", "warnings",                                         # pull manifest, internal board
        "schema", "team", "entry", "history",
        "name", "layer", "date", "deadline", "pull_finished", "n_ranked", "n_baselines", "models",
        "commit", "commit_time", "pulled_at", "late", "repo_private", "evaluator_role", "files", "path", "bytes",
        "card", "version", "summary", "label", "intake", "ok", "errors", "track", "track_source", "needs_review",
        "reviewed", "engines",
        "rank", "S", "ci", "delta", "r_side", "r_guard", "backend", "declines", "arm", "reference", "truncated", "flag",
        "judge", "failed", "refused", "flags", "unscored", "reason", "families", "g", "dims", "side_effects", "guards",
        "delta_comparable", "S_comparable"}
    MAPS = {   # maps whose keys are data: what they may be
        "families": {"instructed_deception", "incentives_and_sandbagging", "user_pressure", "fabrication", "owning_up",
                     "harm_motivated_denial"},
        "side_effects": {"knowledge", "reasoning", "problem_solving", "instruction_following"},
        "guards": {"helpfulness", "pushback_and_feedback", "refusals"},
        "dims": {"instructed_lie", "concealment", "implicit_incentive", "false_premise"},
    }
    CODES = {"flags": {"truncation", "gpu_mismatch", "no_dim_scored"},
             "reason": {"build_failed", "timeout", "suite_failed", "reference_pending", "not_run"},
             "backend": {"vllm", "huggingface"}}
    problems = []
    def walk(node, key, models, where):
        if isinstance(node, list):   # a list's objects are records; its strings may be codes (flags)
            for i, item in enumerate(node):
                walk(item, None if isinstance(item, (dict, list)) else key, models, f"{where}[{i}]")
            return
        if key in CODES and node is not None and node not in CODES[key]:
            problems.append(f"{where}: {node!r} is not a {key} code")
        if not isinstance(node, dict):
            return
        if key in ("models", "engines", "teams") or key in MAPS:   # (a participant's teams is a list, not a map)
            allowed = models if key in ("models", "engines") else MAPS.get(key)
            for k, v in node.items():
                if allowed is not None and k not in allowed:
                    problems.append(f"{where}: {k!r} is not one of the {key} the schema allows")
                if key == "teams" and (not isinstance(v, dict) or v.get("org") != k):
                    problems.append(f"{where}.{k}: the key is not the team file's org")
                if key == "engines" and v not in CODES["backend"]:
                    problems.append(f"{where}.{k}: {v!r} is not an engine")
                walk(v, None, models, f"{where}.{k}")
            return
        for k, v in node.items():
            if k not in SCHEMA_KEYS:
                problems.append(f"{where}.{k}: not a key of the schema")
            walk(v, k, models, f"{where}.{k}")
    fixtures = sorted(f for f in os.listdir(MOCK) if f.endswith(".json"))
    for name in fixtures:
        with open(os.path.join(MOCK, name), encoding="utf-8") as f:
            data = json.load(f)
        walk(data, None, set(data["run"]["models"]), name)
    check(fixtures == ["organizer.json", "participant-late.json", "participant-noentry.json", "participant-unscored.json",
                       "participant.json"] and not problems,
          f"fixtures: {len(fixtures)} files, every key in the schema's list, only the example's dim ids ({problems})")

    # ---- 17. phone width: the open detail doesn't widen the page; the per-model table scrolls inside its wrapper
    ph = tall.new_page()
    private_view(ph, "participant", width=390)
    page_width = ph.evaluate("document.documentElement.scrollWidth")
    ph.locator(".lb-expand").click()
    wrap = ph.locator("#lb-detail-example-team .lb-grid-wrap")
    check(ph.evaluate("document.documentElement.scrollWidth") <= page_width and wrap.is_visible(),
          f"phone: opening the detail doesn't widen the page ({page_width}px, as wide as the public table already is)")
    check(wrap.evaluate("e => e.scrollWidth > e.clientWidth + 1"), "phone: the per-model table scrolls inside its wrapper")
    ph2 = std.new_page()
    private_view(ph2, "participant", width=390)
    bb = ph2.locator(".lb-detail-standalone").bounding_box()
    check(bb["x"] >= 0 and bb["x"] + bb["width"] <= 390
          and ph2.locator(".lb-detail-standalone .lb-grid-wrap").evaluate("e => e.scrollWidth > e.clientWidth + 1"),
          "phone: the block under the table fits the screen; its per-model table scrolls inside it")
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

    check(not captured["space"], f"the real results server was never called ({captured['space']})")
    # the 400 from step 6, and the 401, 503s and refused connection of step 15, are deliberate
    noise = [e for e in console_errors if "mailerlite" not in e.lower() and "net::ERR_FAILED" not in e and "fonts" not in e.lower()
             and "400" not in e and "status of 401" not in e and "status of 503" not in e and "ERR_CONNECTION_REFUSED" not in e]
    check(not noise, f"no unexpected console errors: {noise}")
    browser.close()

print()
print("FAILURES:", failures if failures else "none")
sys.exit(1 if failures else 0)
