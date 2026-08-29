# Reference material: Riot Games as the real-world frame

This file collects the case study the sandbox is modelled on, the mapping between
simulated components and real ones, and the source list. It exists so the report can
show that the simulation has a factual basis rather than being an invented scenario.

Riot is the right case study because they deploy **both** of the layers this project
compares — a deep client-side anti-cheat and a server-side information-hiding
architecture — and they have published technical material about both.

---

## 1. The client layer: Vanguard

Vanguard has two parts: a user-mode client (`vgc.exe`) that appears in the system tray, and
a kernel driver (`vgk.sys`) running at the highest privilege level Windows allows. The
driver is registered as a boot-start service, meaning it loads during Windows' early boot
phase rather than when the game launches.

The reason Riot chose this widely criticised design is exactly the problem this project
needs to demonstrate. If Vanguard only loaded when the game started, a cheat driver that
loaded earlier could already have patched the kernel structures Vanguard relies on to do
its checking. Riot's engineers call this the **"first mover" problem**, and their answer
was to always move first on the defensive side.

This is precisely what **Defense 4** illustrates in the sandbox. `attacker.js` is loaded
after signature verification has completed, so every signature remains valid while the
behaviour of the program has changed. In a browser the equivalent trick is a userscript
declaring `@run-at document-start`.

It is worth noting in the report that the sandbox inherits the same weakness it
demonstrates: `defenses.js` captures a pristine `Function.prototype.toString` reference at
load time, and that reference is only trustworthy because `defenses.js` ran before
`attacker.js`. Change the load order and Defense 5's advantage disappears. The sandbox does
not solve the first-mover problem; it reproduces it.

### The June 2026 development: Vanguard On-Demand

This is the most recent change in this space and belongs in the report's Results &
Discussion section.

Riot has deployed a mode called **Vanguard On-Demand**, in which the kernel driver no
longer loads at boot but only when the player starts the game, and is unloaded on exit.
The mechanism: the user-mode client first performs attestation through the TPM to verify
that the system has not been tampered with, and only then asks Windows to load the signed
driver. For the duration of the session the driver maintains a protected environment using
virtualization-based security.

Requirements are TPM 2.0, Secure Boot, and a CPU supporting VBS. Microsoft's attestation
mechanism validates the boot chain, the hypervisor, and operating-system integrity before
Vanguard is switched into on-demand mode. If a system fails any of these checks, Vanguard
falls back to the previous always-on behaviour.

**Why this matters for the project.** It shows the industry moving from "trust that the
driver loaded first" toward "trust hardware attestation". Instead of software proving its
own cleanliness — which is the shared failure mode of all five defenses in this simulation
— the system anchors trust in something outside software's reach, the TPM chip. It is a
direct answer to the "who checks the checker" paradox that the sandbox demonstrates.

The limits remain, and the report should state them: attestation proves facts about the
**boot chain**, not about the state of RAM during play. It does not see a cheat injected
after boot completes, and it does not see a DMA card reading memory over PCIe from a second
machine.

---

## 2. The server layer: Fog of War

Published in Riot's engineering article *Demolishing Wallhacks with VALORANT's Fog of War*,
and the direct source for the sandbox's three culling modes.

The principle: rather than continuously updating clients with enemy positions, the server
waits until just before an enemy actually becomes visible before sending that data.

More valuable to this project than the final design is **the record of failing and fixing**.
Riot describes three attempts:

1. The first focused on line-of-sight computation, adding raycasts against the corners of
   bounding boxes — but it could not deal with pop-in.
2. The second widened the bounding boxes to catch actions that were about to happen, but
   the line-of-sight check was still too pessimistic.
3. The third combined the second attempt's "looking into the future" with occlusion culling,
   replacing the unreliable raycast.

These map almost one-to-one onto the sandbox's culling modes:

| Riot's attempt | Sandbox mode | Problem it exposed |
|---|---|---|
| Pure raycast | `STRICT` | Pop-in; too pessimistic |
| Widened bounding box | (intermediate step) | Still not sufficient |
| Lookahead + occlusion culling | `BUFFERED` | Smooth, but leaks information |

Reproducing the *path* rather than only the endpoint is a strength when presenting. The
sandbox's `BUFFERED` mode implements the lookahead over both NPC movement and plausible
player movement, which is the direct analogue of attempt two's widened bounding box — and
the measurements show it is exactly that generosity which produces the leak.

---

## 3. What Riot concedes kernel access cannot do

Even with Vanguard at ring 0, some things are out of reach. Analysis of the design notes
that rank manipulation, boosting and similar behaviour fall outside Vanguard's threat model,
because the player really is a human pressing real keys. The abusive behaviour lives in
matchmaking, and the kernel cannot see it. This is why Riot also invests heavily in
server-side analysis to catch what the client-side driver cannot.

This closes the project's argument: even the publisher with the largest resources and the
most invasive client-side anti-cheat in the industry still depends on the server layer for
most of the problem.

---

## 4. Mapping table: sandbox to reality

Include this in the report to establish that the simulation has a practical basis.

| Sandbox component | Real-world counterpart |
|---|---|
| Defense 1 — checksum + `toString` spoofing | Hashing the `.text` section; bypassed with a pristine copy in RAM |
| Defense 2 — hook detection | Function prologue checks, IAT integrity |
| Defense 3 — module enumeration | Scanning for executable memory belonging to no module (`EnumProcessModules`, `VirtualQuery`, `MEM_PRIVATE` vs `MEM_IMAGE`); countering manual mapping |
| Defense 4 — code signing, attacker loaded afterwards | Authenticode / `WinVerifyTrust`; Vanguard's boot-start design and the "first mover" problem |
| Defense 5 — challenge–response + timing | Server-side attestation; Vanguard On-Demand's TPM attestation |
| `Sandbox.processMemory.modules` | The loader's module list (PEB) |
| `Sandbox.processMemory.private` | Executable pages backed by no image |
| Web Worker boundary | The process/network boundary between client and game server |
| `CULLING_MODE = NONE` | Traditional netcode (original CS:GO, most web games) |
| `CULLING_MODE = STRICT` | Riot's first raycast attempt — correct but causes pop-in |
| `CULLING_MODE = BUFFERED` | VALORANT's Fog of War as finally shipped |
| Yellow NPCs (buffer leak) | The attack surface remaining after culling |

---

## 5. Sources

Ordered by citation priority. Primary sources (Riot's own engineering blog) take absolute
precedence over secondary reporting.

**Primary — required reading:**

- Riot Games Technology, *Demolishing Wallhacks with VALORANT's Fog of War*:
  <https://technology.riotgames.com/news/demolishing-wallhacks-valorants-fog-war>
- Riot Games Technology, *Peeking into VALORANT's Netcode*:
  <https://technology.riotgames.com/news/peeking-valorants-netcode>

**Open-source implementation for comparison:**

- CornerCulling — server-side occlusion culling for CS:GO, using analytical raycasts, an
  occluder cache and a BVH: <https://github.com/87andrewh/CornerCulling>

  Valuable for the benchmark section: they measured performance and addressed the latency
  problem, so the sandbox's numbers can be compared against theirs.

**2026 developments — for the discussion section:**

- Vanguard On-Demand and TPM attestation:
  <https://windowsnews.ai/article/riot-games-ends-always-on-kernel-anti-cheat-with-vanguard-on-demand-for-windows-11.431019>

  Secondary reporting. Verify the technical claims against Microsoft's documentation on
  VBS/HVCI and TPM attestation, and against any Riot statement, before citing specifics.

**A note on sources.** When searching for material on Vanguard, most results come from
sites selling cheats. Do not cite those in an academic report — they are biased and not
verifiable. Prefer publisher engineering blogs, Microsoft documentation on
VBS/HVCI/TPM attestation, and conference papers on game security.

---

## 6. Suggested extensions for the discussion

Three questions the sandbox can quantify directly, which are not well covered in the
existing literature:

1. **Buffer width versus cheat advantage.** Sweep the lookahead from 0 to 500 ms and measure
   leaked information (tick count, and distance in time to the moment of legitimate
   visibility). Plot the trade-off curve between experience quality and attack surface.
   The sandbox already reports mean advance warning in milliseconds and percentage of ticks
   affected, so this reduces to varying `BUFFER_LOOKAHEAD_MS` in `src/protocol.js`.

2. **Detection threshold for timing analysis.** At what added overhead, in milliseconds,
   does challenge–response reach 95% confidence? The benchmark's timing sweep produces this
   curve directly. The boundary has practical meaning: it states how cheaply an attacker
   must answer in order to remain invisible.

3. **Computational cost of culling as player count grows.** Measure per-tick time as N
   increases, comparing pure raycasting against a cached-occluder approach — and compare
   against CornerCulling's published figures.
