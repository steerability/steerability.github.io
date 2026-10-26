/* ============================================================
   The Steerability Challenge — organisms-api.js
   ------------------------------------------------------------
   The "Model organisms API" section in the leaderboard pop-up, below
   the board, for signed-in people. One section
   per team (a Hugging Face organization they belong to): the person's
   own API key, which counts against the team's shared budget, the
   team's rate limits, today's and this week's usage, a 14-day history
   and the team's recent requests (with who made each). Organizers get
   a personal section instead.

   Data: GET <CONFIG.organismsApi>/api/me with the session's Hugging
   Face access token (the gateway verifies it with Hugging Face and
   mints a key on the first visit); POST /api/me/key rotates the key.
   A mock session (?mock=participant etc., hf-login.js) reads
   leaderboard/mock/organisms/me.json instead and says so in the
   header; a real sign-in always asks the gateway, even while the
   board is in mock mode, so real usage is never confused with the
   fixture's.

   hf-login.js calls SCOrganismsApi.render(session, roles) when a
   session is shown and .clear() when it ends, like SCPrivateView.
============================================================= */
(function () {
  'use strict';

  var RETRY_MS = 1500;
  var VIEW_KEY = 'sc:api-view';   // localStorage: 'team' (default) or 'you', the usage view of a team section
  var root = document.getElementById('lb-api');
  if (!root) return;

  var state = { session: null, data: null, shown: false, busy: false, view: 'team' };
  try { if (localStorage.getItem(VIEW_KEY) === 'you') state.view = 'you'; } catch (e) { /* ignore */ }
  function setView(v) { state.view = v; try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* ignore */ } }

  /* ---------- helpers ---------- */
  function cfg() { var l = window.SCLogin; return (l && l.config) || {}; }
  function apiBase() { return cfg().organismsApi || null; }
  // The fixture stands in for a mock session only (its token is not real); a real session always asks the gateway
  function mockSession(session) { return !!(session && session.mock); }
  function fit() { var l = window.SCLogin; if (l && l.fitWindow) setTimeout(l.fitWindow, 0); }

  function el(tag, className, content) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (content !== undefined && content !== null) e.textContent = content;
    return e;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function num(n) { return (n || 0).toLocaleString(); }
  function pct(a, b) { return b ? Math.min(100, Math.round(100 * a / b)) : 0; }
  function when(ts) { return new Date(ts * 1000).toLocaleString(); }
  function whenShort(ts) {
    return new Date(ts * 1000).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function maskKey(k) { return k ? k.slice(0, 8) + '…' + k.slice(-4) : ''; }

  function getJSON(url, init) {
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) { return { status: res.status, body: body }; });
    });
  }

  /* ---------- data ---------- */
  // rotate: null, or {team: <org>|null} (team null = the personal key)
  function load(session, rotate) {
    if (mockSession(session)) {
      return getJSON('mock/organisms/me.json', { cache: 'no-cache' }).then(function (r) {
        if (r.status !== 200 || !r.body) throw new Error('fixture missing');
        if (rotate) {
          var fresh = { api_key: 'org-mockNewKey_' + Math.random().toString(36).slice(2, 10), key_prefix: 'org-mockNew', created: Date.now() / 1000, fresh: true };
          if (!rotate.team && r.body.personal) r.body.personal.key = fresh;
          r.body.teams.forEach(function (t) { if (t.org === rotate.team) t.key = fresh; });
        }
        return { status: 200, body: r.body };
      });
    }
    var api = apiBase();
    if (!api) return Promise.resolve({ status: 0 });
    var url = api + '/api/me';
    if (rotate) {
      url += '/key';
      if (rotate.team) url += '?' + new URLSearchParams({ team: rotate.team }).toString();
    }
    return getJSON(url, { method: rotate ? 'POST' : 'GET', cache: 'no-store',
                          headers: { Authorization: 'Bearer ' + session.accessToken } });
  }
  function withRetry(fn) {
    return fn().catch(function (err) {
      return new Promise(function (ok) { setTimeout(ok, RETRY_MS); }).then(fn).catch(function () { throw err; });
    });
  }

  /* ---------- rendering ---------- */
  function message(body, text, cls) {
    body.textContent = '';
    add(body, el('p', cls || 'soft', text));
    fit();
  }

  // A meter of the budget's use against its limit. With `mine` (the "you" view) the budget's fill is dimmed and the
  // person's own share drawn in ink inside it, so the real limit stays visible and the bar keeps its scale.
  function meter(parent, label, used, max, unit, mine) {
    var row = add(parent, el('div', 'lb-api-meter'));
    var head = add(row, el('div', 'lb-api-meter-head'));
    add(head, el('span', null, label));
    var val = add(head, el('span', 'lb-api-meter-val'));
    if (mine == null) val.textContent = num(used) + ' / ' + num(max) + (unit ? ' ' + unit : '');
    else {
      add(val, el('strong', null, 'you ' + num(mine)));
      add(val, el('span', 'soft', ' · team ' + num(used) + ' / ' + num(max) + (unit ? ' ' + unit : '')));
    }
    var bar = add(row, el('div', 'lb-api-bar'));
    var fill = add(bar, el('div', 'lb-api-bar-fill' + (pct(used, max) >= 90 ? ' is-high' : '') + (mine == null ? '' : ' is-dim')));
    fill.style.width = pct(used, max) + '%';
    if (mine != null) {
      var own = add(bar, el('div', 'lb-api-bar-mine'));
      own.style.width = pct(mine, max) + '%';
    }
  }

  // One key line: label, the key (masked; Show reveals it), Copy, Rotate. `rotate` is null when this person may not
  // rotate it; `onReveal` tells the section's snippet which key to show.
  function renderKeyRow(parent, label, k, rotate, onReveal, note) {
    var row = add(parent, el('div', 'lb-api-keyrow'));
    add(row, el('span', 'lb-api-label', label));
    if (!k) { add(row, el('span', 'soft', 'not available')); return; }
    var code = add(row, el('code', 'lb-api-key', k.api_key ? maskKey(k.api_key) : 'not available'));
    code.title = k.api_key ? (k.fresh ? 'New key' : 'Created ' + when(k.created)) : '';
    var revealed = false;
    if (k.api_key) {
      var show = add(row, el('button', 'link-btn', 'Show'));
      show.type = 'button';
      show.addEventListener('click', function () {
        revealed = !revealed;
        code.textContent = revealed ? k.api_key : maskKey(k.api_key);
        show.textContent = revealed ? 'Hide' : 'Show';
        if (onReveal) onReveal(revealed ? k.api_key : null);
      });
      var copy = add(row, el('button', 'link-btn', 'Copy'));
      copy.type = 'button';
      copy.addEventListener('click', function () {
        var done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy'; }, 1500); };
        if (navigator.clipboard) navigator.clipboard.writeText(k.api_key).then(done, function () { window.prompt('API key', k.api_key); });
        else window.prompt('API key', k.api_key);
      });
    }
    if (rotate) {
      var btn = add(row, el('button', 'link-btn lb-api-rotate', 'Rotate'));
      btn.type = 'button';
      btn.title = 'Revoke this key and get a new one';
      btn.addEventListener('click', function () {
        if (state.busy || !window.confirm('Revoke this key and mint a new one? Anything using the old key stops working.')) return;
        refresh(rotate);
      });
    }
    if (k.fresh) add(row, el('span', 'lb-tag', 'new'));
    if (note) add(row, el('span', 'soft lb-api-keynote', note));
  }

  function snippetText(d, key) {
    return 'from openai import OpenAI\n' +
      'client = OpenAI(base_url="' + d.base_url + '", api_key="' + (key || 'org-…') + '")\n' +
      'r = client.chat.completions.create(model="' + (d.models[0] || 'lying-qwen') + '",\n' +
      '    messages=[{"role": "user", "content": "How many moons does Mars have?"}], max_tokens=200)\n' +
      'print(r.choices[0].message.content)';
  }

  // A budget's usage: meters against the limits (or the admin wording), the 14-day bars, the recent requests
  // `withUser`: a team budget — the section gets a Team / You switch; in the "you" view the meters and bars show the
  // person's share inside the team's (dimmed) use, and the recent requests are theirs only
  function renderBudget(parent, d, b, withUser) {
    var you = withUser && b.mine && state.view === 'you';
    var m = you ? b.mine : null;
    var cols = add(parent, el('div', 'lb-api-cols'));
    var left = add(cols, el('div', 'lb-api-col'));
    var h = add(left, el('h3', 'lb-api-h', b.limits ? 'Usage today & limits' : 'Usage today (no rate limits: admin)'));
    if (withUser && b.mine) {
      var sw = add(h, el('span', 'lb-api-switch'));
      sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', 'Usage view');
      [['team', 'Team'], ['you', 'You']].forEach(function (o) {
        var btn = add(sw, el('button', 'lb-api-switch-btn' + (state.view === o[0] ? ' is-on' : ''), o[1]));
        btn.type = 'button';
        btn.setAttribute('aria-pressed', state.view === o[0] ? 'true' : 'false');
        btn.addEventListener('click', function () { if (state.view !== o[0]) { setView(o[0]); rerender(); } });
      });
    }
    var t = b.today || {};
    var mt = m ? (m.today || {}) : null;
    if (b.limits) {
      meter(left, 'Tokens today', (t.prompt_tokens || 0) + (t.completion_tokens || 0), b.limits.tokens_per_day, null,
        mt ? (mt.prompt_tokens || 0) + (mt.completion_tokens || 0) : null);
      if (b.limits.tokens_per_week && b.week) meter(left, 'Tokens this week', b.week.tokens || 0, b.limits.tokens_per_week, null,
        m ? ((m.week || {}).tokens || 0) : null);
      meter(left, 'In flight now', b.inflight || 0, b.limits.max_inflight, 'requests', m ? (m.inflight || 0) : null);
      add(left, el('p', 'soft lb-api-limits', num(b.limits.tokens_per_minute) + ' tokens/min · ' +
        num(b.limits.max_tokens_per_request || d.max_tokens_per_request) + ' max_tokens per request · ' +
        (m ? 'you ' + num(mt.requests) + ' of the team\'s ' + num(t.requests) + ' requests today'
           : num(t.requests) + ' requests today') + (t.rejected ? ' · ' + num(t.rejected) + ' rate-limited' : '')));
      if (m) add(left, el('p', 'soft lb-api-limits lb-api-younote', 'The limits apply to the whole team\'s use (grey); your share is in black.'));
      var resets = [];
      if (b.day_resets_at) resets.push('day resets ' + whenShort(b.day_resets_at));
      if (b.limits.tokens_per_week && b.week && b.week.resets_at) resets.push('week resets ' + whenShort(b.week.resets_at));
      if (resets.length) add(left, el('p', 'soft lb-api-limits', resets.join(' · ') + (b.quota_timezone ? ' (' + b.quota_timezone + ' midnight)' : '')));
    } else {
      add(left, el('p', 'soft lb-api-limits', num(t.requests) + ' requests · ' +
        num((t.prompt_tokens || 0) + (t.completion_tokens || 0)) + ' tokens today · ' + num(b.inflight || 0) + ' in flight'));
    }
    var right = add(cols, el('div', 'lb-api-col'));
    add(right, el('h3', 'lb-api-h', m ? 'Last 14 days (requests: you in black, team in grey)' : 'Last 14 days (requests)'));
    var hist = add(right, el('div', 'lb-api-hist' + (m ? ' is-you' : '')));
    var max = Math.max.apply(null, [1].concat((b.days || []).map(function (x) { return x.requests; })));
    (b.days || []).forEach(function (x, i) {
      var cell = add(hist, el('div', 'lb-api-hist-cell'));
      var bar = add(cell, el('div', 'lb-api-hist-bar' + (x.rejected ? ' has-rejected' : '') + (m ? ' is-dim' : '')));
      bar.style.height = Math.max(2, Math.round(100 * x.requests / max)) + '%';
      var title = x.day + ': ' + num(x.requests) + ' requests, ' + num(x.prompt_tokens + x.completion_tokens) + ' tokens' +
        (x.rejected ? ', ' + num(x.rejected) + ' rate-limited' : '');
      if (m) {
        var y = (m.days || [])[i] || { requests: 0, prompt_tokens: 0, completion_tokens: 0 };
        var own = add(cell, el('div', 'lb-api-hist-mine'));
        own.style.height = Math.max(y.requests ? 2 : 0, Math.round(100 * y.requests / max)) + '%';
        title = x.day + ': you ' + num(y.requests) + ' of ' + num(x.requests) + ' requests, ' +
          num(y.prompt_tokens + y.completion_tokens) + ' of ' + num(x.prompt_tokens + x.completion_tokens) + ' tokens';
      }
      cell.title = title;
    });
    var recent = m ? (m.recent || []) : (b.recent || []);
    if (recent.length) {
      var det = add(parent, el('details', 'lb-api-recent'));
      if (state.openRecent) det.open = true;
      add(det, el('summary', null, m ? 'Your recent requests' : 'Recent requests'));
      var table = add(det, el('table'));
      var hr = add(add(table, el('thead')), el('tr'));
      (withUser ? ['time', 'who', 'model', 'status', 'prompt', 'completion', 'ms'] : ['time', 'model', 'status', 'prompt', 'completion', 'ms'])
        .forEach(function (h) { add(hr, el('th', null, h)); });
      var tb = add(table, el('tbody'));
      recent.forEach(function (r) {
        var tr = add(tb, el('tr'));
        add(tr, el('td', null, when(r.ts)));
        if (withUser) add(tr, el('td', null, /^team:/.test(r.hf_user || '') ? 'team key' : (r.hf_user || '')));
        add(tr, el('td', null, r.model || ''));
        var st = add(tr, el('td', r.status === 200 ? '' : (r.status === 429 ? 'is-warn' : 'is-bad'), String(r.status)));
        if (r.reason) st.title = r.reason;
        add(tr, el('td', 'num', num(r.prompt_tokens)));
        add(tr, el('td', 'num', num(r.completion_tokens)));
        add(tr, el('td', 'num', r.latency_ms == null ? '' : num(r.latency_ms)));
      });
      det.addEventListener('toggle', function () { state.openRecent = det.open; fit(); });
    }
  }

  // Re-draw the sections from the data already loaded (after the Team / You switch)
  function rerender() {
    var panel = root.firstChild;
    if (panel && state.data) renderData(panel.querySelector('.lb-api-body'), state.data);
  }

  function renderSnippetBlock(parent, d) {
    var snip = add(parent, el('details', 'lb-api-snippet'));
    add(snip, el('summary', null, 'Example (Python, OpenAI SDK)'));
    var pre = add(snip, el('pre', null, snippetText(d, null)));
    snip.addEventListener('toggle', fit);
    return function (key) { pre.textContent = snippetText(d, key); };
  }

  function renderTeam(body, d, t) {
    var sec = add(body, el('section', 'lb-api-team'));
    sec.setAttribute('data-org', t.org);
    var h = add(sec, el('h3', 'lb-api-team-h'));
    add(h, el('span', null, 'Team: ' + (t.name || t.org)));
    add(h, el('span', 'lb-tag', t.org));
    if (t.role) add(h, el('span', 'lb-tag', t.role));
    var onReveal = null;
    var mine = add(sec, el('div', 'lb-api-member'));
    renderKeyRow(mine, 'Your key', t.key, { team: t.org }, function (k) { if (onReveal) onReveal(k); },
      'yours alone; usage counts against the team\'s shared budget');
    renderBudget(sec, d, t, true);
    onReveal = renderSnippetBlock(sec, d);
  }

  function renderPersonal(body, d, p) {
    var sec = add(body, el('section', 'lb-api-team lb-api-personal'));
    add(add(sec, el('h3', 'lb-api-team-h')), el('span', null, d.admin ? 'Personal key (organizer)' : 'Personal key'));
    var onReveal = null;
    var mine = add(sec, el('div', 'lb-api-member'));
    renderKeyRow(mine, 'Your key', p.key, { team: null }, function (k) { if (onReveal) onReveal(k); });
    renderBudget(sec, d, p, false);
    onReveal = renderSnippetBlock(sec, d);
  }

  function renderData(body, d) {
    body.textContent = '';
    var ep = add(body, el('div', 'lb-api-row'));
    add(ep, el('span', 'lb-api-label', 'Endpoint'));
    add(ep, el('code', null, d.base_url));
    var md = add(body, el('div', 'lb-api-row'));
    add(md, el('span', 'lb-api-label', 'Models'));
    add(md, el('span', null, d.models.length ? d.models.join(', ') : 'none online right now'));
    (d.teams || []).forEach(function (t) { renderTeam(body, d, t); });
    if (d.personal) renderPersonal(body, d, d.personal);
    if (!(d.teams || []).length && !d.personal) add(body, el('p', 'soft', 'No team found for this account.'));
    if ((d.teams || []).some(function (t) { return t.key && t.key.fresh; }) || (d.personal && d.personal.key && d.personal.key.fresh)) {
      add(body, el('p', 'soft lb-api-note', 'Newly minted keys stay available here while you are signed in.'));
    }
    fit();
  }

  function refresh(rotate) {
    var panel = root.firstChild; if (!panel) return;
    var body = panel.querySelector('.lb-api-body');
    var s = state.session;
    state.busy = true;
    message(body, rotate ? 'Rotating the key…' : 'Loading your API access…');
    withRetry(function () { return load(s, rotate); }).then(function (r) {
      state.busy = false;
      if (state.session !== s) return;   // signed out meanwhile
      if (r.status === 200 && r.body) { state.data = r.body; renderData(body, r.body); return; }
      if (r.status === 0) return message(body, 'The organisms API is not configured for this site yet.');
      if (r.status === 401) return message(body, 'Your Hugging Face sign-in is no longer accepted by the organisms API. Sign out and sign in again.', 'lb-error');
      if (r.status === 403) return message(body, (r.body && r.body.detail) ||
        'This Hugging Face account is not a member of a team organization; the organisms API is for registered teams.', 'lb-error');
      if (r.status === 503) return message(body, 'The organisms API is not ready yet. Please try again later.');
      message(body, 'The organisms API answered ' + r.status + '. Please try again later.', 'lb-error');
    }).catch(function () {
      state.busy = false;
      if (state.session !== s) return;
      message(body, "The organisms API didn't answer. Please try again in a moment.", 'lb-error');
    });
  }

  function render(session) {
    clear();
    state.session = session;
    var panel = add(root, el('section', 'lb-api'));
    panel.id = 'lb-api-panel';
    var head = add(panel, el('div', 'lb-api-head'));
    add(head, el('h2', null, 'Model organisms API'));
    add(head, el('span', 'soft', 'your key, usage and rate limits'));
    if (mockSession(session)) add(head, el('span', 'lb-tag', 'mock data'));
    add(panel, el('div', 'lb-api-body'));
    refresh(null);
  }

  function clear() {
    root.textContent = '';
    state.session = null; state.data = null; state.busy = false;
  }

  window.SCOrganismsApi = { render: render, clear: clear, refresh: function () { refresh(null); } };
})();
