/*
 * ui.js - Controls, defense panel, terminal, education modal, conclusion.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 * Two audiences to serve at once. During the live demo the committee needs to
 * stop the simulation on the exact tick a defense is defeated, so every control
 * is immediate and there is a single-step button. Afterwards the same screen has
 * to be readable as evidence, so the defense panel carries running counters and
 * the terminal explains, in words, why each failure happened.
 */
(function (global) {
  'use strict';

  var Sandbox = global.Sandbox;
  var P = Sandbox.Protocol;
  var Log = Sandbox.Log;

  var el = {};
  var autoscroll = true;
  var terminalNodes = 0;
  var MAX_TERMINAL_NODES = 1200;

  function $(id) { return document.getElementById(id); }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ====================================================================== *
   * Terminal
   * ====================================================================== */

  function appendLogEntry(entry) {
    if (entry === null) {         // cleared
      el.terminal.innerHTML = '';
      terminalNodes = 0;
      return;
    }
    var line = make('div', 'log-line ' + entry.cls + ' g-' + Log.groupFor(entry.level));

    var stamp = make('span', 'log-time',
      entry.t !== null ? '[t=' + entry.t.toFixed(2) + 's]' : '[t=  --  ]');
    var label = make('span', 'log-label', '[' + entry.label + ']');
    var text = make('span', 'log-text', entry.text);

    line.appendChild(stamp);
    line.appendChild(label);
    // A verdict chip, so the five defenses line up in one readable column.
    // An empty badge reserves the same width, keeping an evidence block
    // indented underneath the verdict it belongs to.
    if (entry.badge !== null && entry.badge !== undefined) {
      var badge = make('span', 'log-badge' + (entry.badge ? ' bd-' +
        entry.badge.toLowerCase().replace(/[^a-z]/g, '') : ' is-empty'), entry.badge);
      line.appendChild(badge);
    }
    line.appendChild(text);
    el.terminal.appendChild(line);
    terminalNodes++;

    while (terminalNodes > MAX_TERMINAL_NODES && el.terminal.firstChild) {
      el.terminal.removeChild(el.terminal.firstChild);
      terminalNodes--;
    }
    if (autoscroll) el.terminal.scrollTop = el.terminal.scrollHeight;
  }

  function buildTerminalFilters() {
    var groups = ['server', 'client', 'cheat', 'defense', 'alert', 'lesson', 'system'];
    groups.forEach(function (group) {
      var label = make('label', 'filter-chip');
      var box = make('input');
      box.type = 'checkbox';
      box.checked = true;
      box.addEventListener('change', function () {
        el.terminal.classList.toggle('hide-' + group, !box.checked);
      });
      label.appendChild(box);
      label.appendChild(make('span', null, group));
      el.terminalFilters.appendChild(label);
    });
  }

  /* ====================================================================== *
   * Defense panel
   * ====================================================================== */

  function buildDefensePanel() {
    el.defenseList.innerHTML = '';
    Sandbox.defenses.list().forEach(function (defense) {
      var row = make('div', 'defense-row');
      row.dataset.id = defense.id;

      var enableLabel = make('label', 'defense-enable');
      var enableBox = make('input');
      enableBox.type = 'checkbox';
      enableBox.addEventListener('change', function () {
        Sandbox.defenses.setEnabled(defense.id, enableBox.checked);
        if (defense.id === 'challenge') {
          Sandbox.app.setChallengesEnabled(enableBox.checked);
        }
        Log.system(defense.name + ' ' + (enableBox.checked ? 'enabled' : 'disabled'));
        renderDefensePanel();
      });
      enableLabel.appendChild(enableBox);
      enableLabel.appendChild(make('span', 'defense-name', defense.name));

      var status = make('span', 'defense-status', 'OFF');
      var counts = make('span', 'defense-counts', 'detect 0/0');
      var avg = make('span', 'defense-avg', 'avg —');

      var bypassLabel = make('label', 'defense-bypass');
      var bypassBox = make('input');
      bypassBox.type = 'checkbox';
      bypassBox.addEventListener('change', function () {
        Sandbox.defenses.setBypass(defense.id, bypassBox.checked);
        if (Sandbox.attacker) Sandbox.attacker.refresh();
        Log.cheat('bypass "' + defense.bypassName + '" ' +
          (bypassBox.checked ? 'armed' : 'disarmed') +
          (Sandbox.attacker.getLevel() < 3 ? ' (takes effect at attacker level 3)' : ''));
        renderDefensePanel();
      });
      bypassLabel.appendChild(bypassBox);
      bypassLabel.appendChild(make('span', null, 'bypass'));

      var help = make('button', 'defense-help', '?');
      help.title = 'How this works in the real world, and why it can be defeated';
      help.addEventListener('click', function () { openDefenseModal(defense.id); });

      row.appendChild(enableLabel);
      row.appendChild(status);
      row.appendChild(counts);
      row.appendChild(avg);
      row.appendChild(bypassLabel);
      row.appendChild(help);
      el.defenseList.appendChild(row);

      defense._ui = { row: row, enableBox: enableBox, bypassBox: bypassBox,
                      status: status, counts: counts, avg: avg };
    });
  }

  function renderDefensePanel() {
    Sandbox.defenses.list().forEach(function (defense) {
      var ui = defense._ui;
      if (!ui) return;

      ui.enableBox.checked = defense.enabled;
      ui.bypassBox.checked = defense.bypassEnabled;

      var state;
      if (!defense.enabled) state = 'OFF';
      else if (defense.lastOutcome === 'detected') state = 'DETECTING';
      else if (defense.lastOutcome === 'missed') state = 'BYPASSED';
      else if (defense.lastOutcome === 'false-positive') state = 'FALSE POS';
      else state = 'ACTIVE';

      ui.status.textContent = '[' + state + ']';
      ui.status.className = 'defense-status st-' + state.toLowerCase().replace(' ', '-');

      var s = defense.stats;
      var opportunities = s.detected + s.missed;
      ui.counts.textContent = 'detect ' + s.detected + '/' + opportunities +
        (s.falsePositive ? ' · fp ' + s.falsePositive : '');
      ui.avg.textContent = s.runs
        ? 'avg ' + (s.totalMs / s.runs).toFixed(2) + 'ms'
        : 'avg —';

      ui.row.classList.toggle('is-bypassed', state === 'BYPASSED');
      ui.row.classList.toggle('is-detecting', state === 'DETECTING');
    });
  }

  /* ====================================================================== *
   * Readouts
   * ====================================================================== */

  function renderReadouts() {
    var state = Sandbox.clientState;
    if (!state || !state.ready) return;

    var meta = state.meta;
    el.gameCaption.textContent =
      'tick ' + state.tick + ' · t=' + state.t.toFixed(2) + 's · culling=' + meta.cullingMode +
      ' · server sent ' + meta.sentNpcs + '/' + meta.totalNpcs + ' NPCs' +
      ' · ' + meta.visibleNpcs + ' in line of sight';

    var m = state.metrics;
    var leakPct = m.ticks ? (100 * m.hiddenTicks / m.ticks) : 0;
    var meanLead = m.leakedReceived ? (m.leadMsTotal / m.leakedReceived) : 0;

    el.leakReadout.innerHTML = '';
    var rows = [
      ['Hidden positions received', m.hiddenReceived],
      ['Ticks carrying hidden data', m.hiddenTicks + ' (' + leakPct.toFixed(1) + '%)'],
      ['Leaked by 300ms buffer', m.leakedReceived],
      ['Mean advance warning', meanLead.toFixed(0) + ' ms'],
      ['Revealed by cheat', Sandbox.attacker ? Sandbox.attacker.stats.hiddenRevealed : 0]
    ];
    rows.forEach(function (pair) {
      var row = make('div', 'readout-row');
      row.appendChild(make('span', 'readout-key', pair[0]));
      row.appendChild(make('span', 'readout-value', String(pair[1])));
      el.leakReadout.appendChild(row);
    });

    if (m.ticks > 20 && m.hiddenReceived === 0 && Sandbox.attacker &&
        Sandbox.attacker.getLevel() >= 2) {
      el.leakReadout.appendChild(make('div', 'readout-note',
        'The cheat is running and has received nothing to reveal. This is the ' +
        'STRICT result: the architecture, not the defenses, is doing the work.'));
    }
  }

  /**
   * Switch the main view between the first-person raycaster and the top-down
   * map. Both are drawn by the same client function and from the same packet -
   * the toggle changes presentation only, never what the client was told.
   */
  function setViewMode(mode) {
    var applied = Sandbox.client.setViewMode(mode);
    if (el.viewSelect) el.viewSelect.value = applied;
    updateLockHint();
    Log.client('view = ' + (applied === '3D' ? 'first person' : 'top down') +
      ' — same packet, same data, different projection');
    return applied;
  }

  // The click-to-look prompt only makes sense in the first-person view, and
  // only while the pointer is free.
  function updateLockHint() {
    if (!el.lockHint || !el.lockHint.classList) return;
    var wanted = Sandbox.clientState.viewMode === '3D' &&
      !(Sandbox.client.isPointerLocked && Sandbox.client.isPointerLocked());
    el.lockHint.classList.toggle('hidden', !wanted);
  }

  function buildLegend() {
    // Both views use these colours, so the legend describes both at once.
    var items = [
      ['visible', 'Visible — legitimate line of sight'],
      ['leaked', 'Leaked — sent early by the 300ms buffer'],
      ['wallhack', 'Wallhack — drawn through walls by the cheat'],
      ['lastKnown', 'Last known position'],
      ['player', 'You — the wedge is where you are looking']
    ];
    el.legend.innerHTML = '';
    items.forEach(function (item) {
      var li = make('li');
      var swatch = make('span', 'swatch');
      swatch.style.background = Sandbox.client.PALETTE[item[0]];
      li.appendChild(swatch);
      li.appendChild(make('span', null, item[1]));
      el.legend.appendChild(li);
    });
  }

  /* ====================================================================== *
   * Modal
   * ====================================================================== */

  function openModal(title, sections) {
    el.modalBody.innerHTML = '';
    el.modalBody.appendChild(make('h2', null, title));
    sections.forEach(function (section) {
      el.modalBody.appendChild(make('h3', null, section.heading));
      if (Array.isArray(section.body)) {
        section.body.forEach(function (paragraph) {
          el.modalBody.appendChild(make('p', null, paragraph));
        });
      } else {
        el.modalBody.appendChild(make('p', null, section.body));
      }
    });
    el.modal.classList.add('open');
  }

  function openDefenseModal(id) {
    var notes = Sandbox.education.DEFENSE_NOTES[id];
    var defense = Sandbox.defenses.get(id);
    openModal(notes.title, [
      { heading: 'What this models', body: notes.realWorld },
      { heading: 'Why it can be defeated — bypass: ' + defense.bypassName,
        body: notes.whyBypassable },
      { heading: 'What it costs to deploy', body: notes.cost }
    ]);
  }

  function openCullingModal() {
    var notes = Sandbox.education.CULLING_NOTES;
    openModal('Culling modes', Object.keys(notes).map(function (key) {
      return { heading: notes[key].title, body: notes[key].body };
    }));
  }

  /* ====================================================================== *
   * Conclusion panel
   * ====================================================================== */

  function renderConclusion(benchmark) {
    var conclusion = Sandbox.education.buildConclusion(benchmark);
    el.conclusion.innerHTML = '';
    if (!conclusion.available) {
      el.conclusion.appendChild(make('p', 'muted',
        'Run the benchmark to generate the conclusion from measurements.'));
      return;
    }
    el.conclusion.appendChild(make('h2', null, 'Conclusion — generated from benchmark output'));
    conclusion.lines.forEach(function (line) {
      var block = make('div', 'conclusion-block');
      block.appendChild(make('h3', null, line.heading));
      block.appendChild(make('p', null, line.text));
      el.conclusion.appendChild(block);
    });
    el.conclusion.appendChild(make('p', 'muted',
      'Seed ' + benchmark.seed + ' · ' + benchmark.rows.length + ' combinations × ' +
      benchmark.ticksPerCombo + ' ticks · ' + benchmark.note));
  }

  /* ====================================================================== *
   * Controls
   * ====================================================================== */

  function setPlaying(playing) {
    Sandbox.app.setPlaying(playing);
    el.playBtn.textContent = playing ? '❙❙ Pause' : '▶ Play';
    el.playBtn.classList.toggle('is-playing', playing);
  }

  /**
   * Hand keyboard focus back to the page after a control has been used.
   *
   * Without this the browser keeps the dropdown or checkbox focused, and the
   * arrow keys go to that widget instead of turning the camera - so the player
   * silently stops being able to look left and right the moment anyone touches
   * the control bar. The seed field is exempt while it is being typed into.
   */
  function releaseFocus(node, force) {
    if (!node || typeof node.blur !== 'function') return;
    // The seed field keeps focus while it is being typed into, unless the user
    // explicitly asked to leave it with Enter or Escape.
    if (!force && node.tagName === 'INPUT' && node.type === 'text') return;
    node.blur();
  }

  function wireFocusRelease(container) {
    if (!container || !container.addEventListener) return;
    container.addEventListener('change', function (event) {
      releaseFocus(event.target);
    });
    container.addEventListener('click', function (event) {
      if (event.target && event.target.tagName === 'BUTTON') releaseFocus(event.target);
    });
  }

  function wireControls() {
    el.seedInput.value = Sandbox.app.seed;

    // Both regions carry widgets that would otherwise keep focus: the control
    // bar's dropdowns, and the defense panel's enable/bypass checkboxes.
    wireFocusRelease(el.controls);
    wireFocusRelease(el.defensePane);

    el.playBtn.addEventListener('click', function () {
      setPlaying(!Sandbox.app.playing);
    });

    el.stepBtn.addEventListener('click', function () {
      if (Sandbox.app.playing) setPlaying(false);
      Sandbox.app.step(1);
    });

    el.speedSelect.addEventListener('change', function () {
      Sandbox.app.setSpeed(parseFloat(el.speedSelect.value));
    });

    el.viewSelect.addEventListener('change', function () {
      setViewMode(el.viewSelect.value);
    });

    el.cullingSelect.addEventListener('change', function () {
      Sandbox.app.setCulling(el.cullingSelect.value);
    });

    el.cullingHelp.addEventListener('click', openCullingModal);

    el.attackerSelect.addEventListener('change', function () {
      Sandbox.attacker.setLevel(parseInt(el.attackerSelect.value, 10));
      renderDefensePanel();
    });

    el.overheadRange.addEventListener('input', function () {
      var value = parseInt(el.overheadRange.value, 10);
      el.overheadValue.textContent = value + ' ms';
      Sandbox.attacker.setOverhead(value);
    });

    el.timingBox.addEventListener('change', function () {
      Sandbox.app.setTimingAnalysis(el.timingBox.checked);
    });

    el.resetBtn.addEventListener('click', function () {
      setPlaying(false);
      Sandbox.app.reset(el.seedInput.value.trim() || 'valorant', el.cullingSelect.value);
      Log.system('world reset with seed "' + el.seedInput.value.trim() + '"');
    });

    el.randomSeed.addEventListener('click', function () {
      el.seedInput.value = Sandbox.RNG.randomSeed();
      el.resetBtn.click();
    });

    el.exportBtn.addEventListener('click', function () {
      Sandbox.exporter.exportSession();
    });

    el.benchBtn.addEventListener('click', runBenchmark);
    el.benchCancel.addEventListener('click', function () {
      Sandbox.exporter.cancelBenchmark();
      el.benchCancel.disabled = true;
    });

    el.clearLog.addEventListener('click', function () { Log.clear(); });
    el.autoscrollBox.addEventListener('change', function () {
      autoscroll = el.autoscrollBox.checked;
    });

    el.modalClose.addEventListener('click', function () { el.modal.classList.remove('open'); });
    el.modal.addEventListener('click', function (event) {
      if (event.target === el.modal) el.modal.classList.remove('open');
    });

    global.addEventListener('keydown', function (event) {
      // Escape is handled before the focus guard on purpose: it is the way out
      // when a widget has hold of the keyboard, so it has to work precisely in
      // the case where every other shortcut is being swallowed.
      if (event.key === 'Escape') {
        el.modal.classList.remove('open');
        releaseFocus(event.target, true);
        return;
      }
      // Same narrow rule the movement keys use: only step aside for an element
      // that genuinely needs this key, not for any focused widget at all.
      if (Sandbox.client.claimsKey(event.target, event.key)) {
        // Committing the seed field should hand the keyboard back to the game.
        if (event.key === 'Enter') releaseFocus(event.target, true);
        return;
      }
      if (event.key === ' ') { event.preventDefault(); el.playBtn.click(); }
      if (event.key === '.') { event.preventDefault(); el.stepBtn.click(); }
      if (event.key === 'v' || event.key === 'V') {
        event.preventDefault();
        setViewMode(Sandbox.clientState.viewMode === '3D' ? '2D' : '3D');
      }
    });
  }

  function runBenchmark() {
    el.benchBtn.disabled = true;
    el.benchCancel.disabled = false;
    el.benchProgress.classList.add('active');
    setPlaying(false);

    Sandbox.exporter.runBenchmark(
      { ticksPerCombo: parseInt(el.benchTicks.value, 10) || 500, seed: Sandbox.app.seed },
      function (progress) {
        var pct = progress.total ? Math.round(100 * progress.done / progress.total) : 0;
        el.benchBar.style.width = pct + '%';
        el.benchLabel.textContent = progress.phase + ' · ' + progress.done + '/' +
          progress.total + ' · ' + progress.label;
      }
    ).then(function (benchmark) {
      el.benchBar.style.width = '100%';
      el.benchLabel.textContent = benchmark.cancelled
        ? 'cancelled after ' + benchmark.rows.length + ' combinations'
        : 'complete · ' + benchmark.rows.length + ' combinations in ' +
          (benchmark.durationMs / 1000).toFixed(1) + 's';
      renderConclusion(benchmark);
      renderDefensePanel();
      el.conclusion.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }).catch(function () {
      el.benchLabel.textContent = 'benchmark failed — see terminal';
    }).then(function () {
      el.benchBtn.disabled = false;
      el.benchCancel.disabled = true;
    });
  }

  /* ====================================================================== *
   * Defense inspector
   *
   * The terminal answers "what exactly did this check see?" one line at a time.
   * This panel answers it as a table: the raw values every check compared on
   * its last run, side by side, with the mismatches marked.
   * ====================================================================== */

  /**
   * The watch panel: the raw expected/observed pairs each check actually
   * compared, rather than the sentence it produced afterwards.
   *
   * Built as real DOM instead of canvas on purpose - the digests are the
   * numbers a reader wants to select and paste into a report, and a canvas
   * cannot be copied out of.
   */
  function renderWatch() {
    if (!el.watch) return;
    el.watch.innerHTML = '';

    Sandbox.defenses.list().forEach(function (defense) {
      var block = make('div', 'watch-block' + (defense.enabled ? '' : ' is-off'));

      var head = make('div', 'watch-head');
      head.appendChild(make('span', 'watch-name', defense.name));

      var state = defense.enabled ? (defense.lastOutcome || 'waiting') : 'not armed';
      var chipClass = { clean: 'bd-pass', detected: 'bd-detect', missed: 'bd-bypass',
                        'false-positive': 'bd-false' }[defense.lastOutcome] || '';
      head.appendChild(make('span', 'log-badge ' + chipClass,
        defense.enabled ? (BADGE_TEXT[defense.lastOutcome] || 'WAITING') : 'OFF'));
      head.appendChild(make('span', 'watch-cost',
        defense.lastMs ? defense.lastMs.toFixed(2) + 'ms' : ''));
      block.appendChild(head);

      var values = defense.lastValues || [];
      if (!values.length) {
        block.appendChild(make('p', 'watch-empty', defense.enabled
          ? 'armed — values appear after the first check'
          : 'enable this defense to see what it compares'));
      } else {
        block.appendChild(buildWatchTable(defense, values));
        if (defense.lastNote) {
          block.appendChild(make('p', 'watch-note', defense.lastNote));
        }
      }
      el.watch.appendChild(block);
    });
  }

  function buildWatchTable(defense, values) {
    var table = make('table', 'watch-table');
    var thead = make('thead');
    var hrow = make('tr');
    (defense.lastColumns || []).forEach(function (name) {
      hrow.appendChild(make('th', null, name));
    });
    hrow.appendChild(make('th'));
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = make('tbody');
    values.forEach(function (v) {
      var row = make('tr', v.ok ? null : 'is-bad');
      row.appendChild(make('td', null, v.label));
      row.appendChild(make('td', null, String(v.expected)));
      row.appendChild(make('td', 'col-actual', String(v.actual)));
      row.appendChild(make('td', 'watch-mark', v.ok ? '✓' : '✗'));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    return table;
  }

  var BADGE_TEXT = {
    clean: 'PASS', detected: 'DETECT', missed: 'BYPASS', 'false-positive': 'FALSE+'
  };

  function renderInspector() {
    if (!el.inspector.classList.contains('is-active')) return;
    var list = Sandbox.defenses.list();
    var armed = list.filter(function (d) { return d.enabled; }).length;
    el.inspectorCaption.textContent = armed + '/' + list.length +
      ' defenses armed · attacker level ' +
      (Sandbox.attacker ? Sandbox.attacker.getLevel() : 0) +
      ' · the raw values each check compared on its last run';
    renderWatch();
  }

  function setInspectorTab(name) {
    var showInspector = name === 'inspector';
    el.inspector.classList.toggle('is-active', showInspector);
    el.terminal.classList.toggle('is-hidden', showInspector);
    el.tabTerminal.classList.toggle('is-active', !showInspector);
    el.tabInspector.classList.toggle('is-active', showInspector);
    el.terminalFilters.style.display = showInspector ? 'none' : '';
    renderInspector();
  }

  /* ====================================================================== *
   * Lifecycle
   * ====================================================================== */

  function init() {
    [
      'controls', 'defense-pane',
      'tab-terminal', 'tab-inspector', 'inspector', 'inspector-canvas',
      'inspector-caption', 'watch',
      'env-line', 'banner', 'game-canvas', 'game-caption', 'minimap-canvas', 'legend',
      'leak-readout', 'defense-list', 'terminal', 'terminal-filters', 'conclusion',
      'seed-input', 'random-seed', 'reset-btn', 'play-btn', 'step-btn', 'speed-select',
      'view-select', 'lock-hint',
      'culling-select', 'culling-help', 'attacker-select', 'overhead-range',
      'overhead-value', 'timing-box', 'export-btn', 'bench-btn', 'bench-cancel',
      'bench-ticks', 'bench-progress', 'bench-bar', 'bench-label', 'clear-log',
      'autoscroll-box', 'modal', 'modal-body', 'modal-close'
    ].forEach(function (id) {
      var camel = id.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
      el[camel] = $(id);
    });

    el.mainCtx = el.gameCanvas.getContext('2d');
    el.minimapCtx = el.minimapCanvas.getContext('2d');
    Sandbox.app.attachCanvases(el.mainCtx, el.minimapCtx, el.gameCanvas);

    el.tabTerminal.addEventListener('click', function () { setInspectorTab('terminal'); });
    el.tabInspector.addEventListener('click', function () { setInspectorTab('inspector'); });

    buildTerminalFilters();
    buildDefensePanel();
    buildLegend();
    wireControls();
    renderConclusion(null);

    Log.all().forEach(appendLogEntry);
    Log.subscribe(appendLogEntry);

    setInterval(function () {
      renderDefensePanel();
      renderReadouts();
      updateLockHint();
      renderInspector();
    }, 250);
  }

  function onWorldReady(msg) {
    el.seedInput.value = msg.seed;
    el.envLine.textContent =
      'seed "' + msg.seed + '" · ' + msg.width + '×' + msg.height + ' grid · ' +
      msg.npcCount + ' NPCs · ' + P.TICK_HZ + " Hz · server: " + Sandbox.app.linkKind() +
      ' · SHA-256: ' + Sandbox.Hash.backend;
  }

  function onVerdict() { /* the panel refresh loop picks this up */ }

  function onBooted() {
    if (Sandbox.app.degraded.length) {
      el.banner.style.display = 'block';
      el.banner.textContent = Sandbox.app.degraded.join(' ');
    }
    el.attackerSelect.value = '0';
    el.overheadValue.textContent = el.overheadRange.value + ' ms';
    el.timingBox.checked = Sandbox.app.timingAnalysis;
    renderDefensePanel();
  }

  var exports = {
    init: init,
    onWorldReady: onWorldReady,
    onVerdict: onVerdict,
    onBooted: onBooted,
    renderConclusion: renderConclusion,
    openDefenseModal: openDefenseModal,
    // Exposed so the headless boot test can open the panel and inspect the
    // table it builds.
    setInspectorTab: setInspectorTab
  };

  Sandbox.ui = exports;
  Sandbox.registerModule('ui', exports);
})(typeof self !== 'undefined' ? self : this);
