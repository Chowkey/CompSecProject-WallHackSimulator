# Client Integrity Sandbox

A closed simulation demonstrating, with measurements, a single claim in systems security:

> Any integrity check that runs on a machine the adversary controls is a **self-report**,
> not proof. It raises the cost of an attack; it does not create a guarantee.

Five client-side anti-cheat techniques are implemented, each paired with the technique that
defeats it. Alongside them the server offers three information-culling architectures. The
project measures both, and the comparison is the point: one decision in the server's culling
filter outperforms all five client-side layers combined.

**Scope.** The game, the server, and the attacker are all code written by this project,
running in one web page. Every "cheat" manipulates only this project's own JavaScript
objects. Nothing here targets commercial software, and no part of it functions outside this
sandbox.

---

## Running it

```bash
cd /Users/doancongpho/Desktop/Security
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

A local HTTP server is required for the full demonstration. Opening `index.html` directly
over `file://` still runs, but three things degrade, and the page says so in a banner:

| Over `http://` | Over `file://` |
|---|---|
| Server runs in a Web Worker — a real memory boundary | Server runs on the main thread — no boundary |
| Modules verified with HMAC-SHA256 against `manifest.json` | `fetch` blocked, so nothing can be verified |
| SHA-256 via Web Crypto | Pure-JS SHA-256 fallback |

The Worker boundary is what makes the `STRICT` result meaningful, so use the HTTP server for
anything you intend to report.

### After editing any module

`src/main.js` refuses to load a module whose signature does not match. Re-sign after edits:

```bash
node tools/sign.mjs
```

Files under `src/` that are deliberately **not** signed: `hash.js` and `main.js` (they are
the loader, and a verifier cannot verify itself), `server.js` (it runs in the Worker, on the
trusted side), and `attacker.js` (it is the intruder — signing it would defeat the point).

---

## Demo script

Roughly eight minutes, in the order that builds the argument.

1. **Baseline.** Press Play. `W`/`S` move, `A`/`D` strafe, `Q`/`E` or `←`/`→` turn, `F`
   toggles mouse look. The HUD shows the heading in degrees, so it is obvious whether the
   camera is responding. Green figures appear only when you actually have line of sight to them,
   and the minimap wedge shows where you are facing. `Space` pauses, `.` advances one tick —
   use it to freeze on any moment. `V` switches to the top-down map if the committee wants to
   see the geometry the first-person view is drawn from.

2. **The naive architecture.** Set Culling to `NONE`, Attacker to `2 — wallhack`. A
   conventional ESP overlay appears in the first-person view: bracketed bounding boxes,
   tracer lines from the bottom of the screen, and a range readout on each target — with red
   silhouettes standing *inside the walls you are looking at*. No defense is enabled yet, and
   none would help: the server already handed over the data.

3. **The architectural fix.** Leave the cheat running. Switch Culling to `STRICT`. The red
   silhouettes and their tracers vanish permanently. Say this part out loud: the overlay has
   not been switched off — it is still installed, still hooked, still drawing every frame, and
   the only targets it can box are ones the player could already see unaided. It has been
   starved, not stopped. The readout under the minimap shows zero hidden positions received.
   **Still no defense is enabled.**

4. **The realistic architecture.** Switch to `BUFFERED`. Yellow figures appear — NPCs the
   server sent up to 300 ms early to avoid pop-in. The readout shows the percentage of ticks
   affected and the mean advance warning. This is the attack surface that survives culling,
   and it is the price of a smooth client.

5. **The defenses, one at a time.** Enable a defense, confirm it reports `[DETECTING]`, then
   set Attacker to `3 — evasive` and tick its **bypass** box. The row turns red and reads
   `[BYPASSED]`, and the terminal prints a `LESSON` line explaining why the defense could
   never have worked. The `?` button on each row opens the real-world mapping, including the
   corresponding Windows APIs.

6. **The one that still wins.** Enable Challenge-response with its bypass armed. The cheat
   answers every challenge correctly from its pristine source cache — content proves nothing.
   Now drag **Bypass overhead** upward with `TIMING_ANALYSIS` on. Somewhere below 20 ms the
   server starts flagging the session on latency alone.

7. **The numbers.** Run the benchmark (45 combinations), then read the conclusion panel that
   generates itself underneath. Export session writes JSON and CSV for the report.

---

## The defense values panel

The bottom pane has two tabs. The terminal answers *what exactly did this check see?* one line
at a time; the values panel answers it as a table — the raw expected/observed pairs each check
actually compared on its last run, with every mismatch highlighted. Not a summary of the
comparison, the comparison itself.

```
Code checksum                                          DETECT   0.78ms
  watched function      baseline SHA-256   current SHA-256
  client.renderMinimap  ea8d9e…            9eb235…            ✗
  client.renderMain     791046…            9844e1…            ✗
  client.applyPacket    ad0262…            ad0262…            ✓
```

Each defense declares its own columns, so the table says what the check is really about:
`baseline SHA-256 / current SHA-256` for the checksum, `manifest HMAC / computed HMAC` for code
signing, `pristine reference / current reference` for hook detection, `expected / observed` per
region for module enumeration. Under each table sits the one line naming what that check is
structurally blind to.

The sharpest row in the demo is in challenge–response, where the digest reads **matches ✓** on
a session that is flagged anyway:

```
Challenge-response                                     DETECT   41.20ms
  challenge field    expected                        observed
  digest             server's own copy               matches    ✓
  round trip         8.3 ± 2.1ms                     41.2ms     ✗
  z-score            < 3                             4.70       ✗
```

That is Defense 5's entire argument as three rows of numbers: when the content of an answer
cannot be trusted, measure the physical cost of producing it.

The panel is real DOM rather than canvas so the digests can be selected and pasted straight
into the report. The values are the same objects the terminal formats its evidence lines from,
so the table and the log can never disagree.

## A bug found by comparing all five at once

Reading the five verdicts side by side rather than one at a time turned up a real defect. With
every bypass armed together, Checksum kept reporting DETECT while the other three reported
BYPASS. Each bypass defeats its own defense in isolation, so the per-defense benchmark had
always passed — but the demo script asks for all five together, and in that configuration
Defense 1 was quietly still catching the cheat.

Bypass 2's trampoline unhooks and re-hooks around every inspection, and `installRenderHook()`
builds fresh function objects each time. Bypass 1's spoof table is a `WeakMap` keyed by those
objects, so the first trampoline firing invalidated every entry in it. The fix is to rebuild
the table whenever the hooks are rebuilt.

The honest reading is more interesting than the fix: **a cheat's evasions are not independent**.
Each one is book-keeping the attacker must keep exhaustively in sync with all the others, and
the defender only has to find one place where they drifted apart. `tools/selftest.mjs` §11 now
tests the bypasses in combination, not just one at a time.

## Reading the terminal

The five checks print into one comparable column rather than five differently worded
sentences. Arming a defense first declares its own reach:

```
[DEF:sign] [ARMED ] Code signing — Authenticode / WinVerifyTrust on the image file
[DEF:sign]          READS     the module bytes as fetched at load time, vs manifest.json
[DEF:sign]          BLIND TO  every change made after those bytes were read — i.e. all of them
```

Stating the blind spot *before* the bypass exploits it is deliberate: the reviewer sees the
limitation declared, then watches it exercised, which reads as an argument rather than a
gotcha. Each run then prints a verdict chip, the name column, the cost, and the evidence the
check actually acted on:

```
[DEF:sum ] [DETECT] Checksum      2/3 function hashes changed  ·  0.73ms
[DEF:sum ]          client.renderMinimap ea8d9e…→9eb235… ✗
[DEF:sum ]          client.renderMain    791046…→9844e1… ✗
[DEF:sum ]          client.applyPacket   ad0262… ✓
```

Code signing names every module it covers with its digest, because a signature check that only
says "all good" is indistinguishable from one that is not running — and what the green tick
covers is the entire argument of that defense:

```
[DEF:sign] [DETECT] Code signing  1/6 modules FAIL: client  ·  0.72ms
[DEF:sign]          rng    e5aa8e… ✓   protocol e4a73a… ✓   log       269eaf… ✓
[DEF:sign]          client c5469d… ✗ HMAC mismatch          education 721213… ✓
[DEF:sign]          verified against manifest.json fetched at 06:53:46 — these are the
[DEF:sign]          bytes on disk, not the code now running
```

Chips are `ARMED`, `PASS`, `DETECT`, `BYPASS` and `FALSE+`. On a `BYPASS` the verdict comes
first, then the evidence showing the check genuinely believes itself, then the `LESSON` line
explaining why it never could have worked. Verdicts are emitted in defense-panel order, not in
the order the asynchronous checks happen to settle, so they line up down the column.

## Layout

```
index.html          page shell; loads only hash.js and main.js
styles.css
manifest.json       generated by tools/sign.mjs — do not edit by hand
src/
  hash.js           SHA-256 / HMAC-SHA256, Web Crypto with a pure-JS fallback
  main.js           loader, module table, scoring oracle, main loop
  server.js         authoritative server (Web Worker): map, LOS, culling, challenges
  client.js         packet ingest, first-person raycaster, fog-of-war minimap
  defenses.js       the five checks, their baselines, and the scoring runner
  attacker.js       three attacker levels and five bypass techniques
  ui.js             controls, defense panel, terminal, modals
  export.js         session export and the automated benchmark
  education.js      "?" panel content and the generated conclusion
  rng.js            seeded mulberry32 PRNG
  protocol.js       message vocabulary and simulation constants
  log.js            terminal ring buffer and source taxonomy
  kernel.js         module table, simulated process memory, scoring oracle
tools/
  sign.mjs          regenerates manifest.json
  selftest.mjs      headless checks: hashing, culling, determinism, all 5 defenses
  boottest.mjs      runs index.html's real boot path under a minimal DOM shim
docs/references.md  Riot case study, mapping table, source list
```

`hash.js`, `kernel.js` and `main.js` are the loader and are deliberately unsigned — a
verifier cannot verify itself. That gap is not an oversight; it is the point Defense 4 makes,
and `attacker.js` walks straight through it by loading after verification finishes.

## The five defenses and their bypasses

| # | Defense | Bypass | Why it cannot hold |
|---|---|---|---|
| 1 | Code checksum | `toString()` spoofing | The check must read the thing it checks, and the attacker controls the read |
| 2 | Hook detection | trampoline / self-disarm | The checker is a function too, and is hookable like any other |
| 3 | Module enumeration | manual mapping | The module list is self-reported; unregistered code is not on it |
| 4 | Code signing | load after verification | A signature describes a file at load time, not memory afterwards |
| 5 | Challenge–response | pristine source cache | Answers stay correct — but the *cost* of producing them is measurable |

Defense 5 is the only one that still wins in part of the parameter space, and it does so by
giving up on the content of the answer and measuring its latency instead.

## Verifying it without a browser

Two headless suites run the real modules, not reimplementations of them:

```bash
node tools/selftest.mjs              # hashing, culling, determinism, all 5 defenses
node tools/boottest.mjs              # the actual boot path under a minimal DOM shim
node tools/boottest.mjs --benchmark 120   # plus the full 45-combination matrix
```

`selftest.mjs` checks that each defense stays silent against an untampered client, detects a
naive cheat, and is defeated by its own bypass. `boottest.mjs` runs `index.html`'s boot
sequence — fetch, verify every signature, execute only what verified, wire the UI, connect to
the server, install a cheat and render through it — so a broken element reference or a stale
manifest fails at the command line rather than in front of the committee.

## A loader bug that turned into a finding

`attacker.js` and `server.js` are the two files loaded by URL rather than fetched and verified,
because they are deliberately unsigned — the intruder and the trusted server respectively.
That also made them the two files a browser could quietly serve from cache. The symptom was
a page that looked completely healthy: every signature verified, the client rendered current
code, and only the cheat behaved like an older build of itself, because the browser had reused
a cached `attacker.js`.

The verified modules could not fail this way. A stale copy of one is caught by its HMAC
immediately and loudly. **The file nobody verifies is the file whose version nobody can be
sure of** — Defense 4's argument landing on this project's own loader. Both are now loaded
with a per-page-load cache-busting token, and `tools/boottest.mjs` asserts it.

## Two findings worth putting in the report

Both came out of the measurements rather than being designed in.

**Challenge–response detection is a coverage fraction, and the attacker sets it.** Each
challenge covers one random slice of one random module, so an unprepared hook is caught only
when the slice happens to sample the bytes that changed — reliably within a session (first
detection typically on the first or second challenge), unreliably in any single check. This
is the general behaviour of every rotating partial integrity check, including production ones
that hash a subset of `.text` per pass.

The rate is worth reading carefully, because it is a property of the *cheat's footprint*
rather than of the defense. An earlier build of this sandbox hooked a single render function
and measured **~17%** per challenge. Adding the first-person view meant the cheat had to hook
a second function to reach it, and the measured rate roughly doubled to **~37%** — with the
challenge length, the module set and the defense itself completely unchanged. The defender
does not get to pick this number. A cheat that touches less code is proportionally harder for
any partial integrity check to catch, which is a direct argument for keeping the *sensitive*
surface small rather than for hashing more of it.

**The timing threshold is set by network noise, not by the cheat.** The server adds simulated
round-trip jitter (`NETWORK_JITTER_MS` in `src/protocol.js`, default 8 ms) before z-scoring,
because without it the sandbox would be measuring a same-machine function call and the
detector would look far stronger than it is in production. The sweep then produces a real
curve rather than a step:

| Cheat overhead | 0–8 ms | 20 ms | 30 ms | 40 ms+ |
|---|---|---|---|---|
| Detection rate | 0% | 25% | 75% | 100% |

A cheat whose overhead is small relative to normal network variance is invisible to this
technique no matter how careful the statistics are. Raising the z threshold to protect
players on bad connections directly raises the overhead a cheat is allowed to spend.

## Reproducibility

Every random decision comes from a seeded `mulberry32` stream, so a given seed always
produces the same map, the same patrol routes, and the same challenge sequence. The seed is
shown on screen and recorded in every export. Subsystems draw from separately named streams
so that changing the map generator cannot silently change NPC behaviour for the same seed.

Defense scheduling is driven by tick count rather than wall-clock time, so a fast-forwarded
benchmark performs exactly as many checks as a real-time run of the same length.

## A caveat that belongs in the report

The benchmark fast-forwards the simulation, because 45 × 500 ticks at 20 Hz would take about
nineteen minutes; fast-forwarded it finishes in roughly six seconds. Defense execution times
are real measurements — they are wall-clock timings of the checks themselves. Challenge
latencies are
**not** wall-clock comparable to a live session, and every export marks them as
fast-forward samples. The timing sweep remains valid for locating the detection threshold,
because the cheat's added overhead is genuinely spent — but report the threshold, not the
absolute latencies.
