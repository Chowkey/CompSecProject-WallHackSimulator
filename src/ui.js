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
   * The terminal answers "what exactly did this check see?". It is bad at the
   * other question a reviewer asks, which is "what shape does this attack have
   * over time?" - five defenses flipping from green to red within one second of
   * each other is a single image, and fifty scrolling lines of text.
   *
   * Drawn with plain fillRect/fillText only: no gradients, no measureText, so
   * the headless boot test can run this path through its no-op canvas without
   * throwing.
   * ====================================================================== */

  var inspectorView = 'timeline';

  var VERDICT_COLOUR = {
    clean: '#2f8f5b',
    detected: '#f0c040',
    missed: '#f2545b',
    'false-positive': '#f0a860'
  };

  // Background tint per attacker level, so the regime each verdict belongs to
  // is readable behind the lanes.
  var LEVEL_TINT = [
    null,
    'rgba(94,200,242,0.07)',
    'rgba(240,192,64,0.09)',
    'rgba(242,84,91,0.11)'
  ];
  var LEVEL_NAME = ['attacker off', 'L1 passive', 'L2 wallhack', 'L3 evasive'];

  var GUTTER = 132;
  var MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

  function tickWindow(list) {
    var min = Infinity, max = -Infinity;
    list.forEach(function (d) {
      if (!d.history.length) return;
      min = Math.min(min, d.history[0].tick);
      max = Math.max(max, d.history[d.history.length - 1].tick);
    });
    if (!isFinite(min)) return null;
    if (max - min < 60) max = min + 60;    // keep an empty run readable
    return { min: min, max: max };
  }

  function drawTimeline(ctx, W, H, list) {
    var win = tickWindow(list);
    var top = 30, bottom = H - 30;
    var laneH = (bottom - top) / list.length;
    var plotW = W - GUTTER - 14;
    var xOf = function (tick) {
      if (!win) return GUTTER;
      return GUTTER + plotW * ((tick - win.min) / (win.max - win.min));
    };

    // Attacker-level bands behind everything, taken from whichever defense has
    // the longest history.
    var spine = list.reduce(function (best, d) {
      return d.history.length > best.length ? d.history : best;
    }, []);
    for (var s = 0; s < spine.length; s++) {
      var tint = LEVEL_TINT[spine[s].level];
      if (!tint) continue;
      var bx0 = xOf(spine[s].tick);
      var bx1 = xOf(s + 1 < spine.length ? spine[s + 1].tick : win.max);
      ctx.fillStyle = tint;
      ctx.fillRect(bx0, top, Math.max(1, bx1 - bx0), bottom - top);
    }

    list.forEach(function (defense, i) {
      var y = top + i * laneH;
      var h = laneH - 6;

      ctx.fillStyle = '#12161d';
      ctx.fillRect(GUTTER, y, plotW, h);

      var hist = defense.history;
      for (var j = 0; j < hist.length; j++) {
        var x0 = xOf(hist[j].tick);
        var x1 = xOf(j + 1 < hist.length ? hist[j + 1].tick : win.max);
        ctx.fillStyle = VERDICT_COLOUR[hist[j].outcome] || '#2a3240';
        ctx.fillRect(x0, y, Math.max(1.5, x1 - x0 - 0.5), h);
      }

      ctx.fillStyle = defense.enabled ? '#c9d4e4' : '#5a6377';
      ctx.font = '12px ' + MONO;
      ctx.fillText(defense.short, 10, y + h / 2 + 4);

      if (!hist.length) {
        ctx.fillStyle = '#3d4657';
        ctx.font = '11px ' + MONO;
        ctx.fillText(defense.enabled ? 'armed, no check yet' : 'not enabled',
          GUTTER + 10, y + h / 2 + 4);
      }
    });

    // Time axis.
    ctx.fillStyle = '#5a6377';
    ctx.font = '11px ' + MONO;
    if (win) {
      ctx.fillText('t=' + (win.min / P.TICK_HZ).toFixed(0) + 's', GUTTER, top - 10);
      ctx.fillText('t=' + (win.max / P.TICK_HZ).toFixed(0) + 's', W - 60, top - 10);
    }
    ctx.fillText('every check, oldest left → newest right', GUTTER + 130, top - 10);

    drawLegend(ctx, W, H);
  }

  function drawLegend(ctx, W, H) {
    var items = [
      ['clean', 'no alarm'],
      ['detected', 'detected'],
      ['missed', 'bypassed'],
      ['false-positive', 'false pos']
    ];
    var x = 10;
    var y = H - 16;
    ctx.font = '11px ' + MONO;
    items.forEach(function (item) {
      ctx.fillStyle = VERDICT_COLOUR[item[0]];
      ctx.fillRect(x, y - 8, 10, 10);
      ctx.fillStyle = '#8b97ab';
      ctx.fillText(item[1], x + 15, y + 1);
      x += 15 + item[1].length * 6.6 + 16;
    });

    x += 10;
    for (var lv = 1; lv <= 3; lv++) {
      ctx.fillStyle = LEVEL_TINT[lv];
      ctx.fillRect(x, y - 8, 10, 10);
      ctx.strokeStyle = '#2a3240';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y - 7.5, 9, 9);
      ctx.fillStyle = '#8b97ab';
      ctx.fillText(LEVEL_NAME[lv], x + 15, y + 1);
      x += 15 + LEVEL_NAME[lv].length * 6.6 + 16;
    }
  }

  function bar(ctx, x, y, w, h, fraction, colour) {
    ctx.fillStyle = '#161b24';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, Math.max(0, Math.min(1, fraction)) * w, h);
  }

  function drawScoreboard(ctx, W, H, list) {
    var rowH = (H - 24) / list.length;
    var maxMs = list.reduce(function (m, d) {
      return Math.max(m, d.stats.runs ? d.stats.totalMs / d.stats.runs : 0);
    }, 0.001);

    list.forEach(function (defense, i) {
      var y = 20 + i * rowH;
      var st = defense.stats;
      var opportunities = st.detected + st.missed;
      var rate = opportunities ? st.detected / opportunities : 0;
      var avg = st.runs ? st.totalMs / st.runs : 0;

      ctx.fillStyle = defense.enabled ? '#c9d4e4' : '#5a6377';
      ctx.font = '12px ' + MONO;
      ctx.fillText(defense.short, 10, y + 12);

      // Detection rate: how often it caught real tampering when there was some.
      ctx.fillStyle = '#5a6377';
      ctx.font = '11px ' + MONO;
      ctx.fillText('caught', GUTTER, y + 12);
      bar(ctx, GUTTER + 48, y + 3, 200, 11, rate,
        rate > 0.66 ? '#41d17f' : rate > 0 ? '#f0c040' : '#f2545b');
      ctx.fillStyle = '#8b97ab';
      ctx.fillText(st.detected + '/' + opportunities +
        (opportunities ? '  (' + Math.round(100 * rate) + '%)' : '  (no tampering yet)'),
        GUTTER + 256, y + 12);

      // Cost, relative to the most expensive check on screen.
      ctx.fillStyle = '#5a6377';
      ctx.fillText('cost', GUTTER + 420, y + 12);
      bar(ctx, GUTTER + 456, y + 3, 120, 11, avg / maxMs, '#6fb4e8');
      ctx.fillStyle = '#8b97ab';
      ctx.fillText(avg.toFixed(2) + 'ms × ' + st.runs + ' runs', GUTTER + 584, y + 12);

      // The structural point, next to the numbers.
      ctx.fillStyle = '#6b7688';
      ctx.font = '11px ' + MONO;
      ctx.fillText('BLIND TO  ' + (defense.blind || '—'), GUTTER, y + 30);

      if (defense.lastOutcome) {
        ctx.fillStyle = VERDICT_COLOUR[defense.lastOutcome] || '#5a6377';
        ctx.fillRect(10, y + 22, 8, 8);
        ctx.fillStyle = '#8b97ab';
        ctx.fillText(defense.lastOutcome, 24, y + 30);
      }
    });
  }

  /**
   * The watch panel: the raw expected/observed pairs each check actually
   * compared, rather than the sentence it produced afterwards.
   *
   * Built as real DOM instead of canvas on purpose - the digests are the
   * numbers a reader wants to select and paste into a report, and a canvas
   * cannot be copied out of.
   */
  function renderWatch() {
    if (!el.watch || !el.watch.classList.contains('is-active')) return;
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

  var VIEW_CAPTION = {
    timeline: 'every check plotted in time order',
    scoreboard: 'detection rate is over checks where tampering was actually present',
    watch: 'the raw values each check compared on its last run'
  };

  function renderInspector() {
    if (!el.inspector.classList.contains('is-active')) return;

    var list = Sandbox.defenses.list();
    var armed = list.filter(function (d) { return d.enabled; }).length;
    el.inspectorCaption.textContent = armed + '/' + list.length +
      ' defenses armed · attacker level ' +
      (Sandbox.attacker ? Sandbox.attacker.getLevel() : 0) +
      ' · ' + VIEW_CAPTION[inspectorView];

    if (inspectorView === 'watch') return renderWatch();
    if (!el.inspectorCtx) return;

    var ctx = el.inspectorCtx;
    var W = ctx.canvas.width, H = ctx.canvas.height;
    ctx.fillStyle = '#080a0e';
    ctx.fillRect(0, 0, W, H);
    if (inspectorView === 'timeline') drawTimeline(ctx, W, H, list);
    else drawScoreboard(ctx, W, H, list);
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

  function setInspectorView(name) {
    inspectorView = name;
    el.viewTimeline.classList.toggle('is-active', name === 'timeline');
    el.viewScoreboard.classList.toggle('is-active', name === 'scoreboard');
    el.viewWatch.classList.toggle('is-active', name === 'watch');
    el.watch.classList.toggle('is-active', name === 'watch');
    el.inspectorCanvas.classList.toggle('is-hidden', name === 'watch');
    renderInspector();
  }

  /* ====================================================================== *
   * Lifecycle
   * ====================================================================== */

  function init() {
    [
      'controls', 'defense-pane',
      'tab-terminal', 'tab-inspector', 'inspector', 'inspector-canvas',
      'inspector-caption', 'view-timeline', 'view-scoreboard', 'view-watch', 'watch',
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
    el.inspectorCtx = el.inspectorCanvas.getContext('2d');
    Sandbox.app.attachCanvases(el.mainCtx, el.minimapCtx, el.gameCanvas);

    el.tabTerminal.addEventListener('click', function () { setInspectorTab('terminal'); });
    el.tabInspector.addEventListener('click', function () { setInspectorTab('inspector'); });
    el.viewTimeline.addEventListener('click', function () { setInspectorView('timeline'); });
    el.viewScoreboard.addEventListener('click', function () { setInspectorView('scoreboard'); });
    el.viewWatch.addEventListener('click', function () { setInspectorView('watch'); });

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
    // Exposed so the headless boot test can drive the inspector through a
    // recording canvas and assert it actually plots something.
    setInspectorTab: setInspectorTab,
    setInspectorView: setInspectorView,
    drawInspector: function (ctx, view) {
      var list = Sandbox.defenses.list();
      var W = ctx.canvas.width, H = ctx.canvas.height;
      if (view === 'scoreboard') drawScoreboard(ctx, W, H, list);
      else drawTimeline(ctx, W, H, list);
    }
  };

  Sandbox.ui = exports;
  Sandbox.registerModule('ui', exports);
})(typeof self !== 'undefined' ? self : this);
