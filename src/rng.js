/*
 * rng.js - Seeded pseudo-random number generator.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 * Reproducibility is a requirement of the assignment: the same seed must always
 * produce the same map, the same patrol routes and the same NPC behaviour, so a
 * result shown to the review committee can be reproduced later from the seed
 * printed on screen. Math.random() cannot do that, so every random decision in
 * the simulation goes through mulberry32 seeded from a string.
 *
 * Loaded in both the main thread and the server Worker.
 */
(function (global) {
  'use strict';

  var Sandbox = global.Sandbox = global.Sandbox || {};

  // Turn an arbitrary seed string into a 32-bit integer (xfnv1a).
  function hashSeed(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // mulberry32: small, fast, and good enough for a simulation. Returns a
  // function producing floats in [0, 1).
  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * A named stream. Each subsystem (map generation, patrol routes, challenge
   * selection) takes its own stream so that adding a draw in one place does not
   * shift the sequence seen by the others - otherwise changing the map code
   * would silently change NPC behaviour for the same seed.
   */
  function createRng(seedString, streamName) {
    var state = hashSeed(String(seedString) + '/' + (streamName || 'default'));
    var next = mulberry32(state);

    return {
      seed: seedString,
      stream: streamName || 'default',
      next: next,
      // Integer in [min, max] inclusive.
      int: function (min, max) {
        return min + Math.floor(next() * (max - min + 1));
      },
      // Float in [min, max).
      float: function (min, max) {
        return min + next() * (max - min);
      },
      pick: function (arr) {
        return arr[Math.floor(next() * arr.length)];
      },
      bool: function (probability) {
        return next() < (probability === undefined ? 0.5 : probability);
      },
      // Lowercase hex string of the requested length - used for nonces.
      hex: function (length) {
        var out = '';
        while (out.length < length) {
          out += Math.floor(next() * 0x100000000).toString(16).padStart(8, '0');
        }
        return out.slice(0, length);
      }
    };
  }

  Sandbox.RNG = {
    create: createRng,
    hashSeed: hashSeed,
    mulberry32: mulberry32,
    // A fresh seed for the "randomise" button, still a readable short string.
    randomSeed: function () {
      return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    }
  };
})(typeof self !== 'undefined' ? self : this);
