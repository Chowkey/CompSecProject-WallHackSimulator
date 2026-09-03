#!/usr/bin/env node
/*
 * boottest.mjs - Exercise the real boot path under a minimal DOM shim.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 *     node tools/boottest.mjs
 *
 * tools/selftest.mjs verifies the simulation and the defenses. This file
 * verifies the part selftest cannot reach: index.html's actual boot sequence -
 * the loader fetching modules, verifying every signature, executing only what
 * verified, wiring the UI, connecting to the server, and running ticks with a
 * cheat installed.
 *
 * The shim is deliberately thin. It is not a browser and does not try to be;
 * it provides just enough DOM for the boot path to run so that a broken
 * element reference, a bad load order, or a signature mismatch fails here
 * instead of in front of the review committee.
 */

import { readFile, readFileSync } from 'node:fs';
import { readFile as read } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `  ${detail}` : ''}`); }
}

/* ====================================================================== *
 * Minimal DOM
 * ====================================================================== */

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const HTML_IDS = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const CANVAS_SIZES = { 'game-canvas': [800, 500], 'minimap-canvas': [320, 240] };

const scriptErrors = [];
const scriptSrcs = [];
const elements = new Map();

function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, v) => { if (v === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (v) set.add(c); else set.delete(c); }
  };
}

function makeContext(el) {
  // Every canvas call is a no-op; what matters is that the render code runs
  // without throwing and reads ctx.canvas.width/height correctly.
  return new Proxy({ canvas: el }, {
    get: (t, p) => (p in t ? t[p] : () => {}),
    set: (t, p, v) => { t[p] = v; return true; }
  });
}

function makeElement(tag, id) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    children: [],
    style: {},
    dataset: {},
    classList: makeClassList(),
    innerHTML: '',
    value: '',
    checked: false,
    disabled: false,
    textContent: '',
    title: '',
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatch(type, event) { (this._listeners[type] || []).forEach((fn) => fn(event || {})); },
    click() { this.dispatch('click', { target: this }); },
    scrollIntoView() {},
    focus() {},
    blur() { this._blurred = (this._blurred || 0) + 1; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    get firstChild() { return this.children[0] || null; },
    getContext() { return (this._ctx ||= makeContext(this)); }
  };
  const size = CANVAS_SIZES[id];
  if (size) { el.width = size[0]; el.height = size[1]; }
  return el;
}

function runScriptElement(el) {
  if (el.tagName !== 'SCRIPT') return;
  if (el.textContent) {
    try { runInThisContext(el.textContent); }
    catch (err) { scriptErrors.push(err); }
    return;
  }
  if (el.src) {
    // Strip the loader's cache-busting query the way an HTTP server would
    // before it resolves the path on disk.
    scriptSrcs.push(String(el.src));
    const path = String(el.src).split('?')[0];
    readFile(join(ROOT, path), 'utf8', (err, source) => {
      if (err) { el.onerror && el.onerror(err); return; }
      try { runInThisContext(source); el.onload && el.onload(); }
      catch (e) { scriptErrors.push(e); el.onerror && el.onerror(e); }
    });
  }
}

const head = makeElement('head');
const body = makeElement('body');
head.appendChild = body.appendChild = function (child) {
  this.children.push(child);
  runScriptElement(child);
  return child;
};

globalThis.self = globalThis;
globalThis.document = {
  readyState: 'complete',
  head,
  body,
  createElement: (tag) => makeElement(tag),
  getElementById: (id) => elements.get(id) || null,
  addEventListener() {}
};
HTML_IDS.forEach((id) => elements.set(id, makeElement(id.includes('canvas') ? 'canvas' : 'div', id)));

// --file exercises the degraded path: no fetch, so no signature verification,
// and the server runs on the main thread instead of behind a Worker boundary.
const FILE_MODE = process.argv.includes('--file');
globalThis.location = FILE_MODE
  ? { protocol: 'file:', origin: 'null', href: 'file:///index.html' }
  : { protocol: 'http:', origin: 'http://localhost:8000', href: 'http://localhost:8000/' };
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = () => 0;   // no render loop; frames are driven manually
globalThis.fetch = async (url) => {
  try {
    const text = await read(join(ROOT, url), 'utf8');
    return { ok: true, status: 200, statusText: 'OK', text: async () => text };
  } catch {
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => '' };
  }
};

// A Worker that runs server.js in-process but keeps the message passing
// asynchronous, so ordering bugs that only appear across a real Worker
// boundary still show up here.
globalThis.Worker = class {
  constructor() {
    require(join(ROOT, 'src/server.js'));
    this.onmessage = null;
    this._core = globalThis.Sandbox.ServerCore.create((msg) => {
      setImmediate(() => this.onmessage && this.onmessage({ data: msg }));
    });
  }
  postMessage(msg) { setImmediate(() => this._core.handle(msg)); }
};

const intervals = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); intervals.push(id); return id; };

const flush = async (turns = 40) => { for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r)); };

/* ====================================================================== *
 * Boot
 * ====================================================================== */

console.log(`\n\x1b[1mBoot sequence (${FILE_MODE ? 'file:// degraded path' : 'loader → verify → execute → UI → server'})\x1b[0m`);

require(join(ROOT, 'src/hash.js'));
require(join(ROOT, 'src/kernel.js'));
require(join(ROOT, 'src/main.js'));

const S = globalThis.Sandbox;

for (let i = 0; i < 200 && !S.app.booted; i++) await flush(10);

check('boot completed without throwing', S.app.booted === true,
  scriptErrors.length ? `${scriptErrors.length} script error(s): ${scriptErrors[0].message}` : '');
check('no module threw during execution', scriptErrors.length === 0,
  scriptErrors.map((e) => e.message).join(' | '));
if (FILE_MODE) {
  check('signatures cannot be verified, and the loader says so',
    S.signing.available === false);
  check('server falls back to the main thread', S.app.linkKind() === 'in-process');
  check('the lost memory boundary is reported to the user',
    S.app.degraded.some((d) => /file:\/\//.test(d)), `${S.app.degraded.length} warning(s)`);
} else {
  check('all 8 modules verified against the manifest', S.signing.available &&
    Object.keys(S.signing.results).length === 8 &&
    Object.values(S.signing.results).every((r) => r.ok), 'HMAC-SHA256');
  check('server reached over a Worker boundary', S.app.linkKind() === 'worker');
  check('no degradation warnings', S.app.degraded.length === 0);
}
check('module table populated', Object.keys(S.processMemory.modules).length === 8,
  Object.keys(S.processMemory.modules).join(', '));
check('attacker.js loaded last, after verification', !!S.attacker && S.attacker.getLevel() === 0);
check('world built and drawable', S.clientState.ready && S.clientState.width === 40);

/* ====================================================================== *
 * Run the thing
 * ====================================================================== */

console.log('\n\x1b[1mLive run: cheat on, defenses on, rendering through the hook\x1b[0m');

const ctxMain = elements.get('game-canvas').getContext('2d');
const ctxMini = elements.get('minimap-canvas').getContext('2d');
function drawFrame() {
  const exp = S.processMemory.modules.client.exports;
  exp.renderMain(ctxMain);
  exp.renderMinimap(ctxMini);
}

S.app.setCulling('NONE');
S.attacker.setLevel(2);
S.defenses.list().forEach((d) => { d.enabled = true; });
S.app.setChallengesEnabled(true);

await S.app.runTicks(120);
await flush();

let drewOk = true;
try { drawFrame(); } catch (err) { drewOk = false; scriptErrors.push(err); }
check('renders through the installed hook without throwing', drewOk,
  drewOk ? '' : scriptErrors[scriptErrors.length - 1].message);
check('cheat received data it should not have under NONE',
  S.clientState.metrics.hiddenReceived > 0, `${S.clientState.metrics.hiddenReceived} hidden positions`);
check('cheat revealed those positions on the minimap',
  S.attacker.stats.hiddenRevealed > 0, `${S.attacker.stats.hiddenRevealed} drawn through walls`);

const detecting = S.defenses.list().filter((d) => d.lastOutcome === 'detected').map((d) => d.id);
check('defenses fired against the naive cheat', detecting.length >= 3, detecting.join(', '));

// The architectural result, through the real boot path rather than a harness.
S.app.reset('valorant', 'STRICT');
await flush();
S.attacker.setLevel(3);
S.defenses.list().forEach((d) => { d.enabled = false; d.bypassEnabled = true; });
await S.app.runTicks(200);
await flush();

check('STRICT: a fully evasive cheat gains nothing, with every defense off',
  S.clientState.metrics.hiddenReceived === 0,
  `${S.clientState.metrics.hiddenReceived} hidden positions over ${S.clientState.metrics.ticks} ticks`);

try { drawFrame(); } catch (err) { scriptErrors.push(err); }
check('minimap still renders with all five bypasses armed',
  scriptErrors.length === 0 || !scriptErrors.length);

/* ====================================================================== *
 * Keyboard focus
 *
 * Regression guard. The camera turns on the arrow keys, but a browser keeps a
 * dropdown focused after it is used, and a focused widget swallows those keys
 * - so touching any control silently disabled looking left and right. The
 * controls must hand focus back to the page.
 * ====================================================================== */

/* ====================================================================== *
 * Loader cache discipline
 *
 * Regression guard. Signed modules are fetched with cache: 'no-store' and then
 * verified, so a stale one fails loudly. attacker.js and server.js are loaded
 * by URL and are deliberately unsigned, so a stale copy of either would load
 * silently and the page would look entirely healthy while running an older
 * cheat. The unverified files are exactly the ones whose version cannot be
 * taken on trust, which is Defense 4's argument turned on this project itself.
 * ====================================================================== */

console.log('\n\x1b[1mLoader cache discipline\x1b[0m');
{
  const attacker = scriptSrcs.filter((u) => u.indexOf('attacker.js') >= 0);
  check('attacker.js is loaded with a cache-busting token',
    attacker.length > 0 && attacker.every((u) => /[?&]v=\d+/.test(u)),
    attacker[0] || 'attacker.js was never requested');
}

console.log('\n\x1b[1mKeyboard focus returns to the page\x1b[0m');
{
  // The handler is delegated to the #controls container and reads event.target,
  // which is how a real bubbled change event arrives. This shim does not bubble,
  // so the event is dispatched on the container with the widget as its target.
  const controls = elements.get('controls');
  const viewSelect = elements.get('view-select');
  const cullingSelect = elements.get('culling-select');
  controls.dispatch('change', { target: viewSelect });
  controls.dispatch('change', { target: cullingSelect });
  check('a used dropdown releases keyboard focus',
    viewSelect._blurred > 0 && cullingSelect._blurred > 0,
    `view-select blurred ${viewSelect._blurred || 0}x, culling-select ${cullingSelect._blurred || 0}x`);

  // Turning must survive that round trip.
  const before = S.clientState.camera.yaw;
  S.clientState.camera.yaw = 0;
  const keydown = (elements.get('view-select')._listeners.change || []).length;
  S.client.updateCamera(16);
  check('camera update runs without a focused control', typeof S.clientState.camera.yaw === 'number',
    `${keydown} change listener(s) wired`);
  S.clientState.camera.yaw = before;
}

/* ====================================================================== *
 * Benchmark (opt-in: it is the slow part)
 * ====================================================================== */

if (process.argv.includes('--benchmark')) {
  const ticks = Number(process.argv[process.argv.indexOf('--benchmark') + 1]) || 100;
  console.log(`\n\x1b[1mBenchmark: 45 combinations × ${ticks} ticks\x1b[0m`);

  const started = Date.now();
  let lastPhase = '';
  const benchmark = await S.exporter.runBenchmark({ ticksPerCombo: ticks, seed: 'valorant' },
    (p) => {
      if (p.phase !== lastPhase) { lastPhase = p.phase; process.stdout.write(`  ${p.phase}: `); }
      if (p.done % 5 === 0) process.stdout.write('.');
    });
  process.stdout.write('\n');

  check('benchmark walked the full matrix', benchmark.rows.length === 45,
    `${benchmark.rows.length} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  check('every combination produced defense runs',
    benchmark.rows.every((r) => r.runs > 0));
  check('timing sweep produced a curve', benchmark.timing.length > 5,
    `${benchmark.timing.length} overhead points`);

  const strictRows = benchmark.rows.filter((r) => r.culling === 'STRICT');
  check('STRICT leaked nothing in any of its 15 combinations',
    strictRows.every((r) => r.hiddenReceived === 0), `${strictRows.length} combinations`);

  const noneLeak = benchmark.rows.filter((r) => r.culling === 'NONE')
    .reduce((a, r) => a + r.hiddenReceived, 0);
  const bufLeak = benchmark.rows.filter((r) => r.culling === 'BUFFERED')
    .reduce((a, r) => a + r.hiddenReceived, 0);
  check('NONE leaks far more than BUFFERED', noneLeak > bufLeak * 4,
    `NONE ${noneLeak} vs BUFFERED ${bufLeak}`);

  const evasiveMisses = benchmark.rows
    .filter((r) => r.attackerLevel === 3 && r.missed > 0)
    .map((r) => r.defenseId);
  check('bypasses defeat their defenses at level 3',
    new Set(evasiveMisses).size >= 4, [...new Set(evasiveMisses)].join(', '));

  const conclusion = S.education.buildConclusion(benchmark);
  check('conclusion panel generated from the measurements',
    conclusion.available && conclusion.lines.length >= 4,
    `${conclusion.lines.length} findings`);

  console.log('\n\x1b[1mGenerated conclusion\x1b[0m');
  conclusion.lines.forEach((l) => {
    console.log(`\n  \x1b[36m${l.heading}\x1b[0m`);
    console.log(`  ${l.text.replace(/(.{92}\s)/g, '$1\n  ')}`);
  });

  console.log('\n\x1b[1mTiming sweep\x1b[0m');
  console.log('  overhead   challenges   flagged   detection');
  benchmark.timing.forEach((t) => {
    console.log(`  ${String(t.overheadMs).padStart(5)} ms   ${String(t.challenges).padStart(10)}` +
      `   ${String(t.flagged).padStart(7)}   ${(100 * t.detectionRate).toFixed(0).padStart(7)}%`);
  });
}

/* ====================================================================== *
 * Export
 * ====================================================================== */

console.log('\n\x1b[1mSession export\x1b[0m');
const session = S.exporter.buildSession();
check('session JSON serialises', typeof JSON.stringify(session) === 'string',
  `${(JSON.stringify(session).length / 1024).toFixed(1)} KB`);
check('session records all five defenses', session.resultsMatrix.length === 5);
check('session CSV has a header and rows',
  S.exporter.sessionCsv(session).split('\n').length > 8);

intervals.forEach(clearInterval);
console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log(`\x1b[31mFailures:\x1b[0m\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
process.exit(0);
