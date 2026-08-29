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

 * ====================================================================== */

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log(`\x1b[31mFailures:\x1b[0m\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
