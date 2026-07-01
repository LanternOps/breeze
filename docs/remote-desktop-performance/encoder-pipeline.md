# Windows Remote-Desktop Encode Pipeline (as of Changes #1–#6, 2026-07-01)

Maintainer-facing architecture of the capture→encode path in
`agent/internal/remote/desktop/`, post the 2026-07 performance round. Read this
before touching `mft_*.go`, `encoder_amf_windows.go`, or `gpu_convert_windows.go`.
Measurements and per-change history: [README.md](./README.md) · finding
dispositions: [findings.md](./findings.md).

## Where it runs

On Windows the whole pipeline (capture, encode, WebRTC, input) runs in
**`breeze-user-helper.exe`** in the interactive session — NOT the
`breeze-agent.exe` session-0 service, which only brokers signaling over IPC.
Encoder changes must be deployed as the user-helper binary.

## Backend priority

`encoder.go` factory order: **AMF (AMD) → NVENC (NVIDIA) → MFT (Intel
QuickSync / generic hardware) → OpenH264 (software)**. The MFT backend refuses
to use the *software* H264 MFT (stalls 20–60 frames on Server SKUs) — software
encoding is always OpenH264.

## The MFT path (Intel QuickSync et al.)

### Async event model — the load-bearing fact

Hardware MFTs are **async**: after `MF_TRANSFORM_ASYNC_UNLOCK`, input/output
must be gated on `METransformNeedInput` / `METransformHaveOutput` events from
`IMFMediaEventGenerator`. Driving one with synchronous
`ProcessInput`→poll-`ProcessOutput` produces the classic signature — *accepts
input, never emits output, permanent stall, software fallback*. That was the
Intel UHD 630 bug.

Implementation (`mft_encode_windows.go`):

- `initialize()` QIs the transform for `IMFMediaEventGenerator`; success sets
  `asyncMode`. A sync MFT returns `E_NOINTERFACE` and keeps the legacy path.
- `pumpEvents()` drains the queue non-blocking (`MF_EVENT_FLAG_NO_WAIT`):
  NeedInput events become credits, each HaveOutput is serviced with one
  `ProcessOutput` (via `drainOutput`, which retains all providesSamples /
  stream-change / buffer-grow handling), finished frames queue FIFO.
- `encodeAsync()` feeds one frame per credit and returns the oldest completed
  frame — a **1-frame pipeline** (same shape as the AMF fix): you get frame
  N−1's output while the VCE/QSV works on N. Callers already tolerate nil
  during pipeline fill.
- Credit wait is a **bounded `runtime.Gosched()` yield-spin (≤3ms)** — never
  `time.Sleep`: Windows' 15.6ms timer granularity turns a 1ms sleep into ~15ms
  and re-creates the latency the async fix removed. Steady-state never enters
  the wait (previous frame's NeedInput is already queued).

### Zero-copy DXGI input

With `asyncMode` + a capture D3D11 device, `initialize()` installs the DXGI
device manager (`MFT_MESSAGE_SET_D3D_MANAGER`, **before media-type
negotiation** — which is why `SetD3D11Device` must be called before
`SetDimensions`, whose eager init would otherwise run without the device).

Per frame: `gpuConverter.Convert()` Blts BGRA→NV12 on the GPU into a **ring of
3 NV12 textures** (so the async encoder can still be reading frame N while N+1
converts), the texture is wrapped as a DXGI-surface `IMFSample`
(`createTextureSample`), and fed via `encodeAsync`. No CPU readback, no sample
memcpy. Frames 1–3 of a session still take the readback path so the black-frame
content check can validate the converter.

> **History warning:** an old comment claimed hardware MFTs "stall when fed
> DXGI surface samples (tested on Kit)". That test predated the async fix — the
> stall was the synchronous driving, not the surface input. Do not reintroduce
> the readback on the strength of that comment.

### Degradation ladder

Stalls no longer fall off a cliff to software. In order:

1. **Zero-copy DXGI input** — on stall (2nd flush cycle in `trackNilOutput`,
   the idle-path equivalent in `AdvanceStallDetection`, or the pre-feed
   threshold): tear down the DXGI manager, flush, force keyframe → **readback**.
2. **GPU convert + readback** (CPU memory-buffer input, still hardware encode).
3. **CPU BGRA→NV12** (`Encode()`) — also used under GDI capture; entering it
   with the DXGI manager still installed tears the manager down first.
4. **OpenH264 software** — only after the whole MFT is `permanentlyStalled`.

Monitor switch: `SetD3D11Device` re-points the DXGI manager via `ResetDevice`
(tears down zero-copy if that fails) and recreates the GPU converter.

## Headless / RDP / secure-desktop behavior

Nothing in #3–#6 changed the fallbacks; the fast paths are capability-gated:

- **Headless / no GPU:** DXGI init fails → GDI capture; `probeHardwareMFT`
  finds nothing → OpenH264. Identical to pre-#3.
- **Console held by an RDP session:** DXGI loses the display → GDI capture →
  CPU `Encode()` path. If a hardware MFT exists, the async handshake works for
  memory-buffer input too, so this case *gained* hardware encoding (it used to
  stall to software). Not yet rig-tested — verify when the VM leg is enrolled.
- **UAC / lock screen:** unchanged secure-desktop handling (GDI, cached-frame
  resend, software-encoder preference at session start on a secure desktop).

## Adaptive bitrate (Change #6)

`adaptive.go` AIMD with EWMA smoothing, plus **slow-start recovery**: first
upgrade after congestion needs degrade-backoff (4) + 3 stable samples and steps
gently (+5% of max); consecutive clean upgrades then need 1 sample each with a
doubling step capped at 25% of max. Any degrade or dead-zone sample resets the
streak (`upgradeStreak`), as does `SoftResetForActivity`. Behavior is pinned by
`adaptive_test.go` — extend those tests when touching the controller; the exact
step arithmetic is asserted.

## AMF path (Change #1, for contrast)

AMF is its own backend (no MFT involvement): `SubmitInput` + single
non-blocking `QueryOutput` per call — the same 1-frame pipeline, achieved
without an event queue because AMF's API is natively non-blocking. Outputs
drain FIFO; `amfStallThreshold=8` guards real stalls.

## Reference numbers (1080p, constant motion — see README for method)

| Path | encodeMs/frame |
|---|---|
| OpenH264 software (Intel i7, pre-#3) | ~18.7 |
| MFT hardware + GPU convert + readback (#3) | ~10 |
| MFT hardware + zero-copy DXGI input (#4) | **~2.5** |
| AMF (RX 590, #1) | ~0.5 |
