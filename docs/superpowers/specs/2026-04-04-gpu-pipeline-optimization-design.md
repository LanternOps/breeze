# GPU Pipeline Optimization — Fastest Remote Desktop

**Date:** 2026-04-04 (updated after Phase 1 testing)
**Status:** Approved — Phase 1 abandoned, Phase 2 shipped, Phase 3 revised

## Problem

The hardware MFT (Media Foundation Transform) encoder wraps vendor-specific encoders (NVENC, AMD VCE, Intel Quick Sync) behind a COM abstraction that introduces stall bugs — the MFT accepts input but stops producing output after 25-130 frames. Tested on AMD RX 590 (VCE) and confirmed as a known issue across Intel Quick Sync as well. When the MFT stalls, ProcessInput eventually blocks the goroutine permanently, freezing the video stream.

The current recovery path (flush → retry → swap to OpenH264) works but costs 600ms and drops to 10fps on OpenH264 at 2560x1440. The real fix is bypassing MFT entirely via direct vendor encoder APIs.

## What We Learned

**Phase 1 (Zero-Copy MFT via DXGI Device Manager): ABANDONED**

Tested on Kit (AMD RX 590). The DXGI Device Manager binding succeeds and the MFT produces valid H264 from DXGI surface samples for a few frames, then stalls harder and faster than the CPU readback path. The MFT's internal buffer management breaks when fed GPU-backed samples. This was disabled before for the same reason ("DXGI surface buffer compatibility issues with hardware MFTs"). Confirmed twice — this is a dead end for MFT-based encoding.

**Phase 2 (Dirty Rect Extraction): SHIPPED**

`GetFrameDirtyRects` wired into DXGI capture. `DirtyRectProvider` interface exposed. Dirty rects are extracted after every `AcquireNextFrame`. Data collection is active — ready for ROI encoding when direct encoder APIs are integrated.

## Current Pipeline (with stall recovery)

```
DXGI AcquireNextFrame → BGRA GPU texture
  → VideoProcessorBlt BGRA→NV12 (GPU)
  → CopyResource to staging (GPU→GPU)
  → Map staging texture (GPU→CPU readback)
  → MFT ProcessInput → ProcessOutput → H264 NALUs
  → [if MFT stalls at 8 nil outputs → flush → if stalls again → swap to OpenH264]
  → pion WriteSample → RTP
```

**Stall recovery improvements shipped in this branch:**
- `mftStallThreshold` lowered from 15 to 8 (fires before screen goes idle)
- Pre-ProcessInput guard: check stall counter before feeding frames (prevents goroutine deadlock)
- `AdvanceStallDetection()` for idle periods (progresses state machine without encode calls)
- Total stall-to-OpenH264 recovery: ~600ms

## Target Pipeline (Phase 3)

```
DXGI AcquireNextFrame → BGRA GPU texture
  → Direct NVENC/AMF: register texture, encode, lock bitstream
  → H264 NALUs (~50KB, no raw frame readback)
  → pion WriteSample → RTP
```

No MFT. No stall bugs. No 5.5MB CPU readback. The vendor encoder reads the GPU texture directly and returns only the compressed bitstream.

## Phase 3: Direct NVENC + AMF Integration (via purego)

### GPU-Aware Encoder Pre-Selection

The API already has `device_hardware.gpu_model` from device inventory. Use this to include GPU vendor info in the `start_desktop` payload so the helper can skip encoder discovery and initialize the right backend immediately.

**API change:** When assembling the `start_desktop` command payload in `sessions.ts`, look up the device's `gpu_model` from `device_hardware` and include it:
```json
{
  "sessionId": "...",
  "offer": "...",
  "gpuVendor": "amd",
  "gpuModel": "Radeon RX 590 Series"
}
```

**Agent change:** The encoder factory reads `gpuVendor` from the command payload and tries the matching direct encoder first, skipping irrelevant ones:
- `"nvidia"` → try NVENC, fall back to MFT → OpenH264
- `"amd"` → try AMF, fall back to MFT → OpenH264
- `"intel"` → try MFT (Quick Sync), fall back to OpenH264
- unknown/missing → try all in priority order (current behavior)

This eliminates the 1-2 second probe delay where the factory tries NVENC on an AMD machine (DLL not found) or AMF on an NVIDIA machine.

### Direct NVENC (NVIDIA GPUs)

**DLL:** `nvEncodeAPI64.dll` (ships with NVIDIA driver, free commercial use)

**Pattern:** purego `Dlopen` at runtime, same as OpenH264. No CGO.

**Flow:**
1. `NvEncodeAPICreateInstance` → function pointer table
2. `nvEncOpenEncodeSessionEx` with D3D11 device
3. `nvEncInitializeEncoder` — H264, CBR, ultra-low-latency tuning, no B-frames
4. Per frame: `nvEncRegisterResource` (BGRA texture) → `nvEncMapInputResource` → `nvEncEncodePicture` → `nvEncLockBitstream` → copy NALUs → unlock → unmap
5. NVENC handles BGRA→NV12 conversion internally — no VideoProcessorBlt needed

**File:** `agent/internal/remote/desktop/encoder_nvenc.go` (rewrite existing placeholder)

### Direct AMF (AMD GPUs)

**DLL:** `amfrt64.dll` (ships with AMD driver, MIT-licensed SDK)

**Pattern:** Identical to NVENC — purego `Dlopen`, function table, session management.

**Flow:**
1. `AMFFactory_Create` → `AMFFactory`
2. `factory.CreateContext()` → `AMFContext`, init with D3D11 device
3. `factory.CreateComponent("AMFVideoEncoderVCE_AVC")` → `AMFEncoder`
4. Set properties: `USAGE=ULTRA_LOW_LATENCY`, `RATE_CONTROL=CBR`, `TARGET_BITRATE`, `FRAMERATE`
5. Per frame: create `AMFSurface` from D3D11 texture → `encoder.SubmitInput(surface)` → `encoder.QueryOutput()` → read bitstream from `AMFBuffer`

**File:** `agent/internal/remote/desktop/encoder_amf_windows.go` (new)

### Encoder Priority Order

```
1. NVENC direct  (purego, NVIDIA GPUs — no stalls, true zero-copy)
2. AMF direct    (purego, AMD GPUs — no stalls, true zero-copy)
3. MFT hardware  (Intel Quick Sync + fallback for older NVIDIA/AMD)
4. OpenH264      (universal CPU fallback, all platforms)
```

When `gpuVendor` is known from inventory, skip to the matching entry. Otherwise try in order.

### Files Modified

| File | Change |
|---|---|
| `encoder_nvenc.go` | Full rewrite: purego NVENC bindings |
| `nvenc_windows.go` | NVENC API types, GUIDs, struct definitions |
| `encoder_amf_windows.go` | New: purego AMF bindings |
| `amf_windows.go` | New: AMF API types, struct definitions |
| `encoder.go` | Add `gpuVendor` hint to `EncoderConfig` for pre-selection |
| `session_webrtc.go` | Pass `gpuVendor` from command payload to encoder config |
| `apps/api/src/routes/remote/sessions.ts` | Include `gpuVendor`/`gpuModel` from `device_hardware` in payload |

## Performance Targets

| Metric | MFT (current) | MFT stall→OpenH264 | Direct NVENC/AMF (Phase 3) |
|---|---|---|---|
| Encode latency | 3.7ms (when working) | 48ms (OpenH264) | 1-2ms |
| Stall risk | High (stalls at frame 25-130) | None (OpenH264 is deterministic) | None |
| Max FPS (2560x1440) | ~25fps | ~10fps | 60fps |
| CPU readback | 5.5MB/frame | 5.5MB/frame | ~50KB (bitstream only) |
| Recovery time | N/A | 600ms swap | N/A (no stalls) |

## Not In Scope

- AV1 encoding (NVENC AV1 requires RTX 40+, AMF AV1 requires RX 7000+; most managed fleet GPUs are too old. Viewer decode is not a blocker — Tauri WebView delegates to OS hardware decoders.)
- Phase 1 zero-copy MFT (tested and abandoned — hardware MFTs stall on DXGI surface samples)
- Intel oneVPL direct integration (Quick Sync via MFT is adequate for Intel; most Intel machines are laptops where 10fps OpenH264 fallback is acceptable)
- Client-side hardware decode (browser handles this via WebRTC)
- Custom transport protocol replacing WebRTC (too invasive; playout-delay=0 is already low-latency)
- Frame prediction / speculative rendering
