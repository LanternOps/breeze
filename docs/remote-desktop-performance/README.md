# Remote Desktop Performance Review & Tuning

Living record of the Windows remote-desktop performance effort: the review
findings, the measurement harness/methodology, and a per-change results log.
Each change is implemented and measured **one at a time** against real hardware
before it's kept. (This doc will seed a `remote-desktop-perf` skill later.)

Started 2026-07-01. Branch: `ToddHebebrand/remote-desktop-performance-review`.

---

## Goal

Improve perceived and measured performance of the Windows remote-desktop path
(DXGI capture → hardware H264 encode → WebRTC) without regressing correctness
(no dropped frames, no decoder corruption, no tenant/isolation impact).

---

## Where the code lives (and what actually runs)

- All capture/encode/input/WebRTC code: `agent/internal/remote/desktop/`.
- **On Windows the desktop pipeline runs in `breeze-user-helper.exe` (session 1),
  NOT `breeze-agent.exe` (session 0 service).** The service delegates to the
  per-session user-helper so it can reach the interactive desktop + the physical
  GPU. **Encoder/capture changes must be dev-pushed as `component=user-helper`.**
- Encoder backends (priority): AMF (AMD) · NVENC (NVIDIA) · MFT/QuickSync (Intel/
  generic) · OpenH264 (software fallback). See `encoder.go`.

---

## Review findings (ranked; dispositions in [findings.md](./findings.md), current pipeline architecture in [encoder-pipeline.md](./encoder-pipeline.md))

**Structural (biggest, hardest):**
- MFT "zero-copy" path is actually GPU→CPU→GPU readback every frame
  (`mft_encode_windows.go` → `gpu_convert_windows.go`). Biggest steady-state
  cost on the Intel/generic-MFT path.
- DXGI dirty rects fetched every frame then ignored — full-frame work even when a
  small region changed (`dxgi_capture_windows.go`).

**Quick wins (Tier 1):**
1. RTP sample `Duration` is a constant, not real elapsed time → jitter-buffer
   inflation (`session_capture.go:879,989`).
2. `cacheEncodedFrame` full copy every frame, only used on the lock/UAC screen
   (`session_capture.go:67-83`).
3. Adaptive bitrate ramps up far too slowly (~60s to recover) (`adaptive.go`).
4. Dead per-frame dirty-rect allocation (`dxgi_capture_windows.go:188,482`).

**Medium (Tier 2):**
- **AMF blocks ~16–20ms/frame in a sleep-poll loop under the encoder mutex**
  (`encoder_amf_windows.go`). → **Change #1 (done).**
- Per-frame encoder output allocation; CRC32 IEEE→Castagnoli on GDI path; input
  handled inline on the SCTP goroutine; redundant per-frame `Flush` in
  `CaptureTexture`.

---

## Test harness & methodology

### Topology

```
Mac (dev + measurement)                    Kit / Intel / VM (agent under test)
──────────────────────                     ──────────────────────────────────
worktree docker stack (api/web/pg/redis)   breeze-user-helper.exe (session 1)
  caddy :32797  ── Tailscale proxy ──▶      server_url = http://<mac-ts>:41890
  <mac-tailscale-ip>:<proxy-port> (stable)              allow_dev_update:true auto_update:false
Node WebRTC peer (werift) ── signaling ──▶  DXGI capture → AMF/MFT/NVENC → WebRTC
```

### Local stack + stable proxy
- Stack: `pnpm wt-stack up` → `.breeze-stack.json` (baseUrl, admin creds).
- Caddy front door port is ephemeral; a **stable Tailscale TCP proxy** on the Mac
  (`<mac-tailscale-ip>:<proxy-port> → caddy`) gives remote agents a fixed `server_url` and a
  host-matching dev-push download URL. Proxy script:
  `scratchpad/devpush_proxy.py` (threaded, half-close + SO_LINGER so the ~27MB
  binary isn't truncated). Re-point its `--target-port` after each stack recreate.
- **`PUBLIC_API_URL` must equal the proxy URL** (the API builds the dev-push
  download URL from it, and the agent host-checks it). Set in the API container.

### Enrolling a test agent (re-point off prod)
```
# on the target, as a LOCAL admin (Entra/AAD accounts crash Windows OpenSSH):
breeze-agent enroll <site-key> --enrollment-secret <secret> \
  --server http://<mac-tailscale-ip>:<proxy-port> --config C:\ProgramData\Breeze\agent.yaml --force
# then set allow_dev_update:true, auto_update:false in agent.yaml; restart services.
```

### dev-push loop for an ENCODER change (the important part)
```bash
# 1. edit agent/internal/remote/desktop/**
# 2. build the USER-HELPER (GUI subsystem), not the agent:
cd agent && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -ldflags "-X main.version=dev-$(date +%s) -H windowsgui" \
  -o bin/breeze-user-helper-dev ./cmd/breeze-user-helper
# 3. push with component=user-helper (JWT from POST /api/v1/auth/login → tokens.accessToken):
curl -s -X POST http://localhost:32797/api/v1/dev/push -H "Authorization: Bearer $JWT" \
  -F agentId=<agent_id-hash> -F version=dev-<ts> -F component=user-helper \
  -F binary=@bin/breeze-user-helper-dev
# 4. restart the helper so the new binary loads (broker respawns it ~20s):
ssh <local-admin>@<host> 'powershell -c "Get-Process breeze-user-helper | Stop-Process -Force"'
# 5. measure (below).
```

### Measurement — Node WebRTC peer
`e2e-tests/perf-harness/node-peer/run.ts` (werift). Logs in, starts a desktop
session for `RD_DEVICE_ID`, receives the H264 track, emits a summary JSON.
```bash
cd e2e-tests
RD_DEVICE_ID=<device-uuid> RD_LABEL=<label> RD_MACHINE=<name> RD_DURATION_SEC=30 \
  npx tsx perf-harness/node-peer/run.ts
npx tsx perf-harness/compare.ts perf-harness/results/<base>.json perf-harness/results/<change>.json
```
- **Agent-side metrics are the reliable signal.** They live in
  `C:\ProgramData\Breeze\logs\user-helper.log`: `Desktop WebRTC metrics`
  (captured/encoded/sent/skipped/dropped, **encodeMs**, frameBytes, bandwidthKBps,
  backend) and per-frame `H264 frame sent` (encodeMs). Pull via SSH.
- **Rigor:** run each condition **3×** and average; client-side numbers are noisy
  over the TURN relay.

### Motion source (RESOLVED) + remaining caveats
- **Root cause of "throttling" was the 15-min console auto-lock**, not browser
  rAF throttling. Once Kit locked, capture went to the static lock/secure desktop
  (`frameBytes`→~16, fps→~2). Fix:
  - `powercfg /change monitor-timeout-ac 0` + `standby-timeout-ac 0` (and `-dc`),
    and `HKLM\...\Policies\System\InactivityTimeoutSecs=0` (machine-wide, via SSH).
  - Per-user (console user, set at the console): Sign-in options → "require
    sign-in on wake" = **Never**; Screen saver = **None**.
- **Canonical motion source:** a looping fullscreen muted `<video>`
  (`motion/motion-video.html` playing `motion.mp4`). Video decode is **not**
  rAF-gated, so it survives focus loss. Generate the clip with
  `motion/gen-motion.sh` (ffmpeg). Launch on the console via the `RDMotion`
  scheduled task (Interactive principal) or just open the HTML fullscreen.
  `testsrc2` is light-load (flat color bars → ~5KB frames / ~1.9 Mbps re-encoded);
  swap in a denser clip (mandelbrot/real video) for heavy-throughput A/B.
- **Match the motion profile to the change under test:**
  - *Constant motion* (video loop) → encoder throughput / encode-time changes
    (e.g. Change #1). Verified stable: 48fps, skip=0, frameBytes ~4.6KB across a
    full run.
  - *Bursty / idle→active motion* → **RTP-pacing (finding #1)**: the fixed-
    `Duration` bug only bites when frames are **skipped** (static periods
    under-count elapsed RTP time). Under constant 48fps (skip=0) fixed vs
    real-elapsed pacing are ~identical, so Change #2 needs an intermittent-motion
    profile to show a delta.
- **TURN relay (still open, low priority):** connection uses a DO TURN relay, not
  direct P2P over Tailscale, so absolute client RTT/jitter/bitrate are inflated by
  a ~constant offset. Fine for A/B (same path both sides); revisit only if we need
  true latency numbers. Agent-side metrics are unaffected.

### Video baseline — Kit / RX 590 / AMF (Change #1 binary, constant video motion)
48fps, skip 0, dropped 0, **encodeMs ~0.6ms**, frameBytes ~4.6KB, ~1.9 Mbps,
client jitter ~1.5ms. This is the reference point for constant-motion A/B.

---

## Baseline — Kit / Radeon RX 590 / AMF / 2560×1440 (under motion)

| Metric (agent-side) | Value |
|---|---|
| backend | amf (GPU direct BGRA→NV12, D3D11 bound) |
| **encodeMs** | **~16.3 ms/frame** (min 14, max 78) |
| fps captured/encoded/sent | ~48 (skipped 0, dropped 0) |
| frameBytes / bandwidth | ~43 KB / ~1990 KB/s (~16 Mbps) |

Client-side (1×, relay): meanFps 47.5, p5 44.4, bitrate ~21 Mbps, freeze 0,
loss 0, jitter 1.4 ms.

---

## Change log

### Change #1 — AMF 1-frame pipeline ✅ KEEP
`encoder_amf_windows.go` `encodeFrame()`.

**Problem:** after `SubmitInput`, the encoder blocked up to 20×`time.Sleep(1ms)`
polling `QueryOutput` **for that same frame's output**, all under `e.mu` — so
every frame paid ~16ms of encode-wait latency on the capture goroutine, and
`SetBitrate`/`ForceKeyframe`/`Close` blocked behind it.

**Fix:** 1-frame pipeline — submit frame N, then a **single non-blocking
`QueryOutput`** returns an already-finished *previous* frame (the VCE completed it
in the background while we produced N). No sleep, no long mutex hold. Outputs are
drained in FIFO order (one per call, one `SubmitInput` per call) so the P-frame
reference chain stays intact — **we never drop a frame here.** First call(s) after
init/flush return nil while the pipeline fills; the capture loop tolerates nil and
`amfStallThreshold=8` still guards a genuinely stalled encoder.

**Result (Kit / RX 590):**

| | Baseline | Change #1 |
|---|---|---|
| **encodeMs (agent, deterministic)** | **16.3 ms** | **0.5 ms (~30×)** |
| captured/encoded/sent | 48 fps | 48 fps |
| skipped / dropped | 0 / 0 | 0 / 0 |
| bitrate / quality | ~16 Mbps | unchanged |
| client jitter (3× avg) | 1.4 ms | 1.3–1.4 ms (no regression) |

Delivered fps and bitrate unchanged (encoder was ~80% of the frame budget, now
~2% — the bottleneck moved to capture/display rate, not the encoder). No dropped
frames, no loss, no jitter regression. Client "fps +24%" and "jitter +357%" seen
in single run 1 were **noise** — washed out by the 3× runs.

**Verdict:** clear, content-independent win with no regression. Kept.

**Follow-ups this exposes:** delivered fps is now capped by capture/display (~48,
not 60) — investigate DXGI/AcquireNextFrame pacing next. Also frees headroom the
adaptive controller (finding #3) could use.

### Change #2 — RTP sample duration = real elapsed time (finding #1) ✅ KEEP
`session_capture.go` (`sampleDuration`, `noteSampleWrite`, 3 WriteSample sites) +
`session.go` (`lastSampleNanos`).

**Problem:** every `media.Sample` was written with `Duration = 1/fps` (constant).
pion advances the RTP timestamp by `Duration*clockRate` per sample, so when frames
are **skipped** during static periods the RTP media clock falls behind wall-clock.
That inflates the receiver's jitter/playout estimate and shows up as latency that
climbs after idle.

**Fix:** `Duration = time.Since(lastSampleWrite)` (clamped [1ms, 10s]) so the media
clock tracks wall-clock across idle gaps.

**Two subtleties found while testing (both real bugs):**
1. **Dedicated sample clock.** The idle capture-alive heartbeat
   (`maybeResendCachedFrameOnIdle`) bumps `lastVideoWriteUnixNano` every 125ms
   *without writing a sample* (to keep the no-video watchdog quiet). Reading that
   for the duration reset the clock during idle and defeated the fix. Added a
   separate `lastSampleNanos` updated ONLY at real WriteSample sites
   (`noteSampleWrite`). This is the "capture-alive vs sample-written are different
   signals" follow-up the code comment flagged.
2. **Pion off-by-one (acceptable):** pion applies a sample's Duration to the gap to
   the *next* sample, so the idle gap lands on the frame *after* the resume rather
   than the resume frame itself. Over a session the totals telescope, so
   end-to-end media-clock drift still collapses (residual ≈ the last frame's gap).

**Measurement (needed new tooling):** added `mediaClockDriftMs` +
`mean/p95FramePacingErrorMs` to the peer (RTP-timestamp vs monotonic-arrival), and
a **bursty motion profile** (`bursty.html`, active/idle cycles → real skips) since
the fix is a **no-op under constant motion**. Also fixed a metric bug: per-frame
`>>> 0` wrap handling turned any reordered/backwards RTP delta into +4.29e9 ticks,
blowing the accumulated drift up to ±hundreds of millions — replaced with signed
32-bit deltas (a 30s span at 90kHz never wraps).

**Result (Kit / RX 590, bursty motion, fixed metric, 3× each):**

| | Baseline (change #1) | Change #2 |
|---|---|---|
| **mediaClockDriftMs** | **~15,500 ms** | **~950 ms (~16× less)** |
| meanFramePacingErrorMs | ~24 ms | ~45 ms* |
| jitter | ~1 ms | ~0.8 ms |

*Per-frame pacing error is noisier post-fix because of the pion off-by-one (the
idle gap now lands as one large inter-frame delta); the **cumulative drift** — the
metric that actually reflects media-clock vs wall-clock — is the headline and drops
~16×. Verdict: kept. Best validated under real/bursty usage (no-op under constant
motion by design).

### Change #3 — Intel async-MFT event handshake (fixes QuickSync stall) ✅ KEEP
`comutil_windows.go` (IMFMediaEventGenerator plumbing) + `mft_windows.go`
(eventGen QI at init, async state, reset in shutdown/flush) +
`mft_encode_windows.go` (`encodeAsync`, `pumpEvents`, `popPendingOutput`, branch
in `Encode`/`EncodeTexture`).

**Problem (root cause, confirmed on dell70601 / UHD 630):** the QuickSync
hardware encoder is enumerated with `MFT_ENUM_FLAG_HARDWARE`, which returns an
**asynchronous MFT**. Async MFTs deliver `METransformNeedInput` /
`METransformHaveOutput` events through `IMFMediaEventGenerator`, and
`ProcessInput`/`ProcessOutput` must be gated on those events. The code unlocked
async mode (`MF_TRANSFORM_ASYNC_UNLOCK`) but then drove the transform
**synchronously** — `ProcessInput` then poll `ProcessOutput` every frame — never
servicing the event queue. So the MFT accepted input but `ProcessOutput` returned
`E_UNEXPECTED` forever → 8 nil outputs → permanent-stall → swap to **OpenH264
software** (~19ms/frame, pins a CPU core). AMD/Kit never hit this because the AMF
backend outranks MFT; NVENC has its own backend. **The stall is specific to the
async MFT path (Intel QuickSync + generic hardware MFTs).**

Log signature (before):
```
Hardware MFT async unlock succeeded
MFT H264 encoder initialized type=hardware providesSamples=true gpuPipeline=false
MFT encoder not producing output (buffering) consecutiveNil=3 …
MFT stall detected before ProcessInput → permanently stalled → backend=openh264
```

**Fix:** proper async-MFT event handling.
- `initialize()` QueryInterfaces the transform for `IMFMediaEventGenerator`.
  Success ⇒ `asyncMode` (authoritative test — a synchronous/software MFT returns
  E_NOINTERFACE and keeps the legacy sync path, so no other backend regresses).
- `encodeAsync()` drains the event queue (non-blocking, `MF_EVENT_FLAG_NO_WAIT`),
  counting `METransformNeedInput` credits and servicing each
  `METransformHaveOutput` with a single `ProcessOutput` (reusing `drainOutput`),
  queuing finished frames FIFO. It feeds one frame per NeedInput credit and
  returns the oldest completed frame — a 1-frame pipeline like the AMF fix.
- `flushLocked`/`shutdown` reset the credit + pending-output state; `shutdown`
  releases the event generator.

**Subtlety found while measuring (real):** the first cut waited for a NeedInput
credit with `time.Sleep(1ms)` poll. On Windows the default timer granularity is
**15.6ms**, so each 1ms sleep actually stalled ~15ms → `encodeMs` spiked to
9–37ms and the capture loop periodically backed up (client freezes). Replaced the
sleep-poll with a **bounded `runtime.Gosched()` yield-spin** (≤3ms, wakes the
instant the driver posts the event). Steady state never enters the wait (the
previous frame's NeedInput is already queued by the time the next capture
arrives).

**Result (dell70601 / UHD 630 / 1080p, constant RDMotion, 3× each):**

| | Baseline (openh264 sw) | Change #3 (mft-hardware async) |
|---|---|---|
| backend | openh264 (software fallback) | **mft-hardware (no fallback)** |
| **encodeMs (agent, steady-state)** | **~18.7 ms** | **~10 ms** (~2× faster, on GPU) |
| skipped / dropped | 0 / 0 | 0 / 0 |
| software-swaps per session | 1 (every session) | **0** |
| client meanFps (3× avg) | ~40 (w/ freezes) | ~49.7 |
| client freezeCount (3× avg) | ~4 | ~1 (small) |
| client jitter | ~2.0 ms | ~1.1 ms |

The QuickSync hardware encoder now runs the **entire session** instead of
stalling out after 8 frames. Encode time roughly halved **and** moved off the CPU
onto the iGPU (the point of hardware encoding). The residual ~8–10ms is CPU
BGRA→NV12 conversion (`gpuPipeline=false`) — the next optimization, now unblocked
because the MFT actually runs.

**Verdict:** clear correctness + performance win, well-scoped to the async MFT
path, no regression to AMF/NVENC/software. Kept.

**Follow-ups this exposes:**
- ~~The GPU BGRA→NV12 readback path is no longer moot~~ → **done as Change #4**
  (went further: true zero-copy DXGI-surface input, ~2.5ms).
- A future dedicated event-pump thread (`BeginGetEvent` + `IMFAsyncCallback`)
  would remove even the ≤3ms yield-spin, but the current bounded spin is a no-op
  in steady state.

### Change #4 — MFT zero-copy DXGI input (kills the GPU→CPU→GPU readback) ✅ KEEP
`gpu_convert_windows.go` (NV12 texture ring), `mft_gpu_windows.go`
(`tryInitGPUPipeline` wired into init, `createTextureSample`, manager lifecycle),
`mft_windows.go` (`useDXGISamples` + downgrade in idle stall path),
`mft_encode_windows.go` (zero-copy branch in `EncodeTexture`, downgrade ladder in
`trackNilOutput`), `session_webrtc.go` (SetD3D11Device before SetDimensions).

**Problem (the structural review finding):** the MFT "zero-copy" path did GPU
BGRA→NV12 (`VideoProcessorBlt`) then **read the NV12 back to CPU** and memcpy'd
it into a memory-buffer IMFSample — ~7–8ms/frame of readback+copy at 1080p. The
true zero-copy path (DXGI-surface input samples) existed as dead code
(`createDXGISurfaceSample`, `tryInitGPUPipeline`) but was abandoned because
"hardware MFTs stall when fed DXGI surface samples (tested on Kit)" — which was
actually the **async-MFT-driven-synchronously bug** (Change #3): with the event
queue never serviced, *any* input mode appeared to stall.

**Fix:** with the async handshake in place, wire up true zero-copy input:
- `initialize()` installs the DXGI device manager (`MFT_MESSAGE_SET_D3D_MANAGER`)
  **before media-type negotiation**, for hardware MFTs with a capture D3D11
  device. Torn down if the MFT turns out synchronous (zero-copy requires async).
- `session_webrtc.go`: `SetD3D11Device` now runs **before** `SetDimensions`
  (eager init) — otherwise the device is unknown at init time and the manager is
  never installed (found live: first deploy silently stayed on readback).
- `gpuConverter` grows a **ring of 3 NV12 textures** so the Blt never scribbles
  over a texture the async encoder is still reading (1-frame pipeline ⇒ a slot
  is reused ~2 frames after submission).
- `EncodeTexture`: frames 1–3 still go through readback (keeps the black-frame
  content check that validates the converter), then switches to
  `Convert()` → `createTextureSample()` (DXGI surface buffer) → `encodeAsync()`.
- **Degradation ladder** instead of the old cliff: if the MFT stalls while
  zero-copy input is active (`trackNilOutput` 2nd flush cycle, idle-path
  equivalent, or the pre-feed threshold), it **downgrades to the readback path**
  (teardown manager, flush, keyframe) rather than falling all the way to
  OpenH264. Monitor switch re-points the manager via `ResetDevice`; a CPU frame
  arriving in `Encode()` tears the manager down first.

**Result (dell70601 / UHD 630 / 1080p, constant motion, 3× each):**

| | Change #3 (readback) | Change #4 (zero-copy) |
|---|---|---|
| **encodeMs (agent, steady-state)** | ~10 ms | **~2.5 ms (1.1–3.8)** |
| skipped / dropped | 0 / 0 | 0 / 0 |
| downgrades / software-swaps | — / 0 | **0 / 0** |
| client meanFps (3×) | ~49.7 | ~49.5 (44.3/48.8/55.4) |
| client freezeCount (3×) | ~1 | **0 / 0 / 0** |
| client jitter (3×) | ~1.1 ms | ~1.1 ms (1.7/1.1/0.6) |

Full-path Intel story: **~18.7ms CPU (openh264) → ~10ms (hw MFT + readback) →
~2.5ms (hw MFT zero-copy)** — ~7× less encode latency than where the box
started, with the work on the iGPU instead of pinning a CPU core.

**AMF regression check (Kit / RX 590, same binary):** AMF initializes and runs
identically (encodeMs 0.0–0.5, encoded==sent, dropped 0). Client fps/freezes on
Kit looked "degraded" until root-caused: Kit's RDMotion task is still loaded with
**bursty.html** from Change #2 testing — the skips/idle cycles are the motion
profile, not a regression. (Reminder: swap Kit back to `motion-video.html` for
constant-motion A/B.)

**Verdict:** kept. Residual risks noted: tearing can't be detected by the
node-peer (no decoder) — the texture ring + healthy freeze/PLI metrics are the
evidence; do a human visual pass in the real viewer before shipping broadly.

### Change #5 — remove dead per-frame dirty-rect fetch (finding #4) ✅ KEEP
`dxgi_capture_windows.go` (both AcquireNextFrame sites), `dxgi_windows.go`
(`lastDirtyRects` field, interface assert), `capture.go` (`DirtyRectProvider`
interface removed).

**Problem:** every successful `AcquireNextFrame` called
`IDXGIOutputDuplication::GetFrameDirtyRects` (a COM call) and allocated a
metadata buffer + rect slice — and **nothing ever consumed the result**
(`DirtyRectProvider` had zero callers). Pure per-frame overhead + GC garbage.

**Fix:** stop fetching; removed the unused interface/method/field. The fetch
helper (`getDirtyRects`) + merge/coverage helpers and their tests survive in
`dxgi_dirty_rects_windows.go` for when region-based encoding actually lands.

**Result (Intel, 3×):** no regression — zero-copy still active, encodeMs
2.3–5.2ms, skipped/dropped 0/0, client ~50fps 0 freezes (run 1's 42fps/3
freezes was TURN noise; runs 2–3 clean). Win is freed allocations/COM chatter,
below harness noise by design. Kept on "strictly less work, measured no harm."

### Change #6 — adaptive-bitrate slow-start recovery (finding #3) ✅ KEEP
`adaptive.go` (`upgradeStreak`) + `adaptive_test.go` (4 new tests).

**Problem:** recovery after congestion was fixed at +5%-of-max per upgrade, each
gated on 3 consecutive stable samples → a deep dip (floor → ceiling) needed ~14
steps × 3 samples ≈ 45–60s at the 1s viewer-stats cadence. Users saw a
long blurry/low-fps tail after any transient network hiccup.

**Fix:** slow-start-style acceleration that keeps every anti-oscillation
mechanism intact. The **first** upgrade after congestion is unchanged (degrade
backoff 4 + 3 stable samples + gentle +5% step). While conditions stay clean,
consecutive upgrades accelerate: only 1 stable sample required and the step
doubles per upgrade (5% → 10% → 20% → capped 25% of max). Any degrade **or**
dead-zone sample resets the streak to gentle. `SoftResetForActivity` also
resets it.

**Measurement:** deterministic unit tests (live loss-injection A/B isn't
possible over the TURN path). `TestAdaptive_DeepDipRecoveryTime` pins the
headline: floor→8M ceiling in **6 upgrades / ≤30 samples incl. EWMA decay
(~13 clean samples)** vs ~60 before. Reset-on-degrade / reset-on-dead-zone /
first-step-still-gentle each pinned by their own test; all 14 pre-existing
adaptive tests (incl. NoOscillation) still pass. Rig 3×: no steady-state
regression (zero-copy active, ~49fps, 0–1 freezes, no spurious adaptive
actions on a clean network).

### Skipped — cacheEncodedFrame gating (finding #2) ❌ NOT WORTH IT
Investigated: the per-frame cache copy is a pooled ~5–50KB memcpy (~1–10µs)
whose only consumer is the secure-desktop resend. After Changes #1/#3/#4 the
per-frame budget is ~2.5ms — this is noise. Caching by reference instead would
require a cross-backend guarantee that encoder output buffers are never reused
(false for pooled outputs), i.e. real risk for negligible win. Skipped.

---

## Finding — Intel UHD 630 MFT stalls → software fallback ✅ FIXED (Change #3)
**RESOLVED by Change #3 above.** Retained for context: on real Intel UHD 630
(dell70601) the QuickSync **MFT hardware encoder accepted input but never produced
output** because it's an **async MFT driven synchronously** (output arrives via
`METransformHaveOutput` events, but the code polled `ProcessOutput` and never
serviced the event queue). After ~8 nil frames the agent marked it permanently
stalled and swapped to OpenH264 software. Change #3 implements the async event
handshake so the hardware encoder produces output and the stall never occurs.
Files: `comutil_windows.go`, `mft_windows.go`, `mft_encode_windows.go`.

## Legs & status
- **Kit — Radeon RX 590 (AMF):** enrolled, live, on the **Change #6 binary**.
  Constant-motion regression-verified: 49.7fps, 0 freezes, encodeMs 0.5,
  skip/drop 0/0 — identical to the Change #1 reference. RDMotion swapped back
  to `motion-video.html` (constant). ⚠️ Gotcha hit while swapping: PowerShell
  `Set-ScheduledTask` argument strings with `\"` get truncated — use a
  single-quoted PS string with inner double quotes.
- **Intel — dell70601 / UHD 630 (MFT):** enrolled, live, on the **Change #6
  binary**. QuickSync hardware encoder end-to-end with **zero-copy DXGI input**
  (`encodeMs ~2.5ms`, 0 downgrades, 0 software-swaps).
- **VM .55 (Hyper-V):** GDI + software OpenH264 only. Not enrolled.

---

## Next phase — plan (drafted 2026-07-01, not yet started)

Same methodology: one change at a time, 3× runs per condition, agent-side
`encodeMs`/fps as truth. Priority order:

### Change #7 — capture-loop pacing fix (finding F1) — DO FIRST
**Root cause (code-confirmed, high confidence):** `captureLoopDXGI` pads every
iteration with `time.Sleep(frameDuration - elapsed)` (`session_capture.go:592-594`,
CPU path `:604-607`; `frameDuration = 16.67ms` at 60fps). Windows' 15.6ms timer
granularity quantizes the sleep upward → real period ~20.8ms → **~48fps cap**.
Same footgun as Change #3's 1ms sleep-poll. (The `AcquireNextFrame` 50ms timeout
is NOT the limiter — it returns immediately when a frame is ready.)
**Fix direction:** let DXGI pace the loop — `AcquireNextFrame`'s blocking timeout
already wakes on the next presented frame; skip the sleep padding when a frame was
just delivered and only pad when producing above target fps (then hybrid
coarse-sleep + bounded `Gosched` spin, like Change #3's credit wait). Avoid
`timeBeginPeriod(1)` (process-global, power cost) unless simpler options fail.
The ticker path (`captureLoopTicker`, GDI) has the same quantization — touch only
if trivial. **Expected:** delivered fps 48→~58-60 on both boxes, constant motion;
watch skips/encodeMs/CPU for regressions.

### Change #8 — remove per-frame Flush in CaptureTexture (T5)
`dxgi_capture_windows.go:539-541` flushes the **immediate** D3D11 context every
frame "so CopyResource reaches the GPU before downstream reads" — but the
encoder's `VideoProcessorBlt`/`CopyResource`/`Map` run on the *same* immediate
context (`gpu_convert_windows.go:40-64`), which serializes in submission order.
The flush is redundant and defeats driver command batching. Pre-check before
removing: confirm no cross-device/shared-handle consumer on any path. Expect a
no-harm result like Change #5 (win below harness noise by design).

### Change #9 — input off the SCTP goroutine (T4)
`OnMessage` → `handleInputMessage` (`session_control.go:114-150`) does JSON
parse + `ensureInputDesktop` (desktop syscalls) + blocking `SendInput` user32
calls (`input_windows.go:530-560`) inline on pion's SCTP read goroutine — a slow
`SendInput`/secure-desktop switch stalls the datachannel read loop. **Fix:** one
dedicated input-worker goroutine fed by a bounded channel (single worker
preserves event ordering). On overflow: coalesce consecutive mousemoves, never
drop key/click events. **Measurement gap:** harness has no input-latency metric —
validate via correctness (manual interactive pass on both boxes) + no video
regression; add an input-echo timestamp to the harness only if cheap.

### Change #10 (optional) — pool encoder output buffers (T2)
All three backends allocate per output frame (`encoder_amf_windows.go:582`,
`mft_encode_windows.go:515`, `encoder_openh264.go:281`); `encodedFramePool`
already exists in `session_capture.go:40-61` but isn't wired in. Win is GC
pressure only (likely below noise). Hard part is ownership — outputs flow to
`WriteSample` + `cacheEncodedFrame`, so pooling needs a provable release point
(same risk shape that got finding #2 skipped). Attempt only with a clean
ownership story; otherwise skip with a register note.

### Rig expansion — enroll VM .55 (GDI/software leg)
Unblocks two things: **T3** (CRC32→Castagnoli, software/GDI path only) as a
small measured change, and verifying the untested claim in encoder-pipeline.md
that the RDP/console-held → GDI → hardware-MFT memory-buffer path now gets
hardware encoding instead of stalling to software.

### Deferred / gates
- **S2 region-based encoding:** own phase; needs a design pass first
  (dirty-rect-driven encode region vs encoder ROI hints; helpers preserved in
  `dxgi_dirty_rects_windows.go`).
- **#6 live bursty-loss validation:** still needs a network shaper; unchanged.
- **Ship gate (end of phase):** squash-PR the branch to main after a Kit+Intel
  regression pass and a human visual pass in the real viewer on the final binary.

---

## RESUME — session state (checkpoint 2026-07-01, updated)

**Branch:** `ToddHebebrand/remote-desktop-performance-review` (9 commits: harness,
Change #1, motion+proxy, Change #2, drift-metric, **Change #3 async-MFT**,
**Change #4 zero-copy DXGI input**, **Change #5 dead dirty-rect fetch**,
**Change #6 adaptive slow-start**). Working tree clean.

**Latest:** Changes #3–#6 landed. Intel QuickSync runs end-to-end via the async
event handshake with true zero-copy DXGI-surface input: `encodeMs` ~18.7ms
(openh264 sw) → ~10ms (hw + readback) → **~2.5ms (hw zero-copy)**. Dead
per-frame dirty-rect fetch removed. Adaptive bitrate recovers from a deep dip
in ~13 clean samples instead of ~60 (slow-start streak, unit-test pinned).
cacheEncodedFrame gating (#2) investigated and **skipped** (µs-scale, risk >
win — see Skipped entry). **Both boxes are on the Change #6 binary** and
regression-verified (Kit constant-motion 49.7fps / encodeMs 0.5 / skip 0;
Intel zero-copy ~2.5ms). Kit's RDMotion restored to `motion-video.html`.
Remaining Tier-2 candidate: CRC32→Castagnoli (software/GDI path only).
Outstanding: human visual pass in the real viewer (node-peer can't see
tearing), live bursty-loss validation of Change #6 when a network shaper is
available.

**To bring the rig back up next session:**
1. **Stack:** `pnpm wt-stack up` in the worktree. Ports are ephemeral — read
   `.breeze-stack.json`. Admin `admin@breeze.local` / `BreezeAdmin123!`. Org
   and Site IDs: see `internal/remote-desktop-perf-rig.md`.
   Compose project `breeze-wt-toddhebebrand-remote-desktop-perf-b7ee09`.
2. **PUBLIC_API_URL:** set to the proxy in `.env` (already committed as
   `http://<mac-tailscale-ip>:<proxy-port>`) and recreate the api container. ⚠️ Recreate with
   BOTH `--env-file .env --env-file .env.stack` or `ENROLLMENT_KEY_PEPPER` reverts
   to `.env`'s value and **invalidates existing enrollment keys** (enrolled agents
   keep working via their token; only *new* enrollments need a fresh key). If the
   pg volume was wiped (`wt-stack down`), re-enroll the boxes.
3. **Proxy:** `python e2e-tests/perf-harness/tools/devpush_proxy.py --target-port=<caddy host port>`
   in the background (Mac Tailscale `<mac-tailscale-ip>:<proxy-port>` → caddy). Re-point
   `--target-port` to the new caddy port after any stack recreate.
4. **Verify boxes online:** `select hostname,status from devices;` in the stack pg.

**Boxes (all on the local stack; local admin accounts to dodge Entra-SSH crash):**

| Box | IP | GPU / encoder | device id | agent_id (dev-push) | SSH |
|---|---|---|---|---|---|
| Kit | `<tailscale-ip>` | RX 590 / **AMF** | *(internal doc)* | *(internal doc)* | key auth |
| Intel | `<tailscale-ip>` | UHD 630 / **MFT** | *(internal doc)* | *(internal doc)* | local-admin pw |

Real IPs, device/agent IDs, and SSH access: **`internal/remote-desktop-perf-rig.md`** (gitignored — never commit these here; CLAUDE.md "No Internal Infrastructure Details in Public Code").

**Iterate loop for an ENCODER/CAPTURE change (runs in `breeze-user-helper.exe`):**
```bash
# build user-helper (GUI subsystem)
cd agent && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -ldflags "-X main.version=dev-$(date +%s) -H windowsgui" \
  -o bin/breeze-user-helper-dev ./cmd/breeze-user-helper
# deploy via DIRECT COPY (more reliable than dev-push WS, which races the broker
# respawn and re-locks the exe before the install lands):
scp bin/breeze-user-helper-dev <box>:C:/tmp/h.exe
# then over SSH: Stop-Service BreezeWatchdog,BreezeAgent; kill breeze-user-helper;
#   Copy-Item C:\tmp\h.exe 'C:\Program Files\Breeze\breeze-user-helper.exe' -Force;
#   Start-Service BreezeAgent,BreezeWatchdog   (helper respawns on new binary)
```
**Measure:** `cd e2e-tests; RD_DEVICE_ID=<id> RD_LABEL=<l> RD_DURATION_SEC=30 npx tsx perf-harness/node-peer/run.ts`
then `npx tsx perf-harness/compare.ts <base>.json <change>.json`. Agent-side truth
in `C:\ProgramData\Breeze\logs\user-helper.log` (`Desktop WebRTC metrics`,
`H264 frame sent`). Motion: launch the `RDMotion` scheduled task (constant =
`motion-video.html`, bursty/skips = `bursty.html`); **prevent console lock** (see
Motion section). Run each condition **3×** (client metrics are noisy over the TURN
relay; agent-side `encodeMs` is deterministic).

**To restore a box to prod when done:** Kit — restore `agent.yaml.prod-bak-*` +
re-enroll to `https://us.2breeze.app`. Intel — fresh install (never on prod);
`breeze-agent.exe service uninstall` to remove, or leave for testing.
