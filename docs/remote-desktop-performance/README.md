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

### Change #7 — absolute-schedule frame pacing (finding F1) ✅ KEEP — and F1 root cause REVISED
`pacer.go` (new `framePacer` + 6 unit tests), `session_capture.go`
(`captureLoopDXGI` GPU/CPU tails; `captureAndSendFrame` now returns whether a
frame was sent). Branch `ToddHebebrand/rd-perf-change7-capture-pacing`.

**What the rig showed — two separate facts:**

1. **F1's "~48fps cap" is the motion source, not the capture loop.** A
   diagnostic build with pacing fully removed still delivered 46.5fps. Edge
   composites both the 60fps video AND a 144Hz rAF canvas (`spin.html`) at
   ~46.6–47 presents/s on Kit — whose display is actually **144Hz** 2560×1440,
   not 60 — and Intel's 59Hz panel yields ~53. `skipped=0` in every run: the
   loop captures every present. Delivered fps == compositor present rate on
   both boxes, before and after the fix.
2. **The old relative sleep-pad still had two real, measured defects:**
   (a) at any target below the supply rate it systematically undershot the
   target (sleep-quantization overshoot accumulates): `set_fps` 45 → 44.4,
   47 → 46.1–46.3; (b) at the default 60-target, pad sleeps triggered by
   present jitter swallowed presents into `AccumulatedFrames` (coalescing
   loss): agent-side 45.0–45.8 fps out of a 46.6 supply.

**Fix:** `framePacer` — sent frames are paced against an **absolute schedule**
instead of per-iteration `time.Sleep(frameDuration - elapsed)`. A late frame
(oversleep, slow encode) makes the next wait negative so the deficit is repaid
instead of compounded; >1 period behind resyncs without a catch-up burst; in
supply-limited steady state it never sleeps at all — `AcquireNextFrame`'s
blocking is the pacing. Long-run rate = min(supply, target) exactly.

**Result (Kit / RX 590 / constant video motion, steady-state fps, 3× each):**

| target fps | old (relative pad) | Change #7 (pacer) |
|---|---|---|
| 45 | 44.4 | **45.0 (exact)** |
| 47 (≈ supply) | 46.1–46.3 | **47.0 / 47.0 / 47.0 (exact)** |
| 60 (default) | 45.0–45.8 (agent-side) | **46.5–46.9 (= full supply)** |

Intel (zero-copy MFT): 51.7–52.2 → **53.0–53.6** agent fps, encodeMs 1.1–2.5
(unchanged), skip/drop 0/0. No jitter/freeze regression on either box. Also
removes the per-frame `time.Sleep` syscall in the supply-limited common case.
Small win, exact-target correctness, no regression — kept.

**Harness additions (were needed to measure this):**
- `RD_ACCESS_TOKEN` env (`signaling.ts`) — reuse one admin token per batch;
  the auth rate limiter (~5 logins/window, and failed retries keep the window
  saturated) blocks back-to-back A/B runs. Tokens expire ~15min.
- `RD_DRIVE` commands now send 2s + 7s **after** the control channel opens
  (`run.ts`) — a send racing the agent's `OnMessage` attach is silently
  dropped (set_fps never applied; cost three misleading runs before caught).
- `spin.html` — rAF/canvas motion source (follows display refresh, foreground
  only). NB: Edge still presented it at only ~47/s on the 144Hz box, so it
  does NOT raise the supply ceiling; its per-run supply also drifts more than
  the video loop (42–52 observed) — prefer `motion-video.html` for A/B.

**F1 disposition:** capture loop exonerated; the loop-side defects that did
exist are fixed. Verifying true 60fps delivery needs a motion source that
*presents* ≥60/s steadily — the browser tops out ~47/s on Kit regardless of
refresh rate; a native fullscreen renderer (or browser tuning) is a future
rig upgrade, tracked in the plan below.

### Change #8 — remove redundant per-frame Flush in CaptureTexture (T5) ✅ KEEP
`dxgi_capture_windows.go` (`CaptureTexture`, removed the post-`CopyResource`
`Flush` on the immediate context). Branch
`ToddHebebrand/rd-perf-change8-remove-capture-flush` (stacked on #7).

**Problem:** after `CopyResource(gpuTexture, acquired)` into the capture's
DEFAULT texture, `CaptureTexture` flushed the **immediate** D3D11 context every
frame "so CopyResource reaches the GPU before downstream reads." That flush is
redundant: it only controls *when* the batch is submitted, not the *ordering*
of dependent ops, and it defeats driver command batching.

**Pre-check (no cross-device/shared-handle consumer — verified before removal):**
every downstream reader of `c.gpuTexture` binds to the **same** D3D11 device
(`GetD3D11Device`/`GetD3D11Context` are wired into each encoder via
`SetD3D11Device`). No `OpenSharedResource` / `CreateSharedHandle` /
`D3D11_RESOURCE_MISC_SHARED` / keyed-mutex / second `D3D11CreateDevice` / deferred
context anywhere in the package. So:
- **MFT/VideoProcessor path (Intel):** the encoder's `VideoProcessorBlt` runs on
  this very immediate context (`gpu_convert_windows.go` QIs `c.context` for its
  `ID3D11VideoContext`) — within-context submission order already guarantees the
  copy precedes the read. Flush unambiguously redundant.
- **AMF (Kit) / NVENC:** wrap `c.gpuTexture` on the same device via
  `InitDX11(e.d3d11Device)` / `OpenEncodeSessionEx(device)` — no copy, no shared
  handle — so the driver's **same-device cross-engine hazard tracking** orders the
  VCE/NVENC read after the copy regardless of flush timing (the standard D3D11
  implicit-sync contract).

**Result (constant video motion, agent-side `encodeMs`/skip/drop is truth):**

| | Baseline (#7) | Change #8 |
|---|---|---|
| **Kit / AMF** encodeMs (3×) | 0.5 / 0.0 / 0.5 | 0.8 / 0.3 / 0.9 |
| Kit skipped / dropped / freeze | 0 / 0 / 0 | 0 / 0 / 0 |
| **Intel / MFT** encodeMs | 1.1 / 1.0 / 1.3 | 1.9 / 3.5 / 2.6 / 3.4 / **1.1 / 1.1** (6×) |
| Intel skipped / dropped | 0 / 0 | 0 / 0 (all 6 runs) |

`encodeMs` is the **encoder** timer, not the capture loop, so removing a
capture-loop flush is not expected to move it — and it doesn't systematically:
the MFT zero-copy path swings 1.1–3.5 ms run-to-run (the documented #7 range is
1.1–2.5), and #8 lands on 1.1 twice, so the tight 1.0–1.3 baseline just sampled
the low end. One Intel run showed 3 **client-side** freezes (p5Fps 9.5) with
**agent-side skip/drop 0** — a TURN-relay artifact, not agent frame loss (same
pattern flagged for Changes #4/#5); the other 5 Intel runs and all 3 Kit runs
were freeze-clean. No skips, no drops, no fps change on either backend.

The win — one fewer `Flush` syscall per frame plus restored driver command
batching — lives in the capture loop, which the harness has no timer for, so it
is below harness visibility by design (a Change-#5-style "strictly less work,
measured no harm" result). Kept.

**Caveat / ship gate — CLEARED:** the node-peer has no decoder, so it cannot see
tearing. Removing the flush on **AMF/NVENC** rests on driver same-device
cross-engine sync (not immediate-context submission order), so if any coherency
issue existed it would surface as tearing, invisible to the harness. The
freeze/skip/drop=0 metrics + the NV12 texture ring were the automated evidence;
the **human visual pass in the real viewer on the #8 binary confirmed no tearing
(Kit/AMD, 2026-07-02)** — the residual risk this change carried is retired.

### Change #9 — input injection off the SCTP goroutine (T4) ✅ KEEP
`input_queue.go` (new `inputEventQueue` + unit tests in `input_queue_test.go`),
`session_control.go` (`handleInputMessage` enqueues; new `inputWorkerLoop`),
`session.go` (`inputQ` field, close on cleanup), `session_webrtc.go` (construct
queue), `session_stream.go` (start worker). Branch
`ToddHebebrand/rd-perf-change9-input-worker` (stacked on #8).

**Problem:** pion delivers viewer data-channel messages on its **SCTP read
goroutine**. For the `input` channel that ran `handleInputMessage` inline —
JSON parse + `ensureInputDesktop()` (desktop syscalls) + **blocking `SendInput`**
(`input_windows.go`) — all on that goroutine. A slow injection (a Winlogon/UAC
secure-desktop switch, or `SendInput` blocking) stalls the SCTP read loop, which
backs up **every** data channel (control, cursor, input) for that peer.

**Fix:** the SCTP callback now does only the cheap, non-blocking work — parse,
size-check, `inputActive.Store(true)` (so the capture loop still wakes
immediately, independent of any injection backlog) — then hands the typed event
to a queue. A **single dedicated worker goroutine** drains the queue and calls
the blocking `HandleEvent`, so injection latency never touches the SCTP loop. One
worker preserves event ordering; it's started in `startStreaming` (in `wg`, with
`observability.Recoverer`) and exits on `s.done`.

**Queue design (why not a plain channel):** a Go channel is FIFO-opaque and can't
*coalesce*. The queue is a mutex-guarded slice + a cap-1 notify channel:
- **Coalesce consecutive `mouse_move`s** — a newer absolute position replaces the
  trailing queued move (a slow injector can't build a backlog of stale cursor
  positions). Moves separated by a click/key do **not** coalesce (a drag depends
  on the move that precedes its `mouse_down`).
- **Never drop keys/clicks/scroll** — those carry irreplaceable intent. A safety
  cap (1024) only ever drops the *oldest move*; in practice the queue stays
  near-empty (worker drains in µs).
- **`push` never blocks the producer**; the worker wakes on the cap-1 signal and
  drains everything queued per wakeup.
Unit tests cover FIFO order, coalescing, move-across-click non-coalescing,
keys/clicks/scroll never coalescing, the safety valve dropping only moves, close
semantics, notify, and a concurrent producer/consumer run under `-race` (no lost
keys).

**Measurement.** No harness input-latency metric exists (as the plan flagged), so
validation is (a) **no video regression** and (b) input still injected. Added an
`RD_INPUT_HZ` load generator to the node-peer (floods the input channel with
mouse_move + periodic key/scroll bursts) to exercise the worker concurrently with
video.

| | Baseline (#8) | Change #9 (no flood) |
|---|---|---|
| **Kit / AMF** encodeMs / skip / drop / freeze | ~0.5 / 0 / 0 / 0 | 0.5–1.4 / **0 / 0 / 0** |
| **Intel / MFT** encodeMs / skip / drop / freeze | ~1–2 / 0 / 0 / 0 | 1.8–2.2 / **0 / 0 / 0**, fps 57 |

Under a 60Hz input flood, **`dropped=0` on both boxes** (no video frames dropped
for backpressure while injecting concurrently) and the flood had an *observable
effect on the target* — Kit's bandwidth rose (injected cursor motion changed
screen content); on Intel the flood moving the cursor/scrolling over the Edge
kiosk made the motion page static, which shows up as `AcquireNextFrame`
no-new-frame **skips** (a test-methodology artifact of browser motion, not a
pipeline regression — the same run with no flood is skip=0). That the target
visibly reacted is direct evidence the worker injects input end-to-end.

**Outstanding — manual interactive pass:** the automated harness can prove input
is *accepted and injected without stalling video*, but not that a keystroke types
the *right* character or that a drag tracks correctly. That correctness check is a
human interactive pass in the real viewer on both boxes (mouse drag, typing,
clicks, scroll, Ctrl+Alt+Del) — the analogue of #8's visual pass, folded into the
end-of-phase ship gate.

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
- **Kit — Radeon RX 590 (AMF), display 2560×1440 @ 144Hz:** enrolled, live, on
  the **Change #9 binary** (`dev-1782967071`). Motion supply ceiling ~46.6–47 presents/s (Edge
  compositing — see Change #7); agent delivers the full supply, skip/drop 0/0,
  encodeMs ~0.5. RDMotion on `motion-video.html` (constant). ⚠️ Gotcha:
  PowerShell `Set-ScheduledTask` argument strings with `\"` get truncated —
  use a single-quoted PS string with inner double quotes.
- **Intel — dell70601 / UHD 630 (MFT), display 1920×1080 @ 59Hz:** enrolled,
  live, on the **Change #9 binary** (`dev-1782967071`). QuickSync end-to-end with **zero-copy
  DXGI input** (encodeMs ~1–2.5ms, 0 downgrades, 0 software-swaps), ~53 fps
  (59Hz panel minus compositor losses).
- **VM .55 (Hyper-V):** GDI + software OpenH264 only. Not enrolled.

---

## Next phase — plan (drafted 2026-07-01; Change #7 done)

Same methodology: one change at a time, 3× runs per condition, agent-side
`encodeMs`/fps as truth. Priority order:

### Change #7 — capture-loop pacing fix (finding F1) ✅ DONE
Implemented and measured — see the Change #7 entry in the change log above.
Outcome differed from the hypothesis here: the ~48fps cap turned out to be the
motion-source present rate (proven with a no-pacing diagnostic build), while
the old sleep-pad's real defects (target undershoot + present-coalescing loss)
were fixed by the absolute-schedule `framePacer`. Rig follow-up: a motion
source that presents ≥60/s (browser tops out ~47/s on Kit).

### Change #8 — remove per-frame Flush in CaptureTexture (T5) ✅ DONE
Implemented and measured — see the Change #8 entry in the change log above.
Pre-check confirmed no cross-device/shared-handle/deferred-context consumer;
removed the flush. Result was the expected Change-#5-style "strictly less work,
no measured harm": Kit (AMF) and Intel (MFT) both freeze/skip/drop-clean across
3× / 6× runs, encodeMs distributions overlapping baseline. AMF-tearing risk is
invisible to the node-peer and is folded into the end-of-phase visual-pass gate.

### Change #9 — input off the SCTP goroutine (T4) ✅ DONE
Implemented and measured — see the Change #9 entry in the change log above. One
dedicated input-worker goroutine drains a mutex-guarded coalescing queue (Go
channels can't tail-coalesce), fed by the SCTP callback which now only parses +
enqueues. Coalesces consecutive mouse_moves, never drops keys/clicks/scroll.
No video regression on either box (skip/drop 0, encodeMs unchanged); `dropped=0`
under a 60Hz input flood. Outstanding: the human interactive-correctness pass
(right char typed, drag tracks), folded into the end-of-phase ship gate.

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

## RESUME — session state (checkpoint 2026-07-02, updated)

**Branches:** Changes #1–#6 merged to `main` via PR #2145 (squash). Stacked
change branches (each stacked on the previous):
`ToddHebebrand/rd-perf-change7-capture-pacing` (Change #7 framePacer + harness
additions) → `ToddHebebrand/rd-perf-change8-remove-capture-flush` (Change #8) →
`ToddHebebrand/rd-perf-change9-input-worker` (Change #9, current).

**Latest:** Change #9 measured and kept (see change log): input injection moved
off pion's SCTP read goroutine onto a single dedicated worker fed by a
mutex-guarded coalescing queue (coalesces consecutive mouse_moves, never drops
keys/clicks/scroll, single worker preserves order). Unit-tested (incl. concurrent
`-race`); no video regression on either box (skip/drop 0, encodeMs unchanged);
`dropped=0` under a 60Hz input flood, which also observably moved the target
(proof injection works end-to-end). **Both boxes are now on the Change #9 binary**
(`dev-1782967071`). #8's AMD-tearing gate was already cleared (visual pass
2026-07-02). Next per the plan: Change #10 (optional — pool encoder output
buffers, attempt only with a clean ownership story), rig expansion (VM .55
GDI/software leg unblocks T3), rig follow-up (>=60fps-presenting motion source).
Outstanding gates: **human interactive-correctness pass for #9** (right char
typed, drag tracks, Ctrl+Alt+Del — analogue of #8's visual pass); end-of-phase
visual pass on the final squashed binary; live bursty-loss validation of Change
#6 when a network shaper is available.

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
