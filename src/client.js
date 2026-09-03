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
 * Three things here exist specifically to make the defenses meaningful:
 *
 *   1. The module registers its functions into the loader's module table
 *      (Sandbox.processMemory.modules), so Defense 3 has a list to enumerate
 *      and Defense 5 has something to challenge against.
 *
 *   2. Overlay stages are drawn through pipeline arrays that live inside the
 *      client's own module region - `renderPipeline` for the minimap and
 *      `worldPipeline` for the first-person view. A cheat that appends itself
 *      there leaves no new executable region for a module scan to find - the
 *      simulation's stand-in for manual mapping.
 *
 *   3. The camera derived each frame is left on clientState. A real wallhack
 *      reads the view matrix out of the client's memory for exactly this
 *      reason: to project world positions onto the screen the player is
 *      looking at. Hiding it here would misrepresent the problem.
 *
 * The first-person view is a hand-written DDA raycaster on the same 40x30 wall
 * grid the server culls against - no engine, no WebGL, no dependency. It is a
 * presentation choice, not a security claim: the renderer decides how the data
 * looks, never what data the client is given.
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

    // The look direction belongs to the client; the position does not. The
    // server owns where the player is and validates every movement vector it
    // is sent. Splitting it this way is how a real client works, and it means
    // the packet format does not change at all to support a 3D view.
    camera: { yaw: 0, fov: Math.PI / 3 },

    // The projection derived on the most recent frame, left in plain sight.
    // See note 3 in the file header.
    lastCamera: null,

    viewMode: '3D',       // '3D' first-person, or '2D' top-down

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
    clientState.camera.yaw = 0;
    clientState.lastCamera = null;
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
   * Palette
   *
   * The four entity colours are load-bearing: the whole demo turns on being
   * able to say "that one is red, so the server should never have sent it".
   * They are shared with the legend in ui.js so the two can never drift.
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
    lastKnown: '#6b7688', // grey   - last known position

    // First-person surfaces.
    ceilNear: '#161d29',
    ceilFar: '#0c1017',
    floorNear: '#1b222d',
    floorFar: '#0c1017',
    fog: '#0a0d12'
  };

  /* ====================================================================== *
   * Colour helpers
   *
   * Shades are precomputed into small tables because the raycaster picks a
   * colour per screen column, and building CSS colour strings in that loop
   * would dominate the frame time.
   * ====================================================================== */

  function hexRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mixRgb(a, b, t) {
    return 'rgb(' +
      Math.round(a[0] + (b[0] - a[0]) * t) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * t) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * t) + ')';
  }

  function rampTable(fromHex, toHex, steps) {
    var a = hexRgb(fromHex), b = hexRgb(toHex), out = [];
    for (var i = 0; i < steps; i++) out.push(mixRgb(a, b, i / (steps - 1)));
    return out;
  }

  var SHADE_STEPS = 32;
  var BANDS = 18;
  var shades = null;

  function buildShadeTables() {
    if (shades) return shades;
    shades = {
      wall: [
        rampTable(PALETTE.wallLit, PALETTE.fog, SHADE_STEPS),   // side 0: E/W faces
        rampTable(PALETTE.wallDark, PALETTE.fog, SHADE_STEPS)   // side 1: N/S faces
      ],
      ceil: rampTable(PALETTE.ceilFar, PALETTE.ceilNear, BANDS),
      floor: rampTable(PALETTE.floorNear, PALETTE.floorFar, BANDS)
    };
    return shades;
  }

  /* ====================================================================== *
   * First-person renderer
   * ====================================================================== */

  var RAY_STEP = 2;                  // screen pixels per cast ray
  var FOG_END = P.VIEW_RADIUS;       // the player cannot see past the view radius
  var zBuffer = null;                // per-column wall depth, for sprite occlusion

  function drawBackdrop(ctx, W, H, horizon) {
    var s = buildShadeTables();
    var i, y0, y1;
    for (i = 0; i < BANDS; i++) {
      y0 = horizon * (i / BANDS);
      y1 = horizon * ((i + 1) / BANDS);
      ctx.fillStyle = s.ceil[i];
      ctx.fillRect(0, y0, W, y1 - y0 + 1);
    }
    for (i = 0; i < BANDS; i++) {
      y0 = horizon + (H - horizon) * (i / BANDS);
      y1 = horizon + (H - horizon) * ((i + 1) / BANDS);
      ctx.fillStyle = s.floor[i];
      ctx.fillRect(0, y0, W, y1 - y0 + 1);
    }
  }

  /**
   * One DDA ray per RAY_STEP screen pixels.
   *
   * Textbook grid traversal: step to the next cell boundary on whichever axis
   * is nearer, until a wall cell is hit. `side` records which axis was crossed
   * last, and shading the two differently is what makes corners readable
   * without any texture. The perpendicular distance - not the ray length - is
   * used for the slice height, otherwise the walls bow outward at the edges of
   * the screen.
   */
  function castColumns(ctx, W, H, horizon, px, py, dirX, dirY, planeX, planeY) {
    var s = buildShadeTables();
    var cols = Math.ceil(W / RAY_STEP);
    if (!zBuffer || zBuffer.length !== cols) zBuffer = new Float64Array(cols);

    for (var c = 0; c < cols; c++) {
      var sx = c * RAY_STEP;
      var camX = 2 * ((sx + RAY_STEP / 2) / W) - 1;
      var rdx = dirX + planeX * camX;
      var rdy = dirY + planeY * camX;

      var mapX = Math.floor(px), mapY = Math.floor(py);
      var deltaX = rdx === 0 ? 1e30 : Math.abs(1 / rdx);
      var deltaY = rdy === 0 ? 1e30 : Math.abs(1 / rdy);
      var stepX, stepY, sideDistX, sideDistY;

      if (rdx < 0) { stepX = -1; sideDistX = (px - mapX) * deltaX; }
      else { stepX = 1; sideDistX = (mapX + 1 - px) * deltaX; }
      if (rdy < 0) { stepY = -1; sideDistY = (py - mapY) * deltaY; }
      else { stepY = 1; sideDistY = (mapY + 1 - py) * deltaY; }

      var side = 0;
      var hit = false;
      var guard = 0;
      while (!hit && guard++ < 256) {
        if (sideDistX < sideDistY) { sideDistX += deltaX; mapX += stepX; side = 0; }
        else { sideDistY += deltaY; mapY += stepY; side = 1; }
        if (isWall(mapX, mapY)) hit = true;
      }

      var perp = side === 0 ? sideDistX - deltaX : sideDistY - deltaY;
      if (!hit || !(perp > 0.0001)) perp = FOG_END;
      zBuffer[c] = perp;

      if (perp >= FOG_END) continue;   // beyond sight; the backdrop stands in

      var lineH = H / perp;
      var top = horizon - lineH / 2;
      var shade = Math.min(SHADE_STEPS - 1, Math.floor((perp / FOG_END) * SHADE_STEPS));
      ctx.fillStyle = s.wall[side][shade];
      ctx.fillRect(sx, top, RAY_STEP + 1, lineH);
    }
  }

  /**
   * A flat humanoid silhouette. Deliberately a solid shape in one colour: the
   * colour is the information the demo is about, and a detailed sprite would
   * make green, yellow and red harder to tell apart on a projector.
   */
  function drawFigure(ctx, cx, top, h, color, outline) {
    var w = h * 0.34;
    ctx.fillStyle = color;

    ctx.beginPath();
    ctx.arc(cx, top + h * 0.11, h * 0.095, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx - w * 0.50, top + h * 0.25);
    ctx.lineTo(cx + w * 0.50, top + h * 0.25);
    ctx.lineTo(cx + w * 0.36, top + h * 0.63);
    ctx.lineTo(cx - w * 0.36, top + h * 0.63);
    ctx.closePath();
    ctx.fill();

    ctx.fillRect(cx - w * 0.34, top + h * 0.63, w * 0.26, h * 0.35);
    ctx.fillRect(cx + w * 0.08, top + h * 0.63, w * 0.26, h * 0.35);

    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx - w * 0.62, top, w * 1.24, h);
    }
  }

  /**
   * World position -> screen. Handed to overlay stages on the camera object so
   * a stage never has to duplicate the projection maths.
   *
   * Returns null when the point is behind the camera or off the sides.
   */
  function projectPoint(cam, wx, wy) {
    var rx = wx - cam.px;
    var ry = wy - cam.py;
    var invDet = 1 / (cam.planeX * cam.dirY - cam.dirX * cam.planeY);
    var tx = invDet * (cam.dirY * rx - cam.dirX * ry);
    var depth = invDet * (-cam.planeY * rx + cam.planeX * ry);
    if (depth <= 0.12) return null;

    var screenX = (cam.W / 2) * (1 + tx / depth);
    var height = Math.abs(cam.H / depth) * 0.82;
    var top = cam.horizon + Math.abs(cam.H / depth) / 2 - height;
    if (screenX < -height || screenX > cam.W + height) return null;
    return { x: screenX, top: top, height: height, depth: depth };
  }

  // Column spans of a sprite that are nearer than the wall behind them.
  // Returns null when the sprite is completely hidden.
  function visibleSpans(cam, proj) {
    if (!cam.zBuffer) return [[proj.x - proj.height * 0.3, proj.height * 0.6]];
    var w = proj.height * 0.5;
    var c0 = Math.max(0, Math.floor((proj.x - w / 2) / cam.rayStep));
    var c1 = Math.min(cam.zBuffer.length - 1, Math.ceil((proj.x + w / 2) / cam.rayStep));
    var spans = [];
    var runStart = -1;
    for (var c = c0; c <= c1; c++) {
      var open = cam.zBuffer[c] > proj.depth;
      if (open && runStart < 0) runStart = c;
      if (!open && runStart >= 0) {
        spans.push([runStart * cam.rayStep, (c - runStart) * cam.rayStep]);
        runStart = -1;
      }
    }
    if (runStart >= 0) spans.push([runStart * cam.rayStep, (c1 + 1 - runStart) * cam.rayStep]);
    return spans.length ? spans : null;
  }

  function drawEntitySprite(ctx, cam, e, color, seeThrough, outline) {
    var proj = projectPoint(cam, e.x, e.y);
    if (!proj) return false;

    if (seeThrough) {
      drawFigure(ctx, proj.x, proj.top, proj.height, color, outline);
      return true;
    }

    var spans = visibleSpans(cam, proj);
    if (!spans) return false;

    ctx.save();
    ctx.beginPath();
    for (var i = 0; i < spans.length; i++) ctx.rect(spans[i][0], 0, spans[i][1], cam.H);
    ctx.clip();
    drawFigure(ctx, proj.x, proj.top, proj.height, color, outline);
    ctx.restore();
    return true;
  }

  function drawCrosshair(ctx, W, H) {
    var cx = W / 2, cy = H / 2, r = 7;
    ctx.strokeStyle = 'rgba(230,240,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx - 2, cy);
    ctx.moveTo(cx + 2, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy - 2);
    ctx.moveTo(cx, cy + 2); ctx.lineTo(cx, cy + r);
    ctx.stroke();
  }

  function drawHud(ctx, W, H, visibleCount) {
    var h = 26;
    ctx.fillStyle = 'rgba(8,11,16,0.72)';
    ctx.fillRect(0, H - h, W, h);
    ctx.fillStyle = 'rgba(190,205,225,0.85)';
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    var deg = Math.round(clientState.camera.yaw * 180 / Math.PI) % 360;
    ctx.fillText('CULLING ' + clientState.meta.cullingMode +
      '   ·   tick ' + clientState.tick +
      '   ·   facing ' + deg + '°' + (pointerLocked ? ' [MOUSE]' : '') +
      '   ·   enemies in view: ' + visibleCount +
      '   ·   sent this tick: ' + clientState.meta.sentNpcs + '/' + clientState.meta.totalNpcs,
      12, H - 9);
  }

  function renderWorld3D(ctx) {
    var W = ctx.canvas.width, H = ctx.canvas.height;
    ctx.fillStyle = PALETTE.fog;
    ctx.fillRect(0, 0, W, H);
    if (!clientState.ready) return;

    var cam = clientState.camera;
    var px = clientState.player.x, py = clientState.player.y;
    var dirX = Math.cos(cam.yaw), dirY = Math.sin(cam.yaw);
    var planeLen = Math.tan(cam.fov / 2);
    var planeX = -dirY * planeLen, planeY = dirX * planeLen;
    var horizon = H * 0.5;

    drawBackdrop(ctx, W, H, horizon);
    castColumns(ctx, W, H, horizon, px, py, dirX, dirY, planeX, planeY);

    var view = {
      px: px, py: py, yaw: cam.yaw, fov: cam.fov,
      W: W, H: H, horizon: horizon, rayStep: RAY_STEP,
      dirX: dirX, dirY: dirY, planeX: planeX, planeY: planeY,
      zBuffer: zBuffer,
      project: function (wx, wy) { return projectPoint(view, wx, wy); },
      drawFigure: drawFigure,
      drawEntity: function (e, color, seeThrough, outline) {
        return drawEntitySprite(ctx, view, e, color, seeThrough, outline);
      }
    };

    // Honest rendering: only entities the server marked visible, occluded by
    // the walls in front of them like anything else on screen.
    var sorted = clientState.entities.slice().sort(function (a, b) {
      var da = (a.x - px) * (a.x - px) + (a.y - py) * (a.y - py);
      var db = (b.x - px) * (b.x - px) + (b.y - py) * (b.y - py);
      return db - da;
    });
    var shown = 0;
    for (var i = 0; i < sorted.length; i++) {
      if (!sorted[i].visible) continue;
      if (drawEntitySprite(ctx, view, sorted[i], PALETTE.visible, false, null)) shown++;
    }

    // Left in plain sight on purpose - see note 3 in the file header.
    clientState.lastCamera = view;

    runWorldPipeline(ctx, view);

    drawCrosshair(ctx, W, H);
    drawHud(ctx, W, H, shown);
  }

  /* ====================================================================== *
   * Top-down renderer
   *
   * Kept as a toggle rather than deleted: it shows the geometry the
   * first-person view is derived from, which is the cheapest way to convince
   * a reviewer that both views are drawing the same world.
   * ====================================================================== */

  function renderTopDown(ctx) {
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

    // The honest top-down view draws only entities the server marked visible.
    for (var i = 0; i < clientState.entities.length; i++) {
      var e = clientState.entities[i];
      if (!e.visible) continue;
      drawDot(ctx, e.x * cs, e.y * cs, cs * 0.32, PALETTE.visible);
      ctx.fillStyle = 'rgba(230,240,255,0.55)';
      ctx.font = Math.max(9, cs * 0.42) + 'px ui-monospace, monospace';
      ctx.fillText(e.id, e.x * cs + cs * 0.4, e.y * cs - cs * 0.3);
    }

    drawFacingCone(ctx, clientState.player.x * cs, clientState.player.y * cs,
      P.VIEW_RADIUS * cs, 0.10);
    drawDot(ctx, clientState.player.x * cs, clientState.player.y * cs, cs * 0.36, PALETTE.player);
    ctx.strokeStyle = 'rgba(94,200,242,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(clientState.player.x * cs, clientState.player.y * cs, P.VIEW_RADIUS * cs, 0, Math.PI * 2);
    ctx.stroke();

    // No camera was derived this frame, so a 3D overlay stage has nothing to
    // project against and correctly draws nothing.
    clientState.lastCamera = null;
  }

  /**
   * The main view. Watched by Defenses 1, 2 and 5, and hooked by the cheat, so
   * it stays a single stable entry point and dispatches internally.
   */
  function renderMain(ctx) {
    if (clientState.viewMode === '2D') return renderTopDown(ctx);
    return renderWorld3D(ctx);
  }

  function drawDot(ctx, x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawFacingCone(ctx, x, y, radius, alpha) {
    var cam = clientState.camera;
    ctx.fillStyle = 'rgba(94,200,242,' + alpha + ')';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, radius, cam.yaw - cam.fov / 2, cam.yaw + cam.fov / 2);
    ctx.closePath();
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

    // Where the first-person camera is pointing, so the two views can be read
    // against each other.
    drawFacingCone(ctx, clientState.player.x * cs, clientState.player.y * cs,
      P.VIEW_RADIUS * cs, 0.13);
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

  // The same manual-mapping surface, for the first-person view. Stages receive
  // the camera derived this frame so they can project world positions without
  // reimplementing the renderer.
  function runWorldPipeline(ctx, camera) {
    var region = Sandbox.processMemory && Sandbox.processMemory.modules.client;
    if (!region || !region.worldPipeline) return;
    for (var i = 0; i < region.worldPipeline.length; i++) {
      try {
        region.worldPipeline[i](ctx, camera, clientState, PALETTE);
      } catch (err) {
        Log.alert('world pipeline stage ' + i + ' threw: ' + err.message);
      }
    }
  }

  /* ====================================================================== *
   * Input and camera
   *
   * The client integrates its own look direction and converts held keys into a
   * world-space movement vector. The server receives that vector and clamps it
   * to a legal speed - it never takes the client's word for how far it moved.
   * ====================================================================== */

  var held = Object.create(null);
  var inputSink = null;
  var pendingMouseDx = 0;
  var pointerLocked = false;
  var lastSent = { dx: 0, dy: 0 };
  var lastSentAt = -1e9;

  var TURN_RATE = 2.4;          // radians per second on the arrow keys
  var MOUSE_SENSITIVITY = 0.0022;

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  function readInput() {
    var forward = (held.w || held.ArrowUp ? 1 : 0) - (held.s || held.ArrowDown ? 1 : 0);
    var strafe = (held.d ? 1 : 0) - (held.a ? 1 : 0);
    if (forward === 0 && strafe === 0) return { dx: 0, dy: 0 };

    var len = Math.sqrt(forward * forward + strafe * strafe);
    forward /= len;
    strafe /= len;

    // Forward is (cos yaw, sin yaw); right is that turned a quarter turn.
    var cos = Math.cos(clientState.camera.yaw);
    var sin = Math.sin(clientState.camera.yaw);
    return {
      dx: forward * cos - strafe * sin,
      dy: forward * sin + strafe * cos
    };
  }

  function flushInput(force) {
    if (!inputSink) return;
    var input = readInput();
    if (Math.abs(input.dx - lastSent.dx) < 0.01 && Math.abs(input.dy - lastSent.dy) < 0.01) return;
    var now = nowMs();
    if (!force && now - lastSentAt < P.TICK_MS) return;
    lastSent.dx = input.dx;
    lastSent.dy = input.dy;
    lastSentAt = now;
    inputSink(input);
  }

  /**
   * Turning has to integrate over time rather than fire on keydown, so this is
   * called once per animation frame from main.js. Whenever the heading changes
   * while a movement key is held, the world-space vector changes too and has to
   * be resent - otherwise holding W through a turn would keep walking in the
   * direction the player was facing when the key went down.
   */
  function updateCamera(dtMs) {
    var dt = Math.min(dtMs || 16, 100) / 1000;
    // Q/E as well as the arrows. Arrow keys are the ones a browser is most
    // likely to have taken for itself (scrolling, or a focused widget), so
    // there is always a second way to turn that nothing else competes for.
    var right = held.ArrowRight || held.e ? 1 : 0;
    var left = held.ArrowLeft || held.q ? 1 : 0;
    var turn = right - left;

    if (turn) clientState.camera.yaw += turn * TURN_RATE * dt;
    if (pendingMouseDx) {
      clientState.camera.yaw += pendingMouseDx * MOUSE_SENSITIVITY;
      pendingMouseDx = 0;
    }

    var TAU = Math.PI * 2;
    clientState.camera.yaw = ((clientState.camera.yaw % TAU) + TAU) % TAU;
    flushInput(false);
  }

  function setViewMode(mode) {
    clientState.viewMode = mode === '2D' ? '2D' : '3D';
    return clientState.viewMode;
  }

  function isPointerLocked() {
    return pointerLocked;
  }

  var MOVE_KEYS = ['w', 'a', 's', 'd', 'q', 'e',
                   'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

  var lockTarget = null;

  /**
   * Which keys a focused element is genuinely entitled to.
   *
   * The first version of this guard ignored every key whenever any form control
   * had focus, which meant that using a single dropdown silently disabled the
   * whole keyboard for the rest of the session. Text entry really does need
   * every key - typing a seed must not walk the player - but a dropdown only
   * needs the arrows it uses to change its own value, and a checkbox needs
   * none at all.
   */
  var TEXT_INPUT_TYPES = /^(text|number|search|email|password|url|tel|date)$/;

  function claimsKey(target, key) {
    if (!target) return false;
    var tag = target.tagName || '';
    var type = target.type || '';
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT' && TEXT_INPUT_TYPES.test(type)) return true;
    // Arrow keys drive a dropdown's selection and a slider's value.
    var isArrow = key.indexOf('Arrow') === 0;
    if (tag === 'SELECT' && isArrow) return true;
    if (tag === 'INPUT' && type === 'range' && isArrow) return true;
    return false;
  }

  /**
   * Toggle mouse look. Bound to F because a keypress is a user gesture, which
   * is what the Pointer Lock API requires - and because reaching for the mouse
   * to enable the mouse is a poor trade during a live demo.
   */
  function togglePointerLock() {
    var doc = (typeof document !== 'undefined') ? document : null;
    if (!doc || !lockTarget) return false;
    if (doc.pointerLockElement === lockTarget) {
      if (doc.exitPointerLock) doc.exitPointerLock();
      return false;
    }
    if (typeof lockTarget.requestPointerLock === 'function') lockTarget.requestPointerLock();
    return true;
  }

  function attachInput(target, sink, canvas) {
    inputSink = sink;

    // Capture phase, so movement is read before anything further down the page
    // gets a chance to consume the key. Registered on the window, so it works
    // no matter which element happens to hold focus.
    target.addEventListener('keydown', function (event) {
      var key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (claimsKey(event.target, key)) return;

      if (key === 'f') {
        event.preventDefault();
        togglePointerLock();
        return;
      }
      if (MOVE_KEYS.indexOf(key) < 0) return;
      event.preventDefault();
      held[key] = true;
      flushInput(true);
    }, true);

    // No focus guard on release: a keyup that gets skipped is how a key ends up
    // stuck down forever.
    target.addEventListener('keyup', function (event) {
      var key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (MOVE_KEYS.indexOf(key) < 0) return;
      held[key] = false;
      flushInput(true);
    }, true);

    target.addEventListener('blur', function () {
      for (var k in held) held[k] = false;
      pendingMouseDx = 0;
      flushInput(true);
    });

    attachPointerLook(canvas);
  }

  // Mouse look is optional throughout: pointer lock can be disorienting during
  // a live demo, and arrow-key turning always works without it. Every call is
  // feature-guarded so the headless boot test, which has no pointer-lock API,
  // runs this path unchanged.
  function attachPointerLook(canvas) {
    if (!canvas || typeof canvas.addEventListener !== 'function') return;
    lockTarget = canvas;
    var doc = (typeof document !== 'undefined') ? document : null;

    canvas.addEventListener('click', function () {
      if (typeof canvas.requestPointerLock === 'function') canvas.requestPointerLock();
    });

    if (!doc || typeof doc.addEventListener !== 'function') return;

    doc.addEventListener('pointerlockchange', function () {
      pointerLocked = doc.pointerLockElement === canvas;
      if (canvas.classList && canvas.classList.toggle) {
        canvas.classList.toggle('locked', pointerLocked);
      }
      if (!pointerLocked) pendingMouseDx = 0;
    });

    doc.addEventListener('mousemove', function (event) {
      if (!pointerLocked) return;
      pendingMouseDx += event.movementX || 0;
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
    runWorldPipeline: runWorldPipeline,
    lineOfSight: lineOfSight,
    readInput: readInput
  };

  Sandbox.client = exports;
  Sandbox.client.attachInput = attachInput;
  Sandbox.client.updateCamera = updateCamera;
  Sandbox.client.setViewMode = setViewMode;
  Sandbox.client.isPointerLocked = isPointerLocked;
  Sandbox.client.togglePointerLock = togglePointerLock;
  Sandbox.client.claimsKey = claimsKey;
  Sandbox.client.PALETTE = PALETTE;
  Sandbox.client.state = clientState;

  // Announce this module to the loader's module table. Everything Defense 3
  // enumerates and Defense 5 challenges comes from this call.
  Sandbox.registerModule('client', exports, { renderPipeline: [], worldPipeline: [] });
})(typeof self !== 'undefined' ? self : this);
