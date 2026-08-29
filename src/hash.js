/*
 * hash.js - SHA-256 and HMAC-SHA256 for the Client Integrity Sandbox.
 *
 * EDUCATIONAL SIMULATION. This file belongs to a closed sandbox built for an
 * information-security course. It demonstrates why an integrity check running
 * on a machine the adversary controls is a self-report rather than a proof.
 * Nothing here targets real software or works outside this sandbox.
 *
 * Two implementations live here on purpose:
 *
 *   1. Web Crypto (crypto.subtle), which is what the assignment specifies.
 *   2. A pure-JS fallback, because crypto.subtle is undefined when the page is
 *      opened over file:// (opaque origin, not a secure context). The fallback
 *      keeps the demo alive; the boot banner tells the viewer the environment
 *      is degraded.
 *
 * Note on trust: main.js needs this module to verify every other module's
 * signature, so this module cannot itself be verified by that mechanism. That
 * circularity is not an oversight - it is exactly the point Defense 4 makes.
 * Something at the bottom of the stack is always trusted by assumption.
 *
 * This module is loaded both in the main thread (via <script>) and inside the
 * server Web Worker (via importScripts), so it attaches to `self` rather than
 * assuming a DOM.
 */
(function (global) {
  'use strict';

  var Sandbox = global.Sandbox = global.Sandbox || {};

  /* ---------------------------------------------------------------------- *
   * Byte / text helpers
   * ---------------------------------------------------------------------- */

  function utf8Bytes(str) {
    if (typeof TextEncoder === 'function') {
      return new TextEncoder().encode(str);
    }
    // Fallback encoder for environments without TextEncoder.
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  function toHex(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return hex;
  }

  /* ---------------------------------------------------------------------- *
   * Pure-JS SHA-256 (FIPS 180-4)
   * ---------------------------------------------------------------------- */

  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256Bytes(msg) {
    var H = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);

    var bitLen = msg.length * 8;
    // Padded length: message + 0x80 + zeros + 8-byte length, rounded to 64.
    var padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
    padded.set(msg);
    padded[msg.length] = 0x80;

    // 64-bit big-endian bit length. Lengths here never exceed 2^53, so the
    // high word is derived by division rather than 64-bit arithmetic.
    var hi = Math.floor(bitLen / 0x100000000);
    var lo = bitLen >>> 0;
    var p = padded.length;
    padded[p - 8] = (hi >>> 24) & 0xff;
    padded[p - 7] = (hi >>> 16) & 0xff;
    padded[p - 6] = (hi >>> 8) & 0xff;
    padded[p - 5] = hi & 0xff;
    padded[p - 4] = (lo >>> 24) & 0xff;
    padded[p - 3] = (lo >>> 16) & 0xff;
    padded[p - 2] = (lo >>> 8) & 0xff;
    padded[p - 1] = lo & 0xff;

    var w = new Uint32Array(64);

    for (var off = 0; off < padded.length; off += 64) {
      var i;
      for (i = 0; i < 16; i++) {
        w[i] = (padded[off + i * 4] << 24) | (padded[off + i * 4 + 1] << 16) |
               (padded[off + i * 4 + 2] << 8) | padded[off + i * 4 + 3];
      }
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      var a = H[0], b = H[1], c = H[2], d = H[3];
      var e = H[4], f = H[5], g = H[6], h = H[7];

      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;

        h = g; g = f; f = e;
        e = (d + t1) >>> 0;
        d = c; c = b; b = a;
        a = (t1 + t2) >>> 0;
      }

      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }

    var out = new Uint8Array(32);
    for (var j = 0; j < 8; j++) {
      out[j * 4] = (H[j] >>> 24) & 0xff;
      out[j * 4 + 1] = (H[j] >>> 16) & 0xff;
      out[j * 4 + 2] = (H[j] >>> 8) & 0xff;
      out[j * 4 + 3] = H[j] & 0xff;
    }
    return out;
  }

  function hmacSha256Bytes(keyBytes, msgBytes) {
    var BLOCK = 64;
    var key = keyBytes;
    if (key.length > BLOCK) key = sha256Bytes(key);

    var ipad = new Uint8Array(BLOCK + msgBytes.length);
    var opad = new Uint8Array(BLOCK + 32);
    for (var i = 0; i < BLOCK; i++) {
      var kb = i < key.length ? key[i] : 0;
      ipad[i] = kb ^ 0x36;
      opad[i] = kb ^ 0x5c;
    }
    ipad.set(msgBytes, BLOCK);
    opad.set(sha256Bytes(ipad), BLOCK);
    return sha256Bytes(opad);
  }

  /* ---------------------------------------------------------------------- *
   * Public API
   * ---------------------------------------------------------------------- */

  var subtle = (global.crypto && global.crypto.subtle) || null;

  var Hash = {
    // 'webcrypto' when crypto.subtle is available, 'pure-js' otherwise. The UI
    // surfaces this so the viewer knows which path produced the numbers.
    backend: subtle ? 'webcrypto' : 'pure-js',

    sha256HexSync: function (str) {
      return toHex(sha256Bytes(utf8Bytes(str)));
    },

    hmacSha256HexSync: function (keyStr, msgStr) {
      return toHex(hmacSha256Bytes(utf8Bytes(keyStr), utf8Bytes(msgStr)));
    },

    sha256Hex: function (str) {
      if (!subtle) return Promise.resolve(Hash.sha256HexSync(str));
      return subtle.digest('SHA-256', utf8Bytes(str))
        .then(function (buf) { return toHex(new Uint8Array(buf)); })
        .catch(function () { return Hash.sha256HexSync(str); });
    },

    hmacSha256Hex: function (keyStr, msgStr) {
      if (!subtle) return Promise.resolve(Hash.hmacSha256HexSync(keyStr, msgStr));
      return subtle.importKey(
        'raw', utf8Bytes(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      ).then(function (key) {
        return subtle.sign('HMAC', key, utf8Bytes(msgStr));
      }).then(function (buf) {
        return toHex(new Uint8Array(buf));
      }).catch(function () {
        return Hash.hmacSha256HexSync(keyStr, msgStr);
      });
    },

    // Short form used in terminal lines, e.g. "9f3a1c...".
    short: function (hex) { return hex.slice(0, 6) + '…'; }
  };

  Sandbox.Hash = Hash;
})(typeof self !== 'undefined' ? self : this);
