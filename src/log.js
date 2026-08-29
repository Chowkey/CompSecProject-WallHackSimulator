/*
 * log.js - The terminal model.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 * The terminal is where the technical depth of the project is visible during
 * grading, so it is a real subsystem rather than a wrapper around console.log:
 * a bounded ring buffer, a stable source taxonomy, and per-source filtering.
 *
 * The `lesson` level matters most. Every time a defense is defeated, the code
 * that defeats it also emits a line explaining *why* the defense could not have
 * worked. Those lines are the argument of the report, written down as the
 * simulation produces the evidence for them.
 */
(function (global) {
  'use strict';

  var Sandbox = global.Sandbox = global.Sandbox || {};

  var MAX_ENTRIES = 2000;

  // Source label + CSS class per level. The eight-character labels keep the
  // terminal columns aligned the way a real log does.
  var LEVELS = {
    system:   { label: 'SYSTEM  ', cls: 'lv-system' },
    server:   { label: 'SERVER  ', cls: 'lv-server' },
    client:   { label: 'CLIENT  ', cls: 'lv-client' },
    cheat:    { label: 'CHEAT   ', cls: 'lv-cheat' },
    'def-sum':  { label: 'DEF:sum ', cls: 'lv-def' },
    'def-hook': { label: 'DEF:hook', cls: 'lv-def' },
    'def-mod':  { label: 'DEF:mod ', cls: 'lv-def' },
    'def-sign': { label: 'DEF:sign', cls: 'lv-def' },
    'def-chal': { label: 'DEF:chal', cls: 'lv-def' },
    alert:    { label: 'ALERT   ', cls: 'lv-alert' },
    lesson:   { label: 'LESSON  ', cls: 'lv-lesson' },
    bench:    { label: 'BENCH   ', cls: 'lv-bench' }
  };

  // Which checkbox in the terminal toolbar governs which levels.
  var FILTER_GROUPS = {
    server: ['server'],
    client: ['client'],
    cheat: ['cheat'],
    defense: ['def-sum', 'def-hook', 'def-mod', 'def-sign', 'def-chal'],
    alert: ['alert'],
    lesson: ['lesson'],
    system: ['system', 'bench']
  };

  var entries = [];
  var subscribers = [];
  var seq = 0;
  var muted = false;   // benchmark runs mute the terminal to stay fast

  function levelInfo(level) {
    return LEVELS[level] || LEVELS.system;
  }

  function push(level, text, tick) {
    if (muted) return null;
    var entry = {
      seq: seq++,
      level: level,
      label: levelInfo(level).label,
      cls: levelInfo(level).cls,
      text: text,
      tick: typeof tick === 'number' ? tick : null,
      t: typeof tick === 'number' ? tick / Sandbox.Protocol.TICK_HZ : null,
      wallMs: Date.now()
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    for (var i = 0; i < subscribers.length; i++) subscribers[i](entry);
    return entry;
  }

  function format(entry) {
    var stamp = entry.t !== null
      ? '[t=' + entry.t.toFixed(2) + 's]'
      : '[t=  --  ]';
    return stamp + '[' + entry.label + '] ' + entry.text;
  }

  Sandbox.Log = {
    LEVELS: LEVELS,
    FILTER_GROUPS: FILTER_GROUPS,
    push: push,
    format: format,

    // Convenience wrappers so call sites read as prose.
    system: function (t, tick) { return push('system', t, tick); },
    server: function (t, tick) { return push('server', t, tick); },
    client: function (t, tick) { return push('client', t, tick); },
    cheat: function (t, tick) { return push('cheat', t, tick); },
    alert: function (t, tick) { return push('alert', t, tick); },
    lesson: function (t, tick) { return push('lesson', t, tick); },
    bench: function (t, tick) { return push('bench', t, tick); },

    subscribe: function (fn) {
      subscribers.push(fn);
      return function () {
        var i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },

    all: function () { return entries.slice(); },
    clear: function () {
      entries.length = 0;
      for (var i = 0; i < subscribers.length; i++) subscribers[i](null);
    },
    setMuted: function (value) { muted = !!value; },
    isMuted: function () { return muted; },

    groupFor: function (level) {
      for (var group in FILTER_GROUPS) {
        if (FILTER_GROUPS[group].indexOf(level) >= 0) return group;
      }
      return 'system';
    }
  };
})(typeof self !== 'undefined' ? self : this);
