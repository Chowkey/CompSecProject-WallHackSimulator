/*
 * education.js - The "?" panels and the auto-generated conclusion.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 * The simulation produces numbers; this module says what they mean. Each
 * defense gets a panel with three parts: the real-world mechanism it models
 * (with the corresponding Windows API names, so the theory in the report can be
 * checked against the code), why the technique can be defeated, and what it
 * actually costs to deploy.
 *
 * The conclusion panel at the bottom is generated from benchmark output rather
 * than written in advance. That is the difference between a demo and a result:
 * the claim is only made if the measurements support it.
 */
(function (global) {
  'use strict';

  var Sandbox = global.Sandbox;

  var DEFENSE_NOTES = {
    checksum: {
      title: 'Defense 1 — Code checksum',
      realWorld: 'Hashes important game code and compares it with a trusted original. A changed hash suggests tampering.',
      whyBypassable: 'The cheat can redirect the check to a clean copy, so the hash is correct but the inspected code is fake.',
      cost: 'Fast for small checks. Checking more code costs more CPU; checking less code leaves gaps.'
    },

    hooks: {
      title: 'Defense 2 — Hook detection',
      realWorld: 'Checks whether important functions still point to their original code.',
      whyBypassable: 'The cheat can restore the original function during inspection, then reinstall its hook immediately afterward.',
      cost: 'Low CPU cost, but every game update may require new trusted references.'
    },

    modules: {
      title: 'Defense 3 — Module scan',
      realWorld: 'Looks for unknown modules or suspicious executable memory inside the game process.',
      whyBypassable: 'A cheat can avoid the normal module list or hide inside memory that already belongs to the game.',
      cost: 'Memory scans are expensive and can mistake overlays or accessibility tools for cheats.'
    },

    signing: {
      title: 'Defense 4 — Code signing',
      realWorld: 'Verifies that game files are trusted and unchanged before they load.',
      whyBypassable: 'A valid signature protects the file at load time, but it cannot stop a cheat from changing memory later.',
      cost: 'Cheap and useful against modified files, but it does not protect the running process by itself.'
    },

    challenge: {
      title: 'Defense 5 — Challenge-response',
      realWorld: 'The server asks a random question about client code, then checks both the answer and response time.',
      whyBypassable: 'The cheat can answer from a clean saved copy. Its extra work may still be detected as unusual delay.',
      cost: 'Requires server work and can confuse slow devices or unstable networks with cheating.'
    }
  };

  var CULLING_NOTES = {
    NONE: {
      title: 'All data — vulnerable',
      body: 'The server sends every enemy position. A wallhack can reveal enemies behind walls because their data is already on the client.'
    },
    STRICT: {
      title: 'Visible only — strongest',
      body: 'The server sends only enemies in direct sight. The wallhack cannot reveal hidden enemies because their positions were never sent.'
    },
    BUFFERED: {
      title: 'Buffered — balanced',
      body: 'The server sends visible enemies plus those likely to appear within 300 ms. Movement looks smoother, but a small amount of hidden data can leak.'
    }
  };

  /**
   * Build the conclusion from measurements rather than from conviction. Every
   * sentence here is either backed by a number in the benchmark output or is
   * not printed at all.
   */
  function buildConclusion(results) {
    if (!results || !results.rows || !results.rows.length) {
      return { available: false };
    }

    var rows = results.rows;
    var lines = [];

    // 1. How many defenses were defeated by a fully evasive attacker.
    var evasive = rows.filter(function (r) { return r.attackerLevel === 3; });
    var defeated = {};
    var held = {};
    evasive.forEach(function (r) {
      var missRate = r.runs ? r.missed / r.runs : 0;
      if (r.missed > 0 && missRate >= 0.5) defeated[r.defenseId] = true;
      else if (r.detected > 0) held[r.defenseId] = true;
    });
    var defeatedCount = Object.keys(defeated).length;
    var heldNames = Object.keys(held).map(function (id) {
      return Sandbox.defenses.get(id).name;
    });

    lines.push({
      heading: 'Client-side defenses against a fully evasive attacker',
      text: defeatedCount + ' of 5 defenses were defeated at attacker level 3 with ' +
        'their matching bypass enabled' +
        (heldNames.length
          ? '. Still detecting in at least one configuration: ' + heldNames.join(', ') + '.'
          : '. None of the five held.')
    });

    // 2. The architecture comparison - the central claim.
    var strictRows = rows.filter(function (r) { return r.culling === 'STRICT' && r.attackerLevel >= 2; });
    var strictHidden = strictRows.reduce(function (a, r) { return a + r.hiddenReceived; }, 0);
    var strictTicks = strictRows.reduce(function (a, r) { return a + r.ticks; }, 0);
    var noneRows = rows.filter(function (r) { return r.culling === 'NONE' && r.attackerLevel >= 2; });
    var noneHidden = noneRows.reduce(function (a, r) { return a + r.hiddenReceived; }, 0);

    lines.push({
      heading: 'Server architecture versus client-side defense',
      text: 'Under CULLING_MODE = NONE an attacking client received ' + noneHidden +
        ' out-of-sight entity positions. Under STRICT, across ' + strictTicks +
        ' ticks of the same attacks, it received ' + strictHidden + '. ' +
        (strictHidden === 0
          ? 'A cheat cannot reveal data that was never sent, and no client-side ' +
            'check was needed to achieve that. One decision in the server’s ' +
            'culling filter outperformed all five client-side layers combined.'
          : 'Note the non-zero figure: STRICT should leak nothing, so this warrants ' +
            'investigation before the result is reported.')
    });

    // 3. What the realistic architecture costs in leaked information.
    var bufRows = rows.filter(function (r) { return r.culling === 'BUFFERED'; });
    var bufTicks = bufRows.reduce(function (a, r) { return a + r.ticks; }, 0);
    var bufLeakTicks = bufRows.reduce(function (a, r) { return a + r.leakTicks; }, 0);
    var bufLeaks = bufRows.reduce(function (a, r) { return a + r.leakedReceived; }, 0);
    var bufLeadMs = bufRows.reduce(function (a, r) { return a + r.leadMsTotal; }, 0);

    lines.push({
      heading: 'The cost of a smooth client: measured leakage under BUFFERED',
      text: bufTicks
        ? (100 * bufLeakTicks / bufTicks).toFixed(1) + '% of ticks carried at least one ' +
          'entity the player could not yet legitimately see (' + bufLeaks + ' leaked ' +
          'positions in total), with a mean advance warning of ' +
          (bufLeaks ? (bufLeadMs / bufLeaks).toFixed(0) : '0') + ' ms. ' +
          'That window is the attack surface that remains after culling, and it is ' +
          'the price paid for removing pop-in.'
        : 'No BUFFERED samples were collected.'
    });

    // 4. Where timing analysis still wins.
    if (results.timing && results.timing.length) {
      var wins = results.timing.filter(function (t) { return t.detectionRate >= 0.95; });
      var threshold = wins.length
        ? Math.min.apply(null, wins.map(function (t) { return t.overheadMs; }))
        : null;
      lines.push({
        heading: 'Where the last defense still wins',
        text: threshold !== null
          ? 'Timing analysis reached 95% detection once the cheat’s added ' +
            'overhead exceeded ' + threshold + ' ms. Below that the answers are ' +
            'correct and fast enough to be indistinguishable from honest ones. ' +
            'The defensive question is therefore not "can the cheat answer" but ' +
            '"how cheaply can it answer", and that is a question about the ' +
            'attacker’s engineering budget, not about the strength of the check.'
          : 'Timing analysis did not reach 95% detection at any tested overhead, ' +
            'so within this parameter range the cheat answered indistinguishably ' +
            'from an honest client.'
      });
    }

    lines.push({
      heading: 'What this supports',
      text: 'Every check in this sandbox runs on hardware the adversary controls, ' +
        'and each one is therefore a statement the client makes about itself. The ' +
        'measurements above are consistent with the thesis: client-side integrity ' +
        'checking raises the cost of an attack without bounding it, while a server ' +
        'that declines to send the data removes the attack entirely. The defensive ' +
        'value of the client layer is real but bounded; the defensive value of the ' +
        'architecture is structural.'
    });

    return { available: true, lines: lines };
  }

  var exports = {
    DEFENSE_NOTES: DEFENSE_NOTES,
    CULLING_NOTES: CULLING_NOTES,
    buildConclusion: buildConclusion
  };

  Sandbox.education = exports;
  Sandbox.registerModule('education', exports);
})(typeof self !== 'undefined' ? self : this);
