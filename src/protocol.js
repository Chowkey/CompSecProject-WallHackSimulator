/*
 * protocol.js - Message vocabulary shared by the main thread and the server.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 * The authoritative server runs inside a Web Worker, which means the only way
 * the client can reach it is by sending a message across a real memory
 * boundary. That boundary is the whole point of the project: everything the
 * client (and therefore the cheat) can possibly know is what passes through
 * this file. Keeping the vocabulary in one small module makes the size of that
 * attack surface obvious at a glance.
 *
 * Loaded in both the main thread and the server Worker.
 */
(function (global) {
  'use strict';

  var Sandbox = global.Sandbox = global.Sandbox || {};

  Sandbox.Protocol = {
    // --- main thread -> server ------------------------------------------
    INIT: 'init',                         // { seed, cullingMode, timingAnalysis }
    INPUT: 'input',                       // { dx, dy } player movement intent
    SET_CULLING: 'set-culling',           // { mode }
    SET_TIMING_ANALYSIS: 'set-timing',    // { enabled }
    SET_CHALLENGES: 'set-challenges',     // { enabled }
    SET_RUN_STATE: 'set-run-state',       // { playing, speed }
    STEP: 'step',                         // { count } advance while paused
    REGISTER_SOURCES: 'register-sources', // { sources: { moduleId: text } }
    CHALLENGE_RESPONSE: 'challenge-response', // { id, digest }
    RESET: 'reset',                       // { seed, cullingMode }
    SET_BASELINE_MODE: 'set-baseline-mode',   // { collecting }

    // --- server -> main thread ------------------------------------------
    READY: 'ready',                       // { grid, width, height, seed, npcCount }
    PACKET: 'packet',                     // the culled world snapshot, once per tick
    CHALLENGE: 'challenge',               // { id, moduleId, offset, length, nonce, deadlineMs }
    VERDICT: 'verdict',                   // result of one challenge
    LOG: 'log',                           // { level, text } terminal line from the server
    STATS: 'stats',                       // periodic server-side counters

    CULLING: {
      NONE: 'NONE',
      STRICT: 'STRICT',
      BUFFERED: 'BUFFERED'
    },

    // Simulation constants shared by both sides.
    TICK_HZ: 20,
    TICK_MS: 50,
    GRID_W: 40,
    GRID_H: 30,
    NPC_COUNT: 6,
    VIEW_RADIUS: 14,          // cells; beyond this the player sees nothing
    BUFFER_LOOKAHEAD_MS: 300, // the BUFFERED window that leaks information
    CHALLENGE_INTERVAL_TICKS: 20,  // one challenge per second of simulated time
    CHALLENGE_DEADLINE_MS: 200,
    CHALLENGE_LENGTH: 256,
    DEFENSE_INTERVAL_TICKS: 10,    // 500 ms of simulated time at 20 Hz
    TIMING_BASELINE_SAMPLES: 8,    // clean warm-up responses before z-scoring
    TIMING_Z_THRESHOLD: 3,

    // Simulated round-trip jitter, in milliseconds (standard deviation).
    //
    // Everything in this sandbox runs on one machine, so a challenge round trip
    // costs microseconds and varies almost not at all. A detector tuned against
    // that baseline would be unrealistically strong: it would flag a 2 ms
    // overhead at once, which tells us nothing about whether the technique
    // works against a real player on a real connection.
    //
    // A production server measuring response latency is competing with network
    // variance an order of magnitude larger than the cheat's overhead, so the
    // server adds this jitter before z-scoring. Sweeping it is extension
    // question 2 in docs/references.md: the detection threshold is roughly
    // TIMING_Z_THRESHOLD x NETWORK_JITTER_MS, which is the number that decides
    // whether the technique is deployable.
    NETWORK_JITTER_MS: 8
  };
})(typeof self !== 'undefined' ? self : this);
