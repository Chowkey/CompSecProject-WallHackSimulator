/*
 * attacker.js - The simulated adversary.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 * SCOPE, STATED PLAINLY: every technique below operates exclusively on objects
 * this project created - its own module table, its own exports, its own render
 * pipeline. Nothing here touches, describes, or would help anyone evade any
 * real anti-cheat product. The techniques are modelled at the level of
 * abstraction a textbook uses, because the point is to show *why* a category of
 * defense fails, not how to defeat any particular implementation.
 *
 * This file is loaded LAST, after main.js has finished verifying every module
 * signature. That ordering is not a convenience - it is Defense 4's bypass. It
 * is the sandbox's version of a userscript running at document-start, or of a
 * cheat that patches memory instead of files: every signature stays valid,
 * the manifest still matches, and the behaviour of the program has changed.
 *
 * THREE LEVELS
 *   1  Passive read   - reads clientState, changes nothing
 *   2  Wallhack       - hooks renderMinimap, draws what the fog should hide
 *   3  Evasive        - level 2 plus whichever bypasses are switched on
 *
 * The bypass checkboxes only take effect at level 3. At levels 1 and 2 the
 * cheat is deliberately naive, so the defenses have something to catch.
 */
(function (global) {
  'use strict';

  var Sandbox = global.Sandbox;
  var Log = Sandbox.Log;
  var oracle = Sandbox.truthOracle;

  var pm = Sandbox.processMemory;
  var clientRegion = pm.modules.client;
  var defenseRegion = pm.modules.defenses;

  // Captured while everything is still pristine: this file runs after the
  // loader verified the modules but before anything else touched them.
  var original = {
    renderMinimap: clientRegion.exports.renderMinimap,
    checkHooks: defenseRegion.exports.checkHooks,
    answerChallenge: defenseRegion.exports.answerChallenge,
    functionToString: Function.prototype.toString,
    fileSources: {}
  };
  Object.keys(pm.modules).forEach(function (id) {
    original.fileSources[id] = pm.modules[id].fileSource;
  });

  var settings = {
    level: 0,
    overheadMs: 0
  };

  var installed = {
    renderHook: false,
    trampoline: false,
    toStringSpoof: false,
    challengeHook: false,
    privateRegion: false,
    globalArtifact: false,
    mapped: false,
    filePatch: false
  };

  // Snapshot of the original source of every module, taken before any hook is
  // installed. This is the whole of Defense 5's bypass: keep a clean copy and
  // answer every question from it. The real-world analogue is a cheat that
  // stashes a pristine image of the game's .text section before patching it.
  var pristineSourceCache = null;

  var stats = { reads: 0, entitiesRead: 0, hiddenRevealed: 0, challengesAnswered: 0 };

  function bypassOn(id) {
    var defense = Sandbox.defenses.get(id);
    return settings.level >= 3 && defense && defense.bypassEnabled;
  }

  /* ====================================================================== *
   * The payload: draw what the fog of war is hiding
   * ====================================================================== */

  /**
   * Draw every entity the client received but was not supposed to display.
   *
   * Red   - the server sent an out-of-sight position outright (CULLING = NONE).
   * Yellow- the server sent it early on purpose, to avoid pop-in (BUFFERED).
   *
   * Under STRICT this function draws nothing, ever, because clientState simply
   * does not contain any hidden entity. No amount of cleverness on this side of
   * the boundary changes that.
   */
  function drawHiddenEntities(ctx, cellSize, state, palette) {
    var drawn = 0;
    for (var i = 0; i < state.entities.length; i++) {
      var e = state.entities[i];
      if (e.visible) continue;

      ctx.fillStyle = e.leaked ? palette.leaked : palette.wallhack;
      ctx.beginPath();
      ctx.arc(e.x * cellSize, e.y * cellSize, cellSize * 0.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = e.leaked ? 'rgba(240,192,64,0.5)' : 'rgba(242,84,91,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(state.player.x * cellSize, state.player.y * cellSize);
      ctx.lineTo(e.x * cellSize, e.y * cellSize);
      ctx.stroke();
      drawn++;
    }
    stats.hiddenRevealed += drawn;
    return drawn;
  }

  /* ====================================================================== *
   * Hook installation
   * ====================================================================== */

  function installRenderHook() {
    if (installed.renderHook) return;

    // The replacement is given the same name and arity as the original. Both
    // are trivially forgeable, which is precisely the point: of everything
    // Defense 2 inspects, only the reference comparison has any teeth.
    var hook = function renderMinimap(ctx) {
      original.renderMinimap(ctx);

      // When the payload has been manually mapped into the client's own
      // region, it already ran inside the client's render pipeline and there
      // is nothing left to do here.
      if (installed.mapped) return;

      var state = Sandbox.clientState;
      var cs = Math.min(ctx.canvas.width / state.width, ctx.canvas.height / state.height);
      var payload = pm.private.__cheat_overlay;
      if (payload) payload(ctx, cs, state, Sandbox.client.PALETTE);
    };
    Object.defineProperty(hook, 'length', { value: original.renderMinimap.length });

    clientRegion.exports.renderMinimap = hook;
    installed.renderHook = true;
  }

  function removeRenderHook() {
    if (!installed.renderHook) return;
    clientRegion.exports.renderMinimap = original.renderMinimap;
    installed.renderHook = false;
  }

  /* --- Bypass 1: Function.prototype.toString spoofing -------------------- */

  var spoofedSource = new WeakMap();

  function installToStringSpoof() {
    if (installed.toStringSpoof) return;

    spoofedSource.set(clientRegion.exports.renderMinimap,
      original.functionToString.call(original.renderMinimap));

    Function.prototype.toString = function () {
      if (spoofedSource.has(this)) return spoofedSource.get(this);
      return original.functionToString.call(this);
    };
    installed.toStringSpoof = true;

    Log.cheat('Function.prototype.toString overridden — hooked functions now ' +
      'report their original source on request');
  }

  function removeToStringSpoof() {
    if (!installed.toStringSpoof) return;
    Function.prototype.toString = original.functionToString;
    installed.toStringSpoof = false;
  }

  /* --- Bypass 2: trampoline around the hook detector --------------------- */

  function installTrampoline() {
    if (installed.trampoline) return;

    defenseRegion.exports.checkHooks = function checkHooks() {
      // Disarm, let the inspection see a pristine client, then re-arm. The
      // window of honesty lasts exactly as long as the check does.
      removeRenderHook();
      try {
        return original.checkHooks();
      } finally {
        installRenderHook();
      }
    };
    installed.trampoline = true;

    Log.cheat('trampoline installed on defenses.checkHooks — the cheat now ' +
      'unhooks itself for the duration of every inspection');
  }

  function removeTrampoline() {
    if (!installed.trampoline) return;
    defenseRegion.exports.checkHooks = original.checkHooks;
    installed.trampoline = false;
  }

  /* --- Bypass 3: manual mapping ------------------------------------------ */

  function installMapped() {
    if (installed.mapped) return;
    // Write the payload into a region that already belongs to a legitimate,
    // registered module. Nothing new appears in the module table and no
    // unbacked executable region exists for the scan to find.
    clientRegion.renderPipeline.push(drawHiddenEntities);
    installed.mapped = true;

    Log.cheat('payload manually mapped into the client module region — no new ' +
      'module, no unbacked allocation, nothing on the global object');
  }

  function removeMapped() {
    if (!installed.mapped) return;
    var i = clientRegion.renderPipeline.indexOf(drawHiddenEntities);
    if (i >= 0) clientRegion.renderPipeline.splice(i, 1);
    installed.mapped = false;
  }

  function installPrivateRegion(name, fn) {
    pm.private[name] = fn;
    installed.privateRegion = true;
  }

  function removePrivateRegion() {
    delete pm.private.__cheat_overlay;
    delete pm.private.__cheat_reader;
    installed.privateRegion = false;
  }

  function installGlobalArtifact() {
    global.__cheatOverlayDraw = drawHiddenEntities;
    installed.globalArtifact = true;
  }

  function removeGlobalArtifact() {
    try { delete global.__cheatOverlayDraw; } catch (err) { /* ignore */ }
    installed.globalArtifact = false;
  }

  /* --- Bypass 4: patch memory, not files --------------------------------- */

  function installFilePatch() {
    if (installed.filePatch) return;
    // The naive approach: edit the module on disk. It works, and code signing
    // catches it immediately. Included so the demo can show the one threat
    // signing genuinely addresses.
    Object.keys(pm.modules).forEach(function (id) {
      if (id !== 'client') return;
      pm.modules[id].fileSource = pm.modules[id].fileSource +
        '\n/* patched on disk by the naive cheat */\n';
    });
    installed.filePatch = true;

    Log.cheat('module file patched on disk — crude, and code signing will see it');
  }

  function removeFilePatch() {
    if (!installed.filePatch) return;
    Object.keys(original.fileSources).forEach(function (id) {
      if (pm.modules[id]) pm.modules[id].fileSource = original.fileSources[id];
    });
    installed.filePatch = false;
  }

  /* --- Bypass 5: answer challenges from the pristine cache --------------- */

  function captureSourceCache() {
    if (pristineSourceCache) return;
    pristineSourceCache = {};
    Object.keys(pm.modules).forEach(function (id) {
      pristineSourceCache[id] = Sandbox.defenses.liveSource(id);
    });
    Log.cheat('pristine source cache captured for ' +
      Object.keys(pristineSourceCache).length + ' modules, before any hook was installed');
  }

  function installChallengeHook() {
    if (installed.challengeHook) return;

    defenseRegion.exports.answerChallenge = function answerChallenge(challenge) {
      // Serve the slice from the copy taken before the hooks went in. The
      // digest is genuinely correct - the server has no way to tell it apart
      // from an honest answer by looking at the value.
      var text = pristineSourceCache[challenge.moduleId] || '';
      var slice = text.slice(challenge.offset, challenge.offset + challenge.length);

      // The indirection is not free. In a real cheat the cost comes from the
      // extra lookup and from keeping the shadow copy consistent; here it is a
      // controlled busy-wait so the committee can sweep it and find the
      // threshold where the server's timing analysis starts to win.
      if (settings.overheadMs > 0) {
        var end = performance.now() + settings.overheadMs;
        while (performance.now() < end) { /* deliberate spin */ }
      }

      stats.challengesAnswered++;
      return Sandbox.Hash.sha256Hex(slice + challenge.nonce);
    };
    installed.challengeHook = true;

    Log.cheat('challenge responder hooked — answers now come from the pristine ' +
      'cache with ' + settings.overheadMs + 'ms of added overhead');
  }

  function removeChallengeHook() {
    if (!installed.challengeHook) return;
    defenseRegion.exports.answerChallenge = original.answerChallenge;
    installed.challengeHook = false;
  }

  /* ====================================================================== *
   * Level management
   * ====================================================================== */

  function uninstallAll() {
    removeTrampoline();
    removeChallengeHook();
    removeRenderHook();
    removeToStringSpoof();
    removeMapped();
    removePrivateRegion();
    removeGlobalArtifact();
    removeFilePatch();
  }

  function install() {
    uninstallAll();

    if (settings.level === 0) {
      updateOracle();
      return;
    }

    if (settings.level === 1) {
      // Passive: read the entity list, log it, change nothing. The injected
      // reader still occupies an unbacked executable region, which is why
      // module enumeration is the only defense that can see a passive cheat.
      installPrivateRegion('__cheat_reader', function readEntities(state) {
        return state.entities.length;
      });
      installGlobalArtifact();
      updateOracle();
      return;
    }

    // Levels 2 and 3 both hook the minimap. Capture the clean source first -
    // once the hook is in, the original is gone.
    captureSourceCache();

    var evadeModules = bypassOn('modules');
    var evadeSigning = bypassOn('signing');

    if (evadeModules) {
      installMapped();
    } else {
      installPrivateRegion('__cheat_overlay', drawHiddenEntities);
      installGlobalArtifact();
    }

    installRenderHook();

    if (!evadeSigning) installFilePatch();
    if (bypassOn('checksum')) installToStringSpoof();
    if (bypassOn('hooks')) installTrampoline();
    if (bypassOn('challenge')) installChallengeHook();

    updateOracle();
  }

  /**
   * Tell the scoring oracle what is actually true right now.
   *
   * The oracle exists only so the results matrix can distinguish a detection
   * from a lucky guess. No defense reads it; if one could, it would not be a
   * client-side check at all.
   */
  function updateOracle() {
    oracle.attackerLevel = settings.level;
    oracle.facts.functionsHooked = installed.renderHook;
    oracle.facts.privateRegionAllocated = installed.privateRegion;
    oracle.facts.globalArtifact = installed.globalArtifact;
    oracle.facts.pipelineInjected = installed.mapped;
    oracle.facts.filesModified = installed.filePatch;
  }

  function setLevel(level) {
    settings.level = level;
    install();
    var names = ['disabled', 'Level 1 — passive read', 'Level 2 — wallhack', 'Level 3 — evasive'];
    Log.cheat('attacker ' + names[level] + (level >= 3 ? ' · bypasses: ' + activeBypasses() : ''));
  }

  function activeBypasses() {
    var on = Sandbox.defenses.list()
      .filter(function (d) { return d.bypassEnabled; })
      .map(function (d) { return d.bypassName; });
    return on.length ? on.join(', ') : 'none';
  }

  /**
   * Called once per tick from the main loop. Levels 1 and above harvest the
   * entity list; the counters feed the "information gained" column of the
   * report. Under STRICT this counts zero hidden entities forever.
   */
  function observe(tick) {
    if (settings.level === 0) return;
    var state = Sandbox.clientState;
    stats.reads++;
    stats.entitiesRead += state.entities.length;

    if (tick % 40 !== 0 || Log.isMuted()) return;

    var hidden = state.entities.filter(function (e) { return !e.visible; }).length;
    if (settings.level === 1) {
      Log.cheat('read clientState.entities → ' + state.entities.length + ' entities' +
        (hidden ? ', ' + hidden + ' of them hidden from the player' : ''), tick);
    } else {
      Log.cheat('renderMinimap hooked · drawing ' + state.entities.length + '/' +
        state.entities.length + (hidden ? ' (' + hidden + ' through walls)' : ''), tick);
    }
  }

  Sandbox.attacker = {
    setLevel: setLevel,
    getLevel: function () { return settings.level; },
    setOverhead: function (ms) {
      settings.overheadMs = ms;
      if (installed.challengeHook) {
        Log.cheat('bypass overhead set to ' + ms + 'ms');
      }
    },
    getOverhead: function () { return settings.overheadMs; },
    refresh: install,
    observe: observe,
    stats: stats,
    installed: installed,
    activeBypasses: activeBypasses,
    resetStats: function () {
      stats.reads = stats.entitiesRead = stats.hiddenRevealed = stats.challengesAnswered = 0;
    }
  };

  Log.system('attacker.js loaded — note that this happened AFTER signature ' +
    'verification completed. Every module signature is still valid.');
})(typeof self !== 'undefined' ? self : this);
