# GPU Pipeline Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the 5.5MB/frame CPU readback bottleneck in the remote desktop encode pipeline by re-enabling zero-copy MFT encoding, adding dirty rect partial encoding, and integrating direct NVENC via purego.

**Architecture:** Three independent phases. Phase 1 re-enables the DXGI Device Manager path so the MFT reads NV12 directly from GPU memory. Phase 2 calls `GetFrameDirtyRects` after DXGI frame acquisition to skip unchanged screen regions. Phase 3 replaces the MFT with direct NVENC API calls via purego for NVIDIA GPUs. Each phase has an automatic fallback to the next-best path.

**Tech Stack:** Go, Windows COM/DXGI/MFT/D3D11 syscalls, NVIDIA Video Codec SDK (purego), pion/webrtc

---

## File Map

### Phase 1: Zero-Copy MFT
| File | Action | Responsibility |
|---|---|---|
| `agent/internal/remote/desktop/mft_windows.go` | Modify | Call `tryInitGPUPipeline()` from `initialize()` after MFT config |
| `agent/internal/remote/desktop/mft_encode_windows.go` | Modify | Add DXGI surface sample path in `EncodeTexture()` |
| `agent/internal/remote/desktop/mft_gpu_windows.go` | Modify | Add `createDXGISurfaceSample()` helper |
| `agent/internal/remote/desktop/mft_encode_windows_test.go` | Create | Test zero-copy path selection and fallback |

### Phase 2: Dirty Rect Encoding
| File | Action | Responsibility |
|---|---|---|
| `agent/internal/remote/desktop/dxgi_windows.go` | Modify | Add vtable indices 9, 10; RECT struct |
| `agent/internal/remote/desktop/dxgi_capture_windows.go` | Modify | Call `GetFrameDirtyRects` after `AcquireNextFrame` |
| `agent/internal/remote/desktop/capture.go` | Modify | Add `DirtyRectProvider` interface |
| `agent/internal/remote/desktop/dxgi_dirty_rects_windows.go` | Create | Dirty rect parsing, merging, and ROI computation |
| `agent/internal/remote/desktop/dxgi_dirty_rects_windows_test.go` | Create | Test rect parsing, merging, area calculation |

### Phase 3: Direct NVENC
| File | Action | Responsibility |
|---|---|---|
| `agent/internal/remote/desktop/encoder_nvenc.go` | Rewrite | Full NVENC implementation via purego |
| `agent/internal/remote/desktop/nvenc_windows.go` | Create | NVENC API types, GUIDs, struct definitions |
| `agent/internal/remote/desktop/encoder_nvenc_test.go` | Create | Test factory registration, graceful failure on non-NVIDIA |

---

## Phase 1: Zero-Copy MFT via DXGI Device Manager

### Task 1: Re-enable tryInitGPUPipeline in MFT initialization

**Files:**
- Modify: `agent/internal/remote/desktop/mft_windows.go:349-353`

- [ ] **Step 1: Read the current initialize() to confirm insertion point**

Open `mft_windows.go` and find the comment block at lines 350-353:
```go
// NOTE: We no longer set up the DXGI device manager on the MFT.
// The GPU pipeline uses VideoProcessorBlt for BGRA→NV12 on the GPU,
// then reads back NV12 to CPU and feeds it as a regular memory buffer.
// This avoids DXGI surface buffer compatibility issues with hardware MFTs.
```

- [ ] **Step 2: Replace the skip comment with a conditional tryInitGPUPipeline call**

Replace the comment block (lines 350-353) with:
```go
// Attempt zero-copy GPU pipeline: bind the DXGI device manager to the MFT
// so it can read NV12 textures directly from GPU memory without CPU readback.
// If the hardware MFT rejects DXGI surfaces (driver compatibility), we fall
// back to the ConvertAndReadback path in EncodeTexture.
if m.d3d11Device != 0 {
    m.tryInitGPUPipeline()
    if m.dxgiManager != 0 {
        slog.Info("MFT zero-copy GPU pipeline enabled via DXGI Device Manager")
    } else {
        slog.Info("MFT DXGI Device Manager not available, will use CPU readback path")
    }
}
```

Note: `tryInitGPUPipeline()` already handles errors internally and logs warnings. If it fails, `m.dxgiManager` stays 0 and the fallback path is used.

- [ ] **Step 3: Build and verify compilation**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/`
Expected: Clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add agent/internal/remote/desktop/mft_windows.go
git commit -m "feat(desktop): re-enable DXGI Device Manager binding in MFT initialize

Call tryInitGPUPipeline() during MFT initialization when a D3D11 device
is available. This allows the hardware MFT to read NV12 textures directly
from GPU memory, eliminating the 5.5MB/frame CPU readback at 2560x1440.
Falls back to ConvertAndReadback if the driver rejects DXGI surfaces."
```

---

### Task 2: Add DXGI surface sample creation helper

**Files:**
- Modify: `agent/internal/remote/desktop/mft_gpu_windows.go`

The `MFCreateDXGISurfaceBuffer` proc is already declared in `comutil_windows.go:81`. This task adds a helper that creates an `IMFSample` backed by a DXGI surface (NV12 GPU texture) instead of a CPU memory buffer.

- [ ] **Step 1: Read the existing proc declaration to confirm it exists**

Check `comutil_windows.go` line 81:
```go
procMFCreateDXGISurfaceBuffer = mfplatDLL.NewProc("MFCreateDXGISurfaceBuffer")
```

- [ ] **Step 2: Add the createDXGISurfaceSample function to mft_gpu_windows.go**

Add at the end of the file (after `resetForCPUFallback`):
```go
// createDXGISurfaceSample wraps a D3D11 NV12 texture as an IMFSample backed
// by a DXGI surface buffer. The MFT reads directly from GPU memory — no CPU
// readback required. Returns (sample, cleanup, error). Caller must call
// cleanup() after ProcessInput returns to release the COM objects.
func createDXGISurfaceSample(nv12Texture uintptr, timestamp int64) (uintptr, func(), error) {
	// MFCreateDXGISurfaceBuffer(riid, surface, subresourceIndex, bottomUpWhenFalse) → IMFMediaBuffer
	var mediaBuffer uintptr
	hr, _, _ := procMFCreateDXGISurfaceBuffer.Call(
		uintptr(unsafe.Pointer(&iidID3D11Texture2D)),
		nv12Texture,
		0,     // subresource index 0
		0,     // bottomUpWhenFalse = FALSE
		uintptr(unsafe.Pointer(&mediaBuffer)),
	)
	if int32(hr) < 0 {
		return 0, nil, fmt.Errorf("MFCreateDXGISurfaceBuffer: HRESULT 0x%08X", uint32(hr))
	}

	// MFCreateSample → IMFSample
	var sample uintptr
	hr, _, _ = procMFCreateSample.Call(uintptr(unsafe.Pointer(&sample)))
	if int32(hr) < 0 {
		comRelease(mediaBuffer)
		return 0, nil, fmt.Errorf("MFCreateSample: HRESULT 0x%08X", uint32(hr))
	}

	// IMFSample::AddBuffer(mediaBuffer)
	hr, _, _ = comCall(sample, vtblSampleAddBuffer, mediaBuffer)
	if int32(hr) < 0 {
		comRelease(sample)
		comRelease(mediaBuffer)
		return 0, nil, fmt.Errorf("IMFSample::AddBuffer: HRESULT 0x%08X", uint32(hr))
	}

	// Set sample timestamp (100ns units)
	comCall(sample, vtblSampleSetTime, uintptr(timestamp))

	// Set sample duration (100ns units, 1 frame at current FPS — MFT needs this for rate control)
	comCall(sample, vtblSampleSetDuration, uintptr(166667)) // ~60fps default

	cleanup := func() {
		comRelease(mediaBuffer)
		// Note: do NOT release sample here — MFT owns it after ProcessInput
	}

	return sample, cleanup, nil
}

// IID_ID3D11Texture2D = {6f15aaf2-d208-4e89-9ab4-489535d34f9c}
var iidID3D11Texture2D = comGUID{
	Data1: 0x6f15aaf2,
	Data2: 0xd208,
	Data3: 0x4e89,
	Data4: [8]byte{0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c},
}
```

Check that `vtblSampleAddBuffer`, `vtblSampleSetTime`, `vtblSampleSetDuration`, and `procMFCreateSample` are already defined in `comutil_windows.go`. If `vtblSampleAddBuffer` is not defined, look for the existing sample creation code in `mft_encode_windows.go` — the `createSample()` function uses these vtable indices. Mirror whatever constants exist there.

- [ ] **Step 3: Build and verify**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add agent/internal/remote/desktop/mft_gpu_windows.go
git commit -m "feat(desktop): add DXGI surface sample creation for zero-copy MFT

createDXGISurfaceSample() wraps a D3D11 NV12 texture as an IMFSample
backed by a DXGI surface buffer. The MFT reads directly from GPU memory
instead of a CPU buffer, eliminating the PCIe readback bottleneck."
```

---

### Task 3: Wire zero-copy path into EncodeTexture with automatic fallback

**Files:**
- Modify: `agent/internal/remote/desktop/mft_encode_windows.go:529-538`

This is the critical integration point. `EncodeTexture()` currently always calls `ConvertAndReadback()` (GPU→CPU). Change it to try the zero-copy DXGI surface path first, falling back to CPU readback if the MFT rejects the surface.

- [ ] **Step 1: Read the current EncodeTexture GPU path**

Open `mft_encode_windows.go` and find lines 529-538, the comment and `ConvertAndReadback` call:
```go
// We use ConvertAndReadback instead of the DXGI surface buffer path because
// hardware MFT encoders often have issues reading DXGI surface buffers directly.
nv12, err := m.gpuConv.ConvertAndReadback()
```

- [ ] **Step 2: Replace with zero-copy-first, fallback-to-readback logic**

Replace the ConvertAndReadback block (approximately lines 529-538) with:
```go
// Try zero-copy: feed the NV12 GPU texture directly to the MFT via DXGI surface sample.
// If the MFT rejects it (driver compatibility), fall back to CPU readback permanently.
if m.dxgiManager != 0 && !m.gpuFailed {
    nv12Texture, convErr := m.gpuConv.Convert()
    if convErr != nil {
        slog.Warn("GPU Convert failed, falling back to CPU readback",
            "error", convErr.Error())
        m.gpuFailed = true
    } else {
        timestamp := int64(m.frameIdx) * 166667 // 100ns units at ~60fps
        sample, cleanup, sampleErr := createDXGISurfaceSample(nv12Texture, timestamp)
        if sampleErr != nil {
            slog.Warn("DXGI surface sample creation failed, falling back to CPU readback",
                "error", sampleErr.Error())
            m.dxgiManager = 0 // disable for rest of session
        } else {
            defer cleanup()

            hr := m.processInputSample(sample)
            if int32(hr) < 0 {
                // MFT rejected the DXGI surface — common on certain drivers.
                // Disable zero-copy for the rest of this session.
                slog.Warn("MFT rejected DXGI surface sample, disabling zero-copy",
                    "hresult", fmt.Sprintf("0x%08X", uint32(hr)))
                m.teardownDXGIManager()
                m.gpuFailed = true
                // Fall through to CPU readback below
            } else {
                // Zero-copy succeeded — read output
                m.frameIdx++
                out, outErr := m.processOutput()
                if outErr != nil {
                    return nil, outErr
                }
                m.trackNilOutput(out)
                return out, nil
            }
        }
    }
}

// CPU readback fallback: GPU color convert + read NV12 back to CPU
nv12, err := m.gpuConv.ConvertAndReadback()
```

Note: `m.processInputSample(sample)` should be the raw `ProcessInput` call that returns the HRESULT. Check if there's an existing wrapper or if you need to call `comCall(m.transform, vtblProcessInput, ...)` directly. Match the pattern used by the existing `createSample`/`ProcessInput` flow below.

- [ ] **Step 3: Build and verify**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/`
Expected: Clean build. May need to adjust method names to match existing code patterns.

- [ ] **Step 4: Commit**

```bash
git add agent/internal/remote/desktop/mft_encode_windows.go
git commit -m "feat(desktop): wire zero-copy DXGI surface path into EncodeTexture

EncodeTexture now tries the zero-copy path first: GPU Convert() returns
an NV12 texture handle, createDXGISurfaceSample wraps it for the MFT.
If the MFT rejects the DXGI surface (returns failure HRESULT), the
zero-copy path is disabled for the rest of the session and falls back
to ConvertAndReadback (CPU readback). No behavioral change for GPUs
that don't support DXGI surface input."
```

---

### Task 4: Add logging and verify Phase 1 end-to-end

**Files:**
- Modify: `agent/internal/remote/desktop/mft_encode_windows.go`

- [ ] **Step 1: Add a one-time log when zero-copy encoding produces its first frame**

In the zero-copy success path (after `processOutput` returns non-nil data), add:
```go
if out != nil && !m.zeroCopyLogged {
    m.zeroCopyLogged = true
    slog.Info("MFT zero-copy encode producing output",
        "frameIdx", m.frameIdx,
        "isHW", m.isHW,
        "outputBytes", len(out),
    )
}
```

Add the `zeroCopyLogged bool` field to the `mftEncoder` struct in `mft_windows.go`.

- [ ] **Step 2: Build the Windows agent and dev-push to Kit**

```bash
cd agent
JWT=$(curl -s http://localhost:3001/api/v1/auth/login -H "Content-Type: application/json" \
  -d '{"email":"admin@breeze.local","password":"qac3amt5PRB3djf@vxg"}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['tokens']['accessToken'])")
DEV_VERSION="dev-$(date +%s)"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "-X main.version=$DEV_VERSION" -o bin/breeze-agent-dev ./cmd/breeze-agent
curl -sf -X POST "http://localhost:3001/api/v1/dev/push" \
  -H "Authorization: Bearer $JWT" \
  -F "agentId=e65460f3-413c-4599-a9a6-90ee71bbc4ff" \
  -F "version=$DEV_VERSION" \
  -F "binary=@bin/breeze-agent-dev"
```

- [ ] **Step 3: Connect to Kit via desktop viewer and check logs**

After connecting, query:
```sql
SELECT timestamp, message, fields::text FROM agent_logs
WHERE device_id = 'e65460f3-413c-4599-a9a6-90ee71bbc4ff'
  AND (message LIKE 'MFT zero-copy%' OR message LIKE 'MFT DXGI%'
       OR message LIKE '%rejected DXGI%' OR message LIKE '%surface sample%'
       OR message LIKE 'StartSession:%' OR message LIKE 'Desktop WebRTC metrics%')
  AND timestamp >= NOW() - interval '5 minutes'
ORDER BY timestamp ASC LIMIT 20;
```

**Expected outcomes:**
- Best case: `"MFT zero-copy encode producing output"` — zero-copy works on Kit's GPU.
- Acceptable: `"MFT rejected DXGI surface sample"` then normal metrics — fallback to CPU readback worked, no regression.
- Bad: Crash or black screen — debug the HRESULT.

- [ ] **Step 4: Commit any adjustments**

```bash
git add agent/internal/remote/desktop/
git commit -m "feat(desktop): Phase 1 complete — zero-copy MFT with automatic fallback"
```

---

## Phase 2: Dirty Rect Partial Encoding

### Task 5: Add DXGI dirty rect vtable indices and structures

**Files:**
- Modify: `agent/internal/remote/desktop/dxgi_windows.go:59-71`

- [ ] **Step 1: Add the missing vtable constants**

After the existing `dxgiDuplAcquireNextFrame = 8` constant, add:
```go
dxgiDuplGetFrameDirtyRects = 9  // IDXGIOutputDuplication::GetFrameDirtyRects
dxgiDuplGetFrameMoveRects  = 10 // IDXGIOutputDuplication::GetFrameMoveRects
```

- [ ] **Step 2: Add the RECT struct**

Add near the other DXGI structs:
```go
// dxgiRECT matches the Win32 RECT structure used by GetFrameDirtyRects.
type dxgiRECT struct {
	Left, Top, Right, Bottom int32
}
```

- [ ] **Step 3: Build and verify**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/`

- [ ] **Step 4: Commit**

```bash
git add agent/internal/remote/desktop/dxgi_windows.go
git commit -m "feat(desktop): add DXGI dirty rect vtable indices and RECT struct"
```

---

### Task 6: Implement dirty rect extraction and DirtyRectProvider interface

**Files:**
- Create: `agent/internal/remote/desktop/dxgi_dirty_rects_windows.go`
- Modify: `agent/internal/remote/desktop/capture.go`
- Modify: `agent/internal/remote/desktop/dxgi_capture_windows.go`

- [ ] **Step 1: Add DirtyRectProvider interface to capture.go**

Add after the existing `TextureProvider` interface:
```go
// DirtyRectProvider is implemented by capturers that can report which screen
// regions changed since the last frame. Used to optimize encoding by skipping
// unchanged regions.
type DirtyRectProvider interface {
	DirtyRects() []image.Rectangle
}
```

- [ ] **Step 2: Create dxgi_dirty_rects_windows.go**

```go
//go:build windows

package desktop

import (
	"image"
	"log/slog"
	"syscall"
	"unsafe"
)

// getDirtyRects calls IDXGIOutputDuplication::GetFrameDirtyRects to retrieve
// the list of screen regions that changed since the last AcquireNextFrame.
// Returns nil if the call fails or no metadata is available (non-fatal).
func getDirtyRects(duplication uintptr, metadataSize uint32) []image.Rectangle {
	if duplication == 0 || metadataSize == 0 {
		return nil
	}

	// Allocate buffer for dirty rects (each RECT is 16 bytes)
	buf := make([]byte, metadataSize)
	var bytesReturned uint32

	hr, _, _ := syscall.SyscallN(
		comVtblFn(duplication, dxgiDuplGetFrameDirtyRects),
		duplication,
		uintptr(len(buf)),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&bytesReturned)),
	)
	if int32(hr) < 0 {
		// Non-fatal: dirty rects unavailable, encode full frame
		return nil
	}

	rectSize := uint32(unsafe.Sizeof(dxgiRECT{}))
	count := bytesReturned / rectSize
	if count == 0 {
		return nil
	}

	rects := make([]image.Rectangle, 0, count)
	for i := uint32(0); i < count; i++ {
		r := (*dxgiRECT)(unsafe.Pointer(&buf[i*rectSize]))
		rects = append(rects, image.Rect(
			int(r.Left), int(r.Top),
			int(r.Right), int(r.Bottom),
		))
	}
	return rects
}

// mergeDirtyRects combines overlapping or adjacent dirty rects into a single
// bounding box. For encoding purposes, one large rect is more efficient than
// many small ones (encoder operates on macroblock rows, not arbitrary rects).
func mergeDirtyRects(rects []image.Rectangle) image.Rectangle {
	if len(rects) == 0 {
		return image.Rectangle{}
	}
	bounds := rects[0]
	for _, r := range rects[1:] {
		bounds = bounds.Union(r)
	}
	return bounds
}

// dirtyRectCoversFraction returns the fraction of the screen covered by
// the dirty region (0.0 to 1.0). Used to decide whether partial encoding
// is worthwhile — below a threshold, skip encoding and resend cached frame.
func dirtyRectCoversFraction(dirty image.Rectangle, screenW, screenH int) float64 {
	if screenW <= 0 || screenH <= 0 {
		return 1.0
	}
	area := dirty.Dx() * dirty.Dy()
	return float64(area) / float64(screenW*screenH)
}
```

- [ ] **Step 3: Add dirty rect storage and DirtyRectProvider to dxgiCapturer**

In `dxgi_capture_windows.go`, add a field to the `dxgiCapturer` struct:
```go
lastDirtyRects []image.Rectangle
```

After the `AcquireNextFrame` call in `Capture()` (around line 187), add:
```go
c.lastDirtyRects = getDirtyRects(c.duplication, frameInfo.TotalMetadataBufferSize)
```

Add the same after `AcquireNextFrame` in `CaptureTexture()` (around line 480).

Add the `DirtyRects()` method:
```go
func (c *dxgiCapturer) DirtyRects() []image.Rectangle {
	return c.lastDirtyRects
}
```

- [ ] **Step 4: Build and verify**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/`

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/capture.go \
      agent/internal/remote/desktop/dxgi_dirty_rects_windows.go \
      agent/internal/remote/desktop/dxgi_capture_windows.go
git commit -m "feat(desktop): extract DXGI dirty rects after frame acquisition

Call GetFrameDirtyRects after AcquireNextFrame and expose via
DirtyRectProvider interface. Dirty rects are merged into a bounding
box for encoder ROI hints. Non-fatal: full-frame encode if unavailable."
```

---

### Task 7: Create dirty rect unit tests

**Files:**
- Create: `agent/internal/remote/desktop/dxgi_dirty_rects_windows_test.go`

- [ ] **Step 1: Write tests for mergeDirtyRects and dirtyRectCoversFraction**

```go
//go:build windows

package desktop

import (
	"image"
	"testing"
)

func TestMergeDirtyRects_Empty(t *testing.T) {
	result := mergeDirtyRects(nil)
	if !result.Empty() {
		t.Errorf("expected empty rect, got %v", result)
	}
}

func TestMergeDirtyRects_Single(t *testing.T) {
	rects := []image.Rectangle{image.Rect(10, 20, 100, 200)}
	result := mergeDirtyRects(rects)
	expected := image.Rect(10, 20, 100, 200)
	if result != expected {
		t.Errorf("expected %v, got %v", expected, result)
	}
}

func TestMergeDirtyRects_Multiple(t *testing.T) {
	rects := []image.Rectangle{
		image.Rect(10, 20, 100, 200),
		image.Rect(500, 300, 600, 400),
	}
	result := mergeDirtyRects(rects)
	expected := image.Rect(10, 20, 600, 400)
	if result != expected {
		t.Errorf("expected %v, got %v", expected, result)
	}
}

func TestDirtyRectCoversFraction(t *testing.T) {
	tests := []struct {
		name     string
		dirty    image.Rectangle
		w, h     int
		expected float64
	}{
		{"full screen", image.Rect(0, 0, 1920, 1080), 1920, 1080, 1.0},
		{"quarter", image.Rect(0, 0, 960, 540), 1920, 1080, 0.25},
		{"cursor region", image.Rect(100, 100, 132, 132), 1920, 1080, 0.000494},
		{"zero screen", image.Rect(0, 0, 100, 100), 0, 0, 1.0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := dirtyRectCoversFraction(tt.dirty, tt.w, tt.h)
			if got < tt.expected-0.001 || got > tt.expected+0.001 {
				t.Errorf("expected ~%f, got %f", tt.expected, got)
			}
		})
	}
}
```

- [ ] **Step 2: Run tests**

Run: `cd agent && GOOS=windows go test ./internal/remote/desktop/ -run TestMerge -v`
Expected: All tests pass. (These are pure logic tests, no COM/DXGI required.)

- [ ] **Step 3: Commit**

```bash
git add agent/internal/remote/desktop/dxgi_dirty_rects_windows_test.go
git commit -m "test(desktop): unit tests for dirty rect merging and coverage calculation"
```

---

### Task 8: Log dirty rect statistics in capture loop

**Files:**
- Modify: `agent/internal/remote/desktop/session_capture.go`

- [ ] **Step 1: Add dirty rect logging to the metrics output**

In `captureAndSendFrameGPU()` (around line 789), after capturing the texture, check if the capturer implements `DirtyRectProvider`:
```go
if drp, ok := tp.(DirtyRectProvider); ok {
    if rects := drp.DirtyRects(); len(rects) > 0 {
        merged := mergeDirtyRects(rects)
        fraction := dirtyRectCoversFraction(merged, s.captureConfig.Width, s.captureConfig.Height)
        if fraction < 0.05 {
            slog.Debug("Dirty rect: small change",
                "session", s.id,
                "rects", len(rects),
                "coverage", fmt.Sprintf("%.1f%%", fraction*100),
            )
        }
    }
}
```

This is observational only — Phase 2 doesn't use dirty rects for encoding decisions yet. It just logs the data so we can see how much bandwidth we're wasting on full-frame encodes.

- [ ] **Step 2: Build and verify**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/`

- [ ] **Step 3: Commit**

```bash
git add agent/internal/remote/desktop/session_capture.go
git commit -m "feat(desktop): log dirty rect coverage in capture loop (observational)

Logs dirty rect statistics during GPU capture to measure how much
bandwidth is wasted encoding unchanged screen regions. Phase 2 of
GPU pipeline optimization — data collection before encoding changes."
```

---

## Phase 3: Direct NVENC via purego

### Task 9: Define NVENC API types and constants

**Files:**
- Create: `agent/internal/remote/desktop/nvenc_windows.go`

- [ ] **Step 1: Create NVENC type definitions**

```go
//go:build windows

package desktop

import "unsafe"

// NVENC API version and GUIDs from nvEncodeAPI.h
const (
	nvencAPIVersion       = (12 << 4) | 2 // NVENCAPI_VERSION 12.2
	nvencStructVersion    = (12 << 4) | 2
	nvencOpenEncodeAPIVer = nvencStructVersion

	// NV_ENC_CODEC_H264_GUID
	nvencCodecH264 = 0x6BC82762

	// NV_ENC_PRESET_P4_GUID (balanced quality/speed)
	nvencPresetP4 = 0xFC0A8D3E

	// NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY
	nvencTuningUltraLowLatency = 3

	// NV_ENC_BUFFER_FORMAT_ARGB
	nvencBufferFormatARGB = 0x00000020

	// NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX
	nvencInputResourceDirectX = 0x00000002

	// NV_ENC_PIC_TYPE
	nvencPicTypeIDR = 4

	// NV_ENC_PARAMS_RC_CBR
	nvencRCModeCBR = 2
)

// NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS
type nvencOpenSessionParams struct {
	Version    uint32
	DeviceType uint32 // NV_ENC_DEVICE_TYPE_DIRECTX = 1
	Device     uintptr
	Reserved   uintptr
	APIVersion uint32
	Reserved2  [253]uint32
}

// NV_ENC_REGISTER_RESOURCE
type nvencRegisterResource struct {
	Version         uint32
	ResourceType    uint32 // NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX
	Width           uint32
	Height          uint32
	Pitch           uint32
	SubResourceIndex uint32
	ResourceToRegister uintptr
	RegisteredResource uintptr
	BufferFormat     uint32
	BufferUsage      uint32
	Reserved         [247]uint32
}

// NV_ENC_MAP_INPUT_RESOURCE
type nvencMapInputResource struct {
	Version          uint32
	SubResourceIndex uint32
	InputResource    uintptr
	MappedResource   uintptr
	MappedBufferFmt  uint32
	Reserved         [251]uint32
}

// NV_ENC_LOCK_BITSTREAM
type nvencLockBitstream struct {
	Version           uint32
	DoNotWait         uint32
	LockFlags         uint32
	Reserved          uint32
	BitstreamBufferPtr uintptr
	SliceOffsets      uintptr
	FrameIdx          uint32
	HWEncodeStatus    uint32
	NumSlices         uint32
	BitstreamSizeInBytes uint32
	OutputTimeStamp   int64
	OutputDuration    int64
	BitstreamDataPtr  uintptr
	PictureType       uint32
	PictureStruct     uint32
	FrameAvgQP        uint32
	Reserved2         [229]uint32
}

func nvencStructVer(size uintptr) uint32 {
	return uint32(size) | (nvencStructVersion << 16)
}
```

Note: These structs are based on NVIDIA Video Codec SDK 12.2 headers (`nvEncodeAPI.h`). The reserved fields ensure correct struct sizes for the COM ABI. Check the actual SDK headers if the version has changed — the struct sizes must match exactly.

- [ ] **Step 2: Build and verify**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/`

- [ ] **Step 3: Commit**

```bash
git add agent/internal/remote/desktop/nvenc_windows.go
git commit -m "feat(desktop): add NVENC API type definitions and constants

Defines Go structs matching NVIDIA Video Codec SDK 12.2 types for
NvEncOpenEncodeSession, RegisterResource, MapInputResource, and
LockBitstream. Used by the purego-based NVENC encoder backend."
```

---

### Task 10: Implement NVENC encoder backend

**Files:**
- Rewrite: `agent/internal/remote/desktop/encoder_nvenc.go`

This is the largest task. The encoder loads `nvEncodeAPI64.dll` via purego, creates an NVENC session on the D3D11 device, and encodes BGRA textures directly without CPU readback.

- [ ] **Step 1: Replace the placeholder with the real implementation**

Replace the entire file. Remove the `//go:build nvenc` tag so it always compiles:

```go
//go:build windows

package desktop

import (
	"fmt"
	"log/slog"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

type nvencEncoder struct {
	mu          sync.Mutex
	cfg         EncoderConfig
	width       int
	height      int
	pixelFormat PixelFormat
	forceIDR    bool
	frameIdx    uint64

	// NVENC session state
	funcList    nvencFunctionList
	encoder     uintptr // NV_ENCODE_API_FUNCTION_LIST session
	d3d11Device uintptr
	d3d11Ctx    uintptr

	// Registered input resource (reused across frames)
	registeredResource uintptr
	lastTexture        uintptr // track texture changes for re-registration

	inited bool
}

var (
	nvencDLL     uintptr
	nvencLoadMu  sync.Mutex
	nvencLoaded  bool
	nvencLoadErr error
)

func init() {
	registerHardwareFactory(newNVENCEncoder)
}

func loadNVENC() error {
	nvencLoadMu.Lock()
	defer nvencLoadMu.Unlock()
	if nvencLoaded {
		return nil
	}
	if nvencLoadErr != nil {
		return nvencLoadErr
	}

	var err error
	nvencDLL, err = purego.Dlopen("nvEncodeAPI64.dll", purego.RTLD_LAZY)
	if err != nil {
		nvencLoadErr = fmt.Errorf("nvEncodeAPI64.dll not available: %w", err)
		slog.Debug("NVENC not available (no NVIDIA GPU or driver)", "error", nvencLoadErr.Error())
		return nvencLoadErr
	}
	nvencLoaded = true
	slog.Info("NVENC library loaded")
	return nil
}

func newNVENCEncoder(cfg EncoderConfig) (encoderBackend, error) {
	if cfg.Codec != CodecH264 {
		return nil, fmt.Errorf("nvenc: only H264 supported, got %s", cfg.Codec)
	}
	if err := loadNVENC(); err != nil {
		return nil, err
	}
	return &nvencEncoder{cfg: cfg}, nil
}

func (e *nvencEncoder) Name() string {
	if e.inited {
		return "nvenc-hardware"
	}
	return "nvenc"
}

func (e *nvencEncoder) IsHardware() bool    { return true }
func (e *nvencEncoder) IsPlaceholder() bool { return false }

func (e *nvencEncoder) SetCodec(c Codec) error      { return nil }
func (e *nvencEncoder) SetQuality(q QualityPreset) error { return nil }
func (e *nvencEncoder) SetPixelFormat(pf PixelFormat) { e.pixelFormat = pf }

func (e *nvencEncoder) SetBitrate(bitrate int) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cfg.Bitrate = bitrate
	// TODO: dynamic bitrate change via NvEncReconfigureEncoder
	return nil
}

func (e *nvencEncoder) SetFPS(fps int) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cfg.FPS = fps
	return nil
}

func (e *nvencEncoder) SetDimensions(w, h int) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.inited && (e.width != w || e.height != h) {
		e.shutdown()
	}
	e.width = w
	e.height = h
	return nil
}

func (e *nvencEncoder) SetD3D11Device(device, context uintptr) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.d3d11Device = device
	e.d3d11Ctx = context
}

func (e *nvencEncoder) SupportsGPUInput() bool {
	return e.d3d11Device != 0
}

func (e *nvencEncoder) ForceKeyframe() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.forceIDR = true
	return nil
}

func (e *nvencEncoder) Encode(frame []byte) ([]byte, error) {
	// NVENC requires GPU textures — CPU frames not supported.
	// The capture loop should always use EncodeTexture when NVENC is active.
	return nil, fmt.Errorf("nvenc: CPU Encode not supported, use EncodeTexture")
}

func (e *nvencEncoder) EncodeTexture(bgraTexture uintptr) ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if !e.inited {
		if err := e.initialize(); err != nil {
			return nil, fmt.Errorf("nvenc init: %w", err)
		}
	}

	// Re-register texture if it changed (monitor switch, capturer recreated)
	if bgraTexture != e.lastTexture {
		if e.registeredResource != 0 {
			e.unregisterResource()
		}
		if err := e.registerTexture(bgraTexture); err != nil {
			return nil, fmt.Errorf("nvenc register: %w", err)
		}
		e.lastTexture = bgraTexture
	}

	return e.encodeFrame()
}

func (e *nvencEncoder) Close() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.shutdown()
	return nil
}

func (e *nvencEncoder) shutdown() {
	if !e.inited {
		return
	}
	if e.registeredResource != 0 {
		e.unregisterResource()
	}
	if e.encoder != 0 {
		// NvEncDestroyEncoder
		e.funcList.nvEncDestroyEncoder(e.encoder)
		e.encoder = 0
	}
	e.inited = false
}

// initialize creates the NVENC session on the D3D11 device.
// Caller must hold e.mu.
func (e *nvencEncoder) initialize() error {
	if e.d3d11Device == 0 {
		return fmt.Errorf("no D3D11 device available")
	}
	if e.width == 0 || e.height == 0 {
		return fmt.Errorf("dimensions not set")
	}

	// Get NVENC API function list
	if err := e.loadFunctionList(); err != nil {
		return err
	}

	// Open encode session with D3D11 device
	if err := e.openSession(); err != nil {
		return err
	}

	// Initialize encoder with H264 low-latency config
	if err := e.configureEncoder(); err != nil {
		e.funcList.nvEncDestroyEncoder(e.encoder)
		e.encoder = 0
		return err
	}

	e.inited = true
	slog.Info("NVENC encoder initialized",
		"width", e.width, "height", e.height,
		"bitrate", e.cfg.Bitrate, "fps", e.cfg.FPS,
	)
	return nil
}

// Stub implementations for the NVENC API calls.
// These need to be filled in with the actual purego function calls
// matching the NVENC SDK. The pattern is:
//   1. purego.Dlsym to get function pointer
//   2. purego.NewCallback or direct syscall to invoke
// See the OpenH264 encoder (encoder_openh264.go) for the purego pattern.

func (e *nvencEncoder) loadFunctionList() error {
	// NvEncodeAPICreateInstance → fills function table
	// This is the entry point for all NVENC operations
	return fmt.Errorf("NVENC function list loading: implement with purego.Dlsym for NvEncodeAPICreateInstance")
}

func (e *nvencEncoder) openSession() error {
	return fmt.Errorf("NVENC session open: implement with funcList.nvEncOpenEncodeSessionEx")
}

func (e *nvencEncoder) configureEncoder() error {
	return fmt.Errorf("NVENC encoder config: implement with funcList.nvEncInitializeEncoder")
}

func (e *nvencEncoder) registerTexture(texture uintptr) error {
	return fmt.Errorf("NVENC texture register: implement with funcList.nvEncRegisterResource")
}

func (e *nvencEncoder) unregisterResource() {
	// funcList.nvEncUnregisterResource(e.encoder, e.registeredResource)
	e.registeredResource = 0
}

func (e *nvencEncoder) encodeFrame() ([]byte, error) {
	return nil, fmt.Errorf("NVENC encode: implement with funcList.nvEncEncodePicture + nvEncLockBitstream")
}
```

**Important:** The stub methods at the bottom (`loadFunctionList`, `openSession`, `configureEncoder`, `registerTexture`, `encodeFrame`) return errors that will cause the factory to fall back to MFT. This is safe to ship — NVENC will be skipped and MFT used instead. The stubs are placeholders for the actual purego bindings which require careful struct layout matching against the NVIDIA SDK headers.

- [ ] **Step 2: Build and verify**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/`
Expected: Clean build. NVENC factory registered but will fail at runtime (falls back to MFT).

- [ ] **Step 3: Commit**

```bash
git add agent/internal/remote/desktop/encoder_nvenc.go
git commit -m "feat(desktop): NVENC encoder skeleton with purego DLL loading

Replaces the placeholder NVENC encoder with a real skeleton that:
- Loads nvEncodeAPI64.dll via purego at runtime (no CGO)
- Registers as a hardware factory (tried before MFT)
- Gracefully fails on non-NVIDIA machines (falls back to MFT)
- Accepts BGRA GPU textures directly via EncodeTexture

API call stubs return errors until purego bindings are implemented.
The factory fallback ensures no regression on any GPU."
```

---

### Task 11: Implement NVENC purego bindings (loadFunctionList + openSession)

**Files:**
- Modify: `agent/internal/remote/desktop/encoder_nvenc.go`

- [ ] **Step 1: Implement loadFunctionList using purego**

Replace the stub:
```go
type nvencFunctionList struct {
	nvEncOpenEncodeSessionEx uintptr
	nvEncInitializeEncoder   uintptr
	nvEncRegisterResource    uintptr
	nvEncUnregisterResource  uintptr
	nvEncMapInputResource    uintptr
	nvEncUnmapInputResource  uintptr
	nvEncEncodePicture       uintptr
	nvEncLockBitstream       uintptr
	nvEncUnlockBitstream     uintptr
	nvEncDestroyEncoder      func(encoder uintptr) uintptr
}

func (e *nvencEncoder) loadFunctionList() error {
	var createInstance uintptr
	var err error
	createInstance, err = purego.Dlsym(nvencDLL, "NvEncodeAPICreateInstance")
	if err != nil {
		return fmt.Errorf("NvEncodeAPICreateInstance not found: %w", err)
	}

	// The function list struct has version + ~30 function pointers.
	// We only need ~10 of them. Allocate the full struct (version + pointers).
	type rawFuncList struct {
		Version uint32
		_       uint32 // reserved
		Funcs   [30]uintptr
	}
	var fl rawFuncList
	fl.Version = nvencStructVer(unsafe.Sizeof(fl))

	r1, _, _ := syscall.SyscallN(createInstance, uintptr(unsafe.Pointer(&fl)))
	if r1 != 0 {
		return fmt.Errorf("NvEncodeAPICreateInstance failed: 0x%X", r1)
	}

	// Map function pointers by index (from nvEncodeAPI.h NV_ENCODE_API_FUNCTION_LIST)
	e.funcList.nvEncOpenEncodeSessionEx = fl.Funcs[0]
	e.funcList.nvEncInitializeEncoder = fl.Funcs[2]
	e.funcList.nvEncRegisterResource = fl.Funcs[9]
	e.funcList.nvEncUnregisterResource = fl.Funcs[10]
	e.funcList.nvEncMapInputResource = fl.Funcs[11]
	e.funcList.nvEncUnmapInputResource = fl.Funcs[12]
	e.funcList.nvEncEncodePicture = fl.Funcs[14]
	e.funcList.nvEncLockBitstream = fl.Funcs[15]
	e.funcList.nvEncUnlockBitstream = fl.Funcs[16]
	e.funcList.nvEncDestroyEncoder = func(enc uintptr) uintptr {
		r, _, _ := syscall.SyscallN(fl.Funcs[21], enc)
		return r
	}

	return nil
}
```

**Note:** The function indices (0, 2, 9, 10, etc.) are from the NVIDIA SDK header `nvEncodeAPI.h` struct `NV_ENCODE_API_FUNCTION_LIST`. Verify these against the actual SDK version 12.2 header. If indices are wrong, the encoder will crash — test on an NVIDIA machine before shipping.

- [ ] **Step 2: Implement openSession**

```go
func (e *nvencEncoder) openSession() error {
	params := nvencOpenSessionParams{
		Version:    nvencStructVer(unsafe.Sizeof(nvencOpenSessionParams{})),
		DeviceType: 1, // NV_ENC_DEVICE_TYPE_DIRECTX
		Device:     e.d3d11Device,
		APIVersion: nvencOpenEncodeAPIVer,
	}

	r1, _, _ := syscall.SyscallN(
		e.funcList.nvEncOpenEncodeSessionEx,
		uintptr(unsafe.Pointer(&params)),
		uintptr(unsafe.Pointer(&e.encoder)),
	)
	if r1 != 0 {
		return fmt.Errorf("NvEncOpenEncodeSessionEx failed: 0x%X", r1)
	}
	return nil
}
```

- [ ] **Step 3: Build and verify**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/`

- [ ] **Step 4: Commit**

```bash
git add agent/internal/remote/desktop/encoder_nvenc.go
git commit -m "feat(desktop): NVENC purego bindings — function list and session open

Loads NvEncodeAPICreateInstance via purego.Dlsym, extracts the
function pointer table, and opens an NVENC encode session on the
D3D11 device. No CGO required — same pattern as OpenH264 encoder."
```

---

### Task 12: Implement NVENC encode pipeline (configure + register + encode + lock bitstream)

**Files:**
- Modify: `agent/internal/remote/desktop/encoder_nvenc.go`

- [ ] **Step 1: Implement configureEncoder**

Replace the stub with the actual `NvEncInitializeEncoder` call using H264 CBR low-latency configuration. Use the `NV_ENC_INITIALIZE_PARAMS` struct with `NV_ENC_PRESET_P4_GUID` and `NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY`. Set `enableEncodeAsync = 0` (synchronous mode — simpler, deterministic latency).

This step requires matching the exact struct layout from `nvEncodeAPI.h`. Refer to the NVIDIA Video Codec SDK 12.2 samples (`AppEncD3D11`) for the correct initialization sequence.

- [ ] **Step 2: Implement registerTexture**

Use `nvEncRegisterResource` with `NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX` and `NV_ENC_BUFFER_FORMAT_ARGB` (NVENC handles BGRA→NV12 internally).

- [ ] **Step 3: Implement encodeFrame**

Sequence:
1. `nvEncMapInputResource` → get mapped resource handle
2. `nvEncEncodePicture` with `NV_ENC_PIC_PARAMS` (set `encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR` when `e.forceIDR`)
3. `nvEncLockBitstream` → get pointer to H264 NALUs + size
4. Copy NALUs to Go byte slice
5. `nvEncUnlockBitstream`
6. `nvEncUnmapInputResource`

- [ ] **Step 4: Build and verify on NVIDIA machine**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/`
Deploy to a Windows machine with an NVIDIA GPU and verify via agent logs.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/encoder_nvenc.go agent/internal/remote/desktop/nvenc_windows.go
git commit -m "feat(desktop): complete NVENC encode pipeline — configure, register, encode, readback

Full NVENC integration: H264 CBR low-latency encoding with direct
BGRA texture input. NVENC handles color conversion internally.
Zero CPU readback of raw frames — only the compressed H264 bitstream
(~50KB) is read back. Tested on [GPU model]."
```

---

## Verification Checklist

After all phases, verify on Kit:

```sql
SELECT timestamp, message, fields::text FROM agent_logs
WHERE device_id = 'e65460f3-413c-4599-a9a6-90ee71bbc4ff'
  AND (message LIKE 'MFT zero-copy%' OR message LIKE 'NVENC%'
       OR message LIKE 'StartSession:%' OR message LIKE 'Desktop WebRTC metrics%'
       OR message LIKE 'Dirty rect%')
  AND timestamp >= NOW() - interval '5 minutes'
ORDER BY timestamp ASC LIMIT 30;
```

**Expected metrics improvement:**
- `encodeMs` should drop from 3.7ms to <2ms (zero-copy MFT) or <1ms (NVENC)
- `bandwidthKBps` should be more stable (no PCIe bottleneck)
- Dirty rect logs should show small coverage percentages during cursor-only movement
