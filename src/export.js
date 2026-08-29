/*
 * export.js - Session export and the automated benchmark.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 * This is what turns the demo into a result. The benchmark walks the full
 * matrix - 5 defenses x 3 attacker levels x 3 culling modes = 45 combinations -
 * runs each for a fixed number of ticks, and records detections, misses, false
 * positives, execution cost and leaked information. It then sweeps the cheat's
 * response overhead to find the point where the server's timing analysis starts
 * winning.
 *
 * A note on honesty in the numbers: the benchmark fast-forwards the simulation
 * instead of running it at 20 Hz, because 45 x 500 ticks in real time is about
 * nineteen minutes. Defense execution times are still real measurements. The
 * challenge/response latencies are not wall-clock comparable to a live session,
 * and every export marks them as fast-forward samples so nobody reports them as
 * if they were.
 */
(function (global) {
  'use strict';

  var Sandbox = global.Sandbox;
  var P = Sandbox.Protocol;
  var Log = Sandbox.Log;

  var CULLING_MODES = ['NONE', 'STRICT', 'BUFFERED'];
  var ATTACKER_LEVELS = [1, 2, 3];

  var lastBenchmark = null;
  var cancelRequested = false;

  /* ====================================================================== *
   * Helpers
   * ====================================================================== */

  function settle(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms || 0); });
  }

  function snapshotConfig() {
    return {
      seed: Sandbox.app.seed,
      culling: Sandbox.app.culling,
      timingAnalysis: Sandbox.app.timingAnalysis,
      attackerLevel: Sandbox.attacker ? Sandbox.attacker.getLevel() : 0,
      overheadMs: Sandbox.attacker ? Sandbox.attacker.getOverhead() : 0,
      defenses: Sandbox.defenses.list().map(function (d) {
        return { id: d.id, enabled: d.enabled, bypassEnabled: d.bypassEnabled };
      })
    };
  }

  function restoreConfig(config) {
    Sandbox.defenses.list().forEach(function (d) {
      var saved = config.defenses.filter(function (s) { return s.id === d.id; })[0];
      if (!saved) return;
      d.enabled = saved.enabled;
      d.bypassEnabled = saved.bypassEnabled;
    });
    Sandbox.app.setTimingAnalysis(config.timingAnalysis);
    Sandbox.attacker.setOverhead(config.overheadMs);
    Sandbox.app.reset(config.seed, config.culling);
    Sandbox.attacker.setLevel(config.attackerLevel);
  }

  function configureCombo(defenseId, level, allBypasses) {
    Sandbox.defenses.list().forEach(function (d) {
      d.enabled = (d.id === defenseId);
      d.bypassEnabled = allBypasses;
    });
    Sandbox.app.setChallengesEnabled(defenseId === 'challenge');
  }

  /* ====================================================================== *
   * The benchmark
   * ====================================================================== */

  /**
   * Run one cell of the matrix and return its row.
   *
   * For the challenge/response defense the run is preceded by a clean warm-up:
   * the server needs a baseline latency distribution built from honest
   * responses before a z-score means anything. Handing it a baseline that
   * already contains the cheat's overhead would be measuring the cheat against
   * itself.
   */
  function runCombo(defenseId, level, culling, ticks, seed) {
    var defense = Sandbox.defenses.get(defenseId);
    var needsBaseline = defenseId === 'challenge';

    Sandbox.app.setCulling(culling);
    Sandbox.app.reset(seed, culling);
    configureCombo(defenseId, level, level >= 3);

    return settle(15).then(function () {
      Sandbox.attacker.setLevel(0);
      if (!needsBaseline) return null;
      // Enough ticks for TIMING_BASELINE_SAMPLES honest challenges.
      var warmup = (P.TIMING_BASELINE_SAMPLES + 1) * P.CHALLENGE_INTERVAL_TICKS;
      return Sandbox.app.runTicks(warmup);
    }).then(function () {
      // Discard everything the warm-up produced; only the measured phase counts.
      Sandbox.defenses.resetStats();
      Sandbox.attacker.resetStats();
      Sandbox.app.verdicts.length = 0;
      Sandbox.attacker.setLevel(level);
      return Sandbox.app.runTicks(ticks);
    }).then(function () {
      var metrics = Sandbox.clientState.metrics;
      var stats = defense.stats;
      var verdicts = Sandbox.app.verdicts;

      return {
        defenseId: defenseId,
        defenseName: defense.name,
        attackerLevel: level,
        culling: culling,
        ticks: metrics.ticks,

        runs: stats.runs,
        detected: stats.detected,
        missed: stats.missed,
        falsePositive: stats.falsePositive,
        trueNegative: stats.trueNegative,
        detectionRate: stats.runs ? stats.detected / stats.runs : 0,
        avgMs: stats.runs ? stats.totalMs / stats.runs : 0,
        totalMs: stats.totalMs,
        cpuBudgetPct: metrics.ticks ? 100 * stats.totalMs / (metrics.ticks * P.TICK_MS) : 0,

        // Information the client was given that an honest player could not use.
        hiddenReceived: metrics.hiddenReceived,
        leakTicks: metrics.hiddenTicks,
        leakedReceived: metrics.leakedReceived,
        leadMsTotal: metrics.leadMsTotal,
        revealedByCheat: Sandbox.attacker.stats.hiddenRevealed,

        challengeCount: verdicts.length,
        challengeAnomalies: verdicts.filter(function (v) { return v.anomaly; }).length
      };
    });
  }

  /**
   * Sweep the cheat's added response overhead and record how often the server's
   * timing analysis notices. This produces the detection-threshold curve, which
   * is the one place in the project where a defense measurably wins.
   */
  function runTimingSweep(seed, onProgress) {
    var overheads = [0, 2, 4, 6, 8, 10, 15, 20, 30, 40, 50];
    var challengesPerPoint = 24;
    var results = [];

    return overheads.reduce(function (chain, overheadMs, index) {
      return chain.then(function () {
        if (cancelRequested) return;
        if (onProgress) {
          onProgress({
            phase: 'timing sweep',
            done: index, total: overheads.length,
            label: 'overhead ' + overheadMs + 'ms'
          });
        }

        Sandbox.app.setCulling('BUFFERED');
        Sandbox.app.reset(seed, 'BUFFERED');
        configureCombo('challenge', 3, true);
        Sandbox.app.setTimingAnalysis(true);
        Sandbox.attacker.setOverhead(overheadMs);

        return settle(15).then(function () {
          Sandbox.attacker.setLevel(0);
          var warmup = (P.TIMING_BASELINE_SAMPLES + 1) * P.CHALLENGE_INTERVAL_TICKS;
          return Sandbox.app.runTicks(warmup);
        }).then(function () {
          Sandbox.app.verdicts.length = 0;
          Sandbox.defenses.resetStats();
          Sandbox.attacker.setLevel(3);
          return Sandbox.app.runTicks(challengesPerPoint * P.CHALLENGE_INTERVAL_TICKS);
        }).then(function () {
          var verdicts = Sandbox.app.verdicts.filter(function (v) { return v.baselineReady; });
          var flagged = verdicts.filter(function (v) {
            return v.anomaly || !v.valueOk || v.timedOut;
          });
          var latencies = verdicts.map(function (v) { return v.latencyMs; });
          results.push({
            overheadMs: overheadMs,
            challenges: verdicts.length,
            flagged: flagged.length,
            detectionRate: verdicts.length ? flagged.length / verdicts.length : 0,
            meanLatencyMs: latencies.length
              ? latencies.reduce(function (a, b) { return a + b; }, 0) / latencies.length
              : 0,
            latencies: latencies
          });
        });
      });
    }, Promise.resolve()).then(function () { return results; });
  }

  /**
   * Walk the full matrix. Rendering and the terminal are switched off for the
   * duration - the benchmark is a measurement, not a demo, and drawing 22,500
   * frames would only slow it down.
   */
  function runBenchmark(options, onProgress) {
    options = options || {};
    var ticks = options.ticksPerCombo || 500;
    var seed = options.seed || Sandbox.app.seed;
    var saved = snapshotConfig();

    cancelRequested = false;
    var started = Date.now();
    var rows = [];
    var combos = [];

    CULLING_MODES.forEach(function (culling) {
      ATTACKER_LEVELS.forEach(function (level) {
        Sandbox.defenses.list().forEach(function (defense) {
          combos.push({ defenseId: defense.id, level: level, culling: culling });
        });
      });
    });

    Sandbox.app.setPlaying(false);
    Sandbox.app.setRenderPaused(true);
    Log.bench('benchmark started: ' + combos.length + ' combinations x ' + ticks +
      ' ticks, seed "' + seed + '"');
    Log.setMuted(true);

    return combos.reduce(function (chain, combo, index) {
      return chain.then(function () {
        if (cancelRequested) return;
        if (onProgress) {
          onProgress({
            phase: 'matrix',
            done: index, total: combos.length,
            label: combo.culling + ' / level ' + combo.level + ' / ' + combo.defenseId
          });
        }
        return runCombo(combo.defenseId, combo.level, combo.culling, ticks, seed)
          .then(function (row) { rows.push(row); });
      });
    }, Promise.resolve())
      .then(function () {
        if (cancelRequested) return [];
        return runTimingSweep(seed, onProgress);
      })
      .then(function (timing) {
        Log.setMuted(false);
        Sandbox.app.setRenderPaused(false);
        restoreConfig(saved);

        lastBenchmark = {
          startedAt: new Date(started).toISOString(),
          durationMs: Date.now() - started,
          seed: seed,
          ticksPerCombo: ticks,
          cancelled: cancelRequested,
          fastForwarded: true,
          note: 'Latencies were captured while fast-forwarding the simulation and ' +
            'are not comparable to wall-clock latencies from a live session. ' +
            'Defense execution times are real measurements.',
          rows: rows,
          timing: timing
        };

        Log.bench('benchmark ' + (cancelRequested ? 'cancelled' : 'complete') + ' after ' +
          ((Date.now() - started) / 1000).toFixed(1) + 's · ' + rows.length + ' rows');
        return lastBenchmark;
      })
      .catch(function (err) {
        Log.setMuted(false);
        Sandbox.app.setRenderPaused(false);
        restoreConfig(saved);
        Log.alert('benchmark failed: ' + err.message);
        throw err;
      });
  }

  function cancelBenchmark() { cancelRequested = true; }

  /* ====================================================================== *
   * Session export
   * ====================================================================== */

  function buildSession() {
    var metrics = Sandbox.clientState.metrics;
    var defenses = Sandbox.defenses.list();
    var totalDefenseMs = defenses.reduce(function (a, d) { return a + d.stats.totalMs; }, 0);

    return {
      generatedAt: new Date().toISOString(),
      tool: 'Client Integrity Sandbox',
      environment: {
        serverLink: Sandbox.app.linkKind(),
        hashBackend: Sandbox.Hash.backend,
        signaturesVerified: Sandbox.signing.available,
        degraded: Sandbox.app.degraded
      },
      configuration: snapshotConfig(),
      simulation: {
        ticks: metrics.ticks,
        tickHz: P.TICK_HZ,
        gridWidth: Sandbox.clientState.width,
        gridHeight: Sandbox.clientState.height,
        npcCount: Sandbox.clientState.meta.totalNpcs
      },
      resultsMatrix: defenses.map(function (d) {
        return {
          defenseId: d.id,
          defenseName: d.name,
          attackerLevel: Sandbox.attacker.getLevel(),
          culling: Sandbox.app.culling,
          enabled: d.enabled,
          bypassEnabled: d.bypassEnabled,
          runs: d.stats.runs,
          detected: d.stats.detected,
          missed: d.stats.missed,
          falsePositive: d.stats.falsePositive,
          trueNegative: d.stats.trueNegative,
          avgMs: d.stats.runs ? d.stats.totalMs / d.stats.runs : 0
        };
      }),
      cost: {
        perDefense: defenses.map(function (d) {
          return {
            defenseId: d.id,
            totalMs: d.stats.totalMs,
            avgMsPerRun: d.stats.runs ? d.stats.totalMs / d.stats.runs : 0,
            msPerTick: metrics.ticks ? d.stats.totalMs / metrics.ticks : 0
          };
        }),
        totalCpuBudgetPct: metrics.ticks
          ? 100 * totalDefenseMs / (metrics.ticks * P.TICK_MS) : 0
      },
      informationLeak: {
        ticks: metrics.ticks,
        hiddenPositionsReceived: metrics.hiddenReceived,
        ticksWithHiddenData: metrics.hiddenTicks,
        leakedByBuffer: metrics.leakedReceived,
        meanLeadMs: metrics.leakedReceived ? metrics.leadMsTotal / metrics.leakedReceived : 0,
        revealedByCheat: Sandbox.attacker ? Sandbox.attacker.stats.hiddenRevealed : 0
      },
      challengeLatencies: Sandbox.app.verdicts.map(function (v) {
        return {
          id: v.id, moduleId: v.moduleId, latencyMs: v.latencyMs,
          valueOk: v.valueOk, timedOut: v.timedOut, z: v.z, anomaly: v.anomaly
        };
      }),
      benchmark: lastBenchmark
    };
  }

  function toCsv(rows, columns) {
    var header = columns.join(',');
    var body = rows.map(function (row) {
      return columns.map(function (col) {
        var value = row[col];
        if (value === null || value === undefined) return '';
        if (typeof value === 'number') return Number.isInteger(value) ? value : value.toFixed(4);
        var text = String(value);
        return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
      }).join(',');
    }).join('\n');
    return header + '\n' + body;
  }

  function sessionCsv(session) {
    var parts = [];
    var matrixColumns = ['defenseId', 'defenseName', 'attackerLevel', 'culling', 'enabled',
      'bypassEnabled', 'runs', 'detected', 'missed', 'falsePositive', 'trueNegative', 'avgMs'];

    parts.push('# Client Integrity Sandbox - session export');
    parts.push('# generated,' + session.generatedAt);
    parts.push('# seed,' + session.configuration.seed);
    parts.push('# culling,' + session.configuration.culling);
    parts.push('# attackerLevel,' + session.configuration.attackerLevel);
    parts.push('# serverLink,' + session.environment.serverLink);
    parts.push('');
    parts.push('## results matrix (current session)');
    parts.push(toCsv(session.resultsMatrix, matrixColumns));

    if (session.benchmark && session.benchmark.rows.length) {
      var benchColumns = ['culling', 'attackerLevel', 'defenseId', 'ticks', 'runs', 'detected',
        'missed', 'falsePositive', 'trueNegative', 'detectionRate', 'avgMs', 'cpuBudgetPct',
        'hiddenReceived', 'leakTicks', 'leakedReceived', 'leadMsTotal', 'revealedByCheat'];
      parts.push('');
      parts.push('## benchmark matrix (' + session.benchmark.rows.length + ' combinations x ' +
        session.benchmark.ticksPerCombo + ' ticks)');
      parts.push(toCsv(session.benchmark.rows, benchColumns));

      parts.push('');
      parts.push('## timing analysis sweep (fast-forwarded; see note in JSON)');
      parts.push(toCsv(session.benchmark.timing,
        ['overheadMs', 'challenges', 'flagged', 'detectionRate', 'meanLatencyMs']));
    }

    if (session.challengeLatencies.length) {
      parts.push('');
      parts.push('## challenge latencies (for the histogram)');
      parts.push(toCsv(session.challengeLatencies,
        ['id', 'moduleId', 'latencyMs', 'valueOk', 'timedOut', 'z', 'anomaly']));
    }

    return parts.join('\n');
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportSession() {
    var session = buildSession();
    var stamp = session.generatedAt.replace(/[:.]/g, '-').slice(0, 19);
    download('sandbox-session-' + stamp + '.json',
      JSON.stringify(session, null, 2), 'application/json');
    download('sandbox-session-' + stamp + '.csv', sessionCsv(session), 'text/csv');
    Log.system('session exported as JSON and CSV (' +
      session.resultsMatrix.length + ' defense rows' +
      (session.benchmark ? ', ' + session.benchmark.rows.length + ' benchmark rows' : '') + ')');
    return session;
  }

  var exports = {
    runBenchmark: runBenchmark,
    cancelBenchmark: cancelBenchmark,
    buildSession: buildSession,
    sessionCsv: sessionCsv,
    exportSession: exportSession,
    toCsv: toCsv,
    getLastBenchmark: function () { return lastBenchmark; }
  };

  Sandbox.exporter = exports;
  Sandbox.registerModule('export', exports);
})(typeof self !== 'undefined' ? self : this);
