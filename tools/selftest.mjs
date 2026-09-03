#!/usr/bin/env node
/*
 * selftest.mjs - Headless verification of the Client Integrity Sandbox.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 *     node tools/selftest.mjs
 *
 * The browser demo is the deliverable, but the claims in the report need to be
 * reproducible without clicking through a UI. This harness loads the real
 * modules - not reimplementations of them - and checks the properties the
 * report depends on:
 *
 *   1. SHA-256 and HMAC-SHA256 agree with Node's crypto.
 *   2. The three culling modes behave as claimed, and STRICT leaks nothing.
 *   3. The simulation is deterministic for a given seed.
 *   4. Each of defenses 1-4 detects a naive cheat and is defeated by its own
 *      bypass, and none of them fires against an untampered client.
 *   5. Challenge/response catches the bypasses that defeat 1-4, is itself
 *      defeated by a pristine source cache, and recovers the detection through
 *      timing analysis once the cheat's overhead is large enough.
 *   6. manifest.json matches what is on disk, and an edit is caught.
 *
 * Modules that need a DOM (ui.js) or the page's application object (export.js)
 * are not loaded here; everything they orchestrate is covered directly.
 */

import { createHmac, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `  ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const flush = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
};

/* ====================================================================== *
 * Bootstrap: load the real modules the way index.html does
 * ====================================================================== */

globalThis.self = globalThis;

// The loader itself, trusted by assumption. See the header of kernel.js.
require(join(ROOT, 'src/hash.js'));
require(join(ROOT, 'src/kernel.js'));

const S = globalThis.Sandbox;

// The signed modules, in dependency order. ui.js and export.js are omitted:
// they need a DOM and the page's app object respectively.
const MODULES = ['rng', 'protocol', 'log', 'client', 'defenses', 'education'];

for (const id of MODULES) {
  const source = await readFile(join(ROOT, 'src', `${id}.js`), 'utf8');
  require(join(ROOT, 'src', `${id}.js`));
  S.mapModule(id, source, true);
}
require(join(ROOT, 'src/server.js'));

// The loader normally populates this after fetching manifest.json; Defense 4
// reads it, so the harness has to do the same or every module looks unlisted.
S.signing.manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
S.signing.available = true;
S.signing.allValid = true;
S.signing.verifiedAt = Date.now();

const P = S.Protocol;
S.Log.setMuted(true);

await S.defenses.initialise();

// Loaded last, exactly as the page does it - which is Defense 4's bypass.
require(join(ROOT, 'src/attacker.js'));

const defExports = () => S.processMemory.modules.defenses.exports;
const clientExports = () => S.processMemory.modules.client.exports;

/* ====================================================================== *
 * 1. Hashing
 * ====================================================================== */

section('1. Hashing primitives');
{
  const cases = ['', 'abc', 'x'.repeat(1000), 'đồ án an toàn thông tin ✓⚠'];
  let shaOk = true;
  let hmacOk = true;
  for (const c of cases) {
    if (S.Hash.sha256HexSync(c) !== createHash('sha256').update(c, 'utf8').digest('hex')) shaOk = false;
    for (const key of ['k', 'k'.repeat(70)]) {
      const mine = S.Hash.hmacSha256HexSync(key, c);
      const ref = createHmac('sha256', key).update(c, 'utf8').digest('hex');
      if (mine !== ref) hmacOk = false;
    }
  }
  check('pure-JS SHA-256 matches node:crypto', shaOk, `${cases.length} vectors`);
  check('pure-JS HMAC-SHA256 matches node:crypto', hmacOk, 'short and >block-size keys');
}

/* ====================================================================== *
 * 2 & 3. Culling behaviour and determinism
 * ====================================================================== */

section('2. Culling modes: what the server is willing to send');

function runWorld(seed, mode, ticks) {
  const packets = [];
  const srv = S.ServerCore.create((m) => { if (m.type === P.PACKET) packets.push(m); });
  srv.handle({ type: P.INIT, seed, cullingMode: mode });
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < ticks; i++) {
    if (i % 25 === 0) {
      const d = dirs[Math.floor(i / 25) % dirs.length];
      srv.handle({ type: P.INPUT, dx: d[0], dy: d[1] });
    }
    srv.handle({ type: P.STEP, count: 1 });
  }
  const hidden = packets.reduce((a, p) => a + p.entities.filter((e) => !e.visible).length, 0);
  const leaked = packets.reduce((a, p) => a + p.entities.filter((e) => e.leaked).length, 0);
  const visible = packets.reduce((a, p) => a + p.meta.visibleNpcs, 0);
  const leakTicks = packets.filter((p) => p.meta.leakedNpcs > 0).length;
  return { packets, hidden, leaked, visible, leakTicks };
}

const none = runWorld('valorant', 'NONE', 500);
const strict = runWorld('valorant', 'STRICT', 500);
const buffered = runWorld('valorant', 'BUFFERED', 500);

check('NONE hands the client positions it should not have', none.hidden > 500,
  `${none.hidden} hidden positions sent`);
check('STRICT leaks nothing at all', strict.hidden === 0,
  `${strict.hidden} hidden positions over 500 ticks`);
check('STRICT still shows what is legitimately visible', strict.visible > 0,
  `${strict.visible} line-of-sight NPC-ticks`);
check('all three modes agree on legitimate visibility',
  none.visible === strict.visible && strict.visible === buffered.visible,
  `${strict.visible} NPC-ticks in every mode`);
check('BUFFERED leaks, but only via the lookahead',
  buffered.hidden > 0 && buffered.hidden === buffered.leaked,
  `${buffered.leaked} leaked, ${(100 * buffered.leakTicks / 500).toFixed(1)}% of ticks`);
check('BUFFERED leaks far less than NONE', buffered.hidden < none.hidden / 4,
  `${buffered.hidden} vs ${none.hidden}`);

section('3. Reproducibility');
{
  const key = (r) => JSON.stringify(r.packets.map((p) =>
    [p.tick, p.player.x.toFixed(6), p.entities.map((e) => [e.id, e.x.toFixed(6), e.visible])]));
  const a = runWorld('seed-a', 'BUFFERED', 200);
  const b = runWorld('seed-a', 'BUFFERED', 200);
  const c = runWorld('seed-b', 'BUFFERED', 200);
  check('same seed reproduces the run exactly', key(a) === key(b));
  check('a different seed produces a different world', key(a) !== key(c));
}

/* ====================================================================== *
 * 4. The defense/bypass matrix
 * ====================================================================== */

section('4. Defenses 1-4: detection, and defeat by the matching bypass');

async function evaluate(defenseId, level, bypassArmed) {
  const defense = S.defenses.get(defenseId);
  S.defenses.list().forEach((d) => { d.enabled = false; d.bypassEnabled = false; });
  defense.enabled = true;
  defense.bypassEnabled = bypassArmed;
  S.attacker.setLevel(level);
  S.defenses.resetStats();
  await S.defenses.runAll(0);
  return defense.lastOutcome;
}

for (const id of ['checksum', 'hooks', 'modules', 'signing']) {
  const name = S.defenses.get(id).name;
  const clean = await evaluate(id, 0, false);
  const naive = await evaluate(id, 2, false);
  const evasive = await evaluate(id, 3, true);

  check(`${name}: silent against an untampered client`, clean === 'clean', `outcome=${clean}`);
  check(`${name}: detects the naive cheat`, naive === 'detected', `outcome=${naive}`);
  check(`${name}: defeated by "${S.defenses.get(id).bypassName}"`, evasive === 'missed',
    `outcome=${evasive}`);
}

// Module enumeration is the one check that sees a purely passive cheat, because
// the injected reader still occupies memory no module accounts for.
{
  const passive = await evaluate('modules', 1, false);
  check('Module enumeration: catches even a passive reader', passive === 'detected',
    `outcome=${passive}`);
  const checksumPassive = await evaluate('checksum', 1, false);
  check('Code checksum: correctly silent on a passive reader (no hook to find)',
    checksumPassive === 'clean', `outcome=${checksumPassive}`);
}

/* ====================================================================== *
 * 5. Challenge/response and timing analysis
 * ====================================================================== */

section('5. Challenge-response, and where timing analysis wins');

function newServer(seed, timingAnalysis) {
  const inbox = [];
  const srv = S.ServerCore.create((m) => inbox.push(m));
  srv.handle({ type: P.INIT, seed, cullingMode: 'BUFFERED', timingAnalysis });
  const sources = {};
  for (const id of Object.keys(S.processMemory.modules)) {
    const text = S.defenses.liveSource(id);
    if (text) sources[id] = text;
  }
  srv.handle({ type: P.REGISTER_SOURCES, sources });
  return { srv, inbox };
}

/** Advance until one challenge has been issued, answered, and judged. */
async function oneChallenge({ srv, inbox }) {
  for (let attempt = 0; attempt < 8; attempt++) {
    srv.handle({ type: P.STEP, count: P.CHALLENGE_INTERVAL_TICKS });
    await flush();
    const challenge = inbox.find((m) => m.type === P.CHALLENGE);
    if (!challenge) continue;
    inbox.length = 0;
    const digest = await defExports().answerChallenge(challenge);
    srv.handle({ type: P.CHALLENGE_RESPONSE, id: challenge.id, digest });
    await flush();
    const verdict = inbox.find((m) => m.type === P.VERDICT);
    inbox.length = 0;
    if (verdict) return verdict;
  }
  return null;
}

async function challengeRun({ level, bypassArmed, overheadMs, timingAnalysis, rounds }) {
  S.defenses.list().forEach((d) => { d.enabled = false; d.bypassEnabled = false; });
  S.defenses.get('challenge').enabled = true;
  S.defenses.get('challenge').bypassEnabled = bypassArmed;
  S.attacker.setOverhead(overheadMs || 0);

  // Unhook BEFORE the server takes its reference copies. The server is supposed
  // to hold pristine sources it obtained from the build; letting it snapshot a
  // client that a previous test left hooked would make honest answers look
  // wrong and quietly poison every measurement below.
  S.attacker.setLevel(0);
  const server = newServer('valorant', timingAnalysis !== false);

  // Establish the clean baseline first. Handing the detector a baseline that
  // already contains the cheat's overhead would measure the cheat against
  // itself and prove nothing.
  for (let i = 0; i <= P.TIMING_BASELINE_SAMPLES; i++) await oneChallenge(server);

  S.attacker.setLevel(level);
  const verdicts = [];
  for (let i = 0; i < (rounds || 6); i++) {
    const v = await oneChallenge(server);
    if (v) verdicts.push(v);
  }
  return verdicts;
}

{
  const clean = await challengeRun({ level: 0, bypassArmed: false, overheadMs: 0 });
  check('answers honestly when nothing is hooked',
    clean.length > 0 && clean.every((v) => v.valueOk && !v.anomaly),
    `${clean.filter((v) => v.valueOk).length}/${clean.length} correct, no anomalies`);

  // The bypasses that defeat defenses 1-4 do not help here: the responder reads
  // function source through the pristine toString captured before the attacker
  // existed, so a hooked minimap changes the digest.
  //
  // Detection is per-challenge probabilistic, and deliberately so. Each
  // challenge covers one random slice of one random module, so it only catches
  // the hook when it happens to sample the bytes that changed. This is not a
  // weakness of the sandbox - it is the defining property of rotating partial
  // integrity checks, and the number below is a result worth reporting.
  const hooked = await challengeRun({ level: 3, bypassArmed: false, overheadMs: 0, rounds: 30 });
  const caught = hooked.filter((v) => !v.valueOk).length;
  const rate = hooked.length ? caught / hooked.length : 0;
  const firstCatch = hooked.findIndex((v) => !v.valueOk) + 1;

  check('catches a hook that defeated defenses 1-4, given enough challenges',
    caught > 0, `${caught}/${hooked.length} challenges caught it`);
  check('detects within a short session window', firstCatch > 0 && firstCatch <= 12,
    `first detection on challenge #${firstCatch} (~${firstCatch}s of play)`);
  check('per-challenge detection rate is a coverage fraction, not certainty',
    rate > 0.05 && rate < 1,
    `${(100 * rate).toFixed(0)}% per challenge — a partial check catches a patch eventually, not immediately`);

  const cached = await challengeRun({ level: 3, bypassArmed: true, overheadMs: 0 });
  check('defeated by a pristine source cache',
    cached.length > 0 && cached.every((v) => v.valueOk && !v.anomaly),
    `${cached.filter((v) => v.valueOk).length}/${cached.length} answered correctly`);

  // A costly bypass is caught on latency alone, with every digest correct.
  const slow = await challengeRun({ level: 3, bypassArmed: true, overheadMs: 60, rounds: 8 });
  const flagged = slow.filter((v) => v.anomaly).length;
  check('timing analysis recovers the detection when the bypass is expensive',
    slow.length > 0 && flagged >= slow.length - 1 && slow.every((v) => v.valueOk),
    `60ms overhead: ${flagged}/${slow.length} flagged, all digests correct`);

  // ...and a cheap one is not. This is the real boundary, and it sits at a few
  // multiples of NETWORK_JITTER_MS rather than at the cheat's overhead alone.
  const cheap = await challengeRun({ level: 3, bypassArmed: true, overheadMs: 4, rounds: 8 });
  const cheapFlagged = cheap.filter((v) => v.anomaly).length;
  check('a cheap bypass hides inside normal network jitter',
    cheap.length > 0 && cheapFlagged <= 1,
    `4ms overhead vs ${P.NETWORK_JITTER_MS}ms jitter: ${cheapFlagged}/${cheap.length} flagged`);

  const slowNoTiming = await challengeRun({
    level: 3, bypassArmed: true, overheadMs: 60, timingAnalysis: false, rounds: 4
  });
  check('with TIMING_ANALYSIS off, even the expensive cheat passes',
    slowNoTiming.length > 0 && slowNoTiming.every((v) => v.valueOk && !v.anomaly),
    `${slowNoTiming.length} challenges, 0 flagged`);
}

/* ====================================================================== *
 * 6. Signing
 * ====================================================================== */

section('6. Code signing');
{
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  let allMatch = true;
  const stale = [];
  for (const [id, entry] of Object.entries(manifest.modules)) {
    const source = await readFile(join(ROOT, entry.file), 'utf8');
    const hmac = createHmac('sha256', manifest.key).update(source, 'utf8').digest('hex');
    if (hmac !== entry.hmac) { allMatch = false; stale.push(id); }
  }
  check('manifest.json matches every module on disk', allMatch,
    stale.length ? `stale: ${stale.join(', ')} — run node tools/sign.mjs` :
      `${Object.keys(manifest.modules).length} modules`);

  const source = await readFile(join(ROOT, 'src/client.js'), 'utf8');
  const tampered = createHmac('sha256', manifest.key)
    .update(`${source}\n// edited\n`, 'utf8').digest('hex');
  check('an edited module fails verification', tampered !== manifest.modules.client.hmac);

  const loaderFiles = ['hash.js', 'kernel.js', 'main.js', 'attacker.js', 'server.js'];
  check('the loader and the attacker are deliberately unsigned',
    loaderFiles.every((f) => !manifest.modules[f.replace('.js', '')]),
    loaderFiles.join(', '));
}

/* ====================================================================== *
 * 7. First-person rendering
 *
 * The 3D view carries the demo, so its two load-bearing properties need to
 * stay under test: the projection has to be geometrically right, and the
 * wallhack has to reach it by both of the routes the attacker can take. A
 * recording canvas is used rather than a no-op one, so the checks can count
 * what was actually drawn and in which colour.
 * ====================================================================== */

section('7. First-person rendering');
{
  const recorder = () => {
    const ops = [];
    const ctx = {
      canvas: { width: 800, height: 500 },
      fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', globalAlpha: 1,
      fillRect: (x, y, w, h) => ops.push({ op: 'rect', x, y, w, h, fill: ctx.fillStyle }),
      arc: () => ops.push({ op: 'arc', fill: ctx.fillStyle }),
      strokeRect: () => {}, fillText: () => {}, beginPath: () => {}, closePath: () => {},
      fill: () => {}, stroke: () => {}, moveTo: () => {}, lineTo: () => {}, rect: () => {},
      clip: () => {}, save: () => {}, restore: () => {}
    };
    return { ctx, ops };
  };

  const PAL = S.client.PALETTE;
  const st = S.clientState;
  const draw = () => {
    const { ctx, ops } = recorder();
    clientExports().renderMain(ctx);
    return {
      slices: ops.filter((o) => o.op === 'rect' && o.w <= 4 && o.h > 0),
      red: ops.filter((o) => o.op === 'arc' && o.fill === PAL.wallhack).length,
      yellow: ops.filter((o) => o.op === 'arc' && o.fill === PAL.leaked).length
    };
  };

  S.attacker.setLevel(0);
  S.client.setViewMode('3D');
  const core = S.ServerCore.create((m) => {
    if (m.type === P.READY) S.client.applyWorld(m);
    if (m.type === P.PACKET) S.client.applyPacket(m);
  });
  core.handle({ type: P.INIT, seed: 'valorant', cullingMode: P.CULLING.NONE });
  core.handle({ type: P.STEP, count: 40 });

  const clean = draw();
  const heights = clean.slices.map((s) => s.h);
  check('raycaster draws a wall column per ray',
    clean.slices.length > 100, `${clean.slices.length} slices`);
  check('wall height varies with distance',
    heights.length > 0 && Math.max(...heights) > Math.min(...heights) * 3,
    `${Math.min(...heights).toFixed(0)}px .. ${Math.max(...heights).toFixed(0)}px`);

  // A target the camera looks straight at must land in the middle of the screen,
  // and the depth buffer must place it in front of or behind the wall correctly.
  const target = st.entities.find((e) => !e.visible) || st.entities[0];
  st.camera.yaw = Math.atan2(target.y - st.player.y, target.x - st.player.x);
  draw();
  const proj = st.lastCamera.project(target.x, target.y);
  check('projection centres a target the camera aims at',
    proj && Math.abs(proj.x - 400) < 3 && proj.height > 0,
    proj ? `x=${proj.x.toFixed(1)} of 800, height=${proj.height.toFixed(0)}px` : 'did not project');

  const behindWall = !S.client.lineOfSight(st.player.x, st.player.y, target.x, target.y);
  check('the chosen target really is behind a wall', behindWall);

  check('honest client draws nothing it was not shown', draw().red === 0);

  S.attacker.setLevel(2);
  check('level 2 draws the hidden target through the wall', draw().red > 0);

  S.defenses.list().forEach((d) => S.defenses.setBypass(d.id, true));
  S.attacker.setLevel(3);
  const mapped = draw();
  check('manual mapping reaches the 3D view through worldPipeline',
    mapped.red > 0 && S.processMemory.modules.client.worldPipeline.length === 1,
    `${mapped.red} drawn, ${S.processMemory.modules.client.worldPipeline.length} mapped stage`);

  // The claim the whole project rests on, restated in the renderer: with the
  // server culling strictly there is nothing for the payload to draw.
  core.handle({ type: P.SET_CULLING, mode: P.CULLING.STRICT });
  core.handle({ type: P.STEP, count: 30 });
  const strict = draw();
  check('STRICT: the fully evasive cheat has nothing to draw',
    strict.red + strict.yellow === 0,
    `${st.entities.filter((e) => !e.visible).length} hidden entities in packet`);

  S.attacker.setLevel(0);
  check('uninstalling clears both overlay routes',
    S.processMemory.modules.client.worldPipeline.length === 0 &&
    S.processMemory.modules.client.renderPipeline.length === 0 && draw().red === 0);
  S.defenses.list().forEach((d) => S.defenses.setBypass(d.id, false));

  // The overlay is a conventional ESP: bracketed box, tracer, range readout.
  // Recorded as vector paths so each element can be told apart - a corner box
  // is 4 moveTo + 8 lineTo, while the client's own crosshair is 4 + 4.
  const espShot = () => {
    const ops = [];
    let cur = [];
    const ctx = {
      canvas: { width: 800, height: 500 },
      fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', globalAlpha: 1,
      fillRect: () => {}, strokeRect: () => {}, arc: () => {},
      fillText: (t) => ops.push({ op: 'text', t }),
      beginPath: () => { cur = []; },
      moveTo: (x, y) => cur.push(['M', Math.round(x), Math.round(y)]),
      lineTo: (x, y) => cur.push(['L', Math.round(x), Math.round(y)]),
      stroke: () => ops.push({ op: 'stroke', pts: cur.slice() }),
      closePath: () => {}, fill: () => {}, rect: () => {}, clip: () => {},
      save: () => {}, restore: () => {}
    };
    clientExports().renderMain(ctx);
    const n = (o, k) => o.pts.filter((p) => p[0] === k).length;
    return {
      boxes: ops.filter((o) => o.op === 'stroke' && n(o, 'M') === 4 && n(o, 'L') === 8).length,
      tracers: ops.filter((o) => o.op === 'stroke' && o.pts.length === 2 &&
        o.pts[0][1] === 400 && o.pts[0][2] === 500).length,
      tags: ops.filter((o) => o.op === 'text' && /npc-.*m$/.test(o.t)).length,
      status: ops.filter((o) => o.op === 'text' && /^ESP ACTIVE/.test(o.t)).length
    };
  };

  core.handle({ type: P.SET_CULLING, mode: P.CULLING.NONE });
  core.handle({ type: P.STEP, count: 30 });
  const aim = st.entities.find((e) => !e.visible);
  if (aim) st.camera.yaw = Math.atan2(aim.y - st.player.y, aim.x - st.player.x);

  S.attacker.setLevel(0);
  const noEsp = espShot();
  check('honest client draws no ESP furniture',
    noEsp.boxes === 0 && noEsp.tracers === 0 && noEsp.tags === 0);

  S.attacker.setLevel(2);
  const esp = espShot();
  check('the cheat draws a bounding box, a tracer and a range on its targets',
    esp.boxes > 0 && esp.tracers > 0 && esp.tags > 0,
    `${esp.boxes} boxes, ${esp.tracers} tracers, ${esp.tags} range tags`);

  core.handle({ type: P.SET_CULLING, mode: P.CULLING.STRICT });
  core.handle({ type: P.STEP, count: 30 });
  const starved = espShot();
  check('STRICT starves the ESP rather than switching it off',
    starved.tracers === 0 && starved.status === 1,
    'overlay still installed and still drawing its status line, with nothing hidden left to draw');
  S.attacker.setLevel(0);
}

/* ====================================================================== *
 * 8. Keyboard focus guard
 *
 * Regression guard for a bug that made the demo look broken: the first version
 * ignored every key whenever any form control had focus, so using one dropdown
 * silently disabled looking around for the rest of the session. A focused
 * element may only claim the keys it genuinely needs.
 * ====================================================================== */

section('8. Keyboard focus guard');
{
  const claims = S.client.claimsKey;
  const el = (tagName, type) => ({ tagName, type: type || '' });

  const cases = [
    ['typing a seed keeps every letter', el('INPUT', 'text'), 'e', true],
    ['typing a seed keeps the arrows', el('INPUT', 'text'), 'ArrowRight', true],
    ['a textarea keeps every key', el('TEXTAREA'), 'w', true],
    ['a dropdown keeps the arrows it uses', el('SELECT'), 'ArrowRight', true],
    ['a dropdown does NOT keep the turn keys', el('SELECT'), 'e', false],
    ['a dropdown does NOT keep the movement keys', el('SELECT'), 'w', false],
    ['a slider keeps the arrows', el('INPUT', 'range'), 'ArrowLeft', true],
    ['a slider does NOT keep the turn keys', el('INPUT', 'range'), 'q', false],
    ['a checkbox claims nothing', el('INPUT', 'checkbox'), 'ArrowRight', false],
    ['a button claims nothing', el('BUTTON'), 'ArrowRight', false],
    ['the page body claims nothing', el('BODY'), 'w', false]
  ];

  let wrong = [];
  for (const [name, target, key, expected] of cases) {
    if (claims(target, key) !== expected) wrong.push(name);
  }
  check('a focused widget only claims the keys it needs', wrong.length === 0,
    wrong.length ? `wrong: ${wrong.join('; ')}` : `${cases.length} cases`);

  check('mouse look can be toggled from the keyboard',
    typeof S.client.togglePointerLock === 'function');
}

/* ====================================================================== *
 * 9. Defense log legibility
 *
 * The terminal is the part of this project a reviewer actually reads, so the
 * five checks have to produce comparable output rather than five differently
 * worded sentences: a verdict chip, a fixed-width name column, the evidence
 * the check acted on, and - for a defeated defense - the lesson last.
 * ====================================================================== */

section('9. Defense log legibility');
{
  const captured = [];
  const stop = S.Log.subscribe((e) => { if (e) captured.push(e); });
  S.Log.setMuted(false);

  const since = () => { const n = captured.length; return () => captured.slice(n); };
  const TICK_IDS = ['checksum', 'hooks', 'modules', 'signing'];

  S.attacker.setLevel(0);
  S.defenses.list().forEach((d) => { d.enabled = false; d.lastOutcome = null; });

  let mark = since();
  TICK_IDS.forEach((id) => S.defenses.setEnabled(id, true));
  const armed = mark();
  check('arming a defense declares what it reads and what it cannot see',
    TICK_IDS.every((id) => {
      const d = S.defenses.get(id);
      return armed.some((e) => e.badge === 'ARMED' && e.text.indexOf(d.name) === 0) &&
        armed.some((e) => e.text.indexOf('READS') === 0) &&
        armed.some((e) => e.text.indexOf('BLIND TO') === 0);
    }),
    `${armed.length} scope lines for ${TICK_IDS.length} defenses`);

  mark = since();
  await S.defenses.runAll(10);
  const cleanRun = mark();
  check('a clean run stamps every verdict with a PASS chip',
    cleanRun.filter((e) => e.badge === 'PASS').length === TICK_IDS.length,
    `${cleanRun.filter((e) => e.badge === 'PASS').length}/${TICK_IDS.length}`);

  // Verdicts must appear in the defense panel's order, not in whatever order
  // the asynchronous checks happened to settle.
  const order = cleanRun.filter((e) => e.badge === 'PASS')
    .map((e) => e.text.trim().split(/\s\s+/)[0]);
  const wanted = TICK_IDS.map((id) => S.defenses.get(id).short.trim());
  check('verdicts are printed in panel order, not promise-settle order',
    JSON.stringify(order) === JSON.stringify(wanted), order.join(' → '));

  // The point of Defense 4's evidence block: name every covered module.
  const signEvidence = cleanRun.filter((e) => e.level === 'def-sign' && e.badge === '');
  const signedIds = Object.keys(S.signing.manifest.modules)
    .filter((id) => S.processMemory.modules[id]);
  check('code signing names every module it covers, with its digest',
    signedIds.every((id) => signEvidence.some((e) => e.text.indexOf(id) >= 0)) &&
    signEvidence.some((e) => /bytes on disk, not the code now running/.test(e.text)),
    `${signedIds.length} modules listed across ${signEvidence.length} evidence rows`);

  mark = since();
  S.attacker.setLevel(2);
  await S.defenses.runAll(20);
  const detected = mark();
  check('a naive cheat turns the chips to DETECT and shows what changed',
    detected.filter((e) => e.badge === 'DETECT').length >= 3 &&
    detected.some((e) => e.level === 'def-sum' && /→/.test(e.text)),
    `${detected.filter((e) => e.badge === 'DETECT').length} DETECT verdicts`);

  mark = since();
  S.defenses.list().forEach((d) => S.defenses.setBypass(d.id, true));
  S.attacker.setLevel(3);
  await S.defenses.runAll(30);
  const bypassed = mark();
  const firstBypass = bypassed.findIndex((e) => e.badge === 'BYPASS');
  const firstLesson = bypassed.findIndex((e) => e.level === 'lesson');
  check('a defeated defense reports BYPASS and explains itself afterwards',
    firstBypass >= 0 && firstLesson > firstBypass,
    `${bypassed.filter((e) => e.badge === 'BYPASS').length} bypassed, lesson follows the verdict`);

  S.attacker.setLevel(0);
  S.defenses.list().forEach((d) => { S.defenses.setBypass(d.id, false); d.enabled = false; });
  S.Log.setMuted(true);
  stop();
}

/* ====================================================================== *
 * 11. Bypasses armed together
 *
 * Each bypass defeating its own defense in isolation is not the same claim as
 * all five working at once, and the demo script asks for all five. They are
 * not independent: bypass 2's trampoline unhooks and re-hooks around every
 * inspection, and the fresh function objects that produces silently
 * invalidated bypass 1's source-spoof table until the two were kept in sync.
 * ====================================================================== */

section('10. Watch values behind each verdict');
{
  const shaped = (v) => v && typeof v.label === 'string' &&
    v.expected !== undefined && v.actual !== undefined && typeof v.ok === 'boolean';

  S.attacker.setLevel(0);
  const TICK = ['checksum', 'hooks', 'modules', 'signing'];
  TICK.forEach((id) => { S.defenses.get(id).enabled = true; });
  await S.defenses.runAll(10);

  check('every check exposes the values it compared',
    TICK.every((id) => {
      const d = S.defenses.get(id);
      return d.lastValues.length > 0 && d.lastValues.every(shaped) &&
        d.lastColumns.length === 3 && d.lastNote;
    }),
    TICK.map((id) => `${id}:${S.defenses.get(id).lastValues.length}`).join(' '));

  check('a clean client reports every value as matching',
    TICK.every((id) => S.defenses.get(id).lastValues.every((v) => v.ok)));

  // The values must disagree exactly where the verdict says they do.
  S.attacker.setLevel(2);
  await S.defenses.runAll(20);
  const sum = S.defenses.get('checksum').lastValues;
  const bad = sum.filter((v) => !v.ok);
  check('a hooked function shows two different digests, not just a verdict',
    bad.length === 2 && bad.every((v) => v.expected !== v.actual),
    bad.map((v) => `${v.label} ${v.expected}→${v.actual}`).join('  '));

  const sign = S.defenses.get('signing').lastValues.filter((v) => !v.ok);
  check('code signing shows the manifest HMAC beside the computed one',
    sign.length === 1 && sign[0].label === 'client.js' && sign[0].expected !== sign[0].actual,
    sign.length ? `${sign[0].expected} vs ${sign[0].actual}` : 'no mismatch surfaced');

  // Defense 5's values come from the server verdict, not from a local check.
  S.defenses.get('challenge').enabled = true;
  S.defenses.recordVerdict({
    tick: 25, moduleId: 'client', valueOk: true, timedOut: false,
    latencyMs: 41.2, z: 4.7, anomaly: true,
    baselineMean: 8.3, baselineStd: 2.1, baselineReady: true
  }, 41.2);
  const chal = S.defenses.get('challenge').lastValues;
  const digest = chal.find((v) => v.label === 'digest');
  const zrow = chal.find((v) => v.label === 'z-score');
  check('challenge-response shows a correct digest flagged on latency alone',
    digest && digest.ok && zrow && !zrow.ok && zrow.actual === '4.70',
    `digest ${digest && digest.actual}, z ${zrow && zrow.actual}`);

  S.attacker.setLevel(0);
  S.defenses.list().forEach((d) => { d.enabled = false; });
}

section('11. Bypasses armed together');
{
  const TICK_IDS = ['checksum', 'hooks', 'modules', 'signing'];

  const withBypasses = async (armed) => {
    S.attacker.setLevel(0);
    S.defenses.list().forEach((d) => {
      S.defenses.setBypass(d.id, armed.indexOf(d.id) >= 0);
      d.enabled = d.id !== 'challenge';
      d.lastOutcome = null;
    });
    S.attacker.setLevel(3);
    // Two passes: the trampoline has to have fired at least once.
    await S.defenses.runAll(10);
    await S.defenses.runAll(20);
    return TICK_IDS.map((id) => `${id}=${S.defenses.get(id).lastOutcome}`);
  };

  const solo = await withBypasses(['checksum']);
  check('a bypass defeats its own defense on its own',
    solo[0] === 'checksum=missed', solo.join('  '));

  const pair = await withBypasses(['checksum', 'hooks']);
  check('the trampoline does not re-expose the spoofed hooks',
    pair[0] === 'checksum=missed' && pair[1] === 'hooks=missed', pair.join('  '));

  const all = await withBypasses(TICK_IDS.concat(['challenge']));
  check('all bypasses armed at once defeat all four tick-driven defenses',
    all.every((r) => /=missed$/.test(r)), all.join('  '));

  S.attacker.setLevel(0);
  S.defenses.list().forEach((d) => { S.defenses.setBypass(d.id, false); d.enabled = false; });
}

/* ====================================================================== *

 * ====================================================================== */

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log(`\x1b[31mFailures:\x1b[0m\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
