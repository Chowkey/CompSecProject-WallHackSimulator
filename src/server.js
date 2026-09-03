/*
 * server.js - The authoritative server.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 * WHY THIS RUNS IN A WEB WORKER
 * -----------------------------
 * This is a deliberate architectural choice, not a performance optimisation.
 * A Worker has its own heap. Code running on the page - including the simulated
 * cheat in attacker.js - has no reference to any object in here and no way to
 * obtain one. The only channel is postMessage, and the only data that crosses
 * it is whatever the culling filter below decides to send.
 *
 * That gives the project a real, enforced version of the boundary that a game
 * server has in production, and it is what makes the central claim testable:
 * the five client-side defenses can all be defeated by code running on the
 * client, but no amount of client-side cheating can reach state that was never
 * sent. Under CULLING_MODE = STRICT a fully evasive cheat learns nothing, with
 * every defense switched off.
 *
 * When the page is opened over file://, browsers refuse to start a Worker from
 * an opaque origin. main.js then falls back to running this same code on the
 * main thread through ServerCore.create(). The simulation still runs, but the
 * memory boundary is gone - and the UI says so, because without the boundary
 * the demonstration proves considerably less.
 */
(function (global) {
  'use strict';

  var IN_WORKER = typeof importScripts === 'function' &&
                  typeof WorkerGlobalScope !== 'undefined' &&
                  global instanceof WorkerGlobalScope;

  if (IN_WORKER) {
    // Same-directory imports; the Worker is constructed with 'src/server.js'.
    //
    // The cache-busting token the loader put on this worker's own URL is
    // forwarded to them. These three copies run inside the Worker and are never
    // signature-checked - the verification in main.js covers the main thread's
    // copies - so without this a browser could serve stale constants to the
    // authoritative server while the client ran current code.
    var v = (global.location && global.location.search) || '';
    importScripts('rng.js' + v, 'protocol.js' + v, 'hash.js' + v);
  }

  var Sandbox = global.Sandbox = global.Sandbox || {};
  var P = Sandbox.Protocol;
  var Hash = Sandbox.Hash;

  var PLAYER_SPEED = 6.0;  // cells per second
  var NPC_SPEED = 3.2;     // cells per second

  // Where the player might be a moment from now: standing still, or having
  // moved in any of the eight directions. Used only by the BUFFERED lookahead.
  var PLAYER_LOOKAHEAD_DIRS = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, 0.7071], [-0.7071, -0.7071]
  ];

  /* ====================================================================== *
   * Map generation
   * ====================================================================== */

  function generateMap(rng) {
    var W = P.GRID_W, H = P.GRID_H;
    var grid = new Uint8Array(W * H);

    function set(x, y, v) {
      if (x >= 0 && x < W && y >= 0 && y < H) grid[y * W + x] = v;
    }

    // Solid border.
    for (var x = 0; x < W; x++) { set(x, 0, 1); set(x, H - 1, 1); }
    for (var y = 0; y < H; y++) { set(0, y, 1); set(W - 1, y, 1); }

    // Rectangular blocks act as the occluders the raycast has to deal with.
    // Rooms and pillars of mixed sizes give both long sight lines and tight
    // corners, which is what makes the BUFFERED leak visible in the demo.
    var blocks = rng.int(16, 22);
    for (var i = 0; i < blocks; i++) {
      var bw = rng.int(2, 7);
      var bh = rng.int(2, 5);
      var bx = rng.int(2, W - bw - 2);
      var by = rng.int(2, H - bh - 2);
      for (var dy = 0; dy < bh; dy++) {
        for (var dx = 0; dx < bw; dx++) set(bx + dx, by + dy, 1);
      }
    }

    // Carve horizontal and vertical corridors so the map stays traversable.
    for (var c = 0; c < 4; c++) {
      var cy = rng.int(3, H - 4);
      for (var cx = 1; cx < W - 1; cx++) set(cx, cy, 0);
      var cx2 = rng.int(3, W - 4);
      for (var cy2 = 1; cy2 < H - 1; cy2++) set(cx2, cy2, 0);
    }

    return { grid: grid, width: W, height: H };
  }

  function isWall(map, x, y) {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true;
    return map.grid[y * map.width + x] === 1;
  }

  // Flood fill from a start cell; used to keep every spawn point in one
  // connected region so NPCs never end up stranded behind a wall.
  function reachableCells(map, sx, sy) {
    var seen = new Uint8Array(map.width * map.height);
    var out = [];
    var queue = [{ x: sx, y: sy }];
    var head = 0;
    seen[sy * map.width + sx] = 1;
    var neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (head < queue.length) {
      var cur = queue[head++];
      out.push(cur);
      for (var i = 0; i < 4; i++) {
        var nx = cur.x + neighbours[i][0];
        var ny = cur.y + neighbours[i][1];
        if (isWall(map, nx, ny)) continue;
        var idx = ny * map.width + nx;
        if (seen[idx]) continue;
        seen[idx] = 1;
        queue.push({ x: nx, y: ny });
      }
    }
    return out;
  }

  function findOpenCell(map, rng) {
    for (var attempt = 0; attempt < 4000; attempt++) {
      var x = rng.int(1, map.width - 2);
      var y = rng.int(1, map.height - 2);
      if (!isWall(map, x, y)) return { x: x, y: y };
    }
    // Deterministic last resort, so a pathological map still yields a floor
    // cell rather than a wall the whole simulation would then be built on.
    for (var cy = 1; cy < map.height - 1; cy++) {
      for (var cx = 1; cx < map.width - 1; cx++) {
        if (!isWall(map, cx, cy)) return { x: cx, y: cy };
      }
    }
    return { x: 1, y: 1 };
  }

  // Breadth-first path between two cells, returned as a list of cells.
  function findPath(map, from, to) {
    var W = map.width, H = map.height;
    if (!from || !to || isWall(map, from.x, from.y) || isWall(map, to.x, to.y)) return null;

    var prev = new Int32Array(W * H).fill(-1);
    var start = from.y * W + from.x;
    var goal = to.y * W + to.x;
    if (start === goal) return [{ x: from.x, y: from.y }];

    var queue = [start];
    prev[start] = start;
    var head = 0;
    while (head < queue.length) {
      var cur = queue[head++];
      if (cur === goal) break;
      var cx = cur % W, cy = (cur / W) | 0;
      var neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var i = 0; i < 4; i++) {
        var nx = cx + neighbours[i][0], ny = cy + neighbours[i][1];
        if (isWall(map, nx, ny)) continue;
        var nIdx = ny * W + nx;
        if (prev[nIdx] !== -1) continue;
        prev[nIdx] = cur;
        queue.push(nIdx);
      }
    }
    if (prev[goal] === -1) return null;

    var path = [];
    var node = goal;
    var guard = W * H + 1;
    while (node !== start && guard-- > 0) {
      path.push({ x: node % W, y: (node / W) | 0 });
      node = prev[node];
    }
    if (guard <= 0) return null;
    path.push({ x: from.x, y: from.y });
    path.reverse();
    return path;
  }

  /* ====================================================================== *
   * Line of sight - Bresenham raycast on the grid
   * ====================================================================== */

  /**
   * Walk the grid cells between two points with Bresenham's line algorithm.
   * A wall on any intermediate cell blocks the line.
   *
   * This is the "pure raycast" approach, which maps onto Riot's first attempt
   * at Fog of War: correct, but pessimistic enough to cause visible pop-in -
   * exactly what CULLING_MODE = STRICT demonstrates.
   */
  function hasLineOfSight(map, ax, ay, bx, by) {
    var x0 = Math.floor(ax), y0 = Math.floor(ay);
    var x1 = Math.floor(bx), y1 = Math.floor(by);

    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    var err = dx - dy;

    var guard = 0;
    while (guard++ < 4096) {
      if (x0 === x1 && y0 === y1) return true;
      // Endpoints do not block: a target standing next to a wall is visible.
      if (!(x0 === Math.floor(ax) && y0 === Math.floor(ay)) && isWall(map, x0, y0)) {
        return false;
      }
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    return false;
  }

  function distance(ax, ay, bx, by) {
    var dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* ====================================================================== *
   * The server itself
   * ====================================================================== */

  function createServer(emit) {
    var state = null;
    var timer = null;

    // Module sources handed over at boot, before any attacker code runs. In a
    // real deployment the server would have these from the build pipeline; the
    // important property is only that they are the server's own copy, held on
    // the far side of the memory boundary where the client cannot edit them.
    var sources = {};

    var config = {
      cullingMode: P.CULLING.BUFFERED,
      timingAnalysis: true,
      challengesEnabled: true,
      playing: false,
      speed: 1,
      quiet: false            // benchmark runs suppress per-tick chatter
    };

    var challenges = {
      nextId: 1,
      pending: new Map(),
      latencies: [],          // every measured latency this session
      baseline: [],           // first N correct responses, assumed clean
      baselineMean: 0,
      baselineStd: 0,
      issued: 0,
      correct: 0,
      wrong: 0,
      timedOut: 0,
      anomalies: 0
    };

    function log(level, text) {
      if (config.quiet) return;
      emit({ type: P.LOG, level: level, text: text, tick: state ? state.tick : 0 });
    }

    /* -------------------------------------------------------------------- *
     * World construction
     * -------------------------------------------------------------------- */

    function buildWorld(seed) {
      var mapRng = Sandbox.RNG.create(seed, 'map');
      var npcRng = Sandbox.RNG.create(seed, 'npc');

      var map = generateMap(mapRng);
      var spawn = findOpenCell(map, mapRng);
      var open = reachableCells(map, spawn.x, spawn.y);

      var npcs = [];
      for (var i = 0; i < P.NPC_COUNT; i++) {
        // Patrol route: a loop through 4 reachable cells, expanded to a full
        // cell path with BFS so NPCs follow corridors instead of walking into
        // walls. The route is fixed at build time, which is what makes the
        // 300 ms BUFFERED lookahead an exact prediction rather than a guess.
        var waypoints = [];
        for (var w = 0; w < 4; w++) {
          waypoints.push(open[npcRng.int(0, open.length - 1)]);
        }
        var route = [];
        for (var k = 0; k < waypoints.length; k++) {
          var a = waypoints[k];
          var b = waypoints[(k + 1) % waypoints.length];
          var leg = findPath(map, a, b);
          if (!leg) continue;
          for (var s = 0; s < leg.length - 1; s++) route.push(leg[s]);
        }
        if (route.length < 2) route = [open[0], open[1] || open[0]];

        npcs.push({
          id: 'npc-' + (i + 1),
          route: route,
          progress: npcRng.float(0, route.length),
          x: route[0].x + 0.5,
          y: route[0].y + 0.5
        });
      }

      return {
        seed: seed,
        map: map,
        tick: 0,
        player: { x: spawn.x + 0.5, y: spawn.y + 0.5 },
        input: { dx: 0, dy: 0 },
        npcs: npcs,
        leakStats: {
          ticks: 0,
          ticksWithLeak: 0,
          leakEvents: 0,
          leadTimeMsTotal: 0,
          sentTotal: 0,
          visibleTotal: 0
        }
      };
    }

    // Position of an NPC after advancing `ticks` steps along its fixed route.
    // Used both to move NPCs and - without mutating anything - to look into the
    // near future for the BUFFERED culling mode.
    function positionAt(npc, ticks) {
      var step = NPC_SPEED / P.TICK_HZ;
      var p = npc.progress + step * ticks;
      var len = npc.route.length;
      var idx = ((Math.floor(p) % len) + len) % len;
      var frac = p - Math.floor(p);
      var a = npc.route[idx];
      var b = npc.route[(idx + 1) % len];
      return {
        x: a.x + (b.x - a.x) * frac + 0.5,
        y: a.y + (b.y - a.y) * frac + 0.5
      };
    }

    function movePlayer() {
      var step = PLAYER_SPEED / P.TICK_HZ;

      // The client sends a direction, not a distance. Since the client owns its
      // own look direction, that vector arrives already rotated into world
      // space and can be any length the client feels like sending - so the
      // server clamps it to unit length before applying the speed. Taking the
      // client's magnitude on trust is the textbook speed-hack, and the fix is
      // the same one this whole project is arguing for: validate on the side
      // the adversary does not control.
      var len = Math.sqrt(state.input.dx * state.input.dx + state.input.dy * state.input.dy);
      var scale = len > 1 ? step / len : step;
      var dx = state.input.dx * scale;
      var dy = state.input.dy * scale;

      // Axis-separated collision so sliding along a wall feels normal.
      var nx = state.player.x + dx;
      if (!isWall(state.map, Math.floor(nx), Math.floor(state.player.y))) {
        state.player.x = nx;
      }
      var ny = state.player.y + dy;
      if (!isWall(state.map, Math.floor(state.player.x), Math.floor(ny))) {
        state.player.y = ny;
      }
    }

    /* -------------------------------------------------------------------- *
     * CULLING - the core of the server-side argument
     * -------------------------------------------------------------------- */

    function buildPacket() {
      var mode = config.cullingMode;
      var px = state.player.x, py = state.player.y;
      var lookaheadTicks = Math.round(P.BUFFER_LOOKAHEAD_MS / P.TICK_MS);

      var entities = [];
      var visibleCount = 0;
      var leakedCount = 0;

      for (var i = 0; i < state.npcs.length; i++) {
        var npc = state.npcs[i];
        var visible = distance(px, py, npc.x, npc.y) <= P.VIEW_RADIUS &&
                      hasLineOfSight(state.map, px, py, npc.x, npc.y);
        if (visible) visibleCount++;

        if (mode === P.CULLING.NONE) {
          // Naive netcode: everything goes to the client, and the client is
          // trusted to draw only what it should. A wallhack simply stops
          // honouring that request. This is the architecture the project
          // argues against.
          entities.push({ id: npc.id, x: npc.x, y: npc.y, visible: visible, leaked: false });
          continue;
        }

        if (visible) {
          entities.push({ id: npc.id, x: npc.x, y: npc.y, visible: true, leaked: false });
          continue;
        }

        if (mode === P.CULLING.STRICT) {
          // Nothing is sent. A cheat cannot reveal data it never received;
          // this is the configuration where client-side integrity checking is
          // irrelevant because there is nothing to steal.
          continue;
        }

        if (mode === P.CULLING.BUFFERED) {
          // Look 300 ms into the future and send anything that could become
          // visible inside that window, so it does not pop into existence on
          // screen.
          //
          // Two things move in that window, and both have to be accounted for.
          // The NPC advances along its fixed route, which is exactly
          // predictable. The player might also round a corner, which is not -
          // so the check is run from a small set of positions the player could
          // plausibly reach, which is Riot's "expand the bounding box to catch
          // actions about to happen" in miniature. Being generous here is what
          // removes pop-in, and being generous is precisely what leaks.
          //
          // This is the smoothness/attack-surface trade-off in its clearest
          // form: the packet now contains a position the player is not yet
          // entitled to know, and a cheat reading clientState sees the NPC up
          // to 300 ms before an honest player could.
          var leadTicks = -1;
          var playerStep = PLAYER_SPEED / P.TICK_HZ;
          for (var t = 1; t <= lookaheadTicks && leadTicks < 0; t++) {
            var future = positionAt(npc, t);
            var reach = playerStep * t;
            for (var v = 0; v < PLAYER_LOOKAHEAD_DIRS.length; v++) {
              var ox = px + PLAYER_LOOKAHEAD_DIRS[v][0] * reach;
              var oy = py + PLAYER_LOOKAHEAD_DIRS[v][1] * reach;
              if (isWall(state.map, Math.floor(ox), Math.floor(oy))) continue;
              if (distance(ox, oy, future.x, future.y) <= P.VIEW_RADIUS &&
                  hasLineOfSight(state.map, ox, oy, future.x, future.y)) {
                leadTicks = t;
                break;
              }
            }
          }
          if (leadTicks > 0) {
            entities.push({
              id: npc.id, x: npc.x, y: npc.y,
              visible: false, leaked: true,
              leadMs: leadTicks * P.TICK_MS
            });
            leakedCount++;
            state.leakStats.leakEvents++;
            state.leakStats.leadTimeMsTotal += leadTicks * P.TICK_MS;
          }
        }
      }

      state.leakStats.ticks++;
      state.leakStats.sentTotal += entities.length;
      state.leakStats.visibleTotal += visibleCount;
      if (leakedCount > 0) state.leakStats.ticksWithLeak++;

      return {
        type: P.PACKET,
        tick: state.tick,
        t: state.tick / P.TICK_HZ,
        player: { x: state.player.x, y: state.player.y },
        entities: entities,
        meta: {
          cullingMode: mode,
          totalNpcs: state.npcs.length,
          sentNpcs: entities.length,
          visibleNpcs: visibleCount,
          leakedNpcs: leakedCount
        }
      };
    }

    /* -------------------------------------------------------------------- *
     * DEFENSE 5 - challenge/response with timing analysis
     * -------------------------------------------------------------------- */

    function issueChallenge() {
      var moduleIds = Object.keys(sources);
      if (!moduleIds.length) return;
      // One question at a time. Letting challenges pile up would measure the
      // queue rather than the client, and no real server would do it either.
      if (challenges.pending.size > 0) return;

      var rng = Sandbox.RNG.create(state.seed, 'challenge-' + challenges.nextId);
      var moduleId = moduleIds[rng.int(0, moduleIds.length - 1)];
      var text = sources[moduleId];
      var length = Math.min(P.CHALLENGE_LENGTH, text.length);
      var offset = rng.int(0, Math.max(0, text.length - length));
      var nonce = rng.hex(6);
      var id = challenges.nextId++;

      // The server computes the answer itself, from its own copy. It never
      // asks the client what the source "should" be - that would be another
      // self-report.
      Hash.sha256Hex(text.slice(offset, offset + length) + nonce).then(function (expected) {
        challenges.pending.set(id, {
          id: id,
          moduleId: moduleId,
          expected: expected,
          sentAt: nowMs(),
          deadline: nowMs() + P.CHALLENGE_DEADLINE_MS
        });
        challenges.issued++;
        log('def-chal', 'challenge #' + id + ' {mod:' + moduleId + ', off:' + offset +
            ', len:' + length + ', nonce:' + nonce + '}');
        emit({
          type: P.CHALLENGE,
          id: id,
          moduleId: moduleId,
          offset: offset,
          length: length,
          nonce: nonce,
          deadlineMs: P.CHALLENGE_DEADLINE_MS
        });
      });
    }

    /**
     * Simulated round-trip variance, added to every measured latency.
     *
     * Without it the sandbox would measure a same-machine function call and the
     * timing detector would look far stronger than it is in production, where
     * network jitter is the signal it has to compete against. Three uniform
     * draws are summed to get an approximately normal distribution, seeded by
     * challenge id so a given seed reproduces the same latencies.
     */
    function networkJitter(challengeId) {
      if (!P.NETWORK_JITTER_MS) return 0;
      var rng = Sandbox.RNG.create(state.seed, 'jitter-' + challengeId);
      var sum = rng.next() + rng.next() + rng.next() - 1.5;   // mean 0, sd 0.5
      return sum * 2 * P.NETWORK_JITTER_MS;
    }

    function updateBaseline(latency) {
      if (challenges.baseline.length < P.TIMING_BASELINE_SAMPLES) {
        challenges.baseline.push(latency);
        if (challenges.baseline.length === P.TIMING_BASELINE_SAMPLES) {
          var mean = challenges.baseline.reduce(function (a, b) { return a + b; }, 0) /
                     challenges.baseline.length;
          var variance = challenges.baseline.reduce(function (a, b) {
            return a + (b - mean) * (b - mean);
          }, 0) / challenges.baseline.length;
          challenges.baselineMean = mean;
          // Floor the deviation: with a very tight baseline any jitter would
          // score as a huge z and the detector would cry wolf constantly.
          challenges.baselineStd = Math.max(Math.sqrt(variance), 0.35);
          log('def-chal', 'timing baseline established: mean ' +
              mean.toFixed(2) + 'ms, sigma ' + challenges.baselineStd.toFixed(2) + 'ms (n=' +
              P.TIMING_BASELINE_SAMPLES + ')');
        }
        return null;
      }
      return (latency - challenges.baselineMean) / challenges.baselineStd;
    }

    function handleChallengeResponse(msg) {
      var pending = challenges.pending.get(msg.id);
      if (!pending) return;   // already timed out
      challenges.pending.delete(msg.id);

      var latency = Math.max(0, nowMs() - pending.sentAt + networkJitter(pending.id));
      var valueOk = msg.digest === pending.expected;
      challenges.latencies.push({ id: pending.id, latency: latency, valueOk: valueOk });

      var z = null;
      var anomaly = false;

      if (valueOk) {
        challenges.correct++;
        if (config.timingAnalysis) {
          z = updateBaseline(latency);
          if (z !== null && Math.abs(z) > P.TIMING_Z_THRESHOLD) {
            anomaly = true;
            challenges.anomalies++;
          }
        }
        log('def-chal', 'response #' + pending.id + ' ✓ correct · latency ' +
            latency.toFixed(1) + 'ms' +
            (challenges.baselineStd ? ' (baseline ' + challenges.baselineMean.toFixed(1) + 'ms)' : ''));
        if (anomaly) {
          log('alert', '⚠ ANOMALY - latency z-score ' + z.toFixed(1) +
              ', flagging session. The answer is right; the cost of producing it is not.');
        }
      } else {
        challenges.wrong++;
        log('alert', '⚠ response #' + pending.id + ' ✗ WRONG digest - client code does not ' +
            'match the server copy. Tampering detected.');
      }

      emit({
        type: P.VERDICT,
        id: pending.id,
        moduleId: pending.moduleId,
        valueOk: valueOk,
        timedOut: false,
        latencyMs: latency,
        z: z,
        anomaly: anomaly,
        baselineMean: challenges.baselineMean,
        baselineStd: challenges.baselineStd,
        baselineReady: challenges.baseline.length >= P.TIMING_BASELINE_SAMPLES
      });
    }

    function expireChallenges() {
      var now = nowMs();
      challenges.pending.forEach(function (pending, id) {
        if (now <= pending.deadline) return;
        challenges.pending.delete(id);
        challenges.timedOut++;
        log('alert', '⚠ challenge #' + id + ' TIMED OUT after ' +
            P.CHALLENGE_DEADLINE_MS + 'ms - a client that cannot answer in time is ' +
            'as suspicious as one that answers wrongly.');
        emit({
          type: P.VERDICT, id: id, moduleId: pending.moduleId,
          valueOk: false, timedOut: true, latencyMs: P.CHALLENGE_DEADLINE_MS,
          z: null, anomaly: false,
          baselineMean: challenges.baselineMean, baselineStd: challenges.baselineStd,
          baselineReady: challenges.baseline.length >= P.TIMING_BASELINE_SAMPLES
        });
      });
    }

    /* -------------------------------------------------------------------- *
     * Tick loop
     * -------------------------------------------------------------------- */

    function nowMs() {
      return (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
    }

    function tick() {
      state.tick++;
      movePlayer();

      var step = NPC_SPEED / P.TICK_HZ;
      for (var i = 0; i < state.npcs.length; i++) {
        var npc = state.npcs[i];
        npc.progress += step;
        var pos = positionAt(npc, 0);
        npc.x = pos.x;
        npc.y = pos.y;
      }

      var packet = buildPacket();
      emit(packet);

      if (!config.quiet && state.tick % 10 === 0) {
        var m = packet.meta;
        log('server', 'tick ' + state.tick + ' · culling=' + m.cullingMode +
            ' · sent ' + m.sentNpcs + '/' + m.totalNpcs +
            (m.leakedNpcs ? ' (' + m.leakedNpcs + ' leaked by buffer)' : ''));
      }

      expireChallenges();
      if (config.challengesEnabled && state.tick % P.CHALLENGE_INTERVAL_TICKS === 0) {
        issueChallenge();
      }
    }

    function scheduleLoop() {
      clearTimeout(timer);
      if (!config.playing || !state) return;
      timer = setTimeout(function () {
        tick();
        scheduleLoop();
      }, P.TICK_MS / config.speed);
    }

    /* -------------------------------------------------------------------- *
     * Message handling
     * -------------------------------------------------------------------- */

    function start(seed, cullingMode) {
      clearTimeout(timer);
      state = buildWorld(seed);
      if (cullingMode) config.cullingMode = cullingMode;
      challenges.nextId = 1;
      challenges.pending.clear();
      challenges.latencies = [];
      challenges.baseline = [];
      challenges.baselineMean = 0;
      challenges.baselineStd = 0;
      challenges.issued = challenges.correct = challenges.wrong = 0;
      challenges.timedOut = challenges.anomalies = 0;

      emit({
        type: P.READY,
        seed: seed,
        width: state.map.width,
        height: state.map.height,
        grid: state.map.grid,
        npcCount: state.npcs.length,
        player: { x: state.player.x, y: state.player.y }
      });
      log('server', 'world built from seed "' + seed + '" · ' +
          state.map.width + '×' + state.map.height + ' grid · ' +
          state.npcs.length + ' NPCs · authoritative state is worker-local');
      // Emit one packet immediately so the client can draw before play starts.
      emit(buildPacket());
    }

    function handle(msg) {
      switch (msg.type) {
        case P.INIT:
          config.cullingMode = msg.cullingMode || config.cullingMode;
          config.timingAnalysis = msg.timingAnalysis !== false;
          start(msg.seed, msg.cullingMode);
          break;

        case P.RESET:
          config.playing = false;
          start(msg.seed, msg.cullingMode);
          break;

        case P.INPUT:
          // Sanitise on arrival. Everything crossing this boundary was written
          // by code the adversary controls, including NaN and Infinity.
          if (state) {
            var idx = Number(msg.dx), idy = Number(msg.dy);
            state.input.dx = isFinite(idx) ? idx : 0;
            state.input.dy = isFinite(idy) ? idy : 0;
          }
          break;

        case P.SET_CULLING:
          config.cullingMode = msg.mode;
          log('server', 'CULLING_MODE = ' + msg.mode);
          break;

        case P.SET_TIMING_ANALYSIS:
          config.timingAnalysis = msg.enabled;
          log('server', 'TIMING_ANALYSIS = ' + (msg.enabled ? 'on' : 'off'));
          break;

        case P.SET_CHALLENGES:
          config.challengesEnabled = msg.enabled;
          break;

        case P.SET_RUN_STATE:
          config.playing = msg.playing;
          if (msg.speed) config.speed = msg.speed;
          config.quiet = !!msg.quiet;
          scheduleLoop();
          break;

        case P.STEP:
          // Used for single-stepping in the demo and for fast-forwarding the
          // benchmark, where the main thread drives ticks as fast as it can
          // instead of waiting on wall-clock pacing.
          var count = msg.count || 1;
          for (var i = 0; i < count; i++) tick();
          break;

        case P.REGISTER_SOURCES:
          sources = msg.sources || {};
          log('server', 'received reference copies of ' +
              Object.keys(sources).length + ' modules for challenge/response');
          break;

        case P.CHALLENGE_RESPONSE:
          handleChallengeResponse(msg);
          break;

        case P.SET_BASELINE_MODE:
          if (msg.reset) {
            challenges.baseline = [];
            challenges.baselineMean = 0;
            challenges.baselineStd = 0;
          }
          break;

        case 'get-stats':
          emit({
            type: P.STATS,
            tick: state ? state.tick : 0,
            leakStats: state ? state.leakStats : null,
            challenges: {
              issued: challenges.issued,
              correct: challenges.correct,
              wrong: challenges.wrong,
              timedOut: challenges.timedOut,
              anomalies: challenges.anomalies,
              baselineMean: challenges.baselineMean,
              baselineStd: challenges.baselineStd,
              latencies: challenges.latencies.slice()
            }
          });
          break;
      }
    }

    return { handle: handle };
  }

  Sandbox.ServerCore = { create: createServer };

  if (IN_WORKER) {
    var server = createServer(function (msg) { global.postMessage(msg); });
    global.onmessage = function (event) { server.handle(event.data); };
  }
})(typeof self !== 'undefined' ? self : this);
