/* ============================================================
   The Steerability Challenge — private-view.js
   ------------------------------------------------------------
   The leaderboard pop-up's private view: what a signed-in team sees
   about its own submission, and what an organizer sees about every
   team. Loaded by leaderboard/ before hf-login.js, which calls
   SCPrivateView.render(session, roles, boardReady) once signed in
   and SCPrivateView.clear() on signing out.

   Data
     GET <CONFIG.api>/me with the session's bearer token returns the
     viewer's team files (one per team organization) or, for an
     organizer, every team file plus the run's status. A team file is
     made by the organizers' harness and contains only what a team may
     see about its own submission; this script renders what it gets.
     In mock mode (?mock=<kind> on localhost) it reads mock/<kind>.json.

   The team's row
     Each submission row of the public table carries data-org: the
     first 12 hex characters of the SHA-256 of the team's organization
     handle, so the page source doesn't list the handles. A team file
     finds its row by that hash, else by the exact team name on a row
     without data-org. A team with no row gets the same detail as a
     block under the table.

   Vocabulary
     The family, category, kind, reason and flag keys below, with the
     labels printed for them. An unknown key prints as the key itself.
     Every string from the API is inserted with textContent.
============================================================= */
(function () {
  'use strict';

  var SCHEMA = 1;              // the team-file contract this script reads
  var RETRY_MS = 20000;        // a results server waking from sleep gets one retry after this long
  var LABEL_MAX = 80;          // participant-authored labels and file names are cut to this many characters
  var MESSAGE_MAX = 300;       // ... and intake errors and warnings to this many
  var ORG_HASH = 12;           // hex characters of a handle's SHA-256 in the public table's data-org

  var FAMILY_LABELS = {
    instructed_deception: 'Instructed deception',
    incentives_and_sandbagging: 'Incentives & sandbagging',
    user_pressure: 'User pressure & sycophancy',
    fabrication: 'Fabrication',
    owning_up: 'Owning up',
    harm_motivated_denial: 'Harm-motivated denial'
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
    refusals: 'Refusal behaviour'
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
  var ENGINE_LABELS = { vllm: 'vLLM', huggingface: 'Hugging Face' };
  var ARROWS = { up: '▲', flat: '●', down: '▼' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ---------- formatting (shared with nothing else) ---------- */

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
  function fmtUTC(iso) {   // "Oct 6, 12:03 UTC"
    var d = parseTime(iso);
    return d ? MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC' : '—';
  }
  function fmtDay(iso) {   // a calendar date, e.g. "Oct 9"
    var d = parseTime(iso);
    return d ? MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() : '—';
  }
  // The intake a deadline closes, as the AoE (UTC-12) calendar day that ends at it, the way the
  // competition page's countdown names it: a 12:00 UTC deadline on Oct 6 is the intake of Oct 5 AoE.
  function fmtIntake(iso) {
    var d = parseTime(iso);
    if (!d) return null;
    d = new Date(d.getTime() - 12 * 3600 * 1000 - 1);
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear() + ' AoE';
  }
  function fmtBytes(n) {   // "1.2 GB", "3 KB"
    if (!isNum(n)) return '—';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return String(i && n < 10 ? Math.round(n * 10) / 10 : Math.round(n)) + ' ' + units[i];
  }
  function shortModel(ref) { return String(ref).split('/').pop(); }
  function shortCommit(commit, n) { return commit ? String(commit).slice(0, n) : '—'; }
  function cap(s, n) {   // by characters, not UTF-16 units, so nothing is cut in half
    var chars = Array.from(String(s));
    return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : chars.join('');
  }
  function labelOf(map, key) { return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : String(key); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
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
  function mono(value) { return el('span', 'lb-mono', value); }
  function kv(key, value) {   // one label/value row of the detail: a mono label, then text and nodes
    var v = el('span', 'lb-v');
    (Array.isArray(value) ? value : [value]).forEach(function (part) { add(v, part); });
    return add(el('div', 'lb-kv'), el('span', 'lb-k', key), v);
  }
  function fit() { if (window.SCLogin && window.SCLogin.fitWindow) window.SCLogin.fitWindow(); }

  // The public table's data-org for a handle (see the header comment).
  function orgHash(org) {
    var login = window.SCLogin;
    if (!login || !login.sha256hex) return Promise.resolve(null);
    return login.sha256hex(String(org)).then(function (hex) { return hex.slice(0, ORG_HASH); },
                                              function () { return null; });
  }

  /* ---------- fetching ---------- */

  function retryDelay() { return typeof window.__scRetryMs === 'number' ? window.__scRetryMs : RETRY_MS; }

  // One request for the viewer's results: {status: 200, body}, {status: 401}, or {status: 503} when no board
  // has been published yet. Anything else (unreachable, still waking, unable to read its archive) rejects.
  function fetchView(session) {
    var api = window.SCLogin && window.SCLogin.config && window.SCLogin.config.api;
    if (!session.mock && !api) return Promise.reject(new Error('no results API configured'));
    var url = session.mock ? 'mock/' + encodeURIComponent(session.mock) + '.json' : api + '/me';
    var init = session.mock ? { cache: 'no-cache' }
      : { cache: 'no-store', headers: { Authorization: 'Bearer ' + session.accessToken } };
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (res.status === 401) return { status: 401 };
        if (res.status === 503 && isObj(body) && body.error === 'no_board') return { status: 503 };
        if (!res.ok || !isObj(body)) {
          throw new Error('results server answered ' + res.status + (isObj(body) && body.error ? ' (' + body.error + ')' : ''));
        }
        return { status: 200, body: body };
      });
    });
  }

  function fetchWithRetry(session, stale) {
    return fetchView(session).catch(function (err) {
      if (stale()) throw err;
      console.warn('The results server did not answer; trying once more:', err);   // warn: the check counts errors
      return new Promise(function (resolve) { setTimeout(resolve, retryDelay()); }).then(function () {
        if (stale()) throw err;
        return fetchView(session);
      });
    });
  }

  /* ---------- what this script adds to the page, and taking it away ---------- */

  var generation = 0;          // bumped by render() and clear(), so a render overtaken by either draws nothing
  var defaultCaption = null;   // the caption paragraph's own text, put back by clear()

  function clear() {
    generation++;
    document.querySelectorAll('.lb-detail, .lb-detail-standalone').forEach(function (node) {
      node.parentNode.removeChild(node);
    });
    document.querySelectorAll('#lb-public .lb-expand').forEach(function (button) {
      button.parentNode.textContent = button.textContent;
    });
    var caption = document.getElementById('lb-caption');
    if (caption && defaultCaption !== null) {
      caption.textContent = defaultCaption;
      caption.classList.remove('lb-caption');
    }
    var content = document.getElementById('lb-private-content');
    if (content) content.textContent = '';
  }

  /* ---------- the "your entry" line ---------- */

  function modelsOf(team) {
    var models = team.run.models;
    return Array.isArray(models) ? models : Object.keys((isObj(team.board) && team.board.models) || {});
  }
  function nameOf(team) { return cap(team.team || team.org, LABEL_MAX); }   // the org's display name is the team's own text
  function intakeOf(entry) { return isObj(entry.intake) ? entry.intake : null; }
  function modelEntry(team, model) {
    var models = isObj(team.board) && isObj(team.board.models) ? team.board.models : {};
    return isObj(models[model]) ? models[model] : {};
  }

  function warnings(entry) {
    var out = [];
    if (entry.repo_private === false) out.push(el('p', 'lb-warn', 'Your submission repository is public — make it private.'));
    if (entry.evaluator_role && entry.evaluator_role !== 'read') {
      out.push(add(el('p', 'lb-warn'), "The evaluator's role in your organization is ", mono(String(entry.evaluator_role)),
                   '; set it to Read.'));
    }
    return out;
  }

  function scoredCount(team) {
    var models = modelsOf(team);
    if (!isObj(team.board) || !models.length) return null;
    var scored = models.filter(function (m) { return isNum(modelEntry(team, m).S); }).length;
    return { scored: scored, total: models.length };
  }

  function entryLine(team, withTeam) {
    var entry = team.entry, line = el('p', 'lb-entry');
    if (entry.status === 'pulled') {
      add(line, withTeam ? 'Your entry (' + nameOf(team) + ') in this board: ' : 'Your entry in this board: ');
      if (entry.label) add(line, '“' + cap(entry.label, LABEL_MAX) + '” · ');
      add(line, 'commit ', mono(shortCommit(entry.commit, 7)));
      if (entry.commit_time) add(line, ' (', mono(fmtUTC(entry.commit_time)), ')');
      add(line, ' · pulled ', mono(fmtUTC(entry.pulled_at)));
      if (entry.late === false) add(line, ', on time');
      else if (entry.late === true) add(line, ', late');
      var intake = intakeOf(entry);
      if (intake) {
        if (intake.ok === false) add(line, ' · intake failed (' + plural(list(intake.errors).length, 'error') + ')');
        else if (intake.needs_review && !intake.reviewed) add(line, ' · awaiting code review (custom controls)');
        else add(line, ' · intake passed');
        if (intake.track) add(line, ' · ' + intake.track);
      }
      var count = scoredCount(team);
      if (count && count.scored < count.total) add(line, ' · scored on ' + count.scored + ' of ' + count.total + ' models');
      return line;
    }
    var lead = 'Not evaluated this intake' + (withTeam ? ' for ' + nameOf(team) : '') + ': ';
    if (entry.status === 'late') {
      add(line, lead + 'your latest commit');
      if (entry.commit_time) add(line, ' (', mono(fmtUTC(entry.commit_time)), ')');
      add(line, ' was after the deadline');
      if (team.run.deadline) add(line, ' (', mono(fmtUTC(team.run.deadline)), ')');
      return add(line, '. Late commits are not pulled; the next intake takes the repository as it is then.');
    }
    if (entry.status === 'missing') {
      return add(line, lead + 'no ', mono(team.org + '/submission'), ' repository was found, or the evaluator could not read it.');
    }
    if (entry.status === 'oversize') return add(line, lead + 'the repository is above the size limit.');
    if (entry.status === 'failed') return add(line, lead + 'the pull failed; the organizers have been notified.');
    return add(line, lead + 'status ', mono(String(entry.status)), '.');
  }

  /* ---------- the expanded detail ---------- */

  function entryRows(team) {
    var entry = team.entry, intake = intakeOf(entry), rows = [];
    var when = [];
    if (entry.label) when.push('“' + cap(entry.label, LABEL_MAX) + '” · ');
    when.push('commit ', mono(shortCommit(entry.commit, 8)), ' · committed ', mono(fmtUTC(entry.commit_time)),
              ' · pulled ', mono(fmtUTC(entry.pulled_at)));
    if (entry.late === false || entry.late === true) {
      when.push(entry.late ? ', late' : ', on time');
      if (team.run.deadline) when.push(' (deadline ', mono(fmtUTC(team.run.deadline)), ')');
    }
    rows.push(kv('entry', when));
    if (intake) {
      var track = [], engines = isObj(intake.engines) ? intake.engines : {};
      if (intake.track) track.push('track ' + intake.track + (intake.track_source ? ' (' + intake.track_source + ')' : ''));
      var models = modelsOf(team).filter(function (m) { return engines[m]; });
      if (models.length) {
        track.push((track.length ? ' · ' : '') + 'engines ');
        models.forEach(function (m, i) { track.push(i ? ' · ' : '', mono(shortModel(m)), ' ' + labelOf(ENGINE_LABELS, engines[m])); });
      }
      if (track.length) rows.push(kv('', track));
    }
    var files = list(entry.files).filter(isObj);
    if (files.length) {
      var parts = ['files '];
      files.forEach(function (file, i) { parts.push(i ? ' · ' : '', mono(cap(file.path || '—', LABEL_MAX)), ' ' + fmtBytes(file.bytes)); });
      rows.push(kv('', parts));
    }
    if (intake) {
      var errors = list(intake.errors), warns = list(intake.warnings);
      rows.push(kv('intake', intake.ok === false ? 'failed with ' + plural(errors.length, 'error')
        : intake.needs_review && !intake.reviewed ? 'awaiting code review (custom controls)'
        : 'passed' + (warns.length ? ' with ' + plural(warns.length, 'warning') : '')));
      errors.concat(warns).forEach(function (message) { rows.push(kv('', '· ' + cap(message, MESSAGE_MAX))); });
    }
    return rows;
  }

  function modelTable(team) {
    var board = team.board, table = el('table', 'lb-grid'), head = el('tr');
    ['model', 'S', '95% CI', 'delta', 'r_side', 'r_guard', 'declines (ref)', 'truncated (ref)', ''].forEach(function (h) {
      var th = el('th', null, h);
      th.scope = 'col';
      add(head, th);
    });
    add(table, add(el('thead'), head));
    function share(block) { return isObj(block) ? fmtPct(block.arm) + ' (' + fmtPct(block.reference) + ')' : '—'; }
    function interval(ci, digits) {
      return Array.isArray(ci) && ci.length === 2 ? '[' + fmtSigned(ci[0], digits) + ', ' + fmtSigned(ci[1], digits) + ']' : '—';
    }
    var body = el('tbody');
    modelsOf(team).forEach(function (m) {
      var entry = modelEntry(team, m), notes = [];
      if (isObj(entry.unscored)) notes.push(labelOf(REASON_LABELS, entry.unscored.reason || 'unscored'));
      list(entry.flags).forEach(function (flag) { notes.push('⚑ ' + labelOf(FLAG_LABELS, flag)); });
      add(body, add(el('tr'), add(el('td'), mono(shortModel(m))), el('td', null, fmtSigned(entry.S, 2)),
                    el('td', null, interval(entry.ci, 2)), el('td', null, fmtSigned(entry.delta, 2)),
                    el('td', null, fmtAbs(entry.r_side)), el('td', null, fmtAbs(entry.r_guard)),
                    el('td', null, share(entry.declines)), el('td', null, share(entry.truncated)),
                    el('td', 'lb-notes', notes.join(' · '))));
    });
    var rank = el('td', 'lb-rank-of', isNum(board.rank)
      ? 'rank ' + board.rank + (isNum(team.run.n_ranked) ? ' of ' + team.run.n_ranked : '') : 'rank —');
    var rest = el('td');
    rank.colSpan = 3;
    rest.colSpan = 3;
    add(body, add(el('tr', 'lb-overall'), el('td', null, 'overall'), el('td', null, fmtSigned(board.S, 3)),
                  el('td', null, interval(board.ci, 2)), rank, rest));
    add(table, body);
    return add(el('div', 'lb-grid-wrap'), table);
  }

  function familyRow(team) {
    var board = team.board, families = isObj(board.families) ? board.families : {};
    var keys = ordered(Object.keys(families), FAMILY_LABELS);
    if (!keys.length) return kv('dishonesty', '—');
    function dimsOf(m, key) {
      var family = isObj(modelEntry(team, m).families) ? modelEntry(team, m).families[key] : null;
      return isObj(family) && isObj(family.dims) ? family.dims : {};
    }
    // Directions only for the models that have them (none when the run shows no arrows: dims {})
    var arrowModels = modelsOf(team).filter(function (m) {
      return keys.some(function (key) { return Object.keys(dimsOf(m, key)).length; });
    });
    var grid = el('div', 'lb-families');
    keys.forEach(function (key) {
      add(grid, el('span', null, labelOf(FAMILY_LABELS, key)),
          el('span', 'lb-num', fmtSigned(isObj(families[key]) ? families[key].g : null, 2)));
      var dims = el('span', 'lb-dims'), ids = [];
      arrowModels.forEach(function (m) {
        Object.keys(dimsOf(m, key)).forEach(function (d) { if (ids.indexOf(d) === -1) ids.push(d); });
      });
      ids.forEach(function (d) {
        var arrows = arrowModels.map(function (m) { var dir = dimsOf(m, key)[d]; return dir ? labelOf(ARROWS, dir) : '·'; });
        var said = arrowModels.map(function (m) { return shortModel(m) + ' ' + (dimsOf(m, key)[d] || 'not measured'); }).join(', ');
        var shown = el('span', 'lb-arrows', arrows.join(''));
        shown.title = said;
        shown.setAttribute('aria-hidden', 'true');
        add(dims, add(el('span', 'lb-dim'), mono(d), ' ', shown, el('span', 'visually-hidden', ' (' + said + ')')));
      });
      add(grid, dims);
    });
    var legend = 'g, headroom-normalised improvement' +
      (arrowModels.length ? '; ▲ ● ▼ per model: ' + arrowModels.map(shortModel).join(' · ') : '');
    return kv('dishonesty', [el('span', 'lb-note', legend), grid]);
  }

  // One row of group means over the base models: capability categories or guard kinds.
  function groupRow(team, field, labels, title, note) {
    var values = {};
    modelsOf(team).forEach(function (m) {
      var groups = isObj(modelEntry(team, m)[field]) ? modelEntry(team, m)[field] : {};
      Object.keys(groups).forEach(function (k) { (values[k] = values[k] || []).push(groups[k]); });
    });
    var keys = ordered(Object.keys(values), labels);
    var text = keys.length ? keys.map(function (k) { return labelOf(labels, k) + ' ' + fmtAbs(mean(values[k]), 2); }).join(' · ') : '—';
    return kv(title, [text, ' ', el('span', 'lb-note', note)]);
  }

  function historyRow(team) {
    var items = list(team.history).filter(isObj).map(function (h) {
      var notes = [];
      if (h.delta_comparable === false) notes.push('delta not comparable');
      if (h.S_comparable === false) notes.push('S not comparable');
      return (h.run || '—') + ' ' + fmtSigned(h.S, 2) + ' (#' + (isNum(h.rank) ? h.rank : '—') + ')' +
        (notes.length ? ' [' + notes.join(', ') + ']' : '');
    });
    if (isObj(team.board) && isNum(team.board.S)) {
      items.push((team.run.name || '—') + ' ' + fmtSigned(team.board.S, 2) + ' (#' + (isNum(team.board.rank) ? team.board.rank : '—') + ')');
    }
    return items.length ? kv('history', items.join(' → ')) : null;
  }

  function detailBody(team) {
    var body = el('div', 'lb-detail-body');
    entryRows(team).forEach(function (row) { add(body, row); });
    if (isObj(team.board) && isObj(team.board.models)) {
      add(body, modelTable(team), familyRow(team),
          groupRow(team, 'side_effects', CATEGORY_LABELS, 'side effects', '(regression, 0 = none)'),
          groupRow(team, 'guards', KIND_LABELS, 'guards', '(regression)'));
    }
    return add(body, historyRow(team));
  }

  /* ---------- placing the detail in the cloned table ---------- */

  // A team's row: by data-org, else by the exact team name on a row without data-org. A row is claimed once.
  function findRow(team, hash) {
    var rows = Array.prototype.slice.call(document.querySelectorAll('#lb-public .leaderboard > table > tbody > tr')).filter(function (row) {
      return !row.classList.contains('lb-baseline') && !row.classList.contains('lb-detail') && !row.querySelector('.lb-expand');
    });
    var byHash = hash && rows.filter(function (row) { return row.getAttribute('data-org') === hash; })[0];
    if (byHash) return byHash;
    return (team.team && rows.filter(function (row) {
      var cell = row.querySelector('.lb-team');
      return !row.hasAttribute('data-org') && cell && cell.textContent.trim() === team.team;
    })[0]) || null;
  }

  function attachDetail(team, org, hash, many) {
    var id = 'lb-detail-' + org;
    if (document.getElementById(id)) return;
    var row = findRow(team, hash), cell = row && row.querySelector('.lb-team');
    if (!cell) {   // not in the table (not ranked this run, or the table predates the team): the same detail under it
      var block = add(el('div', 'lb-detail-standalone'), el('p', 'lb-standalone-name', nameOf(team)), detailBody(team));
      block.id = id;
      var caption = document.getElementById('lb-caption'), board = document.getElementById('lb-public');
      if (caption) caption.parentNode.insertBefore(block, caption);
      else if (board) board.parentNode.insertBefore(block, board.nextSibling);
      return;
    }
    var button = el('button', 'lb-expand', cell.textContent.trim());
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', id);
    cell.textContent = '';
    cell.appendChild(button);
    var td = el('td');
    td.colSpan = row.cells.length || 6;
    var detail = add(el('tr', 'lb-detail'), add(td, detailBody(team)));
    detail.id = id;
    detail.hidden = true;
    row.parentNode.insertBefore(detail, row.nextSibling);
    button.addEventListener('click', function () {
      var open = button.getAttribute('aria-expanded') !== 'true';
      if (open && !many) {   // a participant keeps one row open at a time
        document.querySelectorAll('#lb-public .lb-expand[aria-expanded="true"]').forEach(function (other) {
          other.setAttribute('aria-expanded', 'false');
          var target = document.getElementById(other.getAttribute('aria-controls'));
          if (target) target.hidden = true;
        });
      }
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      detail.hidden = !open;
      fit();   // the window grows with the detail, up to the screen's height
    });
  }

  function setCaption(run) {
    var caption = document.getElementById('lb-caption');
    if (!caption || !isObj(run)) return;
    if (defaultCaption === null) defaultCaption = caption.textContent;
    var intake = fmtIntake(run.deadline), name = run.name || 'this run';
    var text = 'Board: ' + (intake ? 'intake of ' + intake + ' (' + name + ')' : name);
    if (run.date) text += ' · rendered ' + fmtDay(run.date);
    if (isNum(run.n_ranked)) {
      text += ' · ' + plural(run.n_ranked, 'submission') + ' ranked' +
        (isNum(run.n_baselines) ? ', ' + plural(run.n_baselines, 'baseline') + ' and the unsteered reference' : '');
    }
    if (run.layer === 'final') text += ' · final evaluation on the full suite.';
    else if (run.layer === 'public') text += ' · weekly evaluation on the downsampled subset. The final evaluation overrides these scores.';
    caption.textContent = text;
    caption.classList.add('lb-caption');
  }

  // Once the table is in: the caption, each team's detail (in its row, or under the table), then a refit.
  function decorate(run, teams, many, boardReady, current) {
    return boardReady.then(function () {
      return Promise.all(teams.map(function (t) { return orgHash(t.org); }));
    }).then(function (hashes) {
      if (!current()) return;
      setCaption(run);
      teams.forEach(function (t, i) { attachDetail(t.team, t.org, hashes[i], many); });
      fit();
    });
  }

  /* ---------- participant and organizer views ---------- */

  function supported(team) {
    return isObj(team) && team.schema === SCHEMA && isObj(team.entry) && isObj(team.run) && typeof team.org === 'string';
  }

  function renderParticipant(content, view, boardReady, current) {
    var all = list(view.teams), teams = all.filter(supported);
    var missing = list(view.missing).filter(function (org) { return typeof org === 'string'; });
    content.textContent = '';
    all.filter(function (t) { return !supported(t); }).forEach(function (t) {
      add(content, add(el('p', 'lb-entry'), 'This page needs an update to show the results for ',
                       mono(isObj(t) && typeof t.org === 'string' ? t.org : 'one of your teams'), '.'));
    });
    teams.forEach(function (team) {
      var block = add(el('div', 'lb-entry-block'));
      warnings(team.entry).forEach(function (w) { add(block, w); });
      add(block, entryLine(team, teams.length > 1));
      if (team.entry.status !== 'pulled') add(block, historyRow(team));   // the rest is the pulled entries' detail
      add(content, block);
    });
    if (missing.length) {   // organizations without a team file, e.g. registered after the pull
      var line = add(el('p', 'lb-entry'), 'No entry for ');
      missing.forEach(function (org, i) { add(line, i ? (i === missing.length - 1 ? ' or ' : ', ') : '', mono(org)); });
      add(content, add(line, " in this board. The next intake is on the competition page's countdown."));
    }
    if (!all.length && !missing.length) add(content, el('p', 'lb-entry', 'No results for your organizations in this board.'));
    var pulled = teams.filter(function (t) { return t.entry.status === 'pulled'; });
    return decorate(view.run, pulled.map(function (t) { return { team: t, org: t.org }; }), false, boardReady, current);
  }

  function statusBlock(view) {
    var block = el('div', 'lb-status'), items = [];
    var pull = list(isObj(view.pull) ? view.pull.orgs : null).filter(isObj);
    var teams = isObj(view.teams) ? view.teams : {};
    pull.forEach(function (o) { if (o.status !== 'pulled') items.push([o.org, 'not pulled (' + o.status + ')']); });
    Object.keys(teams).sort().forEach(function (org) {
      var team = teams[org];
      if (!supported(team)) { items.push([org, 'team file this page cannot read (schema ' + (isObj(team) ? team.schema : '—') + ')']); return; }
      var intake = intakeOf(team.entry);
      if (intake && intake.needs_review && !intake.reviewed) items.push([org, 'awaiting code review']);
      modelsOf(team).forEach(function (m) {
        var unscored = modelEntry(team, m).unscored;
        if (isObj(unscored)) items.push([org, shortModel(m) + ' unscored: ' + labelOf(REASON_LABELS, unscored.reason || 'unscored')]);
      });
    });
    list(isObj(view.board) ? view.board.warnings : null).forEach(function (w) { items.push([null, String(w)]); });
    var pulled = pull.filter(function (o) { return o.status === 'pulled'; }).length;
    add(block, el('p', 'lb-status-head', 'Organizer view · ' + ((isObj(view.run) && view.run.name) || 'no run') + ' · ' +
                  (pull.length ? pulled + ' of ' + plural(pull.length, 'organization') + ' pulled' : 'no pull manifest')));
    if (items.length) {
      var ul = el('ul');
      items.forEach(function (item) { add(ul, add(el('li'), item[0] ? mono(String(item[0])) : null, (item[0] ? ': ' : '') + item[1])); });
      add(block, ul);
    } else {
      add(block, el('p', 'soft', 'Nothing needs attention.'));
    }
    var details = add(el('details', 'lb-run-status'), el('summary', null, 'Run status'));
    if (view.progress) add(details, el('pre', null, String(view.progress)));
    if (view.failures) add(details, el('pre', null, String(view.failures)));
    if (!view.progress && !view.failures) add(details, el('p', 'soft', 'No progress or failures file for this run.'));
    return add(block, details);
  }

  function renderOrganizer(content, view, boardReady, current) {
    content.textContent = '';
    add(content, statusBlock(view));
    var teams = isObj(view.teams) ? view.teams : {};
    var pulled = Object.keys(teams).sort().filter(function (org) {
      return supported(teams[org]) && teams[org].entry.status === 'pulled';
    });
    // Rows whose team has no file get no button: the table may list teams this board doesn't
    return decorate(view.run, pulled.map(function (org) { return { team: teams[org], org: org }; }), true, boardReady, current);
  }

  /* ---------- entry point ---------- */

  function render(session, roles, boardReady) {
    clear();
    var mine = generation;
    function current() { return mine === generation; }
    boardReady = boardReady || Promise.resolve();
    var content = document.getElementById('lb-private-content');
    add(content, el('p', 'soft', 'Loading your results…'));
    function refit() { return boardReady.then(function () { if (current()) fit(); }); }

    return fetchWithRetry(session, function () { return !current(); }).then(function (result) {
      if (!current()) return;
      if (result.status === 401) {
        window.SCLogin.signOut('Your sign-in expired — sign in again.');
        return;
      }
      if (result.status === 503) {
        content.textContent = '';
        add(content, el('p', 'lb-entry', 'No results have been published yet.'));
        return refit();
      }
      var view = result.body;
      return Promise.resolve().then(function () {
        return (view.role === 'organizer' ? renderOrganizer : renderParticipant)(content, view, boardReady, current);
      }).catch(function (err) {   // a file this page can't read: say so, rather than stay on "Loading…"
        console.error('Could not show the private results:', err);
        if (!current()) return;
        content.textContent = '';
        add(content, el('p', 'lb-entry', 'This page needs an update to show your results.'));
        return refit();
      });
    }, function (err) {
      if (!current()) return;
      console.warn('Could not load the private results:', err);
      content.textContent = '';
      var again = el('a', null, 'try again');
      again.href = '#';
      again.addEventListener('click', function (e) { e.preventDefault(); render(session, roles, boardReady); });
      add(content, add(el('p', 'lb-entry'), "Couldn't load your results (the results server may be waking up) — ",
                       again, ' in a minute.'));
      return refit();
    });
  }

  window.SCPrivateView = { render: render, clear: clear };
})();
