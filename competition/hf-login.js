/* ============================================================
   The Steerability Challenge — hf-login.js
   ------------------------------------------------------------
   "Sign in with Hugging Face" for the leaderboard's private view.

   Two pages load this script; data-mode on #lb-private says which:
     launcher  the competition page: one button under the public table
               that opens leaderboard/ in a pop-up window
     window    leaderboard/ (the pop-up): sign-in, the "who" line, and
               (for participants) an ask to star the toolkit repo; the
               board and the private view are leaderboard/private-view.js's

   OAuth 2.0 authorization-code flow with PKCE, run entirely in the
   browser: the Hugging Face app is a *public* client (no secret), so
   nothing here needs a server and the site stays a static GitHub Page.

   Flow (all inside the pop-up)
     1. login()           make a PKCE verifier + state, remember them, send
                          the window to huggingface.co (the launcher opens
                          the pop-up with ?signin, which starts this at once)
     2. handleRedirect()  back on leaderboard/ with ?code=&state=: exchange
                          the code for a token (POST /oauth/token), fetch
                          /oauth/userinfo, keep a small session, clean the URL
     3. renderWindow()    the "who" line (handle, tags, sign out) and the
                          private view (leaderboard/private-view.js, which
                          reads the results API at CONFIG.api and opens a
                          team's results in its row of the board; without
                          it, or without CONFIG.api, a placeholder)

   Storage
     The session and the pending verifier live in localStorage. huggingface.co
     sends Cross-Origin-Opener-Policy: same-origin, so a pop-up that has been
     there comes back with no window.opener: same-origin storage is the one
     channel left between the pop-up and the competition page, whose button
     follows along through the 'storage' event. A session ends when its token
     expires or on "Sign out". sc:mock marks mock mode (below).

   Identity
     - a person is identified by their Hugging Face *handle*
       (userinfo.preferred_username), never by display name
     - their team(s) are the organizations they belong to
       (userinfo.orgs[].preferred_username, scope read-memberships);
       each team submits through <org>/submission, which the evaluator
       account reads — so org membership is the registration
     - organizers are the evaluator account(s) in CONFIG.organizerUsers
       and anyone in the organizer organization CONFIG.organizerOrg

   Local development
     - ?mock=participant | organizer | noteam | none fakes a session
       (localhost only, on either page) and turns mock mode on
       (localStorage sc:mock), so the private view can be built without
       signing in each time: in mock mode the pop-up reads the fixtures
       in leaderboard/mock/ instead of the results API, whatever the
       session (so ?mock=none, a reload and sign-out stay offline), and
       every kind that starts with "participant" (participant-unscored,
       …) is the participant session with its own fixture; ?mock=off
       ends mock mode and the session
     - CONFIG.enabled is the kill switch. Set to false, it takes the
       competition page's button away again, from everyone but browsers
       that have previewed it: the URL had ?preview, or ?mock on
       localhost (either one sets localStorage sc:preview=1, so the button
       stays on there after that). That is also how to look at a deploy
       made dark. The pop-up page works regardless; nothing else links to
       it.
============================================================= */
(function () {
  'use strict';

  var CONFIG = {
    enabled: true,                 // the kill switch: false hides the button again, except in browsers that have visited with ?preview
    clientId: '959e50bd-c96f-4a34-8384-f69cd9ae779c',   // from https://huggingface.co/settings/applications
    hub: 'https://huggingface.co',
    api: 'https://steerability-challenge-evals-leaderboard-api.hf.space',   // the results API; null keeps the placeholders
    scopes: 'openid profile read-memberships',
    organizerUsers: ['steerability-challenge-evaluator'],
    organizerOrg: 'steerability-challenge-evals',
    windowUrl: 'leaderboard/',     // the pop-up, relative to the competition page
    windowName: 'sc-leaderboard',  // window.open reuses the pop-up while it is open
    windowSize: [1040, 860],       // pop-up width, height (px)
    returnHash: '#leaderboard',    // where the competition page lands after ?mock
    starSnoozeDays: 14,            // "Go away" on the star-the-repo ask hides it this long
    defaultTokenSeconds: 8 * 3600  // used only when the token reply has no expires_in
  };

  var SESSION_KEY = 'sc:hf-session';   // localStorage: the signed-in session, shared by both pages
  var PENDING_KEY = 'sc:hf-pending';   // localStorage: verifier + state while on huggingface.co
  var PREVIEW_KEY = 'sc:preview';      // localStorage: show the button even when CONFIG.enabled is false
  var MOCK_KEY = 'sc:mock';            // localStorage: '1' while the pop-up reads its fixtures instead of the results API
  var STAR_KEY = 'sc:star-ask';        // localStorage: 'visited', or when "Go away" was chosen (ms)
  var PENDING_MAX_AGE = 10 * 60 * 1000;   // a sign-in left unfinished for longer is ignored

  var root = document.getElementById('lb-private');
  if (!root) return;
  var mode = root.getAttribute('data-mode');   // 'launcher' or 'window'

  var els = {
    open:      document.getElementById('hf-open'),        // launcher: the button
    openNote:  document.getElementById('hf-open-note'),   // launcher: the soft phrase next to it
    signedOut: root.querySelector('[data-auth-state="signed-out"]'),   // window: sign-in row
    signedIn:  root.querySelector('[data-auth-state="signed-in"]'),    // window: who line + private view
    login:     document.getElementById('hf-login'),
    who:       document.getElementById('lb-who'),
    content:   document.getElementById('lb-private-content'),
    error:     document.getElementById('hf-login-error')
  };

  /* ---------- small helpers ---------- */

  function isLocal() {
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]';
  }
  // Mock mode (localhost only): the pop-up reads leaderboard/mock/ instead of the results API, whatever the session
  function isMock() { return isLocal() && storageGet(MOCK_KEY) === '1'; }

  function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode etc. */ } }
  function storageDel(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

  function base64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomToken(nBytes) {
    var bytes = new Uint8Array(nBytes);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
  }
  function digest(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) { return new Uint8Array(buf); });
  }
  function sha256(text) { return digest(text).then(base64url); }
  // Lowercase hex: the public table's data-org is the first 12 characters of this for the team's org handle
  function sha256hex(text) {
    return digest(text).then(function (bytes) {
      var s = '';
      for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
      return s;
    });
  }

  // The registered redirect URI is the pop-up page's directory URL, without index.html and without
  // query or hash: https://steerability.github.io/competition/leaderboard/ (and
  // http://localhost/competition/leaderboard/ for local previews — any port on http://localhost).
  function redirectUri() {
    return location.origin + location.pathname.replace(/index\.html$/, '');
  }

  function cleanUrl(hash) {
    history.replaceState(null, '', location.pathname + (hash || ''));
    var target = hash && document.getElementById(hash.slice(1));
    if (target) target.scrollIntoView();
  }

  function showError(message) {
    if (!els.error) return;
    els.error.textContent = message;
    els.error.hidden = false;
  }
  function clearError() { if (els.error) { els.error.hidden = true; els.error.textContent = ''; } }

  /* ---------- session ---------- */

  function loadSession() {
    var raw = storageGet(SESSION_KEY);
    if (!raw) return null;
    try {
      var s = JSON.parse(raw);
      if (!s || !s.user || !s.expiresAt || s.expiresAt <= Date.now()) { storageDel(SESSION_KEY); return null; }
      return s;
    } catch (e) { storageDel(SESSION_KEY); return null; }
  }
  function saveSession(s) { storageSet(SESSION_KEY, JSON.stringify(s)); }
  function dropSession() { storageDel(SESSION_KEY); }

  // What the page keeps from userinfo: the handle, the display bits, and the org memberships.
  function sessionFromUserInfo(token, info) {
    return {
      accessToken: token.access_token,
      scope: token.scope || CONFIG.scopes,
      expiresAt: Date.now() + 1000 * (typeof token.expires_in === 'number' ? token.expires_in : CONFIG.defaultTokenSeconds),
      user: {
        username: info.preferred_username,
        name: info.name || info.preferred_username,
        picture: info.picture || '',
        profile: info.profile || (CONFIG.hub + '/' + info.preferred_username)
      },
      orgs: (info.orgs || []).map(function (o) {
        return { handle: o.preferred_username, name: o.name || o.preferred_username, role: o.roleInOrg || null };
      })
    };
  }

  // Roles: organizer = evaluator account or a member of the organizer org; teams = every other org.
  function rolesOf(s) {
    var handles = s.orgs.map(function (o) { return o.handle; });
    var organizer = CONFIG.organizerUsers.indexOf(s.user.username) !== -1 || handles.indexOf(CONFIG.organizerOrg) !== -1;
    var teams = s.orgs.filter(function (o) { return o.handle !== CONFIG.organizerOrg; });
    return { organizer: organizer, teams: teams };
  }

  /* ---------- OAuth (in the pop-up) ---------- */

  // A sleeping results server takes up to a minute to wake: wake it while the person is on huggingface.co.
  // keepalive lets the request outlive the page; nothing reads the answer.
  function wakeApi() {
    if (!CONFIG.api) return;
    try { fetch(CONFIG.api + '/healthz', { cache: 'no-store', keepalive: true }).catch(function () {}); } catch (e) { /* ignore */ }
  }

  function login() {
    clearError();
    if (!CONFIG.clientId || /^REPLACE/.test(CONFIG.clientId)) {
      showError('Sign-in is not configured yet (no OAuth client id). See competition/hf-login.js.');
      return;
    }
    var verifier = randomToken(48);   // 64 url-safe chars: within PKCE's 43–128
    var state = randomToken(24);
    wakeApi();
    return sha256(verifier).then(function (challenge) {
      storageSet(PENDING_KEY, JSON.stringify({ state: state, verifier: verifier, redirectUri: redirectUri(), createdAt: Date.now() }));
      var url = new URL(CONFIG.hub + '/oauth/authorize');
      url.search = new URLSearchParams({
        client_id: CONFIG.clientId,
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: CONFIG.scopes,
        state: state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      }).toString();
      location.assign(url.toString());
    });
  }

  // The sign-in this browser started, if it is recent; it is forgotten either way.
  function takePending() {
    var p = null;
    try { p = JSON.parse(storageGet(PENDING_KEY) || 'null'); } catch (e) { p = null; }
    storageDel(PENDING_KEY);
    return p && p.createdAt && Date.now() - p.createdAt < PENDING_MAX_AGE ? p : null;
  }

  function handleRedirect(params) {
    var pending = takePending();

    if (params.has('error')) {
      // e.g. access_denied when the person cancels on huggingface.co. The provider's text is shown
      // only if a sign-in was started here, so a crafted ?error_description= link can't put words on the page.
      showError(pending
        ? (params.get('error_description') || ('Sign-in was cancelled (' + params.get('error') + ').'))
        : "Sign-in didn't go through — please try again.");
      return Promise.resolve();
    }
    if (!pending || params.get('state') !== pending.state) {
      showError("Sign-in couldn't be verified (unexpected state). Please try again.");
      return Promise.resolve();
    }

    var token;
    return fetch(CONFIG.hub + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CONFIG.clientId,
        code: params.get('code'),
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier
      }).toString()
    })
      .then(function (res) { if (!res.ok) throw new Error('token endpoint returned ' + res.status); return res.json(); })
      .then(function (t) {
        token = t;
        return fetch(CONFIG.hub + '/oauth/userinfo', { headers: { Authorization: 'Bearer ' + t.access_token } });
      })
      .then(function (res) { if (!res.ok) throw new Error('userinfo returned ' + res.status); return res.json(); })
      .then(function (info) { saveSession(sessionFromUserInfo(token, info)); })
      .catch(function (err) {
        console.error('Hugging Face sign-in failed:', err);
        showError("Sign-in didn't go through — please try again.");
      });
  }

  // "Sign out", and the private view's way out when the results API no longer accepts the token (with a message
  // for the error line under the sign-in row)
  function logout(message) {
    dropSession();   // the competition page's button hears this through the 'storage' event
    clearError();
    renderWindow();
    if (message) showError(message);
  }

  /* ---------- mock sessions (localhost only) ---------- */

  // `mock` names the fixture the private view reads (leaderboard/mock/<kind>.json), since ?mock is gone from the
  // URL by the time it renders
  function mockSession(kind) {
    var base = { accessToken: 'mock', scope: CONFIG.scopes, expiresAt: Date.now() + 3600 * 1000, mock: kind };
    var ada = { username: 'ada', name: 'Ada Lovelace', picture: '', profile: CONFIG.hub + '/ada' };
    if (kind === 'organizer') {
      base.user = { username: 'steerability-challenge-evaluator', name: 'steerability-challenge-evaluator', picture: '',
                    profile: CONFIG.hub + '/steerability-challenge-evaluator' };
      base.orgs = [{ handle: 'steerability-challenge-evals', name: 'Steerability Challenge Evals', role: 'admin' },
                   { handle: 'example-team', name: 'Example Team', role: 'read' }];
      return base;
    }
    if (/^participant/.test(kind)) {   // participant, participant-unscored, …: one session, a fixture each
      base.user = ada;
      base.orgs = [{ handle: 'example-team', name: 'Example Team', role: 'write' }];
      return base;
    }
    if (kind === 'noteam') { base.user = ada; base.orgs = []; return base; }
    return null;   // 'none' or anything else: signed out
  }

  /* ---------- the competition page: the button that opens the pop-up ---------- */

  function popupFeatures() {
    var w = CONFIG.windowSize[0], h = CONFIG.windowSize[1];
    var left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
    var top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 3));
    return 'popup,width=' + w + ',height=' + h + ',left=' + left + ',top=' + top;
  }

  function renderLauncher() {
    var s = loadSession();
    els.open.textContent = s ? 'Open private results' : 'Sign in with Hugging Face';
    els.openNote.textContent = s ? 'signed in as @' + s.user.username : "to see your team's private results";
    els.open.href = CONFIG.windowUrl + (s ? '' : '?signin');
  }

  function initLauncher() {
    els.open.addEventListener('click', function (e) {
      e.preventDefault();
      renderLauncher();   // the session may have expired since the page loaded
      var w = window.open(els.open.href, CONFIG.windowName, popupFeatures());
      if (w) w.focus();
      else location.assign(els.open.href);   // pop-ups blocked: open the leaderboard in this tab instead
    });
    window.addEventListener('storage', function (e) {
      if (e.key === SESSION_KEY || e.key === null) renderLauncher();   // signed in or out in the pop-up
    });
    renderLauncher();
  }

  /* ---------- the pop-up: sign-in, who line, private view, public table ---------- */

  function text(tag, className, content) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined) el.textContent = content;
    return el;
  }

  function renderWho(s, roles) {
    els.who.textContent = '';
    if (s.user.picture) {
      var img = document.createElement('img');
      img.src = s.user.picture; img.alt = ''; img.width = 28; img.height = 28; img.className = 'lb-avatar';
      els.who.appendChild(img);
    }
    var who = text('span', null, 'Signed in as ');
    var link = document.createElement('a');
    link.href = s.user.profile; link.target = '_blank'; link.rel = 'noopener';
    link.appendChild(text('strong', null, '@' + s.user.username));
    who.appendChild(link);
    els.who.appendChild(who);

    // The evaluator account is a (read) member of every team organization, so an organizer gets
    // the organizer tag alone; a participant gets one tag per team organization they belong to.
    if (roles.organizer) els.who.appendChild(text('span', 'lb-tag', 'organizer'));
    else roles.teams.forEach(function (t) { els.who.appendChild(text('span', 'lb-tag', 'team: ' + t.handle)); });

    var signout = text('span', 'lb-signout');   // pushed to the right end of the line by the stylesheet
    var out = document.createElement('a');
    out.href = '#'; out.id = 'hf-logout'; out.textContent = 'Sign out';
    out.addEventListener('click', function (e) { e.preventDefault(); logout(); });
    signout.appendChild(out);
    els.who.appendChild(signout);
  }

  // The private view (private-view.js) renders the results. These placeholders stand in without it, or without
  // CONFIG.api; an account with no team organization gets the guidance either way.
  function renderContent(s, roles) {
    var view = window.SCPrivateView;   // looked up now, not when this script loads, so the scripts' order can't break it
    if (view && (CONFIG.api || s.mock) && (roles.organizer || roles.teams.length)) {
      view.render(s, roles);
      return;
    }
    if (view) view.clear();
    els.content.textContent = '';
    if (roles.organizer) {
      els.content.appendChild(text('p', 'soft',
        'Organizer view. The private board for every team will appear here.'));
    } else if (roles.teams.length) {
      els.content.appendChild(text('p', 'soft',
        'Private results for ' + roles.teams.map(function (t) { return t.name + ' (' + t.handle + ')'; }).join(', ') +
        ' will appear here after the next intake.'));
    } else {
      var p = text('p', null, '');
      p.appendChild(document.createTextNode('This account is not a member of a team organization. Sign in with the Hugging Face account that belongs to your team’s organization — the one whose '));
      p.appendChild(text('code', null, '<org>/submission'));
      p.appendChild(document.createTextNode(' repository the evaluator reads (see the competition guide, section 2.1). If Hugging Face asked which organizations to share and you skipped it, sign out and sign in again.'));
      els.content.appendChild(p);
    }
  }

  function renderWindow() {
    var s = loadSession();
    if (!s) {
      if (window.SCPrivateView) window.SCPrivateView.clear();   // its rows and blocks go with the session; the board stays
      els.signedOut.hidden = false;
      els.signedIn.hidden = true;
      return;
    }
    var roles = rolesOf(s);
    renderWho(s, roles);
    renderContent(s, roles);
    els.signedOut.hidden = true;
    els.signedIn.hidden = false;
  }

  // Size the pop-up to its content so the board shows without a scroll bar, up to the screen's height
  // (moving the window up if it would run off the bottom). Browsers only resize pop-up windows; in a
  // tab (pop-ups blocked, phones) resizeTo and moveTo do nothing.
  function fitWindow() {
    var chrome = Math.max(0, window.outerHeight - window.innerHeight);   // title bar, toolbars
    var content = Math.ceil(document.querySelector('main').getBoundingClientRect().bottom + window.scrollY);
    var top = screen.availTop || 0;
    var h = Math.min(content + chrome, screen.availHeight);
    if (window.screenY + h > top + screen.availHeight) window.moveTo(window.screenX, top + screen.availHeight - h);
    if (Math.abs(window.outerHeight - h) > 1) window.resizeTo(window.outerWidth, h);
  }

  // A static page can't tell whether someone has starred the repo: they signed in with Hugging Face, and the
  // Hub doesn't share a GitHub account. So the ask goes by what they did with it in this browser: once they
  // have gone to the repo it never comes back; "Go away" (or Esc) rests it for CONFIG.starSnoozeDays.
  // Participants only: not organizers, and not accounts without a team org (they see the guidance instead).
  function maybeAskForStar() {
    var dialog = document.getElementById('star-ask');
    var s = loadSession();
    if (!dialog || !dialog.showModal || !s) return;
    var roles = rolesOf(s);
    if (roles.organizer || !roles.teams.length) return;
    var seen = storageGet(STAR_KEY);
    if (seen === 'visited' || (seen && Date.now() - Number(seen) < CONFIG.starSnoozeDays * 24 * 3600 * 1000)) return;

    function snooze() { storageSet(STAR_KEY, String(Date.now())); }
    document.getElementById('star-go').addEventListener('click', function () {
      storageSet(STAR_KEY, 'visited');
      setTimeout(function () { dialog.close(); }, 0);   // after the link has opened the repo in a new tab
    });
    document.getElementById('star-dismiss').addEventListener('click', function () { snooze(); dialog.close(); });
    dialog.addEventListener('cancel', snooze);   // Esc
    dialog.showModal();
    dialog.focus();   // rather than its first button, which would show a focus ring before anyone has done anything
  }

  function initWindow(params) {
    if (els.login) els.login.addEventListener('click', function () { login(); });
    window.addEventListener('storage', function (e) {
      if (e.key === SESSION_KEY || e.key === null) renderWindow();   // signed in or out in another window
    });
    // The board (private-view.js renders it from the results API) is in, or has failed for good, once this resolves
    var board = window.SCPrivateView && window.SCPrivateView.boardReady ? window.SCPrivateView.boardReady() : Promise.resolve();

    var ready;
    if (params.has('code') || params.has('error')) {
      ready = handleRedirect(params).then(function () { cleanUrl(); renderWindow(); });
    } else {
      if (params.has('signin')) {
        // Opened by the competition page's button: go straight to huggingface.co. The URL is cleaned
        // first, so coming Back from huggingface.co shows the button instead of leaving again.
        cleanUrl();
        if (!loadSession()) { renderWindow(); login(); return; }
      }
      renderWindow();
      ready = Promise.resolve();
    }
    // Fit once the board, the sign-in state and the web fonts are all in, since each changes the height;
    // then, a moment later, the star-the-repo ask (it floats over the page, so it doesn't change the fit).
    Promise.all([board, ready, document.fonts && document.fonts.ready]).then(function () {
      fitWindow();
      setTimeout(maybeAskForStar, 400);
    });
  }

  /* ---------- boot ---------- */

  // For private-view.js: CONFIG (its api), the window fit (after a row opens), sign-out with a message (when the
  // API rejects the token), the hash that names a team's row in the board, and whether to read the fixtures
  window.SCLogin = { config: CONFIG, fitWindow: fitWindow, signOut: logout, sha256hex: sha256hex, isMock: isMock };

  function init() {
    var params = new URLSearchParams(location.search);
    var mock = params.has('mock') && isLocal();
    if (mock) {
      var kind = params.get('mock');
      if (kind === 'off') {           // leave mock mode, signed out
        storageDel(MOCK_KEY);
        dropSession();
      } else {
        var m = mockSession(kind);
        if (m) saveSession(m); else dropSession();
        storageSet(MOCK_KEY, '1');    // the pop-up reads its fixtures from now on, whatever the session
      }
      storageSet(PREVIEW_KEY, '1');   // a mock session implies previewing the button
      cleanUrl(mode === 'launcher' ? CONFIG.returnHash : '');
    }
    if (mode === 'window') { initWindow(params); return; }

    var preview = params.has('preview') || mock || storageGet(PREVIEW_KEY) === '1';
    if (params.has('preview')) storageSet(PREVIEW_KEY, '1');
    if (!CONFIG.enabled && !preview) return;   // shipped dark: the button stays hidden
    root.hidden = false;
    initLauncher();
  }

  if (window.crypto && crypto.subtle && window.fetch && window.URLSearchParams) {
    init();
  } else if (mode === 'window' && els.login) {
    els.signedOut.hidden = false;
    els.login.disabled = true;
    showError('Sign-in needs a current browser (Web Crypto is unavailable).');
  }
})();
