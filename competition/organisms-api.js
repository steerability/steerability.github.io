/* ============================================================
   The Steerability Challenge — organisms-api.js
   ------------------------------------------------------------
   The "Model organisms API" panel in the leaderboard pop-up: a
   collapsible block under the "who" line for signed-in people, with
   their API key for the organisms gateway, their rate limits, today's
   usage, a 14-day history and their recent requests.

   Data: GET <CONFIG.organismsApi>/api/me with the session's Hugging
   Face access token (the gateway verifies it with Hugging Face and
   mints a key on the first visit); POST /api/me/key rotates the key.
   In mock mode (hf-login.js) it reads leaderboard/mock/organisms/me.json.

   hf-login.js calls SCOrganismsApi.render(session, roles) when a
   session is shown and .clear() when it ends, like SCPrivateView.
============================================================= */
(function () {
  'use strict';

  var OPEN_KEY = 'sc:api-open';   // localStorage: '1' while the panel is expanded
  var RETRY_MS = 1500;
  var root = document.getElementById('lb-api');
  if (!root) return;

  var state = { session: null, data: null, shown: false, busy: false };

  /* ---------- helpers ---------- */
  function cfg() { var l = window.SCLogin; return (l && l.config) || {}; }
  function apiBase() { return cfg().organismsApi || null; }
  function mockMode() { var l = window.SCLogin; return !!(l && l.isMock && l.isMock()); }
  function fit() { var l = window.SCLogin; if (l && l.fitWindow) setTimeout(l.fitWindow, 0); }
  function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

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
  function maskKey(k) { return k ? k.slice(0, 8) + '…' + k.slice(-4) : ''; }

  function getJSON(url, init) {
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) { return { status: res.status, body: body }; });
    });
  }

  /* ---------- data ---------- */
  function load(session, rotate) {
    if (mockMode()) {
      return getJSON('mock/organisms/me.json', { cache: 'no-cache' }).then(function (r) {
        if (r.status !== 200 || !r.body) throw new Error('fixture missing');
        if (rotate) { r.body.api_key = 'org-mockNewKey_' + Math.random().toString(36).slice(2, 10); r.body.key_fresh = true; }
        return { status: 200, body: r.body };
      });
    }
    var api = apiBase();
    if (!api) return Promise.resolve({ status: 0 });
    return getJSON(api + '/api/me' + (rotate ? '/key' : ''), {
      method: rotate ? 'POST' : 'GET', cache: 'no-store',
      headers: { Authorization: 'Bearer ' + session.accessToken }
    });
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

  function meter(parent, label, used, max, unit) {
    var row = add(parent, el('div', 'lb-api-meter'));
    var head = add(row, el('div', 'lb-api-meter-head'));
    add(head, el('span', null, label));
    add(head, el('span', 'lb-api-meter-val', num(used) + ' / ' + num(max) + (unit ? ' ' + unit : '')));
    var bar = add(row, el('div', 'lb-api-bar'));
    var fill = add(bar, el('div', 'lb-api-bar-fill' + (pct(used, max) >= 90 ? ' is-high' : '')));
    fill.style.width = pct(used, max) + '%';
  }

  function renderKeyRow(body, d) {
    var row = add(body, el('div', 'lb-api-keyrow'));
    add(row, el('span', 'lb-api-label', 'API key'));
    var code = add(row, el('code', 'lb-api-key', d.api_key ? maskKey(d.api_key) : 'not available'));
    code.title = d.api_key ? (d.key_fresh ? 'New key' : 'Created ' + when(d.key_created)) : '';
    var revealed = false;
    if (d.api_key) {
      var show = add(row, el('button', 'link-btn', 'Show'));
      show.type = 'button';
      show.addEventListener('click', function () {
        revealed = !revealed;
        code.textContent = revealed ? d.api_key : maskKey(d.api_key);
        show.textContent = revealed ? 'Hide' : 'Show';
        renderSnippet(d, revealed);
      });
      var copy = add(row, el('button', 'link-btn', 'Copy'));
      copy.type = 'button';
      copy.addEventListener('click', function () {
        var done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy'; }, 1500); };
        if (navigator.clipboard) navigator.clipboard.writeText(d.api_key).then(done, function () { window.prompt('Your API key', d.api_key); });
        else window.prompt('Your API key', d.api_key);
      });
    }
    var rotate = add(row, el('button', 'link-btn lb-api-rotate', 'Rotate'));
    rotate.type = 'button';
    rotate.title = 'Revoke this key and get a new one';
    rotate.addEventListener('click', function () {
      if (state.busy || !window.confirm('Revoke your current key and mint a new one? Anything using the old key stops working.')) return;
      refresh(true);
    });
    if (d.key_fresh) add(row, el('span', 'lb-tag', 'new'));
    if (d.key_fresh && d.api_key) add(body, el('p', 'soft lb-api-note', 'This key was just minted for you. It stays available here while you are signed in.'));
  }

  var snippetEl = null;
  function renderSnippet(d, revealed) {
    if (!snippetEl) return;
    var key = revealed && d.api_key ? d.api_key : 'org-…';
    snippetEl.textContent =
      'from openai import OpenAI\n' +
      'client = OpenAI(base_url="' + d.base_url + '", api_key="' + key + '")\n' +
      'r = client.chat.completions.create(model="' + (d.models[0] || 'lying-qwen') + '",\n' +
      '    messages=[{"role": "user", "content": "How many moons does Mars have?"}], max_tokens=200)\n' +
      'print(r.choices[0].message.content)';
  }

  function renderData(body, d) {
    body.textContent = '';
    renderKeyRow(body, d);

    var ep = add(body, el('div', 'lb-api-row'));
    add(ep, el('span', 'lb-api-label', 'Endpoint'));
    add(ep, el('code', null, d.base_url));
    var md = add(body, el('div', 'lb-api-row'));
    add(md, el('span', 'lb-api-label', 'Models'));
    add(md, el('span', null, d.models.length ? d.models.join(', ') : 'none online right now'));

    var cols = add(body, el('div', 'lb-api-cols'));
    var left = add(cols, el('div', 'lb-api-col'));
    add(left, el('h3', 'lb-api-h', d.admin ? 'Usage today (no rate limits: admin)' : 'Usage today & limits'));
    var t = d.today || {};
    if (d.limits) {
      meter(left, 'Tokens today', (t.prompt_tokens || 0) + (t.completion_tokens || 0), d.limits.tokens_per_day);
      meter(left, 'In flight now', d.inflight || 0, d.limits.max_inflight, 'requests');
      var lim = add(left, el('p', 'soft lb-api-limits'));
      lim.textContent = num(d.limits.tokens_per_minute) + ' tokens/min · ' + num(d.limits.max_tokens_per_request) +
        ' max_tokens per request · ' + num(t.requests) + ' requests today' + (t.rejected ? ' · ' + num(t.rejected) + ' rate-limited' : '');
    } else {
      add(left, el('p', 'soft lb-api-limits', num(t.requests) + ' requests · ' + num((t.prompt_tokens || 0) + (t.completion_tokens || 0)) +
        ' tokens today · ' + num(d.inflight || 0) + ' in flight'));
    }

    var right = add(cols, el('div', 'lb-api-col'));
    add(right, el('h3', 'lb-api-h', 'Last 14 days (requests)'));
    var hist = add(right, el('div', 'lb-api-hist'));
    var max = Math.max.apply(null, [1].concat((d.days || []).map(function (x) { return x.requests; })));
    (d.days || []).forEach(function (x) {
      var b = add(hist, el('div', 'lb-api-hist-bar' + (x.rejected ? ' has-rejected' : '')));
      b.style.height = Math.max(2, Math.round(100 * x.requests / max)) + '%';
      b.title = x.day + ': ' + num(x.requests) + ' requests, ' + num(x.prompt_tokens + x.completion_tokens) + ' tokens' +
        (x.rejected ? ', ' + num(x.rejected) + ' rate-limited' : '');
    });

    if (d.recent && d.recent.length) {
      var det = add(body, el('details', 'lb-api-recent'));
      add(det, el('summary', null, 'Recent requests'));
      var table = add(det, el('table'));
      var thead = add(table, el('thead')); var hr = add(thead, el('tr'));
      ['time', 'model', 'status', 'prompt', 'completion', 'ms'].forEach(function (h) { add(hr, el('th', null, h)); });
      var tb = add(table, el('tbody'));
      d.recent.forEach(function (r) {
        var tr = add(tb, el('tr'));
        add(tr, el('td', null, when(r.ts)));
        add(tr, el('td', null, r.model || ''));
        var st = add(tr, el('td', r.status === 200 ? '' : (r.status === 429 ? 'is-warn' : 'is-bad'), String(r.status)));
        if (r.reason) st.title = r.reason;
        add(tr, el('td', 'num', num(r.prompt_tokens)));
        add(tr, el('td', 'num', num(r.completion_tokens)));
        add(tr, el('td', 'num', r.latency_ms == null ? '' : num(r.latency_ms)));
      });
      det.addEventListener('toggle', fit);
    }

    var snip = add(body, el('details', 'lb-api-snippet'));
    add(snip, el('summary', null, 'Example (Python, OpenAI SDK)'));
    snippetEl = add(snip, el('pre'));
    renderSnippet(d, false);
    snip.addEventListener('toggle', fit);
    fit();
  }

  function refresh(rotate) {
    var panel = root.firstChild; if (!panel) return;
    var body = panel.querySelector('.lb-api-body');
    var s = state.session;
    state.busy = true;
    message(body, rotate ? 'Rotating your key…' : 'Loading your API access…');
    withRetry(function () { return load(s, rotate); }).then(function (r) {
      state.busy = false;
      if (state.session !== s) return;   // signed out meanwhile
      if (r.status === 200 && r.body) { state.data = r.body; renderData(body, r.body); return; }
      if (r.status === 0) return message(body, 'The organisms API is not configured for this site yet.');
      if (r.status === 401) return message(body, 'Your Hugging Face sign-in is no longer accepted by the organisms API. Sign out and sign in again.', 'lb-error');
      if (r.status === 403) return message(body, 'This Hugging Face account is not enabled for the organisms API yet.', 'lb-error');
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
    var panel = add(root, el('details', 'lb-api'));
    panel.id = 'lb-api-panel';
    if (storageGet(OPEN_KEY) === '1') panel.open = true;
    var sum = add(panel, el('summary'));
    add(sum, el('span', 'lb-api-title', 'Model organisms API'));
    add(sum, el('span', 'soft', 'your key, usage and rate limits'));
    add(panel, el('div', 'lb-api-body'));
    panel.addEventListener('toggle', function () {
      storageSet(OPEN_KEY, panel.open ? '1' : '0');
      if (panel.open && !state.data && !state.busy) refresh(false);
      fit();
    });
    if (panel.open) refresh(false);
  }

  function clear() {
    root.textContent = '';
    state.session = null; state.data = null; state.busy = false; snippetEl = null;
  }

  window.SCOrganismsApi = { render: render, clear: clear, refresh: function () { refresh(false); } };
})();
