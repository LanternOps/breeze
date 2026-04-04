# GPU Pipeline Optimization — Fastest Remote Desktop

**Date:** 2026-04-04
**Status:** Approved

## Problem

The remote desktop capture pipeline does a full CPU readback of every NV12 frame (~5.5MB at 2560x1440) before feeding it to the hardware MFT encoder. At 60fps this is 330MB/s crossing the PCIe bus. This is the primary bottleneck preventing Breeze from matching Parsec/Moonlight-class latency. Additionally, the hardware MFT stalls on certain GPUs, and full-frame encoding wastes bandwidth when only a small screen region changed.

## Current Pipeline

```
DXGI AcquireNextFrame → BGRA GPU texture
  → VideoProcessorBlt BGRA→NV12 (GPU)
  → CopyResource to staging (GPU→GPU)
  → Map staging texture (GPU→CPU readback) ← 5.5MB/frame bottleneck
  → CreateSample from CPU buffer
  → MFT ProcessInput (CPU buffer)
  → MFT ProcessOutput → H264 NALUs
  → pion WriteSample → RTP
```

## Target Pipeline

```
DXGI AcquireNextFrame → BGRA GPU texture
  → VideoProcessorBlt BGRA→NV12 (GPU, dirty rects only)
  → MFT reads NV12 directly from GPU via DXGI Device Manager ← zero-copy
  → MFT ProcessOutput → H264 NALUs (~50KB/frame)
  → pion WriteSample → RTP
```

Compressed H264 output (~50KB) is 100x smaller than raw NV12 (~5.5MB). Reading back only the compressed bitstream eliminates the PCIe bottleneck.

## Design

Three phases, each independently shippable.

### Phase 1: Re-enable Zero-Copy MFT via DXGI Device Manager

**What exists:** `tryInitGPUPipeline()` in `mft_gpu_windows.go` is fully implemented — creates `IMFDXGIDeviceManager`, calls `ResetDevice`, binds it to the MFT via `MFT_MESSAGE_SET_D3D_MANAGER`. It was disabled because "DXGI surface buffer compatibility issues with hardware MFTs."

**What changed since it was disabled:** The `gpuConverter` now produces a proper NV12 render target texture (`Convert()` returns the GPU texture handle without CPU readback). The MFT just needs to read from that texture instead of a CPU buffer.

**Implementation:**

1. In `mft_windows.go:initialize()`, after MFT activation and type negotiation, call `tryInitGPUPipeline()`. If it fails, log a warning and continue with the CPU readback path (existing behavior).

2. In `mft_encode_windows.go:EncodeTexture()`, change the flow:
   - If `m.dxgiManager != 0` (zero-copy active): call `gpuConv.Convert()` to get the NV12 GPU texture, then create an `IMFMediaBuffer` backed by the DXGI surface (via `MFCreateDXGISurfaceBuffer`) and wrap it in an `IMFSample`. Feed to `ProcessInput`.
   - If `m.dxgiManager == 0` (fallback): use the existing `ConvertAndReadback()` → CPU buffer path.

3. Add `MFCreateDXGISurfaceBuffer` proc load to `mft_windows.go` (from `mfplat.dll`, already loaded).

4. If `ProcessInput` rejects the DXGI sample (returns `MF_E_UNSUPPORTED_D3D_TYPE` or similar), set `m.gpuFailed = true`, call `teardownDXGIManager()`, and fall back to CPU readback for the rest of the session. Log the HRESULT so we know which GPU/driver combinations fail.

**Fallback chain:** Zero-copy MFT → GPU convert + CPU readback → OpenH264 software. Each step is automatic.

**COM calls needed:**
- `MFCreateDXGISurfaceBuffer(IID_ID3D11Texture2D, texture, subresourceIndex=0, bottomUpWhenFalse=FALSE)` → `IMFMediaBuffer`
- `MFCreateSample()` → `IMFSample`, then `AddBuffer(dxgiBuffer)`
- Existing `ProcessInput(sample)` path unchanged

**Testing:** Must verify on Intel (Quick Sync), NVIDIA (NVENC via MFT), and AMD (VCE via MFT). The fallback ensures broken drivers don't break the session.

### Phase 2: Dirty Rect Partial Encoding

**What exists:** `AccumulatedFrames` is used to skip no-change frames. `GetFrameDirtyRects` and `GetFrameMoveRects` are DXGI APIs that return which screen regions changed but are not called (vtable indices 9 and 10 not defined).

**What this enables:** When the user moves the mouse over a 200x100 region on a 2560x1440 screen, only that region needs to be re-encoded. Instead of encoding 3.7 million pixels, encode 20,000 — a 185x reduction.

**Implementation:**

1. Add vtable constants to `dxgi_windows.go`:
   ```
   dxgiDuplGetFrameDirtyRects = 9
   dxgiDuplGetFrameMoveRects  = 10
   ```

2. After `AcquireNextFrame` in `dxgi_capture_windows.go`, call `GetFrameDirtyRects` to get the list of `RECT` structures describing changed regions. Store them on the capturer as `lastDirtyRects []image.Rectangle`.

3. Expose dirty rects via a new `DirtyRectProvider` interface:
   ```go
   type DirtyRectProvider interface {
       DirtyRects() []image.Rectangle
   }
   ```

4. In the capture loop, pass dirty rects to the encoder. The encoder uses them in two ways:
   - **ROI hint to MFT:** Set `CODECAPI_AVEncVideoROIEnabled` + per-frame ROI metadata via `ICodecAPI`. Hardware MFTs that support ROI will allocate more bits to dirty regions and fewer to static regions. This improves quality where it matters without increasing bitrate.
   - **Skip unchanged macroblocks:** For software encoders (OpenH264), mark unchanged 16x16 blocks as SKIP macroblocks. OpenH264's `SFrameBSInfo.sLayerInfo` supports per-slice configuration.

5. For the GPU pipeline, restrict `VideoProcessorBlt` to dirty regions only using the `STREAM_RECT` parameter. This reduces GPU load for partial updates.

**Fallback:** If `GetFrameDirtyRects` fails (returns error or unsupported), fall back to full-frame encoding. This is a pure optimization with no behavioral change.

### Phase 3: Direct NVENC Integration (via purego)

**Why:** MFT wraps NVENC but adds overhead (COM layer, async processing model, MFT stall bugs). Direct NVENC accepts DXGI textures natively, has deterministic latency, and eliminates the entire stall detection apparatus.

**Licensing:** NVIDIA Video Codec SDK is free for commercial use. No redistribution of NVIDIA DLLs needed — `nvEncodeAPI64.dll` ships with the driver.

**Implementation:**

1. Replace the placeholder `encoder_nvenc.go` with a real implementation using `purego` (same pattern as OpenH264 — load DLL at runtime, no CGO).

2. Load `nvEncodeAPI64.dll` via `purego.Dlopen`. Key functions:
   - `NvEncodeAPICreateInstance` → function table
   - `nvEncOpenEncodeSession` with `NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS` (D3D11 device)
   - `nvEncInitializeEncoder` with `NV_ENC_INITIALIZE_PARAMS` (H264, low-latency preset)
   - `nvEncRegisterResource` → register DXGI texture as input
   - `nvEncMapInputResource` → map for encoding
   - `nvEncEncodePicture` → encode frame, get bitstream
   - `nvEncLockBitstream` / `nvEncUnlockBitstream` → read H264 NALUs

3. `EncodeTexture(bgraTexture uintptr)` flow:
   - Register the BGRA texture with NVENC (one-time per texture)
   - Map as input resource
   - Call `nvEncEncodePicture` with `NV_ENC_PIC_PARAMS` (force IDR via `encodePicFlags`)
   - Lock bitstream, copy H264 NALUs, unlock
   - No color conversion needed — NVENC handles BGRA→NV12 internally

4. Configuration: Use the "low latency" preset (`NV_ENC_PRESET_LOW_LATENCY_DEFAULT_GUID`), zero-latency mode (`NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY`), single-slice, no B-frames, CBR rate control.

5. Register as a hardware factory with higher priority than MFT:
   ```go
   func init() {
       registerHardwareFactory(newNVENCEncoder) // tried before MFT
   }
   ```

6. Remove the `//go:build nvenc` tag so it's always compiled. At runtime, `purego.Dlopen("nvEncodeAPI64.dll")` fails gracefully on non-NVIDIA machines, and the factory returns an error, falling back to MFT.

**Fallback chain:** NVENC direct → MFT hardware (zero-copy or CPU readback) → OpenH264 software.

**Future: AMD AMF** — Same pattern as NVENC but loading `amfrt64.dll`. AMD AMF is MIT-licensed. Can be added as a separate encoder backend after NVENC is proven. The `encoderBackend` interface already supports this via `registerHardwareFactory`.

## Encoder Priority Order (after all phases)

```
1. NVENC direct (purego, NVIDIA GPUs, true zero-copy)
2. MFT hardware + DXGI Device Manager (zero-copy, Intel/AMD/NVIDIA)
3. MFT hardware + GPU convert + CPU readback (current path)
4. OpenH264 software (fallback, all platforms)
```

Each level falls to the next automatically on failure.

## Files Modified

### Phase 1 (Zero-Copy MFT)
| File | Change |
|---|---|
| `mft_windows.go` | Call `tryInitGPUPipeline()` from `initialize()` |
| `mft_encode_windows.go` | Add DXGI surface sample path in `EncodeTexture()` |
| `mft_gpu_windows.go` | Add `MFCreateDXGISurfaceBuffer` proc and sample creation helper |

### Phase 2 (Dirty Rects)
| File | Change |
|---|---|
| `dxgi_windows.go` | Add vtable indices 9, 10; `RECT` struct |
| `dxgi_capture_windows.go` | Call `GetFrameDirtyRects` after `AcquireNextFrame`; expose via interface |
| `capture.go` | Add `DirtyRectProvider` interface |
| `session_capture.go` | Pass dirty rects to encoder; restrict `VideoProcessorBlt` source rect |

### Phase 3 (Direct NVENC)
| File | Change |
|---|---|
| `encoder_nvenc.go` | Full rewrite: purego bindings, NVENC session, encode, bitstream readback |
| `encoder.go` | No change (factory system already supports it) |

## Performance Targets

| Metric | Current | Phase 1 | Phase 3 |
|---|---|---|---|
| PCIe readback per frame | 5.5MB (NV12) | ~50KB (H264 only) | ~50KB (H264 only) |
| Encode latency (2560x1440) | 3-4ms + readback | 2-3ms | 1-2ms |
| MFT stall risk | High (Kit stalls at frame 53) | Medium (still MFT) | None (NVENC is deterministic) |
| Max sustainable FPS | ~45fps (PCIe bound) | 60fps | 60fps+ |

## Not In Scope

- AV1 encoding (future — NVENC AV1 requires RTX 40+, AMF AV1 requires RX 7000+; most managed fleet GPUs are too old. Viewer decode is not a blocker — Tauri WebView delegates to OS hardware decoders.)
- AMD AMF direct integration (follow-on after NVENC, same pattern)
- Client-side hardware decode (browser handles this via WebRTC)
- Custom transport protocol replacing WebRTC (too invasive; playout-delay=0 is already low-latency)
- Frame prediction / speculative rendering
