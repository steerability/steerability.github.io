/* ============================================================
   The Steerability Challenge — private-view.js
   ------------------------------------------------------------
   The leaderboard pop-up's board and private view: each week's
   public table from the results API, a picker that steps through
   the weeks, and, for a signed-in team, its own results in a drawer
   under its row (for an organizer, every team's). Loaded by
   leaderboard/ before hf-login.js, which calls
   SCPrivateView.render(session, roles) once signed in,
   SCPrivateView.clear() on signing out, and waits on
   SCPrivateView.boardReady() before fitting the window.

   Data (the results API, CONFIG.api in hf-login.js)
     GET /runs           the index: the weekly runs, oldest first,
                         which is the latest, and the week being
                         evaluated (pending), whose block says how far
                         along it is (phase, intake_done)
     GET /board/<run>    a week's public table: the ranked submissions
                         and the baselines, in descending S
     GET /me?run=<run>   with the session's bearer token: the viewer's
                         team files for that week (one per team
                         organization) or, for an organizer, every
                         team file (the run's status that comes with
                         them is not shown here). On the week being
                         evaluated its top-level run block carries the
                         phase and intake_done as well. A team file
                         (schema 2, 3 or 4) is made by the organizers' harness
                         and contains only what a team may see about
                         its own submission; this script renders what
                         it gets. Its entry.record is the pull and the
                         intake as the organizers' console prints
                         them, and the page shows those lines as they
                         are.
     Each answer is kept for the session, so stepping back to a week
     is instant.

   The team's row
     Each submission row of the board carries data-org: the first 12
     hex characters of the SHA-256 of the team's organization handle,
     so the page never lists the handles. A team file finds its row by
     that hash, else by the exact team name on a row without data-org.
     The row's name becomes a button in the accent colour and the
     whole row the click target; the drawer under it holds the
     per-model results under the board's own columns, the breakdown
     (dishonesty families, side effects, guards), the record, and the
     method card. A team with no row in that week gets the same drawer
     as a block under the table.

   Mock mode (SCLogin.isMock(): after ?mock=<kind> on localhost)
     The three requests read mock/runs.json, mock/board.<run>.json,
     and mock/<kind>.json (the latest run) or mock/<kind>.<run>.json
     (another run); a week without a file for the kind shows as one
     with no entry.

   The week being evaluated
     While a week is in evaluation the index names it as pending, and
     the picker gets one more step after the latest published week:
     signed in, a table of the viewer's own rows (an organizer's: every
     pulled team) with the turning status wheel where the score will
     be, else one line saying the week is being evaluated. The line
     under the table says how many submissions were pulled and follows
     the run's phase (being checked, running, being scored); without a
     phase it says only the first. The drawer shows the evaluation's
     progress per model, the record, and the method card. How much
     progress is a site setting, CONFIG.pendingProgress in hf-login.js
     (an organizer's browser can pin its own with ?progress=):
     'coarse', the default, reads in progress with the wheel on every
     model of every submission until the board is published.
     'detailed' gives a participant completed, error, or else in
     progress with the wheel, and an organizer the raw code per
     model. A submission that did not pass the intake checks gets one
     line saying it is not evaluated instead of the table, except in
     an organizer's detailed view. GET /me?run=<pending> is fetched on
     every visit, since its progress changes, and its run block is the
     freshest for the line; in mock mode it is
     mock/<kind>.<pending run>.json. Before the pull (pending.pulled
     false) nothing is fetched: a signed-in participant sees a row per
     team organization of their session with the spinner, anyone else
     a line saying the week has not been pulled yet.

   Still being evaluated
     The latest published week's /me answer carries running: the teams
     the board does not list yet, the same for every viewer, each with
     the evaluation's state per model. They show as a divided section at
     the top of the table, in the order given: rank and scores "--", no
     drawer, the per-model state in the name's tooltip, and the viewer's
     own team (by org_hash) in bold. Other weeks and the pending week
     show none; a missing key is an empty list.

   Vocabulary
     The family, category, kind, reason and flag keys below, with the
     labels printed for them. An unknown key prints as the key itself.
     Every string from the API is inserted with textContent.
============================================================= */
(function () {
  'use strict';

  var SCHEMAS = [2, 3, 4];     // the team-file schemas this script reads: 3 adds in_delta to the families, 4 more guard kinds
  var RETRY_MS = 20000;        // a results server waking from sleep gets one retry after this long
  var LABEL_MAX = 80;          // participant-authored names are cut to this many characters
  var MESSAGE_MAX = 300;       // ... and the record's lines to this many
  var ORG_HASH = 12;           // hex characters of a handle's SHA-256 in the board's data-org
  var RESIZE_SETTLE_MS = 150;  // the status wheels restart this long after the window's last resize event

  var FAMILY_LABELS = {
    instructed_deception: 'Instructed deception',
    incentives_and_sandbagging: 'Incentives & sandbagging',
    user_pressure: 'User pressure & sycophancy',
    fabrication: 'Fabrication',
    owning_up: 'Owning up',
    harm_denial: 'Harm-motivated denial'
  };
  var CATEGORY_LABELS = {
    knowledge: 'Knowledge',
    reasoning: 'Reasoning',
    problem_solving: 'Problem solving',
    instruction_following: 'Instruction following'
  };
  var KIND_LABELS = {
    helpfulness: 'Helpfulness & compliance',
    pushback_and_feedback: 'Pushback & feedback accuracy',
    refusals: 'Refusal behaviour',
    over_conservativeness: 'Over-conservativeness',
    confidentiality_and_persona: 'Confidentiality & persona'
  };
  var REASON_LABELS = {
    build_failed: 'The pipeline could not be built on either engine',
    timeout: "A request exceeded the run's time limit",
    suite_failed: "A suite failed after the run's retries",
    reference_pending: 'Not scored yet: the reference arm has not run on this engine',
    not_run: 'Not run in this interval'
  };
  var FLAG_LABELS = {
    truncation: 'Truncation above the reference',
    gpu_mismatch: 'Ran on other GPUs than its reference',
    no_dim_scored: 'No dishonesty dimension could be scored'
  };
  var ENGINE_LABELS = { vllm: 'vLLM', huggingface: 'Hugging Face' };   // the record names the engines itself; kept with the vocabulary
  var EVAL_LABELS = { not_started: 'not started', in_progress: 'in progress', completed: 'completed', error: 'error' };   // an organizer's detailed view
  var PARTICIPANT_EVAL_LABELS = { completed: 'completed', error: 'error' };   // a participant's detailed view; any other code reads EVAL_LABELS.in_progress
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ---------- formatting ---------- */

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function list(x) { return Array.isArray(x) ? x : []; }
  function fmtSigned(x, digits) {
    if (!isNum(x)) return '—';
    var s = x.toFixed(digits === undefined ? 3 : digits);
    if (Number(s) === 0) s = s.replace('-', '');   // no "-0.000"
    return s.charAt(0) === '-' ? s : '+' + s;
  }
  function fmtAbs(x, digits) { return isNum(x) ? x.toFixed(digits === undefined ? 3 : digits) : '—'; }
  function fmtPct(x) { return isNum(x) ? Math.round(x * 100) + '%' : '—'; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parseTime(iso) {
    var t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    return isNaN(t) ? null : new Date(t);
  }
  function fmtUTC(iso) {   // "Oct 13, 12:41 UTC"
    var d = parseTime(iso);
    return d ? MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC' : '—';
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function interval(ci) {   // "[+0.44, +0.58]"
    return Array.isArray(ci) && ci.length === 2 && isNum(ci[0]) && isNum(ci[1])
      ? '[' + fmtSigned(ci[0], 2) + ', ' + fmtSigned(ci[1], 2) + ']' : '—';
  }
  function shortModel(ref) { return String(ref).split('/').pop(); }
  function cap(s, n) {   // by characters, not UTF-16 units, so nothing is cut in half
    var chars = Array.from(String(s));
    return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : chars.join('');
  }
  function labelOf(map, key) { return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : String(key); }
  function lowerFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }
  // The keys of a map in the order of a label table, then the unknown ones in their own order.
  function ordered(keys, labels) {
    var known = Object.keys(labels).filter(function (k) { return keys.indexOf(k) !== -1; });
    return known.concat(keys.filter(function (k) { return !Object.prototype.hasOwnProperty.call(labels, k); }));
  }
  function mean(values) {
    var xs = values.filter(isNum);
    return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : null;
  }

  /* ---------- DOM ---------- */

  function $(id) { return document.getElementById(id); }
  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = content;
    return node;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return parent;
  }
  function fit() { if (window.SCLogin && window.SCLogin.fitWindow) window.SCLogin.fitWindow(); }

  // The board's data-org for a handle (see the header comment).
  function orgHash(org) {
    var login = window.SCLogin;
    if (!login || !login.sha256hex) return Promise.resolve(null);
    return login.sha256hex(String(org)).then(function (hex) { return hex.slice(0, ORG_HASH); },
                                              function () { return null; });
  }

  /* ---------- fetching ---------- */

  function retryDelay() { return typeof window.__scRetryMs === 'number' ? window.__scRetryMs : RETRY_MS; }
  function mockMode() { var login = window.SCLogin; return !!(login && login.isMock && login.isMock()); }
  function apiBase() { var login = window.SCLogin; return (login && login.config && login.config.api) || null; }

  // One GET as {status, body} (the JSON object, or null); rejects only when there is no answer at all.
  function getJSON(url, init) {
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        return { status: res.status, body: isObj(body) ? body : null };
      });
    });
  }
  function answered(r) {
    return new Error('results server answered ' + r.status + (r.body && r.body.error ? ' (' + r.body.error + ')' : ''));
  }

  // The index: {runs, latest, pending}, or {noBoard: true} before any board is published. Anything else rejects.
  function loadRuns() {
    var mock = mockMode(), api = apiBase();
    if (!mock && !api) return Promise.reject(new Error('no results API configured'));
    return getJSON(mock ? 'mock/runs.json' : api + '/runs', { cache: mock ? 'no-cache' : 'no-store' }).then(function (r) {
      if (r.status === 503 && r.body && r.body.error === 'no_board') return { noBoard: true };
      if (r.status !== 200 || !r.body) throw answered(r);
      var runs = list(r.body.runs).filter(function (run) { return isObj(run) && typeof run.name === 'string'; });
      if (!runs.length) throw new Error('the index lists no runs');
      var names = runs.map(function (run) { return run.name; });
      var pending = isObj(r.body.pending) && typeof r.body.pending.name === 'string' && names.indexOf(r.body.pending.name) === -1
        ? r.body.pending : null;
      return { runs: runs, latest: names.indexOf(r.body.latest) !== -1 ? r.body.latest : names[names.length - 1], pending: pending };
    });
  }

  // A week's board: {run, rows}.
  function loadBoard(run) {
    var mock = mockMode(), api = apiBase();
    var url = mock ? 'mock/board.' + encodeURIComponent(run) + '.json' : api + '/board/' + encodeURIComponent(run);
    return getJSON(url, { cache: mock ? 'no-cache' : 'no-store' }).then(function (r) {
      if (r.status !== 200 || !r.body || !Array.isArray(r.body.rows)) throw answered(r);
      return r.body;
    });
  }

  // The viewer's private view of a week: {status: 200, body}, {status: 401} (the token is not accepted), {status: 404}
  // (a week the API has nothing for), or {status: 503} (no board published). In mock mode a missing per-run fixture
  // is the 404, and a session without a fixture kind reads nothing.
  function loadView(session, run) {
    if (mockMode()) {
      var kind = session.mock;
      if (!kind) return Promise.resolve({ status: 404 });
      var file = run === state.latest ? kind : kind + '.' + run;
      return getJSON('mock/' + encodeURIComponent(file) + '.json', { cache: 'no-cache' }).then(function (r) {
        if (r.status === 404) return { status: 404 };
        if (r.status !== 200 || !r.body) throw answered(r);
        return { status: 200, body: r.body };
      });
    }
    var api = apiBase();
    if (!api) return Promise.reject(new Error('no results API configured'));
    return getJSON(api + '/me?run=' + encodeURIComponent(run),
                   { cache: 'no-store', headers: { Authorization: 'Bearer ' + session.accessToken } }).then(function (r) {
      if (r.status === 401 || r.status === 404) return { status: r.status };
      if (r.status === 503 && r.body && r.body.error === 'no_board') return { status: 503 };
      if (r.status !== 200 || !r.body) throw answered(r);
      return { status: 200, body: r.body };
    });
  }

  // One more try after RETRY_MS when a request fails (the server waking up), unless the caller has moved on.
  function withRetry(request, stale) {
    return request().catch(function (err) {
      if (stale()) throw err;
      console.warn('The results server did not answer; trying once more:', err);   // warn: the check counts errors
      return new Promise(function (resolve) { setTimeout(resolve, retryDelay()); }).then(function () {
        if (stale()) throw err;
        return request();
      });
    });
  }

  /* ---------- state ---------- */

  var state = {
    runs: null, latest: null,   // the index
    pending: null,              // ... and its week being evaluated, if any
    run: null,                  // the week on show
    boards: {}, views: {},      // by run name; the views are the current session's
    session: null, roles: null, // set by render(), cleared by clear()
    busy: false                 // a board is being fetched: the arrows wait
  };
  var generation = 0;         // bumped by render() and clear(): a private view overtaken by either draws nothing
  var switches = 0;           // bumped by each week switch: a board or view that arrives late draws nothing
  var boardState = 'loading'; // 'shown' once a board is up; 'failed' or 'none' (nothing published) when there is none
  var settled = false;        // the first board is in, or its load has failed for good (ready has resolved)
  var settle, ready = new Promise(function (resolve) { settle = function () { settled = true; resolve(); }; });

  /* ---------- the board ---------- */

  // A line in place of the table: loading, nothing published, or the failure with its "try again".
  function note(text, again) {
    var pub = $('lb-public'), p = el('p', 'soft', text);
    p.id = 'lb-board-note';
    if (again) {
      var link = el('a', null, 'try again');
      link.href = '#';
      link.addEventListener('click', function (e) { e.preventDefault(); again(); });
      add(p, link, ' in a minute.');
    }
    pub.textContent = '';
    add(pub, p);
  }

  // The picker's sequence: the published weeks, then the week being evaluated when there is one.
  function sequence() { return list(state.runs).concat(state.pending ? [state.pending] : []); }
  function runIndex(name) { return sequence().map(function (r) { return r.name; }).indexOf(name); }
  function isPending(name) { return !!(state.pending && state.pending.name === name); }
  function pulled(run) { return run.pulled !== false; }   // the pending block says whether its pull has happened
  function runBlock(name) {   // a week's run block: its board's, or the index's pending block
    var board = state.boards[name];
    return board && isObj(board.run) ? board.run : (isPending(name) ? state.pending : null);
  }
  function runLabel(name) {
    var entry = sequence()[runIndex(name)], block = runBlock(name);
    var label = (entry && entry.label) || (block && block.label) || name;
    return cap(String(label), LABEL_MAX);
  }

  // The board's table shell, in the competition page's own markup, so its styles apply unchanged.
  function tableShell() {
    var wrap = el('div', 'leaderboard'), table = el('table'), head = el('tr'), body = el('tbody');
    [['Rank', 'lb-rank'], ['Team', 'lb-team'], ['Overall score', 'lb-score'], ['delta', 'lb-score'],
     ['r_side', 'lb-score'], ['r_guard', 'lb-score']].forEach(function (h) {
      var th = el('th', h[1], h[0]);
      th.scope = 'col';
      add(head, th);
    });
    add(wrap, add(table, add(el('thead'), head), body));
    return { wrap: wrap, body: body };
  }
  function showTable(shell) {
    var pub = $('lb-public');
    pub.textContent = '';
    add(pub, shell.wrap);
  }
  function hideCaption() { var caption = $('lb-caption'); if (caption) caption.hidden = true; }

  // A published week's table.
  function renderBoard(board) {
    var shell = tableShell();
    list(board.rows).filter(isObj).forEach(function (r) {
      var row = el('tr'), baseline = r.kind === 'baseline';
      if (baseline) row.className = 'lb-baseline';
      else if (typeof r.org_hash === 'string' && r.org_hash) row.setAttribute('data-org', r.org_hash);
      add(row, el('td', 'lb-rank', !baseline && isNum(r.rank) ? pad(r.rank) : '–'),
          el('td', 'lb-team', cap(r.team === null || r.team === undefined ? '' : r.team, LABEL_MAX)),
          el('td', 'lb-score', fmtSigned(r.S, 3)), el('td', 'lb-score', fmtSigned(r.delta, 3)),
          el('td', 'lb-score', fmtAbs(r.r_side, 3)), el('td', 'lb-score', fmtAbs(r.r_guard, 3)));
      add(shell.body, row);
    });
    showTable(shell);
    hideCaption();
  }

  // "← Week n →": the arrows step through the published weeks and then the week being evaluated, and wait at the ends
  // and while a board is being fetched.
  function renderPicker() {
    var picker = $('lb-weeks');
    if (!picker) return;
    var i = runIndex(state.run), n = sequence().length;
    if (i === -1) { picker.hidden = true; return; }
    $('lb-week').textContent = runLabel(state.run);
    $('lb-earlier').disabled = state.busy || i === 0;
    $('lb-later').disabled = state.busy || i === n - 1;
    picker.hidden = false;
  }

  function go(step) {
    var i = runIndex(state.run) + step;
    if (state.busy || i < 0 || i >= sequence().length) return;
    showRun(sequence()[i].name);
  }

  // Switch to a week: its board (fetched once), then the private view of it, if anyone is signed in. The week being
  // evaluated has no board: its skeleton renders at once and the private view fills it in.
  function showRun(name) {
    var mine = ++switches;
    function stale() { return mine !== switches; }
    clearDecoration();
    if (settled && state.session) $('lb-private-content').textContent = '';   // the previous week's lines go with its board
    state.run = name;
    if (isPending(name)) {
      state.busy = false;
      boardState = 'shown';
      renderPicker();
      var pending = state.pending;
      return (pulled(pending) ? renderPending(pending, null) : renderUnpulled(pending, stale)).then(function () {
        if (stale()) return;
        settle();
        fit();
        if (pulled(pending)) return showView();   // before the pull the panel is complete: nothing to fetch
      });
    }
    state.busy = true;
    boardState = 'loading';
    renderPicker();
    var cached = state.boards[name];
    if (!cached) note('Loading the leaderboard…');
    var load = cached ? Promise.resolve(cached) : withRetry(function () { return loadBoard(name); }, stale);
    return load.then(function (board) {
      if (stale()) return;
      state.boards[name] = board;
      renderBoard(board);
      boardState = 'shown';
      state.busy = false;
      renderPicker();
      settle();
      fit();
      return showView();
    }, function (err) {
      if (stale()) return;
      console.warn('Could not load the leaderboard:', err);
      note("Couldn't load the leaderboard (the results server may be waking up) — ", function () { showRun(name); });
      hideCaption();
      boardState = 'failed';
      state.busy = false;
      renderPicker();   // the other weeks stay reachable
      settle();
      fit();
      return showView();
    });
  }

  // The index, then the latest week.
  function loadAll() {
    var mine = ++switches;
    function stale() { return mine !== switches; }
    boardState = 'loading';
    note('Loading the leaderboard…');
    $('lb-weeks').hidden = true;
    hideCaption();
    return withRetry(loadRuns, stale).then(function (index) {
      if (stale()) return;
      if (index.noBoard) {
        note('No results have been published yet.');
        boardState = 'none';
        settle();
        fit();
        return showView();
      }
      state.runs = index.runs;
      state.latest = index.latest;
      state.pending = index.pending;
      return showRun(index.latest);
    }, function (err) {
      if (stale()) return;
      console.warn('Could not load the leaderboard:', err);
      note("Couldn't load the leaderboard (the results server may be waking up) — ", loadAll);
      boardState = 'failed';
      settle();
      fit();
      return showView();
    });
  }

  /* ---------- the private view ---------- */

  function supported(team) {
    return isObj(team) && SCHEMAS.indexOf(team.schema) !== -1 && isObj(team.entry) && isObj(team.run) && typeof team.org === 'string';
  }
  function nameOf(team) { return cap(team.team || team.org, LABEL_MAX); }   // the org's display name is the team's own text
  function modelsOf(team) {
    var models = team.run.models;
    return Array.isArray(models) ? models : Object.keys((isObj(team.board) && team.board.models) || {});
  }
  function modelEntry(team, model) {
    var models = isObj(team.board) && isObj(team.board.models) ? team.board.models : {};
    return isObj(models[model]) ? models[model] : {};
  }

  // A week the API has no file for: a participant has no entry (in mock mode, one block per team organization, as a
  // fixture for a week without one would say); an organizer gets an empty status.
  function emptyView(run) {
    var block = runBlock(run), roles = state.roles || {};
    if (roles.organizer) return { role: 'organizer', run: block, board: null, teams: {}, pull: null, progress: null, failures: null };
    return { role: 'participant', run: block, teams: [],
             missing: mockMode() ? list(roles.teams).map(function (t) { return t.handle; }) : [] };
  }

  // The private view of the week on show, for the current session: fetched once per week, then the board is decorated.
  function showView() {
    var s = state.session, run = state.run, content = $('lb-private-content');
    if (!s || !content) return Promise.resolve();
    if (boardState !== 'shown') { content.textContent = ''; return Promise.resolve(); }   // nothing to decorate; the board's note says why
    var gen = generation, mine = switches, pending = isPending(run);
    function stale() { return gen !== generation || mine !== switches; }
    if (pending && !pulled(state.pending)) return renderUnpulled(state.pending, stale);   // nothing to fetch before the pull
    var cached = pending ? null : state.views[run];   // the week being evaluated is fetched on every visit: its progress changes
    if (!cached) { content.textContent = ''; add(content, el('p', 'soft', 'Loading your results…')); }
    var load = cached ? Promise.resolve(cached) : withRetry(function () { return loadView(s, run); }, stale);
    return load.then(function (result) {
      if (stale()) return;
      if (result.status === 401) {
        window.SCLogin.signOut('Your sign-in expired — sign in again.');
        return;
      }
      if (result.status === 503) {
        content.textContent = '';
        add(content, el('p', null, 'No results have been published yet.'));
        fit();
        return;
      }
      if (!pending) state.views[run] = result;
      var view = result.status === 404 ? emptyView(run) : result.body;
      return (pending ? renderPending(state.pending, view, stale) : decorate(view, stale)).catch(function (err) {
        console.error('Could not show the private results:', err);   // a file this page can't read: say so, rather than stay on "Loading…"
        if (stale()) return;
        content.textContent = '';
        add(content, el('p', null, 'This page needs an update to show your results.'));
        fit();
      });
    }, function (err) {
      if (stale()) return;
      console.warn('Could not load the private results:', err);
      content.textContent = '';
      var again = el('a', null, 'try again');
      again.href = '#';
      again.addEventListener('click', function (e) { e.preventDefault(); showView(); });
      add(content, add(el('p'), "Couldn't load your results (the results server may be waking up) — ", again, ' in a minute.'));
      fit();
    });
  }

  // A drawer per team file: in its row, or as a block under the table; then a block per organization without a file
  // (participant) and per file this page can't read. Nothing describes the entries above the board.
  function decorate(view, stale) {
    var content = $('lb-private-content'), label = runLabel(state.run), many = view.role === 'organizer';
    var items = [], missing = [];   // {team, org}, in the order shown
    content.textContent = '';
    if (many) {
      var files = isObj(view.teams) ? view.teams : {};
      Object.keys(files).forEach(function (org) { items.push({ team: files[org], org: org }); });
    } else {
      var all = list(view.teams);
      all.forEach(function (t) { items.push({ team: t, org: isObj(t) && typeof t.org === 'string' ? t.org : null }); });
      missing = list(view.missing).filter(function (org) { return typeof org === 'string'; });
      if (!all.length && !missing.length) add(content, el('p', null, 'No results for your organizations in ' + label + '.'));
    }
    return Promise.all(items.map(function (it) { return supported(it.team) ? orgHash(it.org) : Promise.resolve(null); })).then(function (hashes) {
      if (stale()) return;
      return runningSection(view).then(function () {
      items.forEach(function (it, i) { if (supported(it.team)) attachDetail(it.team, it.org, hashes[i]); });
      missing.forEach(function (org) {
        attachNote(org, org, 'No entry for this organization in ' + label + ". The next intake is on the competition page's countdown.");
      });
      items.forEach(function (it) {
        if (supported(it.team)) return;
        var org = it.org || 'one of your teams';
        attachNote(it.org, org, 'This page needs an update to show the results for ' + org + '.');
      });
      fit();
      });
    });
  }

  // The teams still being evaluated, as a divided section at the top of the latest published week's table (see the
  // header comment). Nothing is attached to these rows: no data-org (a team file never finds one), no drawer.
  function runningSection(view) {
    var entries = list(view.running).filter(function (e) { return isObj(e) && typeof e.team === 'string'; });
    var body = document.querySelector('#lb-public .leaderboard > table > tbody');
    if (!entries.length || !body || state.run !== state.latest || isPending(state.run)) return Promise.resolve();
    var teams = state.roles ? list(state.roles.teams) : [];
    return Promise.all(teams.map(function (t) { return isObj(t) && typeof t.handle === 'string' ? orgHash(t.handle) : null; })).then(function (mine) {
      if (document.querySelector('#lb-public tr.lb-running')) return;
      var head = el('tr', 'lb-running lb-running-head'), td = el('td', null, 'Still being evaluated');
      td.colSpan = 6;
      var rows = [add(head, td)];
      entries.forEach(function (e) {
        var row = el('tr', 'lb-running'), cell = el('td', 'lb-team', cap(e.team, LABEL_MAX));
        if (typeof e.org_hash === 'string' && e.org_hash && mine.indexOf(e.org_hash) !== -1) row.classList.add('lb-mine');
        var states = isObj(e.evaluation) ? Object.keys(e.evaluation).map(function (m) {
          return shortModel(m) + ': ' + labelOf(EVAL_LABELS, e.evaluation[m]);
        }) : [];
        if (states.length) {
          var said = cap(states.join(', '), MESSAGE_MAX);
          cell.title = said;
          add(cell, el('span', 'visually-hidden', ' ' + said));
        }
        add(row, el('td', 'lb-rank', '--'), cell);
        for (var i = 0; i < 4; i++) add(row, el('td', 'lb-score', '--'));
        rows.push(row);
      });
      rows[rows.length - 1].classList.add('lb-running-last');
      rows.reverse().forEach(function (row) { body.insertBefore(row, body.firstChild); });
    });
  }

  /* ---------- the drawer ---------- */

  function section(label, content, boxed) {
    return add(el('div', boxed ? 'lb-sec lb-boxed' : 'lb-sec'), el('span', 'lb-k', label), content);
  }

  // Per model, under the board's own columns: the name, the 95% interval, S, delta, r_side, r_guard; then the overall.
  function resultsTable(team) {
    var board = team.board, table = el('table', 'lb-models'), head = el('tr');
    [['results', 'lb-rank'], ['model', null], ['95% CI', 'lb-ci'], ['S', 'lb-score'], ['delta', 'lb-score'],
     ['r_side', 'lb-score'], ['r_guard', 'lb-score']].forEach(function (h) {
      var th = el('th', h[1], h[0]);
      th.scope = 'col';
      add(head, th);
    });
    var body = el('tbody');
    modelsOf(team).forEach(function (m) {
      var entry = modelEntry(team, m), cell = add(el('td', 'lb-model-cell'), el('span', 'lb-model', shortModel(m)));
      if (isObj(entry.unscored)) add(cell, el('span', 'lb-unscored', ' not scored'));
      add(body, add(el('tr'), el('td', 'lb-rank'), cell, el('td', 'lb-ci', interval(entry.ci)),
                    el('td', 'lb-score', fmtSigned(entry.S, 3)), el('td', 'lb-score', fmtSigned(entry.delta, 3)),
                    el('td', 'lb-score', fmtAbs(entry.r_side, 3)), el('td', 'lb-score', fmtAbs(entry.r_guard, 3))));
    });
    add(body, add(el('tr', 'lb-overall'), el('td', 'lb-rank'), el('td', 'lb-model-cell', 'overall'), el('td', 'lb-ci', interval(board.ci)),
                  el('td', 'lb-score', fmtSigned(board.S, 3)), el('td', 'lb-score'), el('td', 'lb-score'), el('td', 'lb-score')));
    return add(table, add(el('thead'), head), body);
  }

  // A group of the breakdown: a mono heading, then label/value rows (the dishonesty values say the per-model g in a title).
  function group(heading, rows) {
    var dl = el('dl');
    rows.forEach(function (r) {
      var dd = el('dd', null, r.value);
      if (r.said) { dd.title = r.said; add(dd, el('span', 'visually-hidden', ' ' + r.said)); }
      add(dl, add(el('div', 'lb-row'), el('dt', null, r.label), dd));
    });
    return add(el('div', 'lb-group'), el('h3', null, heading), dl);
  }
  function meanRows(team, field, labels) {   // the mean over the models, per category or kind
    var values = {};
    modelsOf(team).forEach(function (m) {
      var groups = modelEntry(team, m)[field];
      if (isObj(groups)) Object.keys(groups).forEach(function (k) { (values[k] = values[k] || []).push(groups[k]); });
    });
    return ordered(Object.keys(values), labels).map(function (k) { return { label: labelOf(labels, k), value: fmtAbs(mean(values[k]), 2) }; });
  }
  function breakdown(team) {
    var board = team.board, families = isObj(board.families) ? board.families : {}, models = modelsOf(team);
    var groups = el('div', 'lb-groups'), keys = ordered(Object.keys(families), FAMILY_LABELS);
    if (keys.length) {
      add(groups, group('dishonesty (g per family)', keys.map(function (key) {
        // schema 3: in_delta false is a family with no target cell this week (g null); a file without in_delta counts it in
        if (isObj(families[key]) && families[key].in_delta === false) {
          return { label: labelOf(FAMILY_LABELS, key), value: '—', said: 'Not scored this week: this family has no target cell in this week’s delta.' };
        }
        var said = 'g is the improvement over the unsteered model, per model: ' + models.map(function (m) {
          var f = modelEntry(team, m).families, e = isObj(f) && isObj(f[key]) ? f[key] : null;
          return shortModel(m) + ' ' + (e && e.in_delta === false ? 'not scored' : fmtSigned(e ? e.g : null, 2));
        }).join(', ');
        return { label: labelOf(FAMILY_LABELS, key), value: fmtSigned(isObj(families[key]) ? families[key].g : null, 2), said: said };
      })));
    }
    var side = meanRows(team, 'side_effects', CATEGORY_LABELS), guards = meanRows(team, 'guards', KIND_LABELS);
    if (side.length) add(groups, group('side effects (regression)', side));
    if (guards.length) add(groups, group('guards (regression)', guards));
    return groups.childNodes.length ? section('breakdown', groups, false) : null;
  }

  // The record: the pull and intake lines as the organizers' console shows them, then the run's diagnostics per model.
  function line(key, text) {
    return add(el('div', 'lb-line'), el('span', 'lb-key', typeof key === 'string' ? key : ''),
               el('span', 'lb-text', cap(String(text), MESSAGE_MAX)));
  }
  function diagnostics(team, m) {
    var e = modelEntry(team, m), name = shortModel(m);
    if (isObj(e.unscored)) return name + '  not scored: ' + labelOf(REASON_LABELS, e.unscored.reason || 'unscored');
    var flags = list(e.flags).map(String), judge = isObj(e.judge) ? e.judge : {};
    var parts = [name,
      'declines ' + (isObj(e.declines) ? fmtPct(e.declines.arm) + ' (reference ' + fmtPct(e.declines.reference) + ')' : '— (reference —)'),
      'truncated ' + (isObj(e.truncated) ? fmtPct(e.truncated.arm) + ' (' + fmtPct(e.truncated.reference) + ')' : '— (—)') +
        (flags.indexOf('truncation') !== -1 ? ', above the reference' : '')];
    if (isNum(judge.failed) && judge.failed > 0) parts.push('judge failures ' + judge.failed);
    if (isNum(judge.refused) && judge.refused > 0) parts.push('judge refusals ' + judge.refused);
    flags.forEach(function (f) { if (f !== 'truncation') parts.push(lowerFirst(labelOf(FLAG_LABELS, f))); });
    return parts.join('  ');
  }
  function recordSection(team) {
    var box = el('div', 'lb-record');
    list(team.entry.record).forEach(function (pair) {
      if (Array.isArray(pair) && pair.length >= 2) add(box, line(pair[0], pair[1]));
    });
    if (isObj(team.board) && isObj(team.board.models)) {
      modelsOf(team).forEach(function (m, i) { add(box, line(i ? '' : 'run', diagnostics(team, m))); });
    }
    if (!box.childNodes.length) add(box, line('', '—'));
    return section('record', box, true);
  }

  // The method card as the team submitted it: the file's text, nothing rendered.
  function cardSection(team) {
    var card = team.entry.method_card;
    if (!isObj(card) || typeof card.text !== 'string') return null;
    var box = el('div', 'lb-card', card.text);
    if (card.truncated === true) add(box, el('span', 'lb-cut', '[the card is longer; it was cut here]'));
    return section('method card', box, true);
  }

  function drawer(team) {
    var d = el('div', 'lb-drawer'), board = isObj(team.board) ? team.board : null;
    if (board && isObj(board.models)) add(d, resultsTable(team));
    if (board) add(d, breakdown(team));
    return add(d, recordSection(team), cardSection(team));
  }

  /* ---------- the week being evaluated ---------- */

  // A pending file: a team file's entry (schema 2's or later), the evaluation's progress per model, and no board.
  function supportedPending(team) {
    return isObj(team) && (team.schema === 1 || SCHEMAS.indexOf(team.schema) !== -1) && isObj(team.entry) && typeof team.org === 'string';
  }
  function spinner() {   // the status wheel, turning (.lb-spin)
    var s = el('span', 'lb-spin');
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', 'being evaluated');
    return s;
  }
  // "Week 3 is being evaluated: 15 submissions were pulled at the intake, Oct 13, 12:41 UTC, and checked; the evaluation
  // is running. Results appear here …": the run's phase says how far along it is ("upcoming" never gets here: before the
  // pull is renderUnpulled's). Without a phase, or with one this script doesn't know, the sentence ends after the pull.
  function pendingCaption(run) {
    var caption = $('lb-caption');
    if (!caption) return;
    var n = isNum(run.n_pulled) ? run.n_pulled : 0, when = run.pull_finished ? fmtUTC(run.pull_finished) : null;
    var checked = run.intake_done === true ? ', and checked' : '';   // the API can report evaluating before every check is published
    var tails = {
      pulled: ', and ' + (n === 1 ? 'is' : 'are') + ' being checked.',
      checked: checked + '; the evaluation is running.',
      evaluating: checked + '; the evaluation is running.',
      finishing: checked + '; the evaluation runs have finished and the results are being scored.'
    };
    var tail = typeof run.phase === 'string' && Object.prototype.hasOwnProperty.call(tails, run.phase) ? tails[run.phase] : '.';
    caption.textContent = runLabel(run.name) + ' is being evaluated: ' + plural(n, 'submission') + (n === 1 ? ' was' : ' were') +
      ' pulled at the intake' + (when ? ', ' + when : '') + tail + ' Results appear here when the board is published.';
    caption.hidden = false;
  }

  // Before the pull: a signed-in participant's team organizations as rows with the spinner and nothing to open; for
  // anyone else (signed out, no team, an organizer) one line. Nothing is fetched: there is nothing to fetch yet.
  function renderUnpulled(run, stale) {
    var roles = state.session && state.roles ? state.roles : null;
    var teams = roles && !roles.organizer ? list(roles.teams).filter(function (t) { return isObj(t) && typeof t.handle === 'string'; }) : [];
    return Promise.all(teams.map(function (t) { return orgHash(t.handle); })).then(function (hashes) {
      if (stale && stale()) return;
      clearDecoration();
      var content = $('lb-private-content'), label = runLabel(run.name);
      if (content) content.textContent = '';
      if (!teams.length) {
        note(label + ' has not been pulled yet.');
      } else {
        var shell = tableShell();
        teams.forEach(function (t, i) {
          var row = el('tr');
          if (hashes[i]) row.setAttribute('data-org', hashes[i]);
          add(shell.body, add(row, el('td', 'lb-rank'), el('td', 'lb-team', cap(t.name || t.handle, LABEL_MAX)),
                              add(el('td', 'lb-score'), spinner()), el('td', 'lb-score'), el('td', 'lb-score'), el('td', 'lb-score')));
        });
        showTable(shell);
      }
      var caption = $('lb-caption');
      if (caption) {
        caption.textContent = label + " has not been pulled yet. Submissions are pulled at the next intake, on the competition page's " +
          'countdown; results appear here when the board is published.';
        caption.hidden = false;
      }
      fit();
    });
  }

  // The pending week: signed in, the board's shape with the viewer's own rows (an organizer's: every pulled team) and
  // the spinner where the score will be, else (signed out, before the view answers, or nothing pulled) one line; then
  // a block for a team that was not pulled, for an organization without an entry, and for a file this page can't read.
  function renderPending(run, view, stale) {
    var many = !!(view && view.role === 'organizer'), items = [], missing = [];
    if (view && many) {
      var files = isObj(view.teams) ? view.teams : {};
      Object.keys(files).forEach(function (org) { items.push({ team: files[org], org: org }); });
    } else if (view) {
      list(view.teams).forEach(function (t) { items.push({ team: t, org: isObj(t) && typeof t.org === 'string' ? t.org : null }); });
      missing = list(view.missing).filter(function (org) { return typeof org === 'string'; });
    }
    var pulled = items.filter(function (it) { return supportedPending(it.team) && it.team.entry.status === 'pulled'; });
    return Promise.all(pulled.map(function (it) { return orgHash(it.org); })).then(function (hashes) {
      if (stale && stale()) return;
      var shell = tableShell(), label = runLabel(run.name);
      pulled.forEach(function (it, i) {
        var row = el('tr');
        if (hashes[i]) row.setAttribute('data-org', hashes[i]);
        add(shell.body, add(row, el('td', 'lb-rank'), el('td', 'lb-team', nameOf(it.team)), add(el('td', 'lb-score'), spinner()),
                            el('td', 'lb-score'), el('td', 'lb-score'), el('td', 'lb-score')));
      });
      clearDecoration();   // the blocks of the table this one replaces
      if (pulled.length) showTable(shell); else note(label + ' is being evaluated.');
      // the line from the view's run block when it has one for this week: it is fetched on every visit, the index's at page load
      pendingCaption(view && isObj(view.run) && view.run.name === run.name ? view.run : run);
      if (view) {
        var content = $('lb-private-content');
        content.textContent = '';
        if (!many && !items.length && !missing.length) add(content, el('p', null, 'No results for your organizations in ' + label + '.'));
      }
      pulled.forEach(function (it, i) { attachDetail(it.team, it.org, hashes[i], pendingDrawer); });
      items.forEach(function (it) {
        if (supportedPending(it.team) && it.team.entry.status !== 'pulled') attachDetail(it.team, it.org, null, pendingDrawer);
      });
      missing.forEach(function (org) {
        attachNote(org, org, 'No entry for this organization in ' + label + ". The next intake is on the competition page's countdown.");
      });
      items.forEach(function (it) {
        if (supportedPending(it.team)) return;
        var org = it.org || 'one of your teams';
        attachNote(it.org, org, 'This page needs an update to show the results for ' + org + '.');
      });
      fit();
    });
  }

  // Whether the pending week's drawers show each model's state (see the header comment): an organizer's pinned choice
  // in this browser, else the site's. Anything but 'detailed' is the coarse view.
  function detailedProgress() {
    var login = window.SCLogin || {}, organizer = !!(state.roles && state.roles.organizer);
    var own = organizer && login.progressView ? login.progressView() : null;
    return (own || (login.config && login.config.pendingProgress)) === 'detailed';
  }

  // The drawer on the pending week: the evaluation's progress per model (for a pulled entry), the record, the card.
  // Coarse: every model reads in progress with the wheel. Detailed: an organizer sees the raw code per model, a
  // participant completed, error, or else in progress with the wheel. A submission that did not pass the intake checks
  // gets one line instead of the table, except in an organizer's detailed view.
  function progressSection(team) {
    var detailed = detailedProgress(), raw = detailed && !!(state.roles && state.roles.organizer), intake = team.entry.intake;
    if (!raw && isObj(intake) && intake.ok === false) {
      return section('progress', el('p', 'soft', 'Not evaluated: the submission did not pass the intake checks (see the record).'), false);
    }
    var table = el('table', 'lb-progress'), body = el('tbody'), progress = isObj(team.evaluation) ? team.evaluation : {};
    var models = isObj(team.run) && Array.isArray(team.run.models) ? team.run.models : list(state.pending && state.pending.models);
    models.forEach(function (m) {
      var cell = el('td'), code = progress[m];
      if (raw) {
        if (code === 'in_progress') add(cell, spinner());
        add(cell, typeof code === 'string' ? labelOf(EVAL_LABELS, code) : '—');
      } else if (detailed && typeof code === 'string' && Object.prototype.hasOwnProperty.call(PARTICIPANT_EVAL_LABELS, code)) {
        add(cell, PARTICIPANT_EVAL_LABELS[code]);
      } else {
        add(cell, spinner(), EVAL_LABELS.in_progress);
      }
      add(body, add(el('tr'), el('td', null, shortModel(m)), cell));
    });
    return section('progress', add(table, body), false);
  }
  function pendingDrawer(team) {
    var d = el('div', 'lb-drawer');
    if (team.entry.status === 'pulled') add(d, progressSection(team));
    return add(d, recordSection(team), cardSection(team));
  }

  /* ---------- placing the drawer: in the team's row, or as a block under the table ---------- */

  // A team's row: by data-org, else by the exact team name on a row without data-org. A row is claimed once.
  function findRow(team, hash) {
    var rows = Array.prototype.slice.call(document.querySelectorAll('#lb-public .leaderboard > table > tbody > tr')).filter(function (row) {
      return !row.classList.contains('lb-baseline') && !row.classList.contains('lb-running') && !row.classList.contains('lb-detail') && !row.classList.contains('lb-expandable');
    });
    var byHash = hash && rows.filter(function (row) { return row.getAttribute('data-org') === hash; })[0];
    if (byHash) return byHash;
    return (team.team && rows.filter(function (row) {
      var cell = row.querySelector('.lb-team');
      return !row.hasAttribute('data-org') && cell && cell.textContent.trim() === team.team;
    })[0]) || null;
  }

  function placeBlock(block) {   // under the table, after the blocks already there
    var after = $('lb-public');
    while (after.nextElementSibling && after.nextElementSibling.classList.contains('lb-detail-standalone')) after = after.nextElementSibling;
    after.parentNode.insertBefore(block, after.nextSibling);
  }

  function attachDetail(team, org, hash, build) {   // build: the drawer for a published week (default) or the pending one
    var id = 'lb-detail-' + org, make = build || drawer;
    if ($(id)) return;
    var row = findRow(team, hash), cell = row && row.querySelector('.lb-team');
    if (!cell) {   // not in this week's table: the same drawer as a block under it
      var block = add(el('div', 'lb-detail-standalone'), el('p', 'lb-standalone-name', nameOf(team)), make(team));
      block.id = id;
      placeBlock(block);
      return;
    }
    // The name becomes the button that carries the ARIA state; the row itself is the click target (see onBoardClick)
    var button = el('button', 'lb-expand', cell.textContent.trim());
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', id);
    cell.textContent = '';
    cell.appendChild(button);
    row.classList.add('lb-expandable');
    var td = el('td');
    td.colSpan = row.cells.length || 6;
    var detail = add(el('tr', 'lb-detail'), add(td, make(team)));
    detail.id = id;
    detail.hidden = true;
    row.parentNode.insertBefore(detail, row.nextSibling);
  }

  // A block for an organization without a team file, or with one this page can't read: its name and a line.
  function attachNote(org, name, text) {
    var id = org ? 'lb-detail-' + org : null;
    if (id && $(id)) return;
    var block = add(el('div', 'lb-detail-standalone'), el('p', 'lb-standalone-name', cap(name, LABEL_MAX)), el('p', 'lb-standalone-note', text));
    if (id) block.id = id;
    placeBlock(block);
  }

  // One listener on the board for every expandable row: a click anywhere in the row toggles its drawer, and Enter
  // or Space on the name button arrives here once, as the button's native click.
  function onBoardClick(e) {
    var row = e.target && e.target.closest ? e.target.closest('tr.lb-expandable') : null;
    if (row) toggle(row, !row.classList.contains('is-open'));
  }
  function toggle(row, open) {
    var button = row.querySelector('.lb-expand'), detail = button && $(button.getAttribute('aria-controls'));
    if (!detail) return;
    if (open && !(state.roles && state.roles.organizer)) closeDrawers();   // a participant keeps one drawer open at a time
    row.classList.toggle('is-open', open);
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    detail.hidden = !open;
    markOpen();
    fit();   // the window grows with the drawer, up to the screen's height
    rekickSpinners();
  }
  function closeDrawers() {
    document.querySelectorAll('#lb-public tr.lb-expandable.is-open').forEach(function (row) {
      var button = row.querySelector('.lb-expand'), detail = button && $(button.getAttribute('aria-controls'));
      row.classList.remove('is-open');
      if (button) button.setAttribute('aria-expanded', 'false');
      if (detail) detail.hidden = true;
    });
    markOpen();
  }
  function markOpen() {   // while any drawer is open the rest of the board recedes
    var board = document.querySelector('#lb-public .leaderboard');
    if (board) board.classList.toggle('has-open', !!board.querySelector('tr.is-open'));
  }

  // The status wheels, started afresh: a new element starts a new animation on a new layer. Called after a drawer
  // toggle and after the window has resized (the pop-up resizes itself on every fit()); some browsers stop painting a
  // turning wheel when the layout around it changes, while its animation still reports running. Under reduced motion
  // the wheel has no animation and the clone is the same still dot.
  function rekickSpinners() {
    requestAnimationFrame(function () {
      document.querySelectorAll('#lb-public .lb-spin').forEach(function (s) { s.replaceWith(s.cloneNode(true)); });
    });
  }
  // One restart once the resizing has stopped, not one per event: dragging a window's edge fires resize continuously,
  // and a restart on each would hold every wheel at its starting angle for the whole drag.
  var resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rekickSpinners, RESIZE_SETTLE_MS);
  }

  // Take the private detail off the page: the drawers, the blocks, and the rows' expandable state.
  function clearDecoration() {
    document.querySelectorAll('.lb-detail, .lb-detail-standalone, #lb-public tr.lb-running').forEach(function (node) { node.parentNode.removeChild(node); });
    document.querySelectorAll('#lb-public tr.lb-expandable').forEach(function (row) {
      var button = row.querySelector('.lb-expand');
      if (button) button.parentNode.textContent = button.textContent;
      row.classList.remove('lb-expandable', 'is-open');
    });
    markOpen();
  }

  /* ---------- entry points ---------- */

  // Sign-out, or a sign-in overtaken by another: the private detail goes; the board and the picker stay (the pending
  // week's table goes back to the signed-out skeleton).
  function clear() {
    generation++;
    state.session = null;
    state.roles = null;
    state.views = {};
    clearDecoration();
    var content = $('lb-private-content');
    if (content) content.textContent = '';
    if (isPending(state.run) && boardState === 'shown') {
      if (pulled(state.pending)) renderPending(state.pending, null); else renderUnpulled(state.pending);
    }
  }

  function render(session, roles) {
    clear();
    state.session = session;
    state.roles = roles;
    var content = $('lb-private-content');
    if (content) add(content, el('p', 'soft', 'Loading your results…'));
    // Until the first board is in, the board's own flow shows the view once it lands (the session is set now)
    return settled ? showView() : ready;
  }

  function init() {
    if (!$('lb-public')) return;
    $('lb-earlier').addEventListener('click', function () { go(-1); });
    $('lb-later').addEventListener('click', function () { go(1); });
    $('lb-public').addEventListener('click', onBoardClick);
    window.addEventListener('resize', onResize);
    loadAll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.SCPrivateView = { render: render, clear: clear, boardReady: function () { return ready; } };
})();
