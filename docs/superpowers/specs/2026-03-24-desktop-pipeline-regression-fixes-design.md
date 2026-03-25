# Desktop Pipeline Regression Fixes

**Date:** 2026-03-24
**Status:** Approved
**Scope:** 8 bugs in `agent/internal/remote/desktop/` — encoder swap, stall detection, frame dropping, adaptive control

## Context

PR #286 (v0.13.14) introduced Quality VBR rate control, hardware-only MFT probing, a `maxFrameSizeBytes` frame-size guard, and the `swapToSoftwareEncoder` fallback path. These changes interact to produce:

1. **IDR keyframes dropped** by `maxFrameSizeBytes` — causes permanent decoder corruption (artifacts) or video freeze (already patched in this session).
2. **Data race** on `s.encoder` between RTCP and capture goroutines.
3. **Adaptive controller broken after encoder swap** — stale pointer, stale EWMA.
4. **MFT stall detection blind on CPU path** — permanent freeze on Windows Server.
5. **Stale cached frames resent after swap** — transient decoder corruption.
6. **`h264ContainsIDR` off-by-4** — the new IDR guard can miss the last NALU.
7. **Post-switch repaints consumed instantly** — decoder instability after monitor switch.
8. **Stall debounce blocks second recovery** — up to 5s frozen video.

## Design

### Fix 1: Atomic Encoder Swap

**Problem:** `swapToSoftwareEncoder()` manually coordinates 5+ operations. Missing steps caused bugs #2, #3, #5.

**Change:** Extract `atomicEncoderSwap(newEnc *VideoEncoder)` on `Session`:

```
atomicEncoderSwap(newEnc *VideoEncoder):
  1. s.clearCachedEncodedFrame()           // prevent stale resends
  2. oldEnc := s.encoder.Swap(newEnc)      // atomic pointer swap
  3. s.adaptive.SetEncoder(newEnc)          // update adaptive pointer + reset EWMA
  4. s.cpuEncodeErrors = 0                  // reset error counter
  5. oldEnc.Close()                         // release old encoder resources
```

`swapToSoftwareEncoder()` becomes: create encoder, configure dimensions/pixel format, call `atomicEncoderSwap`. The swap is now a single reusable unit.

**Files:** `session_capture.go`

### Fix 2: Data Race on `s.encoder`

**Problem:** RTCP goroutine reads `session.encoder` without lock; capture goroutine writes it during swap.

**Change:** Replace `encoder *VideoEncoder` field on `Session` with `atomic.Pointer[VideoEncoder]`. All access via `.Load()` / `.Store()`.

- Capture loop: `enc := s.encoder.Load()` before each encode call
- RTCP PLI handler: `if enc := session.encoder.Load(); enc != nil { enc.ForceKeyframe() }`
- DataChannel control handler (`session_control.go`): all `s.encoder.SetBitrate/SetFPS/ForceKeyframe` via `.Load()`
- `OnFPSChange` callback closure (`session_webrtc.go:263`): `session.encoder.Load().SetFPS(fps)`
- `doCleanup()` in `session.go`: `if enc := s.encoder.Load(); enc != nil { enc.Close() }`
- `startStreaming()` in `session_stream.go`: `s.encoder.Load().ForceKeyframe()`
- Reset `firstKF = true` when loaded pointer differs from last-seen pointer (first PLI after swap gets through immediately)
- No mutex contention in the hot path

**Files:** `session.go` (field change, `doCleanup`), `session_capture.go` (all `s.encoder` reads), `session_webrtc.go` (RTCP handler, `OnFPSChange` callback), `session_control.go` (DataChannel handler), `session_stream.go` (`startStreaming`)

### Fix 3: Adaptive Controller Encoder Update

**Problem:** `adaptive.encoder` set once at construction, never updated after swap. All `SetBitrate()` calls go to closed encoder.

**Change:** Add `SetEncoder(enc *VideoEncoder)` method on `AdaptiveBitrate`:

```go
func (a *AdaptiveBitrate) SetEncoder(enc *VideoEncoder) {
    a.mu.Lock()
    a.encoder = enc
    a.encoderSamples = 0    // reset stale EWMA
    a.mu.Unlock()
}
```

Called from `atomicEncoderSwap`. `CapForSoftwareEncoder()` is called after `SetEncoder` in `swapToSoftwareEncoder`.

Also fix the TOCTOU in `CapForSoftwareEncoder`: capture `targetBitrate` into a local before `a.mu.Unlock()`.

**Files:** `adaptive.go`

### Fix 4: MFT Stall Detection on CPU Path

**Problem:** `Encode()` in `mft_encode_windows.go` has an early-return on `mfENotAccepting` that skips `trackNilOutput`. Stall counter never increments on CPU fallback path.

**Change:** Add `m.trackNilOutput(out)` on the `mfENotAccepting` drain-and-return paths in **both** `Encode()` (CPU path, lines ~90-93) and `EncodeTexture()` (GPU path, lines ~600-603). Only add the call on the successful drain returns (where `out` may be nil or data), not on error returns (where the MFT returned a real error, not a stall).

**Files:** `mft_encode_windows.go`

### Fix 5: `h264ContainsIDR` Boundary Fix

**Problem:** Loop condition `i < len(data)-4` skips last 4 bytes. Start code at `len(data)-4` is missed.

**Change:** Fix loop bounds to `i+2 < len(data)` for 3-byte start codes, `i+3 < len(data)` for 4-byte. Add bounds check `i+startLen < len(data)` before reading NAL type byte. Apply the same fix to `describeH264NALUs` which has the identical boundary bug (diagnostic-only but should be consistent).

**Files:** `session_stream.go`

### Fix 6: Stale Cached Frame After Swap

**Problem:** `lastEncodedFrame` not cleared during encoder swap. Idle-resend sends MFT-encoded frames after OpenH264 swap.

**Change:** Handled by `atomicEncoderSwap` step 1: `s.clearCachedEncodedFrame()`. No separate fix needed — subsumed by Fix 1.

### Fix 7: Post-Switch Repaints Timing

**Problem:** 5 repaints consumed at loop speed (~83ms total) instead of spread over ~2s.

**Change:** Add `lastPostSwitchRepaint time.Time` in the DXGI capture loop. Only decrement and repaint when `time.Since(lastPostSwitchRepaint) >= 400ms`. Spreads 5 repaints over 2 seconds.

**Files:** `session_capture.go` (DXGI loop locals)

### Fix 8: Stall Debounce Tuning

**Problem:** 5-second debounce blocks second stall recovery. MFT stalls twice within 5s = frozen video for full debounce window.

**Change:** After the first flush within 10 seconds, use a reduced threshold of `mftStallThreshold / 2` (10 frames instead of 20) for faster second recovery. The 5-second minimum between flushes remains as the hard floor.

```go
threshold := mftStallThreshold
if time.Since(m.lastStallFlush) < 10*time.Second {
    threshold = mftStallThreshold / 2
}
```

**Files:** `mft_encode_windows.go`

## Files Changed

| File | Changes |
|------|---------|
| `session.go` | `encoder` field → `atomic.Pointer[VideoEncoder]`, `doCleanup` via `.Load()` |
| `session_capture.go` | `atomicEncoderSwap()`, refactored `swapToSoftwareEncoder()`, all `s.encoder` access via `.Load()`, `postSwitchRepaints` timing |
| `session_webrtc.go` | RTCP handler uses `.Load()`, `OnFPSChange` callback uses `.Load()`, `firstKF` reset on pointer change |
| `session_control.go` | All `s.encoder` access via `.Load()` (SetBitrate, SetFPS, ForceKeyframe on DataChannel goroutine) |
| `adaptive.go` | New `SetEncoder()` method, TOCTOU fix in `CapForSoftwareEncoder` |
| `mft_encode_windows.go` | `trackNilOutput` on both CPU and GPU `mfENotAccepting` paths, stall debounce tuning |
| `session_stream.go` | `h264ContainsIDR` + `describeH264NALUs` boundary fix, `startStreaming` encoder via `.Load()` |

## Testing

- **Build:** `GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/` and `GOOS=linux GOARCH=amd64 go build ./internal/remote/desktop/`
- **Race detector:** `go test -race ./internal/remote/desktop/...` (verifies Fix 2)
- **Manual:** Deploy to Windows VM and desktop, verify no freeze/artifacts after 3s, verify monitor switch recovery, verify encoder swap produces clean video
- **Regression:** Existing remote desktop E2E tests should pass unchanged
