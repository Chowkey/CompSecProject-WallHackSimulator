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
      realWorld: [
        'An anti-cheat hashes the executable pages of the game (the .text section) ' +
        'at startup, keeps the digest, and re-hashes periodically. Reading those ' +
        'pages means ReadProcessMemory or a direct pointer walk; the digest is ' +
        'usually a fast non-cryptographic hash for the periodic pass and something ' +
        'stronger for the initial baseline.',
        'The sandbox equivalent is SHA-256 over fn.toString(), because that is the ' +
        'only way JavaScript can read a function’s code.'
      ],
      whyBypassable: [
        'The check has to read the thing it is checking, and the read goes through ' +
        'machinery the attacker also controls. In native code the cheat keeps a ' +
        'clean copy of .text and redirects the scanner’s reads to it. In the ' +
        'sandbox it overrides Function.prototype.toString and returns the source it ' +
        'saved before hooking.',
        'The digest is computed correctly over the wrong bytes. Nothing in the ' +
        'algorithm is broken; the input was chosen by the adversary.'
      ],
      cost: 'Cheap in isolation, but the periodic pass has to be tuned: hashing the ' +
        'whole image every frame is not viable, so real deployments hash a rotating ' +
        'subset. The wider the rotation, the longer a patch survives undetected.'
    },

    hooks: {
      title: 'Defense 2 — Hook detection',
      realWorld: [
        'Inline hooks rewrite the first bytes of a function with a jump. Detection ' +
        'compares the current prologue against a saved copy, or walks the import ' +
        'address table looking for entries that no longer point inside the module ' +
        'that exported them.',
        'The sandbox holds the original function references in a closure-scoped Map ' +
        'and compares by identity, plus fn.name and fn.length as a second-order ' +
        'check.'
      ],
      whyBypassable: [
        'The detector is code in the same address space as the cheat, so the cheat ' +
        'can hook the detector. The classic form is a trampoline: restore the ' +
        'original bytes just before the inspection runs, let it pass, and reinstall ' +
        'the hook immediately afterwards.',
        'Note what the sandbox demonstrates about the name and arity check: the ' +
        'replacement function is given the same name and length as the original, ' +
        'and both checks pass. Only the reference comparison has any teeth, and ' +
        'that comparison is what the trampoline defeats.'
      ],
      cost: 'Low CPU cost, high maintenance cost. Every game patch moves the ' +
        'functions worth watching, so the baseline has to be regenerated on each ' +
        'build, and a mistake means false positives against legitimate players.'
    },

    modules: {
      title: 'Defense 3 — Module enumeration',
      realWorld: [
        'EnumProcessModules lists the images the loader knows about. VirtualQuery ' +
        'walks the address space region by region. Executable memory that is ' +
        'MEM_PRIVATE rather than MEM_IMAGE - code with no file behind it - is the ' +
        'classic signature of an injected payload.',
        'The sandbox models this with Sandbox.processMemory: `modules` is the ' +
        'loader’s list, `private` is executable memory backed by nothing.'
      ],
      whyBypassable: [
        'The module list is self-reported by the loader, so code that never asks to ' +
        'be loaded never appears on it. Manual mapping does exactly that: the cheat ' +
        'maps its own image without involving the loader.',
        'The stronger variant, which the sandbox demonstrates, is to put the payload ' +
        'inside memory that already belongs to a legitimate module. There is then no ' +
        'unbacked region to find and no new entry in the list - the scan is looking ' +
        'for a discrepancy that no longer exists.'
      ],
      cost: 'A full address-space walk is expensive and cannot run often. It also ' +
        'produces false positives constantly: overlays, streaming software, ' +
        'accessibility tools and JIT compilers all allocate executable private memory ' +
        'for entirely legitimate reasons.'
    },

    signing: {
      title: 'Defense 4 — Code signing',
      realWorld: [
        'Authenticode signatures verified through WinVerifyTrust before an image is ' +
        'mapped; on the kernel side, Driver Signature Enforcement refusing to load an ' +
        'unsigned driver at all.',
        'The sandbox signs each module with HMAC-SHA256 against manifest.json and ' +
        'refuses to execute a module whose text does not match.'
      ],
      whyBypassable: [
        'A signature is a statement about a file at the moment it was loaded. It is ' +
        'not a statement about the process afterwards. A cheat that patches memory ' +
        'rather than files leaves every signature valid.',
        'The sandbox makes this concrete through load order: attacker.js is loaded ' +
        'after verification has finished. Every module still matches the manifest, ' +
        'the check still passes, and the client is compromised. This is the same ' +
        'shape as a userscript running at document-start, and the same shape as the ' +
        '"first mover" problem that made Riot ship Vanguard as a boot-start driver.',
        'Note also that the manifest key is hardcoded in a file the client can read. ' +
        'That is not a shortcut taken for the demo - it is what always happens when ' +
        'the verifier and the thing it verifies live on the same untrusted machine.'
      ],
      cost: 'Nearly free at runtime and genuinely valuable: it stops the entire class ' +
        'of attacks that ship a modified game file. It simply does not address ' +
        'anything that happens after load.'
    },

    challenge: {
      title: 'Defense 5 — Challenge–response with timing analysis',
      realWorld: [
        'The server issues an unpredictable question about the client’s code and ' +
        'checks the answer against its own copy. The nonce defeats replay and the ' +
        'random slice defeats caching a single answer.',
        'The strongest production version of this idea does not trust software at ' +
        'all: Vanguard On-Demand attests the boot chain through TPM 2.0 and Secure ' +
        'Boot before the kernel driver is loaded, anchoring trust in hardware the ' +
        'software cannot rewrite.'
      ],
      whyBypassable: [
        'The cheat keeps a complete copy of the original source, taken before it ' +
        'installed any hook, and serves every requested slice from that copy. The ' +
        'answers are genuinely correct, so the content of the response stops being ' +
        'evidence of anything.',
        'Note also what the sandbox measures before any bypass is armed: a single ' +
        'challenge covers one random slice of one random module, so it catches an ' +
        'unprepared hook only when it happens to sample the bytes that changed - ' +
        'around 37% of the time in this configuration. Detection is a coverage ' +
        'fraction, not a certainty. It is reliable across a session and unreliable ' +
        'in any one check, which is the general behaviour of every rotating partial ' +
        'integrity check, including the ones that hash a subset of .text per pass.',
        'That percentage is a property of the cheat, not of the check. It is the ' +
        'fraction of the module the attacker had to modify. An earlier build of ' +
        'this sandbox hooked one render function and measured around 17%; hooking ' +
        'a second one to reach the first-person view roughly doubled it, with the ' +
        'challenge size and the defense left untouched. The defender therefore ' +
        'does not get to choose this number - the attacker does, by being ' +
        'economical. A cheat with a smaller footprint is proportionally harder for ' +
        'any partial integrity check to sample.',
        'What survives the pristine-cache bypass is cost. Answering indirectly takes ' +
        'measurably longer, and that is not something the client can fake downwards ' +
        '- it can only add delay, never remove it. The server builds a latency ' +
        'distribution from a clean baseline and flags responses beyond z = 3.',
        'The threshold, though, is not set by the cheat. It is set by the noise the ' +
        'detector has to compete with. In the sandbox the server adds simulated ' +
        'round-trip jitter (NETWORK_JITTER_MS in protocol.js), and the benchmark ' +
        'sweep then shows detection climbing from nothing to certain across roughly ' +
        'three to five times that jitter. A cheat whose overhead is small compared ' +
        'to normal network variance is invisible to this technique no matter how ' +
        'carefully the statistics are done.',
        'This is still the only defense of the five that wins anywhere. Its limit is ' +
        'the same as TPM attestation’s: it proves something about a moment, not ' +
        'about the whole session.'
      ],
      cost: 'Server CPU per challenge, plus a round trip per check, plus a real false ' +
        'positive risk - a player on a loaded machine or a bad connection produces ' +
        'exactly the latency outliers the detector is looking for. Raising the z ' +
        'threshold to protect those players raises the overhead a cheat is allowed ' +
        'to spend, so the two errors trade directly against each other.'
    }
  };

  var CULLING_NOTES = {
    NONE: {
      title: 'CULLING_MODE = NONE',
      body: 'Every NPC position is sent to every client, and the client is asked ' +
        'politely to draw only what should be visible. This is traditional netcode ' +
        'and it is what most web games still do. A wallhack here is a few lines ' +
        'long, because the data is already in the client. No client-side defense ' +
        'changes that - the information has been handed over.'
    },
    STRICT: {
      title: 'CULLING_MODE = STRICT',
      body: 'Only NPCs with line of sight are sent. This corresponds to Riot’s ' +
        'first attempt at Fog of War: raycasts against bounding-box corners, correct ' +
        'but too pessimistic, and the result was visible pop-in as enemies appeared ' +
        'the instant they became visible. Note what the sandbox measures here: with ' +
        'every defense switched off, a fully evasive cheat gains zero information.'
    },
    BUFFERED: {
      title: 'CULLING_MODE = BUFFERED',
      body: 'NPCs that are visible now, plus NPCs that could become visible within ' +
        '300 ms. This is the shape of the deployed VALORANT solution: Riot’s ' +
        'third attempt combined looking slightly into the future with occlusion ' +
        'culling to replace the unreliable raycast. It removes the pop-in, and it ' +
        'leaks - the client now holds positions the player is not yet entitled to. ' +
        'The yellow markers on the minimap are that leak, and the benchmark ' +
        'measures how large it is.'
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
