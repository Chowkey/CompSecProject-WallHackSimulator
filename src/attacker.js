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
 *   2  Wallhack       - hooks renderMain and renderMinimap, draws what the fog
 *                      should hide: enemy silhouettes straight through walls
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
    renderMain: clientRegion.exports.renderMain,
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

  /**
   * The same payload, drawn into the first-person view - a conventional ESP
   * overlay: corner-bracketed bounding box, tracer line, and range readout.
   *
   * The only line that makes it a wallhack is the one that skips the depth
   * test, so a target standing behind a wall is painted over the wall instead
   * of being clipped by it. Everything else here is ordinary presentation. That
   * is the uncomfortable part of the lesson: the cheat is not defeating a
   * check, it is drawing data it was handed, and drawing is the client's job.
   *
   * The camera comes from clientState, where the client leaves it each frame.
   * Reading the view transform out of the client's own memory is exactly how a
   * real overlay projects world positions onto the screen; there is nothing to
   * defeat here, because the data is already on this side of the boundary.
   *
   * Targets the player can legitimately see are boxed too, in green and without
   * a tracer. That is deliberate: under CULLING = STRICT the overlay keeps
   * running at full strength and every box it can draw is one the player could
   * already see unaided. The cheat is not switched off in that demo - it is
   * starved.
   *
   * It deliberately does not touch stats.hiddenRevealed: the minimap payload
   * already counts each hidden entity once per frame, and counting it twice
   * would inflate the number this project reports.
   */
  function drawHiddenEntities3D(ctx, camera, state, palette) {
    if (!camera || typeof camera.project !== 'function') return 0;

    // Far to near, so a closer target is painted over a further one.
    var list = state.entities.slice().sort(function (a, b) {
      var da = (a.x - camera.px) * (a.x - camera.px) + (a.y - camera.py) * (a.y - camera.py);
      var db = (b.x - camera.px) * (b.x - camera.px) + (b.y - camera.py) * (b.y - camera.py);
      return db - da;
    });

    var drawn = 0;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var p = camera.project(e.x, e.y);
      if (!p) continue;

      var throughWall = !e.visible;
      var colour = throughWall
        ? (e.leaked ? palette.leaked : palette.wallhack)
        : palette.visible;
      var range = Math.sqrt((e.x - camera.px) * (e.x - camera.px) +
                            (e.y - camera.py) * (e.y - camera.py));

      if (throughWall) {
        // The whole wallhack, in one call: draw the silhouette ignoring the
        // depth buffer the renderer just built.
        camera.drawFigure(ctx, p.x, p.top, p.height, colour);
        drawTracer(ctx, camera, p, colour);
        drawn++;
      }

      drawBox(ctx, p, colour, throughWall);
      drawTag(ctx, p, e.id + '  ' + range.toFixed(1) + 'm', colour, throughWall);
    }

    drawEspStatus(ctx, state, drawn);
    return drawn;
  }

  /**
   * The overlay's own status line, drawn by the cheat rather than by the game.
   *
   * It earns its place in the demo twice over. It proves the overlay is running
   * - so a screen with no boxes on it is a screen with nothing to box, not a
   * broken cheat - and under CULLING = STRICT it sits there reading "0 through
   * walls" for as long as anyone cares to watch, which is the entire argument
   * of this project rendered as one line of text.
   */
  function drawEspStatus(ctx, state, drawn) {
    var mode = state.meta ? state.meta.cullingMode : '?';
    var hidden = 0;
    for (var i = 0; i < state.entities.length; i++) {
      if (!state.entities[i].visible) hidden++;
    }
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = drawn > 0 ? 'rgba(242,84,91,0.95)' : 'rgba(242,84,91,0.55)';
    ctx.fillText('ESP ACTIVE  ·  ' + drawn + ' drawn through walls  ·  ' +
      hidden + ' hidden in packet  ·  culling=' + mode, 12, 20);
  }

  // Corner brackets rather than a closed rectangle - it stays readable over a
  // busy wall without hiding the target inside it.
  function drawBox(ctx, p, colour, emphatic) {
    var w = p.height * 0.44;
    var x0 = p.x - w / 2, y0 = p.top, x1 = p.x + w / 2, y1 = p.top + p.height;
    var arm = Math.max(3, Math.min(w, p.height) * 0.28);

    ctx.strokeStyle = colour;
    ctx.lineWidth = emphatic ? 1.6 : 1;
    ctx.globalAlpha = emphatic ? 1 : 0.45;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + arm); ctx.lineTo(x0, y0); ctx.lineTo(x0 + arm, y0);
    ctx.moveTo(x1 - arm, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + arm);
    ctx.moveTo(x1, y1 - arm); ctx.lineTo(x1, y1); ctx.lineTo(x1 - arm, y1);
    ctx.moveTo(x0 + arm, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - arm);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // The snap line an ESP draws from the bottom of the screen to the target.
  function drawTracer(ctx, camera, p, colour) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(camera.W / 2, camera.H);
    ctx.lineTo(p.x, p.top + p.height);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawTag(ctx, p, label, colour, emphatic) {
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    // measureText is absent from the headless canvas shim, so fall back to an
    // estimate rather than throwing during the boot test.
    var metrics = ctx.measureText && ctx.measureText(label);
    var width = (metrics && metrics.width) || label.length * 6;
    ctx.fillStyle = colour;
    ctx.globalAlpha = emphatic ? 0.95 : 0.5;
    ctx.fillText(label, p.x - width / 2, p.top - 5);
    ctx.globalAlpha = 1;
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

    // The same treatment for the first-person view. Two hooked functions rather
    // than one changes nothing about what the defenses can prove - the oracle
    // fact is still simply "functions are hooked" - but it makes the point that
    // a cheat hooks wherever the data is drawn, and the defender has to guess
    // the whole list in advance.
    var hook3d = function renderMain(ctx) {
      original.renderMain(ctx);

      if (installed.mapped) return;   // already ran inside the world pipeline

      var state = Sandbox.clientState;
      var camera = state.lastCamera;   // left there by the client each frame
      if (!camera) return;             // top-down view: nothing to project onto
      var payload = pm.private.__cheat_overlay3d;
      if (payload) payload(ctx, camera, state, Sandbox.client.PALETTE);
    };
    Object.defineProperty(hook3d, 'length', { value: original.renderMain.length });

    clientRegion.exports.renderMinimap = hook;
    clientRegion.exports.renderMain = hook3d;
    installed.renderHook = true;
  }

  function removeRenderHook() {
    if (!installed.renderHook) return;
    clientRegion.exports.renderMinimap = original.renderMinimap;
    clientRegion.exports.renderMain = original.renderMain;
    installed.renderHook = false;
  }

  /* --- Bypass 1: Function.prototype.toString spoofing -------------------- */

  var spoofedSource = new WeakMap();

  function installToStringSpoof() {
    if (installed.toStringSpoof) return;

    // Every hooked function needs an entry, or Defense 1 catches the one that
    // was forgotten. That is the realistic failure mode for this bypass: it is
    // not hard, it is just book-keeping the attacker has to get exhaustively
    // right, and the defender only has to find one omission.
    spoofedSource.set(clientRegion.exports.renderMinimap,
      original.functionToString.call(original.renderMinimap));
    spoofedSource.set(clientRegion.exports.renderMain,
      original.functionToString.call(original.renderMain));

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
    clientRegion.worldPipeline.push(drawHiddenEntities3D);
    installed.mapped = true;

    Log.cheat('payload manually mapped into the client module region — no new ' +
      'module, no unbacked allocation, nothing on the global object');
  }

  function removeMapped() {
    if (!installed.mapped) return;
    var i = clientRegion.renderPipeline.indexOf(drawHiddenEntities);
    if (i >= 0) clientRegion.renderPipeline.splice(i, 1);
    var j = clientRegion.worldPipeline.indexOf(drawHiddenEntities3D);
    if (j >= 0) clientRegion.worldPipeline.splice(j, 1);
    installed.mapped = false;
  }

  function installPrivateRegion(name, fn) {
    pm.private[name] = fn;
    installed.privateRegion = true;
  }

  function removePrivateRegion() {
    delete pm.private.__cheat_overlay;
    delete pm.private.__cheat_overlay3d;
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

    // Levels 2 and 3 both hook the render path. Capture the clean source first
    // - once the hooks are in, the originals are gone.
    captureSourceCache();

    var evadeModules = bypassOn('modules');
    var evadeSigning = bypassOn('signing');

    if (evadeModules) {
      installMapped();
    } else {
      installPrivateRegion('__cheat_overlay', drawHiddenEntities);
      installPrivateRegion('__cheat_overlay3d', drawHiddenEntities3D);
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
