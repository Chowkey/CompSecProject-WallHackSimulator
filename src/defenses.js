/*
 * defenses.js - The five client-side integrity checks.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 * Each defense here is a faithful, scaled-down version of a technique that real
 * anti-cheat systems use, and each one is defeated by a matching technique in
 * attacker.js. The pairing is the experiment: switch a defense on, watch it
 * work, switch its bypass on, watch it report "clean" while the client is
 * demonstrably compromised.
 *
 * ONE PIECE OF EQUIPMENT IS CAPTURED HERE AT LOAD TIME:
 *
 *   var nativeToString = Function.prototype.toString;
 *
 * This module runs before attacker.js, so that reference is pristine, and
 * Defense 5 uses it to read function source through a path the attacker's
 * Function.prototype.toString override cannot reach. That advantage exists for
 * exactly one reason: we loaded first. It is the sandbox's version of the
 * "first mover" problem that pushed Riot to make Vanguard a boot-start driver -
 * and it evaporates the moment anything gets to run before us.
 *
 * SCORING: the runner compares each verdict against Sandbox.truthOracle, which
 * records what the attacker actually did. No defense ever reads the oracle. A
 * checker that could consult ground truth would not be a checker; it would be
 * the server.
 */
(function (global) {
  'use strict';

  var Sandbox = global.Sandbox;
  var P = Sandbox.Protocol;
  var Log = Sandbox.Log;
  var Hash = Sandbox.Hash;

  // Captured before any attacker code exists. See the note above.
  var nativeToString = Function.prototype.toString;

  // Closure-held, never attached to any reachable object. A cheat can rewrite
  // the exports table freely; it cannot read this Map to learn what the
  // originals were. That is Defense 2's only real advantage.
  var pristineRefs = new Map();
  var pristineMeta = new Map();     // name -> { name, length }
  var baselineHashes = new Map();   // name -> sha256 of fn.toString() at boot
  var baselineGlobals = new Set();  // window own-property names at boot
  var moduleBaseline = {};          // moduleId -> concatenated pristine source

  var initialised = false;

  // The functions worth watching: the ones a wallhack has to touch.
  var WATCHED = [
    { module: 'client', name: 'renderMinimap' },
    { module: 'client', name: 'renderMain' },
    { module: 'client', name: 'applyPacket' }
  ];

  function region(moduleId) {
    return Sandbox.processMemory.modules[moduleId] || null;
  }

  function lookup(moduleId, name) {
    var r = region(moduleId);
    return r && r.exports ? r.exports[name] : null;
  }

  function key(entry) { return entry.module + '.' + entry.name; }

  /**
   * Reconstruct a module's current code as one string, in registration order.
   * Read through the pristine toString reference, so a spoofed
   * Function.prototype.toString does not affect it.
   */
  function liveSource(moduleId) {
    var r = region(moduleId);
    if (!r || !r.exports) return '';
    var parts = [];
    for (var i = 0; i < r.exportOrder.length; i++) {
      var name = r.exportOrder[i];
      var fn = r.exports[name];
      parts.push(name + '=' + (typeof fn === 'function' ? nativeToString.call(fn) : String(fn)));
    }
    return parts.join('\n');
  }

  /* ====================================================================== *
   * Defense definitions
   * ====================================================================== */

  function makeDefense(spec) {
    return {
      id: spec.id,
      name: spec.name,
      short: spec.short,
      logLevel: spec.logLevel,
      entry: spec.entry,            // export name the runner dispatches through
      realWorld: spec.realWorld,
      bypassName: spec.bypassName,
      bypassLesson: spec.bypassLesson,
      enabled: false,
      bypassEnabled: false,
      lastOutcome: null,
      lastDetail: '',
      stats: {
        runs: 0, detected: 0, missed: 0,
        falsePositive: 0, trueNegative: 0, totalMs: 0
      }
    };
  }

  var defenses = [
    makeDefense({
      id: 'checksum',
      name: 'Code checksum',
      short: 'Checksum',
      logLevel: 'def-sum',
      entry: 'checkChecksums',
      bypassName: 'toString() spoofing',
      realWorld: 'Hashing the .text section and comparing against a baseline.',
      bypassLesson: 'A checker has to READ the thing it checks, and the attacker ' +
        'controls that read. Overriding Function.prototype.toString is the exact ' +
        'analogue of a cheat keeping a pristine copy of .text in RAM and pointing ' +
        'the scanner at it.'
    }),
    makeDefense({
      id: 'hooks',
      name: 'Hook detection',
      short: 'Hook detect',
      logLevel: 'def-hook',
      entry: 'checkHooks',
      bypassName: 'trampoline / self-disarm',
      realWorld: 'Comparing function prologues and IAT entries against saved originals.',
      bypassLesson: 'The checker is just another function, hookable like any other. ' +
        'The cheat restores the originals immediately before the check runs and ' +
        're-installs itself immediately after. There is no root of trust in ring 3.'
    }),
    makeDefense({
      id: 'modules',
      name: 'Module enumeration',
      short: 'Module enum',
      logLevel: 'def-mod',
      entry: 'enumerateModules',
      bypassName: 'manual mapping',
      realWorld: 'EnumProcessModules plus VirtualQuery, looking for executable ' +
        'MEM_PRIVATE pages that belong to no loaded image.',
      bypassLesson: 'The module list is self-reported by the loader. Code that ' +
        'never registers is not on it. Writing the payload into a region that ' +
        'already belongs to a legitimate module leaves the scan nothing to find.'
    }),
    makeDefense({
      id: 'signing',
      name: 'Code signing',
      short: 'Code signing',
      logLevel: 'def-sign',
      entry: 'verifySignatures',
      bypassName: 'load after verification',
      realWorld: 'Authenticode / WinVerifyTrust on the image file before it is mapped.',
      bypassLesson: 'A signature proves what the file was when it was loaded. It ' +
        'says nothing about the state of memory afterwards. The cheat never ' +
        'touches the file - it edits the process.'
    }),
    makeDefense({
      id: 'challenge',
      name: 'Challenge-response',
      short: 'Challenge-resp',
      logLevel: 'def-chal',
      entry: 'answerChallenge',
      bypassName: 'pristine source cache',
      realWorld: 'Server-issued attestation over client code; TPM-backed ' +
        'attestation in Vanguard On-Demand.',
      bypassLesson: 'The cheat snapshots the original source before hooking and ' +
        'answers every challenge from that copy. The content of the answer stops ' +
        'being evidence - which is why the server also measures how long the ' +
        'answer took to produce.'
    })
  ];

  var byId = {};
  defenses.forEach(function (d) { byId[d.id] = d; });

  /* ====================================================================== *
   * DEFENSE 1 - Code checksum
   * ====================================================================== */

  /**
   * Hash the source of every watched function and compare against the baseline
   * captured at boot.
   *
   * Note the deliberate use of String(fn), i.e. fn.toString(). That is the only
   * way JavaScript can read a function's code, and it is a method the function's
   * own prototype chain controls - so it is exactly as trustworthy as asking the
   * suspect to describe themselves. Defense 1's bypass consists of nothing more
   * than answering that question differently.
   */
  function checkChecksums() {
    var jobs = WATCHED.map(function (entry) {
      var fn = lookup(entry.module, entry.name);
      if (typeof fn !== 'function') {
        return Promise.resolve({ key: key(entry), missing: true });
      }
      return Hash.sha256Hex(String(fn)).then(function (hex) {
        return { key: key(entry), hex: hex };
      });
    });

    return Promise.all(jobs).then(function (results) {
      var mismatches = [];
      results.forEach(function (r) {
        if (r.missing) { mismatches.push(r.key + ' (missing)'); return; }
        var expected = baselineHashes.get(r.key);
        if (expected && expected !== r.hex) {
          mismatches.push(r.key + ' ' + Hash.short(expected) + ' → ' + Hash.short(r.hex));
        }
      });

      var sample = results[0];
      var detail = mismatches.length
        ? mismatches.length + ' function(s) changed: ' + mismatches.join(', ')
        : 'all ' + results.length + ' hashes match (' +
          (sample && sample.hex ? 'renderMinimap=' + Hash.short(sample.hex) : '') + ')';

      return { alarm: mismatches.length > 0, detail: detail };
    });
  }

  /* ====================================================================== *
   * DEFENSE 2 - Hook detection
   * ====================================================================== */

  /**
   * Compare each watched export against the pristine reference held in a
   * closure. Also compare fn.name and fn.length, which is a second-order check
   * that only matters if identity comparison has somehow been satisfied - a
   * cheat that restores the original reference just long enough to pass.
   */
  function checkHooks() {
    var findings = [];
    WATCHED.forEach(function (entry) {
      var k = key(entry);
      var current = lookup(entry.module, entry.name);
      var pristine = pristineRefs.get(k);
      if (!pristine) return;

      if (current !== pristine) {
        findings.push(k + ' reference replaced');
        return;
      }
      var meta = pristineMeta.get(k);
      if (meta && (current.name !== meta.name || current.length !== meta.length)) {
        findings.push(k + ' signature drift (name/arity)');
      }
    });

    return Promise.resolve({
      alarm: findings.length > 0,
      detail: findings.length
        ? findings.join(', ')
        : WATCHED.length + ' references identical to originals'
    });
  }

  /* ====================================================================== *
   * DEFENSE 3 - Module enumeration
   * ====================================================================== */

  /**
   * Walk the simulated process memory looking for executable code that belongs
   * to no registered module, plus any global that appeared after boot.
   *
   * Sandbox.processMemory.private stands in for executable MEM_PRIVATE pages:
   * memory that holds code but is not backed by any loaded image. Finding one is
   * the classic signal that something was injected.
   */
  function enumerateModules() {
    var findings = [];
    var pm = Sandbox.processMemory;

    // 1. Executable regions with no owning module.
    Object.keys(pm.private).forEach(function (name) {
      if (typeof pm.private[name] === 'function') {
        findings.push('unbacked executable region "' + name + '"');
      }
    });

    // 2. Modules in the table with no manifest entry.
    Object.keys(pm.modules).forEach(function (id) {
      if (!pm.modules[id].signed) {
        findings.push('module "' + id + '" present but absent from manifest');
      }
    });

    // 3. Globals that were not there at boot.
    var current = Object.getOwnPropertyNames(global);
    for (var i = 0; i < current.length; i++) {
      var name = current[i];
      if (baselineGlobals.has(name)) continue;
      var value;
      try { value = global[name]; } catch (err) { continue; }
      if (typeof value === 'function') {
        findings.push('new global function "' + name + '"');
      }
    }

    var scanned = Object.keys(pm.modules).length + Object.keys(pm.private).length;
    return Promise.resolve({
      alarm: findings.length > 0,
      detail: findings.length
        ? findings.join(', ')
        : 'scanned ' + scanned + ' regions, all accounted for by the module table'
    });
  }

  /* ====================================================================== *
   * DEFENSE 4 - Code signing
   * ====================================================================== */

  /**
   * Re-check the HMAC of every module against the manifest.
   *
   * This is written honestly, which is why it is so unsatisfying: the source
   * text it hashes is the text that was fetched at load time, and that text is
   * never going to change, because the cheat has no interest in editing files.
   * The check therefore returns "valid" forever, no matter what happens to the
   * running code. Editing src/client.js on disk and reloading DOES trip it -
   * that is the threat it was designed for, and the only one it addresses.
   */
  function verifySignatures() {
    var manifest = Sandbox.signing.manifest;
    var jobs = Object.keys(Sandbox.processMemory.modules).map(function (id) {
      var mod = Sandbox.processMemory.modules[id];
      var expected = manifest.modules[id];
      if (!expected) return Promise.resolve({ id: id, ok: false, reason: 'not in manifest' });
      if (typeof mod.fileSource !== 'string') {
        return Promise.resolve({ id: id, ok: true, reason: 'no file copy (inline module)' });
      }
      return Hash.hmacSha256Hex(manifest.key, mod.fileSource).then(function (sig) {
        return { id: id, ok: sig === expected.hmac, reason: sig === expected.hmac ? '' : 'HMAC mismatch' };
      });
    });

    return Promise.all(jobs).then(function (results) {
      var bad = results.filter(function (r) { return !r.ok; });
      return {
        alarm: bad.length > 0,
        detail: bad.length
          ? bad.map(function (r) { return r.id + ': ' + r.reason; }).join(', ')
          : results.length + ' modules match manifest (as fetched at ' +
            new Date(Sandbox.signing.verifiedAt).toISOString().slice(11, 19) + ')'
      };
    });
  }

  /* ====================================================================== *
   * DEFENSE 5 - Challenge-response
   * ====================================================================== */

  /**
   * Answer one server challenge: hash a slice of this module's live code,
   * salted with the server's nonce.
   *
   * The nonce makes replay useless and the random slice makes caching a single
   * answer useless, so a cheat has to keep the entire original source around and
   * serve slices from it on demand. It can - see attacker.js - and then the
   * value of the answer proves nothing. What remains measurable is how long the
   * answer took, which is why the server also z-scores the latency.
   */
  function answerChallenge(challenge) {
    var text = liveSource(challenge.moduleId);
    var slice = text.slice(challenge.offset, challenge.offset + challenge.length);
    return Hash.sha256Hex(slice + challenge.nonce);
  }

  /* ====================================================================== *
   * Registration and initialisation
   * ====================================================================== */

  var exports = {
    checkChecksums: checkChecksums,
    checkHooks: checkHooks,
    enumerateModules: enumerateModules,
    verifySignatures: verifySignatures,
    answerChallenge: answerChallenge,
    liveSource: liveSource
  };

  /**
   * Capture every baseline. Must run after all modules are registered and
   * before attacker.js is loaded - main.js enforces that ordering, and the
   * fact that the ordering matters this much is itself part of the lesson.
   */
  function initialise() {
    if (initialised) return Promise.resolve();
    initialised = true;

    baselineGlobals.clear();
    Object.getOwnPropertyNames(global).forEach(function (n) { baselineGlobals.add(n); });

    var jobs = WATCHED.map(function (entry) {
      var k = key(entry);
      var fn = lookup(entry.module, entry.name);
      if (typeof fn !== 'function') return Promise.resolve();
      pristineRefs.set(k, fn);
      pristineMeta.set(k, { name: fn.name, length: fn.length });
      return Hash.sha256Hex(nativeToString.call(fn)).then(function (hex) {
        baselineHashes.set(k, hex);
      });
    });

    Object.keys(Sandbox.processMemory.modules).forEach(function (id) {
      moduleBaseline[id] = liveSource(id);
    });

    return Promise.all(jobs).then(function () {
      Log.system('defense baselines captured: ' + baselineHashes.size + ' function hashes, ' +
        pristineRefs.size + ' pristine references, ' + baselineGlobals.size + ' known globals');
    });
  }

  /* ====================================================================== *
   * The runner
   * ====================================================================== */

  function scoreOutcome(defense, alarm) {
    var shouldDetect = Sandbox.truthOracle.shouldDetect(defense.id);
    defense.stats.runs++;

    var outcome;
    if (shouldDetect && alarm) outcome = 'detected';
    else if (shouldDetect && !alarm) outcome = 'missed';
    else if (!shouldDetect && alarm) outcome = 'false-positive';
    else outcome = 'clean';

    if (outcome === 'detected') defense.stats.detected++;
    else if (outcome === 'missed') defense.stats.missed++;
    else if (outcome === 'false-positive') defense.stats.falsePositive++;
    else defense.stats.trueNegative++;

    return outcome;
  }

  function reportOutcome(defense, outcome, detail, ms, tick) {
    var changed = defense.lastOutcome !== outcome;
    defense.lastOutcome = outcome;
    defense.lastDetail = detail;

    if (Log.isMuted()) return;

    if (outcome === 'detected') {
      if (changed) {
        Log.push('alert', '⚠ ' + defense.name + ' DETECTED tampering — ' + detail +
          ' · ' + ms.toFixed(2) + 'ms', tick);
      }
    } else if (outcome === 'missed') {
      if (changed) {
        Log.push('alert', '⚠ FALSE NEGATIVE — ' + defense.name + ' reports clean, but the ' +
          'client is tampered. Bypass: ' + defense.bypassName, tick);
        Log.lesson(defense.bypassLesson, tick);
      }
    } else if (outcome === 'false-positive') {
      Log.push('alert', '⚠ FALSE POSITIVE — ' + defense.name + ': ' + detail, tick);
    } else if (changed) {
      Log.push(defense.logLevel, detail + ' ✓ · ' + ms.toFixed(2) + 'ms', tick);
    }
  }

  /**
   * Run every enabled defense once. Called every DEFENSE_INTERVAL_TICKS
   * (500 ms of simulated time), driven by tick count rather than wall clock so
   * that a fast-forwarded benchmark run produces the same number of checks as a
   * real-time run.
   */
  function runAll(tick) {
    var jobs = [];

    defenses.forEach(function (defense) {
      if (!defense.enabled) return;
      if (defense.id === 'challenge') return;   // scored on server verdicts instead

      var entryFn = exportsTable()[defense.entry];
      if (typeof entryFn !== 'function') return;

      var started = now();
      var job;
      try {
        job = Promise.resolve(entryFn());
      } catch (err) {
        job = Promise.resolve({ alarm: true, detail: 'check threw: ' + err.message });
      }

      jobs.push(job.then(function (result) {
        var ms = now() - started;
        defense.stats.totalMs += ms;
        var outcome = scoreOutcome(defense, result.alarm);
        reportOutcome(defense, outcome, result.detail, ms, tick);
      }));
    });

    return Promise.all(jobs);
  }

  /**
   * Dispatch through the module table rather than closing over the functions
   * directly. This is what makes Defense 2's trampoline bypass expressible: the
   * attacker can replace the entry in the table and the runner will call the
   * replacement, exactly as a hooked import would redirect a real call.
   */
  function exportsTable() {
    var r = region('defenses');
    return (r && r.exports) || exports;
  }

  /**
   * Score one challenge/response verdict from the server. Unlike the other
   * four, this defense is not polled - the server decides when to test, which
   * is the structural reason it is the only one that still wins anywhere.
   */
  function recordVerdict(verdict, clientCostMs) {
    var defense = byId.challenge;
    if (!defense.enabled) return;

    defense.stats.totalMs += clientCostMs || 0;
    var alarm = !verdict.valueOk || verdict.timedOut || verdict.anomaly;
    var outcome = scoreOutcome(defense, alarm);

    var detail;
    if (verdict.timedOut) detail = 'response missed the ' + P.CHALLENGE_DEADLINE_MS + 'ms deadline';
    else if (!verdict.valueOk) detail = 'digest mismatch on module ' + verdict.moduleId;
    else if (verdict.anomaly) detail = 'digest correct but latency z=' + verdict.z.toFixed(1);
    else detail = 'digest correct, latency ' + verdict.latencyMs.toFixed(1) + 'ms';

    if (outcome === 'detected' && verdict.anomaly && !Log.isMuted()) {
      Log.lesson('Timing analysis caught what content inspection could not. When the ' +
        'answer cannot be trusted, measure the physical cost of producing it.');
    }
    reportOutcome(defense, outcome, detail, clientCostMs || 0, verdict.tick);
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  function resetStats() {
    defenses.forEach(function (d) {
      d.stats = { runs: 0, detected: 0, missed: 0, falsePositive: 0, trueNegative: 0, totalMs: 0 };
      d.lastOutcome = null;
      d.lastDetail = '';
    });
  }

  Sandbox.defenses = {
    list: function () { return defenses; },
    get: function (id) { return byId[id]; },
    initialise: initialise,
    runAll: runAll,
    recordVerdict: recordVerdict,
    resetStats: resetStats,
    liveSource: liveSource,
    nativeToString: nativeToString,
    WATCHED: WATCHED,
    setEnabled: function (id, value) {
      if (byId[id]) byId[id].enabled = !!value;
    },
    setBypass: function (id, value) {
      if (byId[id]) byId[id].bypassEnabled = !!value;
    },
    anyEnabled: function () {
      return defenses.some(function (d) { return d.enabled; });
    }
  };

  Sandbox.registerModule('defenses', exports);
})(typeof self !== 'undefined' ? self : this);
