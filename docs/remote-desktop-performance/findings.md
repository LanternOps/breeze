# Remote Desktop Performance Review — Findings Register

Companion to [README.md](./README.md) (methodology, measurements, change log).
One row per finding from the 2026-07-01 review of `agent/internal/remote/desktop/`,
with final disposition. Ordered by original ranking.

| # | Finding | Tier | Status | Change |
|---|---|---|---|---|
| S1 | MFT "zero-copy" is GPU→CPU→GPU readback every frame | Structural | ✅ Fixed | #4 |
| S2 | DXGI dirty rects fetched every frame then ignored | Structural | ◐ Partial | #5 (dead fetch removed; region-based encoding still open) |
| — | Intel UHD 630: hardware MFT stalls → OpenH264 fallback (found on rig, not in the original review) | Structural | ✅ Fixed | #3 |
| 1 | RTP sample `Duration` constant instead of real elapsed time | 1 | ✅ Fixed | #2 |
| 2 | `cacheEncodedFrame` full copy every frame, only consumed on lock/UAC | 1 | ❌ Skipped (deliberate) | — |
| 3 | Adaptive bitrate ramps up far too slowly (~60s recovery) | 1 | ✅ Fixed | #6 |
| 4 | Dead per-frame dirty-rect allocation | 1 | ✅ Fixed | #5 |
| T1 | AMF blocks ~16–20ms/frame in sleep-poll under encoder mutex | 2 | ✅ Fixed | #1 |
| T2 | Per-frame encoder output allocation | 2 | ⬜ Open | planned #10 (optional) |
| T3 | CRC32 IEEE→Castagnoli on GDI/software path | 2 | ⬜ Open | planned (after VM leg enrolled) |
| T4 | Input handled inline on the SCTP goroutine | 2 | ⬜ Open | planned #9 |
| T5 | Redundant per-frame `Flush` in `CaptureTexture` | 2 | ✅ Fixed | #8 |
| F1 | Delivered fps caps at ~48–50, not 60 (capture/display pacing, exposed by #1) | Follow-up | ✅ Resolved (root cause revised) | #7 — cap is the motion-source present rate, not the loop; #7 fixes the loop's real defects (exact-target pacing, coalescing recovery) |

## Detail — fixed findings

### F1 / frame pacing (Change #7) — a hypothesis corrected by measurement

The register originally blamed the ~48fps cap on the capture loop's
`time.Sleep(frameDuration - elapsed)` pad (quantization). A diagnostic build
with pacing fully removed still delivered 46.5fps — the cap is the
**compositor's present rate for the motion source** (~46.6–47/s in Edge on
Kit's 144Hz display; ~53 on Intel's 59Hz panel). `AcquireNextFrame` syncs to
the *next* present, so the feared pad+present-wait resonance cannot occur.
What WAS real: quantization overshoot made any below-supply target undershoot
(45 → 44.4), and jitter-triggered pads coalesced presents at the default
target (−1.5fps). Change #7's absolute-schedule `framePacer` fixes both
(exact-target: 47.0×3; full-supply delivery at 60-target). Lesson: measure
the *supply* (present rate) before blaming the consumer — and `skipped=0`
with `captured < target` is the supply-limited signature.

### Intel async-MFT stall (Change #3) — the root cause worth remembering

Hardware H264 MFTs enumerated with `MFT_ENUM_FLAG_HARDWARE` are **asynchronous**:
they deliver `METransformNeedInput` / `METransformHaveOutput` events via
`IMFMediaEventGenerator`, and `ProcessInput`/`ProcessOutput` must be gated on
those events. The code unlocked async mode (`MF_TRANSFORM_ASYNC_UNLOCK`) but
drove the transform synchronously — so it accepted input and never produced
output. 8 nil outputs → flush cycles → `permanentlyStalled` → OpenH264 (~19ms/
frame on a pinned CPU core). Only Intel hit it because AMF (AMD) and NVENC
outrank MFT in backend priority. Fix: `encodeAsync`/`pumpEvents` in
`mft_encode_windows.go`. See [encoder-pipeline.md](./encoder-pipeline.md).

Two secondary bugs found while validating:

1. **`time.Sleep(1ms)` on Windows sleeps ~15.6ms** (default timer granularity).
   The first cut of the credit-wait used a 1ms sleep-poll and inflated encodeMs
   to 9–37ms. Bounded `runtime.Gosched()` yield-spin instead.
2. **`SetD3D11Device` ran after `SetDimensions`** (which eager-inits the
   encoder), so init-time decisions couldn't see the capture D3D11 device.
   Reordered in `session_webrtc.go`.

### Zero-copy DXGI input (Change #4) — a false belief corrected

The old init comment said hardware MFTs "stall when fed DXGI surface samples on
many GPU/driver combinations — tested and confirmed on Kit," which justified the
per-frame NV12 readback. **That test was run against the synchronous-driving
bug above** — any input mode appeared to stall. With the async handshake in
place, DXGI-surface input works. Do not reintroduce the readback based on the
old comment. Residual: readback survives as the first-3-frames content check
and the stall-downgrade target.

### Adaptive slow-start (Change #6)

Fixed +5%-of-max steps gated on 3 stable samples each = ~14×3 samples to climb
out of a deep dip. Now: first post-congestion upgrade unchanged (backoff + 3
stable + gentle step), then consecutive clean upgrades accelerate (1 sample,
doubling step, 25%-of-max cap); any degrade/dead-zone resets. Unit-test pinned
(`adaptive_test.go`); live loss injection wasn't possible over the TURN relay.

### Per-frame capture Flush removal (Change #8) — mind the cross-engine caveat

`CaptureTexture` flushed the immediate D3D11 context after every
`CopyResource(gpuTexture, acquired)`. A `Flush` controls *when* a command batch
submits, not the *ordering* of dependent ops, so it was redundant and defeated
driver command batching. Removed after a pre-check that found **no**
cross-device / shared-handle (`OpenSharedResource`, `CreateSharedHandle`,
`D3D11_RESOURCE_MISC_SHARED`, keyed-mutex) / second-device / deferred-context
consumer of `c.gpuTexture` anywhere in the package.

Two distinctions worth remembering:

1. **Not all downstream readers share the immediate context.** The MFT/
   VideoProcessor path reads `c.gpuTexture` via `VideoProcessorBlt` on the *same*
   immediate context (submission order guarantees copy-before-read). But
   **AMF and NVENC** consume the texture from a separate hardware encode engine
   (same D3D11 device, via `InitDX11`/`OpenEncodeSessionEx`), *not* through that
   context — their safety rests on the driver's **same-device cross-engine hazard
   tracking**, the standard D3D11 implicit-sync contract, which holds only because
   there's no shared handle. If a shared handle existed, a keyed mutex (not a
   flush) would be the correct guard. The failure mode if this were wrong is
   **tearing**, which the node-peer (no decoder) cannot see — hence the mandated
   human visual pass on AMD.
2. **Measure the metric's variance before calling a regression.** Intel #8
   encodeMs first looked elevated (1.9–3.5 vs a 1.0–1.3 baseline), but more runs
   hit 1.1 — the MFT zero-copy path just swings 1.1–3.5 ms run-to-run and the
   3-run baseline sampled the low end. `encodeMs` is the *encoder* timer anyway;
   a *capture-loop* flush can't systematically move it. A 3× sample is enough for
   a stable metric (Kit AMF ~0.5) but too thin for a wide-variance one.

## Detail — deliberately skipped

### cacheEncodedFrame gating (finding 2)

The copy is a pooled ~5–50KB memcpy (~1–10µs/frame); its only consumer is the
secure-desktop resend. Post-#1/#3/#4 the per-frame budget is ~2.5ms, so this is
noise. The tempting alternative — cache by reference — requires encoder output
buffers to never be reused, which is not guaranteed across backends. Risk > win.
Re-evaluate only if a profiler ever shows it.

## Detail — still open

- **S2 region-based encoding:** the real dirty-rect win is encoding only changed
  regions (or feeding encoder ROI hints). Large project; the fetch helpers were
  kept in `dxgi_dirty_rects_windows.go` for this.
- **T3 CRC32→Castagnoli:** only benefits the software/GDI path; both rig boxes
  now run hardware paths, so measuring needs the VM leg or forced software mode.
- **F1 capture pacing:** encoder is no longer the bottleneck anywhere; ~48–50
  delivered fps points at DXGI/AcquireNextFrame or display pacing.
- **Validation debt:** live bursty-loss validation of #6 (needs a network
  shaper); tearing can only be judged by a human in the real viewer (checked
  clean on 2026-07-01, and again on the #8 binary / Kit-AMD 2026-07-02 — the
  path most exposed to the flush removal).
- **From PR #2145 review (deferred):** session metrics don't distinguish
  "encoder buffering" from "frame dropped for backpressure" — the nil-output
  path hits neither `RecordSkip` nor `RecordDrop`, so async-pipeline absorption
  is invisible to dashboards. Logging was added at the encoder layer (flush
  discards, no-credit drops, GetEvent failures); a proper metrics counter needs
  a decision about skip/drop semantics first.
