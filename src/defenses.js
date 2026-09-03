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
      // What the check actually inspects, and what it structurally cannot see.
      // Printed to the terminal the moment a defense is switched on, so the
      // limitation is on the record before the bypass demonstrates it.
      reads: spec.reads,
      blind: spec.blind,
      bypassName: spec.bypassName,
      bypassLesson: spec.bypassLesson,
      enabled: !!spec.enabled,
      bypassEnabled: false,
      lastOutcome: null,
      lastDetail: '',
      // The raw expected/observed pairs the last run compared, surfaced by the
      // inspector's watch panel. A verdict is only as convincing as the values
      // behind it, so they are kept rather than formatted away.
      lastValues: [],
      lastColumns: ['item', 'expected', 'observed'],
      lastNote: '',
      lastMs: 0,
      stats: {
        runs: 0, detected: 0, missed: 0,
        falsePositive: 0, trueNegative: 0, totalMs: 0
      }
    };
  }

  var defenses = [
    makeDefense({
      id: 'checksum',
      reads: 'fn.toString() of the 3 watched render functions',
      blind: 'a toString that has been taught to answer with the original text',
      name: 'Code checksum',
      short: 'Checksum',
      logLevel: 'def-sum',
      entry: 'checkChecksums',
      bypassName: 'toString() spoofing',
      enabled: true,
      realWorld: 'Hashing the .text section and comparing against a baseline.',
      bypassLesson: 'A checker has to READ the thing it checks, and the attacker ' +
        'controls that read. Overriding Function.prototype.toString is the exact ' +
        'analogue of a cheat keeping a pristine copy of .text in RAM and pointing ' +
        'the scanner at it.'
    }),
    makeDefense({
      id: 'hooks',
      reads: 'identity, name and arity of the 3 watched exports',
      blind: 'a cheat that unhooks itself for the duration of this call',
      name: 'Hook detection',
      short: 'Hook detect',
      logLevel: 'def-hook',
      entry: 'checkHooks',
      bypassName: 'trampoline / self-disarm',
      enabled: true,
      realWorld: 'Comparing function prologues and IAT entries against saved originals.',
      bypassLesson: 'The checker is just another function, hookable like any other. ' +
        'The cheat restores the originals immediately before the check runs and ' +
        're-installs itself immediately after. There is no root of trust in ring 3.'
    }),
    makeDefense({
      id: 'modules',
      reads: 'the module table, the private region list and the global object',
      blind: 'code appended inside a module region that is already registered',
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
      reads: 'the module bytes as fetched at load time, vs manifest.json',
      blind: 'every change made after those bytes were read — i.e. all of them',
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
      reads: 'one random 256-byte slice of one random module, per challenge',
      blind: 'a cheat answering from a pristine copy it captured before hooking',
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

      // The values are the hashes themselves. Exposing them is the point: a
      // reviewer can watch a specific digest change the instant the hook goes
      // in, and watch it stop changing once the bypass is armed.
      var values = results.map(function (r) {
        var expected = baselineHashes.get(r.key);
        if (r.missing) {
          return { label: r.key, expected: Hash.short(expected || ''), actual: 'MISSING', ok: false };
        }
        return {
          label: r.key,
          expected: Hash.short(expected || r.hex),
          actual: Hash.short(r.hex),
          ok: !expected || expected === r.hex
        };
      });

      var detail = mismatches.length
        ? mismatches.length + '/' + results.length + ' function hashes changed'
        : results.length + '/' + results.length + ' function hashes match baseline';

      return {
        alarm: mismatches.length > 0,
        detail: detail,
        values: values,
        columns: ['watched function', 'baseline SHA-256', 'current SHA-256'],
        note: 'the baseline was taken at boot; the current column is whatever ' +
          'fn.toString() returns right now'
      };
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
    var values = [];

    WATCHED.forEach(function (entry) {
      var k = key(entry);
      var current = lookup(entry.module, entry.name);
      var pristine = pristineRefs.get(k);
      if (!pristine) return;
      var meta = pristineMeta.get(k) || {};

      // The identity comparison is the only part with teeth, so it is what the
      // table shows first; name and arity are printed beside it precisely
      // because they look reassuring and are trivially forgeable.
      var replaced = current !== pristine;
      var drift = !replaced && (current.name !== meta.name || current.length !== meta.length);
      if (replaced) findings.push(k + ' reference replaced');
      else if (drift) findings.push(k + ' signature drift (name/arity)');

      values.push({
        label: k,
        expected: 'same ref · ' + meta.name + '/' + meta.length,
        actual: (replaced ? 'REPLACED' : 'same ref') + ' · ' +
          (current ? current.name + '/' + current.length : '—'),
        ok: !replaced && !drift
      });
    });

    return Promise.resolve({
      alarm: findings.length > 0,
      detail: findings.length
        ? findings.length + '/' + WATCHED.length + ' references replaced'
        : WATCHED.length + '/' + WATCHED.length + ' references identical to originals',
      values: values,
      columns: ['watched export', 'pristine reference', 'current reference'],
      note: 'name and arity are shown because they look like evidence and are ' +
        'forged in one line; only the reference comparison means anything'
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

    var mods = Object.keys(pm.modules);
    var priv = Object.keys(pm.private);

    var values = mods.map(function (id) {
      return {
        label: 'module ' + id,
        expected: 'registered + signed',
        actual: pm.modules[id].signed ? 'registered + signed' : 'NOT IN MANIFEST',
        ok: !!pm.modules[id].signed
      };
    });
    priv.forEach(function (name) {
      values.push({
        label: 'private region ' + name,
        expected: '(none should exist)',
        actual: typeof pm.private[name] === 'function' ? 'EXECUTABLE, unbacked' : 'data',
        ok: typeof pm.private[name] !== 'function'
      });
    });
    findings.forEach(function (f) {
      if (f.indexOf('new global') !== 0) return;
      values.push({ label: f.replace(/^new global function /, 'global '),
        expected: 'absent at boot', actual: 'PRESENT', ok: false });
    });

    return Promise.resolve({
      alarm: findings.length > 0,
      detail: findings.length
        ? findings.length + ' unaccounted region(s) found'
        : mods.length + ' modules + ' + priv.length + ' private regions, all accounted for',
      values: values,
      columns: ['region', 'expected', 'observed'],
      note: 'this list is self-reported by the loader — code that never ' +
        'registers does not appear on it at all'
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
        var ok = sig === expected.hmac;
        return { id: id, ok: ok, sig: sig, reason: ok ? '' : 'HMAC mismatch' };
      });
    });

    return Promise.all(jobs).then(function (results) {
      var bad = results.filter(function (r) { return !r.ok; });

      // A signature check that only reports "all good" is indistinguishable
      // from one that is not running at all, and the whole argument of this
      // defense is about what the green tick actually covers - so every
      // covered file is named with both HMACs side by side.
      var values = results.map(function (r) {
        var entry = manifest.modules[r.id];
        return {
          label: r.id + '.js',
          expected: entry ? Hash.short(entry.hmac) : 'not in manifest',
          actual: r.sig ? Hash.short(r.sig) : (r.reason || '—'),
          ok: r.ok
        };
      });

      return {
        alarm: bad.length > 0,
        detail: bad.length
          ? bad.length + '/' + results.length + ' modules FAIL: ' +
            bad.map(function (r) { return r.id; }).join(', ')
          : results.length + '/' + results.length + ' modules match manifest',
        values: values,
        columns: ['module', 'manifest HMAC', 'computed HMAC'],
        note: 'computed over the bytes fetched at ' +
          new Date(Sandbox.signing.verifiedAt).toISOString().slice(11, 19) +
          ' — these are the bytes on disk, not the code now running'
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

  function padTo(text, width) {
    var out = String(text);
    while (out.length < width) out += ' ';
    return out;
  }

  /**
   * Terminal evidence lines, derived from the same structured values the watch
   * panel renders. One source of truth: a value that appears in the table is
   * the value that was logged, and neither can drift from the other.
   */
  function evidenceFrom(values, note) {
    if (!values || !values.length) return note ? [note] : [];
    var width = values.reduce(function (m, v) { return Math.max(m, v.label.length); }, 0);
    var lines = values.map(function (v) {
      var shown = v.ok ? v.actual : v.expected + ' → ' + v.actual;
      return padTo(v.label, width + 2) + shown + (v.ok ? '  ✓' : '  ✗');
    });
    if (note) lines.push(note);
    return lines;
  }

  // One chip per outcome, so five different checks produce one comparable
  // column in the terminal rather than five differently-worded sentences.
  var BADGE = {
    detected: 'DETECT',
    missed: 'BYPASS',
    'false-positive': 'FALSE+',
    clean: 'PASS'
  };

  /**
   * What a defense can and cannot see, printed the moment it is switched on.
   *
   * Stating the blind spot before the bypass exploits it is the honest order to
   * present this in: the reviewer sees that the limitation was known and
   * declared, and then watches it be exercised. It reads as an argument rather
   * than as a gotcha.
   */
  function logScope(defense) {
    if (Log.isMuted() || !defense.reads) return;
    Log.push(defense.logLevel, defense.name + ' — ' + defense.realWorld, null, 'ARMED');
    Log.push(defense.logLevel, 'READS     ' + defense.reads, null, '');
    Log.push(defense.logLevel, 'BLIND TO  ' + defense.blind, null, '');
  }

  function reportOutcome(defense, outcome, detail, ms, tick, result) {
    var changed = defense.lastOutcome !== outcome;
    defense.lastOutcome = outcome;
    defense.lastDetail = detail;

    // Kept whether or not the terminal is muted: the watch panel reads these,
    // and a benchmark run mutes the log but still updates the UI.
    if (result) {
      defense.lastValues = result.values || [];
      defense.lastColumns = result.columns || ['item', 'expected', 'observed'];
      defense.lastNote = result.note || '';
      defense.lastMs = ms;
    }

    if (Log.isMuted()) return;
    var evidence = result ? evidenceFrom(result.values, result.note) : null;

    // Evidence is verbose, so it is printed when the verdict changes rather
    // than on every one of the two checks per second.
    var showEvidence = changed && evidence && evidence.length;

    if (outcome === 'detected') {
      if (changed) {
        Log.push('alert', padTo(defense.short, 14) + detail +
          '  ·  ' + ms.toFixed(2) + 'ms', tick, 'DETECT');
      }
    } else if (outcome === 'missed') {
      if (changed) {
        Log.push('alert', padTo(defense.short, 14) + 'reports clean while the client is ' +
          'tampered  ·  bypass: ' + defense.bypassName, tick, 'BYPASS');
      }
    } else if (outcome === 'false-positive') {
      Log.push('alert', padTo(defense.short, 14) + detail, tick, 'FALSE+');
    } else if (changed) {
      Log.push(defense.logLevel, padTo(defense.short, 14) + detail +
        '  ·  ' + ms.toFixed(2) + 'ms', tick, 'PASS');
    }

    if (showEvidence) {
      for (var i = 0; i < evidence.length; i++) {
        Log.push(defense.logLevel, evidence[i], tick, '');
      }
    }

    // The lesson comes last, after the reader has seen the verdict and the
    // evidence that the check genuinely believes itself.
    if (outcome === 'missed' && changed) Log.lesson(defense.bypassLesson, tick);
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
        return { defense: defense, result: result, ms: ms };
      }));
    });

    // Score and report only once every check has settled, walking the list in
    // the defense panel's own order. Reporting as each promise resolves put the
    // five verdicts on screen in a different sequence every run, which makes
    // them impossible to compare down a column.
    return Promise.all(jobs).then(function (rows) {
      rows.forEach(function (row) {
        var outcome = scoreOutcome(row.defense, row.result.alarm);
        reportOutcome(row.defense, outcome, row.result.detail, row.ms, tick,
          row.result);
      });
    });
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
    // The server holds the reference copy, so these are the only numbers the
    // client side ever gets to see about its own answer.
    var z = typeof verdict.z === 'number' ? verdict.z : null;
    var values = [
      { label: 'module challenged', expected: 'chosen at random by the server',
        actual: verdict.moduleId, ok: true },
      { label: 'digest', expected: "server's own copy",
        actual: verdict.valueOk ? 'matches' : 'MISMATCH', ok: !!verdict.valueOk },
      { label: 'deadline', expected: '≤ ' + P.CHALLENGE_DEADLINE_MS + 'ms',
        actual: verdict.timedOut ? 'MISSED' : 'met', ok: !verdict.timedOut },
      { label: 'round trip', expected: verdict.baselineReady
          ? verdict.baselineMean.toFixed(1) + ' ± ' + verdict.baselineStd.toFixed(1) + 'ms'
          : 'baseline still filling',
        actual: verdict.latencyMs.toFixed(1) + 'ms', ok: !verdict.anomaly },
      { label: 'z-score', expected: '< ' + P.TIMING_Z_THRESHOLD,
        actual: z === null ? '—' : z.toFixed(2), ok: !verdict.anomaly }
    ];

    reportOutcome(defense, outcome, detail, clientCostMs || 0, verdict.tick, {
      values: values,
      columns: ['challenge field', 'expected', 'observed'],
      note: 'the digest can be correct and the session still flagged — that is ' +
        'the whole point of measuring latency instead of content'
    });
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  function resetStats() {
    defenses.forEach(function (d) {
      d.stats = { runs: 0, detected: 0, missed: 0, falsePositive: 0, trueNegative: 0, totalMs: 0 };
      d.lastValues = [];
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
      var defense = byId[id];
      if (!defense) return;
      var wasEnabled = defense.enabled;
      defense.enabled = !!value;
      // Declare the check's reach the moment it is armed, once per arming.
      if (defense.enabled && !wasEnabled) {
        defense.lastOutcome = null;   // so the next run prints its evidence
        logScope(defense);
      }
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
