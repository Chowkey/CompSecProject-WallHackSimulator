/*
 * main.js - Loader, module table, and the main loop.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 * This file plays the part of the operating system's image loader. It fetches
 * each module, verifies its signature against manifest.json, executes exactly
 * the text it verified, and records the result in a module table
 * (Sandbox.processMemory.modules) that stands in for the PEB module list.
 *
 * It is deliberately NOT signed itself, and neither is hash.js, because the
 * verifier cannot verify itself. Something at the bottom has to be trusted by
 * assumption. Every integrity scheme has this property; naming it is more
 * honest than hiding it.
 *
 * Load order is load-bearing, in this order and for these reasons:
 *   1. verified modules execute
 *   2. defenses capture their baselines, while everything is still pristine
 *   3. attacker.js loads - after all of the above, which is Defense 4's bypass
 */
(function (global) {
  'use strict';

  var Sandbox = global.Sandbox;

  /* ====================================================================== *
   * Loader
   *
   * The module table, the simulated process memory and the scoring oracle live
   * in kernel.js, which is loaded before this file. This file is the part of
   * the loader that fetches, verifies and executes.
   * ====================================================================== */

  // Order matters: each module may use the ones above it.
  var MODULE_FILES = ['rng', 'protocol', 'log', 'client', 'defenses', 'education', 'export', 'ui'];

  // Buffered because the loader runs before log.js exists; flushed once the
  // modules are up so the terminal shows the boot sequence in order.
  var bootLog = [];
  function boot(text) { bootLog.push(text); }

  function fetchText(url) {
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      return res.text();
    });
  }

  function executeModule(id, source) {
    var script = document.createElement('script');
    // Execute the exact text that was verified, rather than pointing at the URL
    // again. Verifying one copy and then loading another would be a
    // time-of-check/time-of-use gap - a small one here, but the same shape as
    // the gap Defense 4 loses to.
    script.textContent = source + '\n//# sourceURL=' + location.origin + '/src/' + id + '.js\n';
    document.head.appendChild(script);
  }

  // One token per page load, appended to every dynamically inserted script.
  //
  // This is not incidental plumbing - it fixes a bug worth recording. Modules
  // are fetched with cache: 'no-store' and then verified against the manifest,
  // so a stale copy of one fails loudly and immediately. attacker.js is loaded
  // through a script tag and is deliberately unsigned, which meant a browser
  // could quietly serve a cached older build of it: the page looked correct,
  // every signature still verified, and only the cheat behaved like an earlier
  // version of itself.
  //
  // That is Defense 4's lesson landing on this project's own code. The file
  // nobody verifies is the file whose version nobody can be sure of.
  var CACHE_TOKEN = String(Date.now());

  function loadScriptTag(url) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = url + (url.indexOf('?') < 0 ? '?' : '&') + 'v=' + CACHE_TOKEN;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('failed to load ' + url)); };
      document.head.appendChild(script);
    });
  }

  /**
   * DEFENSE 4 in its load-time form: fetch every module, verify its HMAC
   * against the manifest, and refuse to execute anything that does not match.
   */
  function verifyAndLoad() {
    return fetchText('manifest.json').then(function (text) {
      var manifest = JSON.parse(text);
      Sandbox.signing.manifest = manifest;
      Sandbox.signing.available = true;

      var sources = {};
      return MODULE_FILES.reduce(function (chain, id) {
        return chain.then(function () {
          return fetchText('src/' + id + '.js').then(function (src) { sources[id] = src; });
        });
      }, Promise.resolve()).then(function () { return sources; });
    }).then(function (sources) {
      var manifest = Sandbox.signing.manifest;
      var jobs = MODULE_FILES.map(function (id) {
        var entry = manifest.modules[id];
        if (!entry) {
          return Promise.resolve({ id: id, ok: false, reason: 'not listed in manifest' });
        }
        return Sandbox.Hash.hmacSha256Hex(manifest.key, sources[id]).then(function (sig) {
          return {
            id: id,
            ok: sig === entry.hmac,
            reason: sig === entry.hmac ? '' : 'HMAC mismatch',
            sig: sig
          };
        });
      });

      return Promise.all(jobs).then(function (results) {
        var bad = results.filter(function (r) { return !r.ok; });
        results.forEach(function (r) { Sandbox.signing.results[r.id] = r; });
        Sandbox.signing.allValid = bad.length === 0;
        Sandbox.signing.verifiedAt = Date.now();

        if (bad.length) {
          var names = bad.map(function (r) { return r.id + '.js (' + r.reason + ')'; }).join(', ');
          throw new Error('Signature verification failed for ' + names +
            '. Run `node tools/sign.mjs` to re-sign after editing a module.');
        }

        MODULE_FILES.forEach(function (id) {
          Sandbox.mapModule(id, sources[id], true);
          executeModule(id, sources[id]);
        });

        boot('verified and loaded ' + MODULE_FILES.length +
          ' signed modules (HMAC-SHA256, backend: ' + Sandbox.Hash.backend + ')');
      });
    });
  }

  /**
   * Fallback for file:// where fetch() is blocked by the opaque origin. The
   * simulation still runs, but nothing can be verified - which the UI says out
   * loud, because an unverifiable demo proves less.
   */
  function loadUnverified() {
    Sandbox.signing.available = false;
    return MODULE_FILES.reduce(function (chain, id) {
      return chain.then(function () {
        return loadScriptTag('src/' + id + '.js').then(function () {
          // No file copy (fetch is unavailable) and nothing to compare it
          // against, so the region is marked as accounted-for rather than
          // reported as an unsigned intruder by Defense 3.
          Sandbox.mapModule(id, null, true);
        });
      });
    }, Promise.resolve());
  }

  /* ====================================================================== *
   * Server link - Worker, or same-thread fallback
   * ====================================================================== */

  var link = null;

  function connectServer(onMessage) {
    if (location.protocol === 'file:') return connectInProcess(onMessage);
    try {
      // Same reasoning as loadScriptTag: server.js is unsigned too, so a cached
      // copy would go unnoticed.
      var worker = new Worker('src/server.js?v=' + CACHE_TOKEN);
      worker.onmessage = function (event) { onMessage(event.data); };
      worker.onerror = function () {
        boot('Worker failed to start; falling back to same-thread server');
        connectInProcess(onMessage);
      };
      link = {
        kind: 'worker',
        post: function (msg) { worker.postMessage(msg); }
      };
      return Promise.resolve(link);
    } catch (err) {
      return connectInProcess(onMessage);
    }
  }

  function connectInProcess(onMessage) {
    return loadScriptTag('src/server.js').then(function () {
      var core = Sandbox.ServerCore.create(function (msg) { onMessage(msg); });
      link = {
        kind: 'in-process',
        post: function (msg) { core.handle(msg); }
      };
      return link;
    });
  }

  /* ====================================================================== *
   * Application state and the main loop
   * ====================================================================== */

  var app = {
    seed: 'valorant',
    culling: 'BUFFERED',
    playing: false,
    speed: 1,
    timingAnalysis: true,
    booted: false,
    degraded: [],
    lastPacket: null,
    challengeCostMs: 0,
    verdicts: [],
    serverStats: null
  };

  var tickWaiters = [];
  var pendingWork = Promise.resolve();

  function P() { return Sandbox.Protocol; }
  function clientExports() { return Sandbox.processMemory.modules.client.exports; }
  function defenseExports() { return Sandbox.processMemory.modules.defenses.exports; }

  function onServerMessage(msg) {
    var proto = P();
    switch (msg.type) {
      case proto.READY:
        clientExports().applyWorld(msg);
        app.seed = msg.seed;
        if (Sandbox.ui) Sandbox.ui.onWorldReady(msg);
        break;

      case proto.PACKET:
        handlePacket(msg);
        break;

      case proto.CHALLENGE:
        handleChallenge(msg);
        break;

      case proto.VERDICT:
        msg.tick = app.lastPacket ? app.lastPacket.tick : 0;
        app.verdicts.push(msg);
        Sandbox.defenses.recordVerdict(msg, app.challengeCostMs);
        if (Sandbox.ui) Sandbox.ui.onVerdict(msg);
        break;

      case proto.LOG:
        Sandbox.Log.push(msg.level, msg.text, msg.tick);
        break;

      case proto.STATS:
        app.serverStats = msg;
        if (app.statsResolve) { app.statsResolve(msg); app.statsResolve = null; }
        break;
    }
  }

  function handlePacket(packet) {
    app.lastPacket = packet;

    // Dispatch through the module table, not through a captured reference, so
    // that a hook installed on the exports actually takes effect - the same
    // reason a hooked import redirects a real call.
    clientExports().applyPacket(packet);

    if (Sandbox.attacker) Sandbox.attacker.observe(packet.tick);

    if (packet.tick % P().DEFENSE_INTERVAL_TICKS === 0) {
      pendingWork = Sandbox.defenses.runAll(packet.tick);
    }

    resolveTickWaiters();
  }

  function handleChallenge(challenge) {
    var started = performance.now();
    var answer;
    try {
      answer = Promise.resolve(defenseExports().answerChallenge(challenge));
    } catch (err) {
      answer = Promise.resolve('');
    }
    answer.then(function (digest) {
      app.challengeCostMs = performance.now() - started;
      link.post({ type: P().CHALLENGE_RESPONSE, id: challenge.id, digest: digest });
    });
  }

  function resolveTickWaiters() {
    for (var i = tickWaiters.length - 1; i >= 0; i--) {
      var waiter = tickWaiters[i];
      if (--waiter.remaining > 0) continue;
      tickWaiters.splice(i, 1);
      pendingWork.then(waiter.resolve);
    }
  }

  /* --- render loop ------------------------------------------------------ */

  var canvases = {};
  var renderPaused = false;

  var lastFrameAt = 0;

  function renderFrame(now) {
    var dt = lastFrameAt ? (now || 0) - lastFrameAt : 16;
    lastFrameAt = now || 0;

    if (!renderPaused && Sandbox.clientState && Sandbox.clientState.ready) {
      // Turning integrates over time, so it belongs on the frame clock rather
      // than on key events. Called through Sandbox.client rather than the
      // module exports table: it is camera plumbing, not something a defense
      // watches or a cheat has any reason to hook.
      if (Sandbox.client.updateCamera) Sandbox.client.updateCamera(dt);

      var exportsTable = clientExports();
      if (canvases.main) exportsTable.renderMain(canvases.main);
      if (canvases.minimap) exportsTable.renderMinimap(canvases.minimap);
    }
    requestAnimationFrame(renderFrame);
  }

  /* ====================================================================== *
   * Public control surface, used by ui.js and export.js
   * ====================================================================== */

  Sandbox.app = app;

  app.attachCanvases = function (mainCtx, minimapCtx, mainElement) {
    canvases.main = mainCtx;
    canvases.minimap = minimapCtx;
    canvases.mainElement = mainElement || (mainCtx && mainCtx.canvas) || null;
  };

  app.setPlaying = function (playing) {
    app.playing = playing;
    link.post({ type: P().SET_RUN_STATE, playing: playing, speed: app.speed, quiet: Sandbox.Log.isMuted() });
  };

  app.setSpeed = function (speed) {
    app.speed = speed;
    link.post({ type: P().SET_RUN_STATE, playing: app.playing, speed: speed, quiet: Sandbox.Log.isMuted() });
  };

  app.step = function (count) {
    link.post({ type: P().STEP, count: count || 1 });
  };

  app.setCulling = function (mode) {
    app.culling = mode;
    link.post({ type: P().SET_CULLING, mode: mode });
  };

  app.setTimingAnalysis = function (enabled) {
    app.timingAnalysis = enabled;
    link.post({ type: P().SET_TIMING_ANALYSIS, enabled: enabled });
  };

  app.setChallengesEnabled = function (enabled) {
    link.post({ type: P().SET_CHALLENGES, enabled: enabled });
  };

  app.reset = function (seed, culling) {
    app.seed = seed || app.seed;
    app.culling = culling || app.culling;
    app.playing = false;
    app.verdicts = [];
    Sandbox.defenses.resetStats();
    if (Sandbox.attacker) Sandbox.attacker.resetStats();
    link.post({ type: P().RESET, seed: app.seed, cullingMode: app.culling });
  };

  app.setRenderPaused = function (paused) { renderPaused = paused; };

  /**
   * Advance exactly n ticks and resolve once their defense work has settled.
   *
   * The ticks are fast-forwarded in chunks rather than one giant batch. The
   * server issues a challenge on a tick boundary and cannot see the answer
   * until the main thread gets a turn, so a single 500-tick batch would run the
   * whole combination first and only then answer 25 challenges back to back -
   * each one queued behind the previous one's overhead. The latencies that came
   * out of that would say more about the batching than about the cheat. One
   * chunk per challenge interval keeps every request/response pair isolated.
   */
  app.runTicks = function (n) {
    var chunk = P().CHALLENGE_INTERVAL_TICKS;
    var remaining = n;

    function nextChunk() {
      if (remaining <= 0) return Promise.resolve();
      var count = Math.min(chunk, remaining);
      remaining -= count;
      return new Promise(function (resolve) {
        tickWaiters.push({ remaining: count, resolve: resolve });
        link.post({ type: P().STEP, count: count });
      }).then(function () {
        // Yield the event loop so the challenge round-trip can complete.
        return new Promise(function (resolve) { setTimeout(resolve, 0); });
      }).then(nextChunk);
    }

    return nextChunk();
  };

  app.requestServerStats = function () {
    return new Promise(function (resolve) {
      app.statsResolve = resolve;
      link.post({ type: 'get-stats' });
    });
  };

  app.linkKind = function () { return link ? link.kind : 'none'; };

  /* ====================================================================== *
   * Boot sequence
   * ====================================================================== */

  function start() {
    var loadStrategy = (location.protocol === 'file:') ? loadUnverified : verifyAndLoad;

    return loadStrategy()
      .catch(function (err) {
        if (location.protocol === 'file:') throw err;
        // A signature failure is a hard stop - that is what refusing to load
        // means. Anything else (a missing manifest during development) falls
        // back to unverified loading with a loud warning.
        if (/Signature verification failed/.test(err.message)) throw err;
        app.degraded.push('manifest unavailable: ' + err.message);
        return loadUnverified();
      })
      .then(function () {
        if (location.protocol === 'file:') {
          app.degraded.push(
            'Opened over file:// — signatures cannot be verified, the server ' +
            'runs on the main thread instead of a Worker, and SHA-256 falls back ' +
            'to a pure-JS implementation. The memory boundary that makes the ' +
            'STRICT result meaningful is absent. Serve over http for the real demo.');
        }
        if (Sandbox.Hash.backend !== 'webcrypto') {
          app.degraded.push('crypto.subtle unavailable; using the pure-JS SHA-256 fallback.');
        }
        bootLog.forEach(function (line) { Sandbox.Log.system(line); });
        return connectServer(onServerMessage);
      })
      .then(function () {
        app.degraded.forEach(function (line) { Sandbox.Log.alert(line); });
        Sandbox.Log.system('server link established (' + link.kind + ')' +
          (link.kind === 'worker'
            ? ' — authoritative state lives in a separate heap the page cannot reach'
            : ' — WARNING: no memory boundary, the page shares a heap with the server'));

        // Baselines are captured now: every module is loaded and nothing has
        // been able to touch them yet.
        return Sandbox.defenses.initialise();
      })
      .then(function () {
        // The UI must exist before the first packet arrives. Over a Worker the
        // reply is asynchronous and the order would not matter, but the
        // same-thread fallback delivers READY synchronously inside post() - so
        // initialising afterwards would hand the UI a world it has no elements
        // to display.
        Sandbox.ui.init();
        Sandbox.client.attachInput(global, function (input) {
          link.post({ type: P().INPUT, dx: input.dx, dy: input.dy });
        }, canvases.mainElement);

        // Hand the server its own reference copies for challenge/response.
        var sources = {};
        Object.keys(Sandbox.processMemory.modules).forEach(function (id) {
          var text = Sandbox.defenses.liveSource(id);
          if (text) sources[id] = text;
        });
        link.post({ type: P().REGISTER_SOURCES, sources: sources });
        link.post({
          type: P().INIT,
          seed: app.seed,
          cullingMode: app.culling,
          timingAnalysis: app.timingAnalysis
        });

        requestAnimationFrame(renderFrame);

        // Loaded last, on purpose. See the header of attacker.js.
        boot('loading attacker.js (unsigned, cache-busted with v=' + CACHE_TOKEN + ')');
        return loadScriptTag('src/attacker.js');
      })
      .then(function () {
        app.booted = true;
        Sandbox.ui.onBooted();
        Sandbox.Log.system('boot complete — press Play, then switch the attacker on ' +
          'and watch the minimap.');
      })
      .catch(function (err) {
        var box = document.getElementById('boot-error');
        if (box) {
          box.style.display = 'block';
          box.textContent = 'Boot failed: ' + err.message;
        }
        if (Sandbox.Log) Sandbox.Log.alert('boot failed: ' + err.message);
        throw err;
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(typeof self !== 'undefined' ? self : this);
