/*
 * client.js - The game client.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 * This is the untrusted side of the boundary. Everything in this file runs in
 * the page, in the same heap as the simulated cheat, which means every object
 * here is reachable and rewritable by attacker.js. That is not a flaw in the
 * design - it is the situation every real game client is in, and reproducing it
 * faithfully is the point.
 *
 * Two things here exist specifically to make the defenses meaningful:
 *
 *   1. The module registers its functions into the loader's module table
 *      (Sandbox.processMemory.modules), so Defense 3 has a list to enumerate
 *      and Defense 5 has something to challenge against.
 *
 *   2. Minimap overlays are drawn through a `renderPipeline` array that lives
 *      inside the client's own module region. A cheat that appends itself there
 *      leaves no new executable region for a module scan to find - the
 *      simulation's stand-in for manual mapping.
 */
(function (global) {
  'use strict';

  var Sandbox = global.Sandbox;
  var P = Sandbox.Protocol;
  var Log = Sandbox.Log;

  /* ====================================================================== *
   * Client state - the cheat's entire field of view
   * ====================================================================== */

  var clientState = {
    ready: false,
    tick: 0,
    t: 0,
    seed: '',
    width: 0,
    height: 0,
    grid: null,
    player: { x: 0, y: 0 },
    entities: [],
    lastKnown: {},        // id -> { x, y, tick } for the fading grey markers
    meta: { cullingMode: P.CULLING.BUFFERED, totalNpcs: 0, sentNpcs: 0, visibleNpcs: 0, leakedNpcs: 0 },

    // How much the client was told that an honest player is not entitled to
    // see. This is the quantity the whole project is about: under STRICT it is
    // zero and no cheat can be written that changes that.
    metrics: {
      ticks: 0,
      hiddenReceived: 0,   // entities sent with visible === false
      hiddenTicks: 0,      // ticks where at least one such entity arrived
      leakedReceived: 0,   // subset attributable to the BUFFERED lookahead
      leadMsTotal: 0
    }
  };

  // Deliberately global: the cheat must be able to find it, exactly as a cheat
  // in a real client finds the entity list by scanning process memory.
  Sandbox.clientState = clientState;

  var visibilityCache = { cellX: -1, cellY: -1, lit: null };

  /* ====================================================================== *
   * Packet handling
   * ====================================================================== */

  function applyWorld(msg) {
    clientState.ready = true;
    clientState.seed = msg.seed;
    clientState.width = msg.width;
    clientState.height = msg.height;
    clientState.grid = msg.grid;
    clientState.player = msg.player;
    clientState.entities = [];
    clientState.lastKnown = {};
    clientState.metrics = {
      ticks: 0, hiddenReceived: 0, hiddenTicks: 0, leakedReceived: 0, leadMsTotal: 0
    };
    visibilityCache.cellX = -1;
    Log.client('world received · ' + msg.width + '×' + msg.height +
      ' grid · client knows nothing the server did not send');
  }

  function applyPacket(packet) {
    clientState.tick = packet.tick;
    clientState.t = packet.t;
    clientState.player = packet.player;
    clientState.entities = packet.entities;
    clientState.meta = packet.meta;

    var hidden = 0;
    var leaked = 0;
    for (var i = 0; i < packet.entities.length; i++) {
      var e = packet.entities[i];
      if (e.visible) {
        clientState.lastKnown[e.id] = { x: e.x, y: e.y, tick: packet.tick };
      } else {
        hidden++;
        if (e.leaked) {
          leaked++;
          clientState.metrics.leadMsTotal += e.leadMs || 0;
        }
      }
    }

    clientState.metrics.ticks++;
    clientState.metrics.hiddenReceived += hidden;
    clientState.metrics.leakedReceived += leaked;
    if (hidden > 0) clientState.metrics.hiddenTicks++;
  }

  /* ====================================================================== *
   * Visibility for rendering
   * ====================================================================== */

  function isWall(x, y) {
    if (!clientState.grid) return true;
    if (x < 0 || y < 0 || x >= clientState.width || y >= clientState.height) return true;
    return clientState.grid[y * clientState.width + x] === 1;
  }

  // Same Bresenham walk the server uses. Here it only decides which floor tiles
  // are drawn lit; the server's copy is the one that decides what data the
  // client is allowed to have. Running it on both sides is intentional - it
  // shows that the client can compute visibility perfectly well and still not
  // be trusted with the answer.
  function lineOfSight(ax, ay, bx, by) {
    var x0 = Math.floor(ax), y0 = Math.floor(ay);
    var x1 = Math.floor(bx), y1 = Math.floor(by);
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    var err = dx - dy;
    var guard = 0;
    while (guard++ < 4096) {
      if (x0 === x1 && y0 === y1) return true;
      if (!(x0 === Math.floor(ax) && y0 === Math.floor(ay)) && isWall(x0, y0)) return false;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    return false;
  }

  function computeVisibleCells() {
    var cx = Math.floor(clientState.player.x);
    var cy = Math.floor(clientState.player.y);
    if (visibilityCache.cellX === cx && visibilityCache.cellY === cy) {
      return visibilityCache.lit;
    }
    var lit = new Uint8Array(clientState.width * clientState.height);
    var R = P.VIEW_RADIUS;
    for (var y = cy - R; y <= cy + R; y++) {
      for (var x = cx - R; x <= cx + R; x++) {
        if (x < 0 || y < 0 || x >= clientState.width || y >= clientState.height) continue;
        var dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > R * R) continue;
        if (lineOfSight(clientState.player.x, clientState.player.y, x + 0.5, y + 0.5)) {
          lit[y * clientState.width + x] = 1;
        }
      }
    }
    visibilityCache.cellX = cx;
    visibilityCache.cellY = cy;
    visibilityCache.lit = lit;
    return lit;
  }

  /* ====================================================================== *
   * Rendering
   * ====================================================================== */

  var PALETTE = {
    floorLit: '#1d2430',
    floorDark: '#12161d',
    wallLit: '#3c4657',
    wallDark: '#1a1f27',
    grid: 'rgba(255,255,255,0.03)',
    player: '#5ec8f2',
    visible: '#41d17f',   // green  - legitimately visible
    leaked: '#f0c040',    // yellow - sent early by the 300 ms buffer
    wallhack: '#f2545b',  // red    - revealed only by the cheat
    lastKnown: '#6b7688'  // grey   - last known position
  };

  function renderMain(ctx) {
    var W = ctx.canvas.width, H = ctx.canvas.height;
    ctx.fillStyle = '#0b0e13';
    ctx.fillRect(0, 0, W, H);
    if (!clientState.ready) return;

    var cs = Math.min(W / clientState.width, H / clientState.height);
    var lit = computeVisibleCells();

    for (var y = 0; y < clientState.height; y++) {
      for (var x = 0; x < clientState.width; x++) {
        var wall = isWall(x, y);
        var visible = lit[y * clientState.width + x] === 1;
        ctx.fillStyle = wall
          ? (visible ? PALETTE.wallLit : PALETTE.wallDark)
          : (visible ? PALETTE.floorLit : PALETTE.floorDark);
        ctx.fillRect(x * cs, y * cs, cs, cs);
      }
    }

    ctx.strokeStyle = PALETTE.grid;
    ctx.lineWidth = 1;
    for (var gx = 0; gx <= clientState.width; gx++) {
      ctx.beginPath(); ctx.moveTo(gx * cs, 0); ctx.lineTo(gx * cs, clientState.height * cs); ctx.stroke();
    }
    for (var gy = 0; gy <= clientState.height; gy++) {
      ctx.beginPath(); ctx.moveTo(0, gy * cs); ctx.lineTo(clientState.width * cs, gy * cs); ctx.stroke();
    }

    // The honest main view draws only entities the server marked visible.
    for (var i = 0; i < clientState.entities.length; i++) {
      var e = clientState.entities[i];
      if (!e.visible) continue;
      drawDot(ctx, e.x * cs, e.y * cs, cs * 0.32, PALETTE.visible);
      ctx.fillStyle = 'rgba(230,240,255,0.55)';
      ctx.font = Math.max(9, cs * 0.42) + 'px ui-monospace, monospace';
      ctx.fillText(e.id, e.x * cs + cs * 0.4, e.y * cs - cs * 0.3);
    }

    drawDot(ctx, clientState.player.x * cs, clientState.player.y * cs, cs * 0.36, PALETTE.player);
    ctx.strokeStyle = 'rgba(94,200,242,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(clientState.player.x * cs, clientState.player.y * cs, P.VIEW_RADIUS * cs, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawDot(ctx, x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * The minimap, and the single most important function in the project.
   *
   * Honest behaviour: fog of war. Only entities the server marked visible are
   * drawn, plus fading grey markers where entities were last seen.
   *
   * This is the function attacker.js replaces at Level 2. Defenses 1, 2 and 5
   * all watch it, and the visible difference on screen when the hook goes in is
   * the demo's turning point.
   */
  function renderMinimap(ctx) {
    var W = ctx.canvas.width, H = ctx.canvas.height;
    ctx.fillStyle = '#080a0e';
    ctx.fillRect(0, 0, W, H);
    if (!clientState.ready) return;

    var cs = Math.min(W / clientState.width, H / clientState.height);

    for (var y = 0; y < clientState.height; y++) {
      for (var x = 0; x < clientState.width; x++) {
        if (!isWall(x, y)) continue;
        ctx.fillStyle = '#232a35';
        ctx.fillRect(x * cs, y * cs, cs, cs);
      }
    }

    // Fading last-known positions for entities not currently visible.
    for (var id in clientState.lastKnown) {
      var lk = clientState.lastKnown[id];
      var age = clientState.tick - lk.tick;
      if (age <= 0 || age > P.TICK_HZ * 5) continue;
      var stillVisible = clientState.entities.some(function (e) {
        return e.id === id && e.visible;
      });
      if (stillVisible) continue;
      ctx.globalAlpha = Math.max(0, 1 - age / (P.TICK_HZ * 5)) * 0.7;
      drawDot(ctx, lk.x * cs, lk.y * cs, cs * 0.35, PALETTE.lastKnown);
      ctx.globalAlpha = 1;
    }

    for (var i = 0; i < clientState.entities.length; i++) {
      var e = clientState.entities[i];
      if (!e.visible) continue;   // fog of war, honoured
      drawDot(ctx, e.x * cs, e.y * cs, cs * 0.4, PALETTE.visible);
    }

    drawDot(ctx, clientState.player.x * cs, clientState.player.y * cs, cs * 0.45, PALETTE.player);

    runRenderPipeline(ctx, cs);
  }

  /**
   * Overlay stages, stored inside this module's own region of the simulated
   * process memory. The honest client registers none.
   *
   * A cheat that appends a stage here is running code that belongs, as far as
   * any module enumeration can tell, to the client module - which is precisely
   * why Defense 3 cannot see it. See attacker.js, bypass "manual mapping".
   */
  function runRenderPipeline(ctx, cellSize) {
    var region = Sandbox.processMemory && Sandbox.processMemory.modules.client;
    if (!region || !region.renderPipeline) return;
    for (var i = 0; i < region.renderPipeline.length; i++) {
      try {
        region.renderPipeline[i](ctx, cellSize, clientState, PALETTE);
      } catch (err) {
        Log.alert('render pipeline stage ' + i + ' threw: ' + err.message);
      }
    }
  }

  /* ====================================================================== *
   * Input
   * ====================================================================== */

  var held = Object.create(null);
  var inputSink = null;

  function readInput() {
    var dx = (held.d || held.ArrowRight ? 1 : 0) - (held.a || held.ArrowLeft ? 1 : 0);
    var dy = (held.s || held.ArrowDown ? 1 : 0) - (held.w || held.ArrowUp ? 1 : 0);
    return { dx: dx, dy: dy };
  }

  function attachInput(target, sink) {
    inputSink = sink;
    var keys = ['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

    target.addEventListener('keydown', function (event) {
      var key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (keys.indexOf(key) < 0) return;
      if (event.target && /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
      event.preventDefault();
      held[key] = true;
      if (inputSink) inputSink(readInput());
    });

    target.addEventListener('keyup', function (event) {
      var key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (keys.indexOf(key) < 0) return;
      held[key] = false;
      if (inputSink) inputSink(readInput());
    });

    target.addEventListener('blur', function () {
      for (var k in held) held[k] = false;
      if (inputSink) inputSink({ dx: 0, dy: 0 });
    });
  }

  /* ====================================================================== *
   * Registration
   * ====================================================================== */

  var exports = {
    applyWorld: applyWorld,
    applyPacket: applyPacket,
    renderMain: renderMain,
    renderMinimap: renderMinimap,
    runRenderPipeline: runRenderPipeline,
    lineOfSight: lineOfSight,
    readInput: readInput
  };

  Sandbox.client = exports;
  Sandbox.client.attachInput = attachInput;
  Sandbox.client.PALETTE = PALETTE;
  Sandbox.client.state = clientState;

  // Announce this module to the loader's module table. Everything Defense 3
  // enumerates and Defense 5 challenges comes from this call.
  Sandbox.registerModule('client', exports, { renderPipeline: [] });
})(typeof self !== 'undefined' ? self : this);
