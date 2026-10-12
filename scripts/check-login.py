"""Headless checks of "Sign in with Hugging Face" against the local preview: the competition page's button, and
the leaderboard pop-up (competition/leaderboard/) where sign-in and the private view live.

    scripts/preview.sh                      # in one terminal
    python3 scripts/check-login.py          # in another (needs: pip install playwright && playwright install chromium)

Huggingface.co is never contacted: the authorize, token and userinfo endpoints are mocked (the authorize stub sends
Cross-Origin-Opener-Policy: same-origin like the real page, then approves or denies by redirecting back), and
hf-login.js is served with a test client id and CONFIG.enabled forced on (step 12 forces it off), whatever the
committed values. Screenshots land in tmp/shots/. Exit status 1 on any failed check.
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

def set_pending(page, state, age_ms=0):
    page.evaluate("([state, age]) => localStorage.setItem('sc:hf-pending', JSON.stringify("
                  "{state: state, verifier: 'v-' + state, redirectUri: 'x', createdAt: Date.now() - age}))", [state, age_ms])

with sync_playwright() as p:
    browser = p.chromium.launch()
    console_errors = []
    captured = {"authorize": [], "token": [], "userinfo_headers": None}
    hf = {"authorize": "approve", "token": "ok"}   # how the mocked huggingface.co answers

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
                {"sub": "o2", "name": "Saddle Point", "preferred_username": "saddle-point", "picture": "", "roleInOrg": "read"},
            ]}))

    def new_context(enabled=True):
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
        # A 1600px-tall screen, so the pop-up can fit the whole board (Playwright's screen emulation doesn't reach
        # pop-ups, where screen = the window); resizeTo/moveTo are recorded, since headless can't resize anyway.
        ctx.add_init_script("Object.defineProperty(screen, 'availHeight', { get: function () { return 1600; }, configurable: true });"
                            "Object.defineProperty(screen, 'availTop', { get: function () { return 0; }, configurable: true });"
                            "window.__resizes = []; window.resizeTo = function (w, h) { window.__resizes.push(h); };"
                            "window.moveTo = function () {};")
        ctx.on("page", watch)
        ctx.route("**/competition/hf-login.js*", serve_js(enabled))
        ctx.route("https://huggingface.co/oauth/authorize*", authorize)
        ctx.route("https://huggingface.co/oauth/token", token_endpoint)
        ctx.route("https://huggingface.co/oauth/userinfo", userinfo_endpoint)
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
    check("Organizer view" in win.inner_text("#lb-private-content"), "pop-up: organizer placeholder rendered")
    sess = local(win, "sc:hf-session")
    check(sess["user"]["username"] == "steerability-challenge-evaluator" and sess["accessToken"] == "hf_oauth_mock_token",
          "pop-up: session stored (localStorage)")
    check(abs(sess["expiresAt"] - (win.evaluate("Date.now()") + 28800 * 1000)) < 60_000, "pop-up: expiresAt from expires_in")
    win.wait_for_selector("#lb-public .leaderboard tbody tr")
    n_page, n_win = page.locator(".leaderboard tbody tr").count(), win.locator("#lb-public .leaderboard tbody tr").count()
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
    check(asked == need and need > win.evaluate("innerHeight"),
          f"pop-up: resizes itself to its content ({asked}px tall, was {win.evaluate('outerHeight')}px), so no scroll bar")
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
    win.click("#hf-logout")
    win.wait_for_selector("#hf-login:visible")
    check(local(win, "sc:hf-session") is None, "sign out: session removed")
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
    for kind, expect in [("participant", "team: saddle-point"), ("organizer", "organizer"), ("noteam", "not a member")]:
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

    # ---- 12. shipped dark: CONFIG.enabled=false hides the competition page's button unless ?preview or ?mock
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

    # the 400 from step 6 is deliberate
    noise = [e for e in console_errors if "mailerlite" not in e.lower() and "net::ERR_FAILED" not in e and "fonts" not in e.lower()
             and "400" not in e]
    check(not noise, f"no unexpected console errors: {noise}")
    browser.close()

print()
print("FAILURES:", failures if failures else "none")
sys.exit(1 if failures else 0)
