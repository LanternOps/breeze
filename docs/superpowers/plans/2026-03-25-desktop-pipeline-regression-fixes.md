# Desktop Pipeline Regression Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 8 bugs in the remote desktop video pipeline that cause data races, video freezes, decoder corruption, and stall detection failures.

**Architecture:** Convert `Session.encoder` to `atomic.Pointer[VideoEncoder]` for lock-free cross-goroutine safety. Extract `atomicEncoderSwap()` to encapsulate the 5-step swap sequence. Add `SetEncoder()` to `AdaptiveBitrate` so the adaptive controller tracks the live encoder. Remaining fixes are isolated one-liners in their respective files.

**Tech Stack:** Go 1.24, `sync/atomic`, pion/webrtc

**Spec:** `docs/superpowers/specs/2026-03-24-desktop-pipeline-regression-fixes-design.md`

---

## File Map

| File | Responsibility | Changes |
|------|---------------|---------|
| `session.go` | Session struct, lifecycle | `encoder` field → `atomic.Pointer[VideoEncoder]`, update `doCleanup` |
| `session_capture.go` | Capture loop, encoder swap | New `atomicEncoderSwap()`, refactor `swapToSoftwareEncoder()`, all `.Load()` calls, repaint timing |
| `session_webrtc.go` | WebRTC setup, RTCP handler | `.Load()` on PLI handler + OnFPSChange, `firstKF` reset on pointer change |
| `session_control.go` | DataChannel control messages | `.Load()` on SetBitrate/SetFPS/ForceKeyframe |
| `session_stream.go` | Streaming helpers, NAL parser | Fix `h264ContainsIDR` + `describeH264NALUs` boundary, `.Load()` in `startStreaming` |
| `adaptive.go` | Adaptive bitrate controller | New `SetEncoder()`, TOCTOU fix in `CapForSoftwareEncoder` |
| `mft_encode_windows.go` | MFT H264 encoder (Windows) | `trackNilOutput` on CPU+GPU `mfENotAccepting` paths, stall debounce tuning |

---

### Task 1: Convert `Session.encoder` to `atomic.Pointer[VideoEncoder]`

This is the foundation — all other tasks depend on this field type change.

**Files:**
- Modify: `session.go:44` (field declaration)
- Modify: `session.go:358-360` (`doCleanup`)
- Modify: `session_webrtc.go:206` (initial Store)
- Modify: `session_webrtc.go:113,125-135` (RTCP PLI handler)
- Modify: `session_webrtc.go:263` (OnFPSChange callback)
- Modify: `session_control.go:78,91,97-98` (DataChannel handler)
- Modify: `session_stream.go:29-30` (`startStreaming`)

- [ ] **Step 1: Change the field type in `session.go`**

Replace line 44:
```go
// OLD:
encoder         *VideoEncoder
// NEW:
encoder         atomic.Pointer[VideoEncoder]
```

Add `"sync/atomic"` to the imports if not already present (check — it may already be imported for `atomic.Bool` fields).

- [ ] **Step 2: Update `doCleanup` in `session.go`**

Replace lines 358-360:
```go
// OLD:
if s.encoder != nil {
    s.encoder.Close()
}
// NEW:
if enc := s.encoder.Load(); enc != nil {
    enc.Close()
}
```

- [ ] **Step 3: Update initial assignment in `session_webrtc.go`**

At line 206, replace the bare assignment:
```go
// OLD:
session.encoder = enc
// NEW:
session.encoder.Store(enc)
```

- [ ] **Step 4: Update RTCP PLI handler in `session_webrtc.go`**

Replace lines 133-135. Also add pointer-change detection to reset `firstKF`:

```go
// OLD (lines 113, 125-135):
firstKF := true
...
case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
    if !firstKF && time.Since(lastKF) < 500*time.Millisecond {
        continue
    }
    firstKF = false
    lastKF = time.Now()
    if session.encoder != nil {
        _ = session.encoder.ForceKeyframe()
    }

// NEW:
firstKF := true
var lastEnc *VideoEncoder
...
case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
    enc := session.encoder.Load()
    // Reset rate limit after encoder swap so first PLI gets through immediately
    if enc != lastEnc {
        firstKF = true
        lastEnc = enc
    }
    if !firstKF && time.Since(lastKF) < 500*time.Millisecond {
        continue
    }
    firstKF = false
    lastKF = time.Now()
    if enc != nil {
        _ = enc.ForceKeyframe()
    }
```

- [ ] **Step 5: Update OnFPSChange callback in `session_webrtc.go`**

At line 263:
```go
// OLD:
session.encoder.SetFPS(fps)
// NEW:
if enc := session.encoder.Load(); enc != nil {
    enc.SetFPS(fps)
}
```

- [ ] **Step 6: Update `session_control.go`**

Replace lines 78, 91, 97-98:
```go
// Line 78 — OLD:
s.encoder.SetBitrate(msg.Value)
// NEW:
if enc := s.encoder.Load(); enc != nil {
    enc.SetBitrate(msg.Value)
}

// Line 91 — OLD:
s.encoder.SetFPS(msg.Value)
// NEW:
if enc := s.encoder.Load(); enc != nil {
    enc.SetFPS(msg.Value)
}

// Lines 97-98 — OLD:
if s.encoder != nil {
    s.encoder.ForceKeyframe()
}
// NEW:
if enc := s.encoder.Load(); enc != nil {
    enc.ForceKeyframe()
}
```

- [ ] **Step 7: Update `startStreaming` in `session_stream.go`**

Replace lines 29-30:
```go
// OLD:
if s.encoder != nil {
    _ = s.encoder.ForceKeyframe()
}
// NEW:
if enc := s.encoder.Load(); enc != nil {
    _ = enc.ForceKeyframe()
}
```

- [ ] **Step 8: Update ALL `s.encoder` references in `session_capture.go`**

Every bare `s.encoder.Xxx()` call in the capture loop must use `.Load()`. The capture loop is hot path — load once per iteration or per call site, not repeatedly:

```go
// Pattern for each call site:
// OLD: s.encoder.Flush()
// NEW: if enc := s.encoder.Load(); enc != nil { enc.Flush() }

// OLD: s.encoder.ForceKeyframe()
// NEW: if enc := s.encoder.Load(); enc != nil { enc.ForceKeyframe() }

// OLD: s.encoder.Encode(img.Pix)
// NEW: enc := s.encoder.Load()
//      ... h264Data, err := enc.Encode(img.Pix)

// OLD: s.encoder.BackendName()
// NEW: s.encoder.Load().BackendName()
```

Apply this to ALL lines identified: 267, 304, 307, 354, 362, 395, 444, 509, 537, 553, 615, 652, 660, 682, 732, 778, 836-837, 843, 846-847, 892.

For the `captureAndSendFrame` function, load the encoder once at the top and reuse:
```go
enc := s.encoder.Load()
if enc == nil {
    return
}
// ... use enc throughout the function
```

- [ ] **Step 9: Build check**

Run:
```bash
cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/
cd agent && GOOS=linux GOARCH=amd64 go build ./internal/remote/desktop/
```
Expected: both succeed with no errors.

- [ ] **Step 10: Commit**

```bash
git add agent/internal/remote/desktop/session.go \
        agent/internal/remote/desktop/session_capture.go \
        agent/internal/remote/desktop/session_webrtc.go \
        agent/internal/remote/desktop/session_control.go \
        agent/internal/remote/desktop/session_stream.go
git commit -m "fix: convert Session.encoder to atomic.Pointer for cross-goroutine safety

Eliminates data race between RTCP goroutine (PLI→ForceKeyframe),
DataChannel goroutine (SetBitrate/SetFPS), and capture goroutine
(swapToSoftwareEncoder). All access now via Load()/Store().
Also resets PLI rate-limit after encoder swap for fast recovery."
```

---

### Task 2: Add `SetEncoder()` to `AdaptiveBitrate` and fix TOCTOU

**Files:**
- Modify: `adaptive.go:30` (struct), `~109` (constructor), `199-238` (CapForSoftwareEncoder)

- [ ] **Step 1: Add `SetEncoder` method**

Add after `NewAdaptiveBitrate()` (after line ~122):
```go
// SetEncoder updates the encoder pointer after a mid-session encoder swap.
// Resets encoder throughput EWMA so stale data from the old encoder doesn't
// incorrectly cap FPS on the new encoder.
func (a *AdaptiveBitrate) SetEncoder(enc *VideoEncoder) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.encoder = enc
	a.encoderSamples = 0
	a.prevCaptured = 0
	a.prevEncoded = 0
	a.smoothedEncodeRatio = 0
	a.mu.Unlock()
}
```

- [ ] **Step 2: Fix TOCTOU in `CapForSoftwareEncoder`**

At line 228-231, `a.targetBitrate` is read after `a.mu.Unlock()`. Capture into a local before unlock:

```go
// OLD (lines 218-231):
encoder := a.encoder
fpsCallback := a.onFPSChange
...
a.mu.Unlock()

if encoder != nil {
    if err := encoder.SetBitrate(a.targetBitrate); err != nil {

// NEW:
encoder := a.encoder
fpsCallback := a.onFPSChange
targetBitrate := a.targetBitrate  // capture before unlock
...
a.mu.Unlock()

if encoder != nil {
    if err := encoder.SetBitrate(targetBitrate); err != nil {
```

- [ ] **Step 3: Build check**

```bash
cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/
```

- [ ] **Step 4: Commit**

```bash
git add agent/internal/remote/desktop/adaptive.go
git commit -m "fix: add SetEncoder() to AdaptiveBitrate, fix TOCTOU in CapForSoftwareEncoder

SetEncoder() updates the encoder pointer and resets throughput EWMA
after mid-session encoder swaps. Fixes the stale-pointer bug where
adaptive bitrate adjustments went to a closed encoder.
Also captures targetBitrate before mutex unlock to fix a data race."
```

---

### Task 3: Extract `atomicEncoderSwap` and refactor `swapToSoftwareEncoder`

**Files:**
- Modify: `session_capture.go:890-958`

Depends on: Task 1 (atomic pointer), Task 2 (SetEncoder method)

- [ ] **Step 1: Add `atomicEncoderSwap` method**

Add before `swapToSoftwareEncoder()`:
```go
// atomicEncoderSwap performs a clean encoder replacement in one atomic sequence.
// Clears stale cached frames, swaps the pointer, updates the adaptive controller,
// resets error counters, and closes the old encoder. Must be called from the
// capture goroutine.
func (s *Session) atomicEncoderSwap(newEnc *VideoEncoder) {
	s.clearCachedEncodedFrame()
	oldEnc := s.encoder.Swap(newEnc)
	if s.adaptive != nil {
		s.adaptive.SetEncoder(newEnc)
	}
	s.cpuEncodeErrors = 0
	if oldEnc != nil {
		oldEnc.Close()
	}
}
```

- [ ] **Step 2: Refactor `swapToSoftwareEncoder` to use it**

Replace lines 945-952:
```go
// OLD:
s.encoder = newEnc
s.cpuEncodeErrors = 0
oldEnc.Close()

// Cap ABR for software encoder
if s.adaptive != nil {
    s.adaptive.CapForSoftwareEncoder()
}

// NEW:
s.atomicEncoderSwap(newEnc)

// Cap ABR for software encoder
if s.adaptive != nil {
    s.adaptive.CapForSoftwareEncoder()
}
```

Also remove `oldEnc := s.encoder` at line 895 (no longer needed — `atomicEncoderSwap` handles it).

- [ ] **Step 3: Build check**

```bash
cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/
```

- [ ] **Step 4: Commit**

```bash
git add agent/internal/remote/desktop/session_capture.go
git commit -m "refactor: extract atomicEncoderSwap for clean encoder replacement

Encapsulates cached-frame clearing, atomic pointer swap, adaptive
controller update, error counter reset, and old encoder cleanup in
one reusable method. Fixes stale cached frames and broken adaptive
controller after encoder swap."
```

---

### Task 4: Fix `trackNilOutput` gap on MFT CPU and GPU paths

**Files:**
- Modify: `mft_encode_windows.go:76-96,587-607`

- [ ] **Step 1: Add `trackNilOutput` to CPU path early returns**

In `Encode()`, after the `mfENotAccepting` drain-and-retry block (around lines 89-93), add `trackNilOutput` before each successful early return:

```go
// After the drain attempt succeeds (out may be nil or data):
// Line ~90 — OLD:
return out, nil
// NEW:
m.trackNilOutput(out)
return out, nil

// Line ~93 (retry succeeded) — OLD:
return out, nil
// NEW:
m.trackNilOutput(out)
return out, nil
```

Do NOT add it to the error return path (line ~89 `return nil, err`) — that's a real error, not a stall.

- [ ] **Step 2: Add `trackNilOutput` to GPU path early returns**

Same pattern in `EncodeTexture()` around lines 599-603:

```go
// Line ~600 — OLD:
return out, nil
// NEW:
m.trackNilOutput(out)
return out, nil

// Line ~603 — OLD:
return out, nil
// NEW:
m.trackNilOutput(out)
return out, nil
```

- [ ] **Step 3: Tune stall debounce for faster second recovery**

At line 411, replace the threshold check:

```go
// OLD:
if m.consecutiveNilOutputs >= mftStallThreshold && time.Since(m.lastStallFlush) >= 5*time.Second {

// NEW:
threshold := mftStallThreshold
// After a recent flush, use a lower threshold for faster second recovery.
// The 5-second floor between flushes still prevents infinite flush loops.
if m.lastStallFlush != (time.Time{}) && time.Since(m.lastStallFlush) < 10*time.Second {
    threshold = mftStallThreshold / 2
}
if m.consecutiveNilOutputs >= threshold && time.Since(m.lastStallFlush) >= 5*time.Second {
```

- [ ] **Step 4: Build check**

```bash
cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/
```

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/mft_encode_windows.go
git commit -m "fix: MFT stall detection on CPU path, faster second recovery

trackNilOutput was skipped on mfENotAccepting early returns, making
stall detection blind on Windows Server CPU fallback. Also reduces
the stall threshold from 20 to 10 frames for second recovery within
10 seconds of the first flush."
```

---

### Task 5: Fix `h264ContainsIDR` and `describeH264NALUs` boundary bugs

**Files:**
- Modify: `session_stream.go:254-276,278-320`

- [ ] **Step 1: Fix `h264ContainsIDR` loop bounds**

Replace the function (lines 254-276):

```go
func h264ContainsIDR(data []byte) bool {
	for i := 0; i+2 < len(data); {
		startLen := 0
		if data[i] == 0 && data[i+1] == 0 {
			if data[i+2] == 1 {
				startLen = 3
			} else if i+3 < len(data) && data[i+2] == 0 && data[i+3] == 1 {
				startLen = 4
			}
		}
		if startLen == 0 {
			i++
			continue
		}
		if i+startLen < len(data) && data[i+startLen]&0x1f == 5 {
			return true
		}
		i += startLen + 1
	}
	return false
}
```

- [ ] **Step 2: Fix `describeH264NALUs` loop bounds**

Replace the loop condition in `describeH264NALUs` (line ~282):

```go
// OLD:
for i := 0; i < len(data)-4; {
// NEW:
for i := 0; i+2 < len(data); {
```

And add bounds check before reading NAL type (line ~272):

```go
// OLD:
naluType := data[i+startLen] & 0x1f
// NEW:
if i+startLen >= len(data) {
    break
}
naluType := data[i+startLen] & 0x1f
```

Also fix the 4-byte start code check to guard `i+3 < len(data)`:
```go
// OLD:
} else if data[i+2] == 0 && i+3 < len(data) && data[i+3] == 1 {
// This is already correct in describeH264NALUs — just verify the loop condition change.
```

- [ ] **Step 3: Build check**

```bash
cd agent && GOOS=linux GOARCH=amd64 go build ./internal/remote/desktop/
```

- [ ] **Step 4: Commit**

```bash
git add agent/internal/remote/desktop/session_stream.go
git commit -m "fix: h264ContainsIDR and describeH264NALUs boundary bugs

Loop condition i < len(data)-4 missed start codes in the last 4 bytes.
Changed to i+2 < len(data) with explicit bounds checks before reading
NAL type byte. Prevents the IDR guard from failing to protect keyframes."
```

---

### Task 6: Fix `postSwitchRepaints` timing

**Files:**
- Modify: `session_capture.go:250-251,317,424-426`

- [ ] **Step 1: Add timing variable**

Near line 250-251 where other time variables are declared:
```go
var lastPostSwitchRepaint time.Time
```

- [ ] **Step 2: Rate-limit the repaint decrements**

Replace lines 424-426:
```go
// OLD:
if postSwitchRepaints > 0 {
    postSwitchRepaints--
    forceDesktopRepaint()
}

// NEW:
if postSwitchRepaints > 0 && time.Since(lastPostSwitchRepaint) >= 400*time.Millisecond {
    postSwitchRepaints--
    forceDesktopRepaint()
    lastPostSwitchRepaint = time.Now()
}
```

- [ ] **Step 3: Build check**

```bash
cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/
```

- [ ] **Step 4: Commit**

```bash
git add agent/internal/remote/desktop/session_capture.go
git commit -m "fix: spread post-switch repaints over 2s instead of 83ms

postSwitchRepaints was consumed at loop speed (~5 frames in 83ms).
Rate-limit to 400ms between repaints so the decoder gets frames
spread over 2 seconds to stabilize at the new resolution."
```

---

### Task 7: Final build and race detector verification

- [ ] **Step 1: Full cross-platform build**

```bash
cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/
cd agent && GOOS=linux GOARCH=amd64 go build ./internal/remote/desktop/
cd agent && go vet ./internal/remote/desktop/
```

- [ ] **Step 2: Run existing tests with race detector**

```bash
cd agent && go test -race ./internal/remote/desktop/... -timeout 120s
```

Note: race detector may not have coverage for all paths (these are mostly integration-level bugs), but it will catch any compile-time issues and existing test regressions.

- [ ] **Step 3: Run full agent test suite**

```bash
cd agent && go test -race ./... -timeout 300s
```

Expected: all existing tests pass.
