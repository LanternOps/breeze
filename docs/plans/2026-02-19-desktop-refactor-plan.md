# Desktop Package File Decomposition — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split three large files (`webrtc.go`, `capture_dxgi_windows.go`, `encoder_mft_windows.go`) in `agent/internal/remote/desktop/` into 11 focused files for maintainability.

**Architecture:** Pure file reorganization within `package desktop`. No API changes, no new exports, no behavior changes. Each new file gets the correct imports and build tags from the original.

**Tech Stack:** Go, Windows COM/DXGI/MFT, pion/webrtc

---

## Prerequisites

All work happens in `agent/internal/remote/desktop/`.
All new files are `package desktop`.
The original files are deleted after their contents are fully distributed.

**Verification command (run after each task):**
```bash
cd /Users/toddhebebrand/breeze/agent && GOOS=windows GOARCH=amd64 go vet ./internal/remote/desktop/
```

Note: Since this is a macOS dev machine targeting Windows, `go vet` with `GOOS=windows` is the primary check. Full builds require a Windows cross-compiler. The `go vet` command will catch missing imports, undefined symbols, and duplicate definitions.

---

### Task 1: Split `capture_dxgi_windows.go` → `dxgi_windows.go` (types, init, teardown)

**Files:**
- Create: `agent/internal/remote/desktop/dxgi_windows.go`
- Source: `agent/internal/remote/desktop/capture_dxgi_windows.go` (lines 1–416, 419–422, 717–760, 1178–1185)

**Step 1: Create `dxgi_windows.go`**

Copy these sections from `capture_dxgi_windows.go` into the new file:
- Build tag + package declaration (line 1)
- Imports: `fmt`, `image`, `log/slog`, `runtime`, `sync`, `sync/atomic`, `syscall`, `time`, `unsafe` (lines 3–15)
- DLL procs and Windows API declarations (lines 17–31)
- Constants block (lines 33–72)
- COM GUIDs (lines 74–79)
- All struct types: `d3d11Texture2DDesc`, `d3d11MappedSubresource`, `dxgiRational`, `dxgiModeDesc`, `dxgiOutDuplDesc`, `dxgiOutDuplFrameInfo` (lines 81–137)
- `dxgiCapturer` struct (lines 139–194)
- `newPlatformCapturer()` (lines 196–206)
- `initDXGI()` (lines 208–416)
- `comVtblFn()` (lines 419–422)
- `Close()` (lines 717–728)
- `releaseDXGI()` (lines 730–760)
- Interface assertions (lines 1178–1185)

Remove `image` from imports — only needed in capture file. Keep all other imports.

**Step 2: Verify no duplicate symbols**

The original file still exists with remaining functions. Ensure no function appears in both files.

---

### Task 2: Split `capture_dxgi_windows.go` → `dxgi_capture_windows.go` (frame acquisition)

**Files:**
- Create: `agent/internal/remote/desktop/dxgi_capture_windows.go`
- Source: `agent/internal/remote/desktop/capture_dxgi_windows.go` (lines 428–714, 955–976, 981–1176)

**Step 1: Create `dxgi_capture_windows.go`**

Copy these sections:
- Build tag: `//go:build windows && !cgo`
- Package declaration
- Imports: `fmt`, `image`, `log/slog`, `syscall`, `unsafe`
- `sampleCursorForCrossThread()` (lines 428–437)
- `Capture()` (lines 441–631)
- `readRotated()` (lines 636–666)
- `CaptureRegion()` (lines 669–693)
- `GetScreenBounds()` (lines 696–714)
- `TightLoop()` (lines 955–959)
- `IsBGRA()` (lines 965–969)
- `AccumulatedFrames()` (lines 972–976)
- `CaptureTexture()` (lines 981–1148)
- `ReleaseTexture()` (lines 1151–1162)
- `GetD3D11Device()` (lines 1165–1169)
- `GetD3D11Context()` (lines 1172–1176)

---

### Task 3: Split `capture_dxgi_windows.go` → `dxgi_desktop_windows.go` (desktop switching)

**Files:**
- Create: `agent/internal/remote/desktop/dxgi_desktop_windows.go`
- Delete: `agent/internal/remote/desktop/capture_dxgi_windows.go`

**Step 1: Create `dxgi_desktop_windows.go`**

Copy these sections:
- Build tag: `//go:build windows && !cgo`
- Package declaration
- Imports: `fmt`, `log/slog`, `runtime`, `syscall`, `time`, `unsafe`
- `closeDesktopHandle()` (lines 764–769)
- `switchToInputDesktop()` (lines 778–818)
- `desktopName()` (lines 822–847)
- `checkDesktopSwitch()` (lines 860–936)
- `switchToGDI()` (lines 938–942)
- `ConsumeDesktopSwitch()` (lines 945–947)
- `OnSecureDesktop()` (lines 950–952)

**Step 2: Delete `capture_dxgi_windows.go`**

All content has been distributed. Delete the original file.

**Step 3: Verify**

```bash
cd /Users/toddhebebrand/breeze/agent && GOOS=windows GOARCH=amd64 go vet ./internal/remote/desktop/
```

**Step 4: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/remote/desktop/dxgi_windows.go agent/internal/remote/desktop/dxgi_capture_windows.go agent/internal/remote/desktop/dxgi_desktop_windows.go
git rm agent/internal/remote/desktop/capture_dxgi_windows.go
git commit -m "refactor: split capture_dxgi_windows.go into 3 focused files

Split the 1185-line DXGI capturer into:
- dxgi_windows.go: types, D3D11/DXGI init, teardown
- dxgi_capture_windows.go: CPU/GPU frame acquisition
- dxgi_desktop_windows.go: desktop switching, GDI fallback

Pure file reorganization — no API or behavior changes.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Split `encoder_mft_windows.go` → `mft_windows.go` (struct, init, config)

**Files:**
- Create: `agent/internal/remote/desktop/mft_windows.go`
- Source: `agent/internal/remote/desktop/encoder_mft_windows.go` (lines 1–70, 74–290, 363–658, 992–1174, 1176–1189)

**Step 1: Create `mft_windows.go`**

Copy these sections:
- Build tag: `//go:build windows`
- Package declaration
- Imports: `fmt`, `log/slog`, `runtime`, `sync`, `syscall`, `time`, `unsafe`
- `mftEncoder` struct (lines 15–56)
- `init()` (lines 58–60)
- `newMFTEncoder()` (lines 62–70)
- `initialize()` (lines 74–290)
- `findEncoder()` (lines 363–401)
- `enumAndActivate()` (lines 403–441)
- `setOutputType()` (lines 443–535)
- `setInputType()` (lines 537–619)
- `setLowLatency()` (lines 621–636)
- `unlockAsyncMFT()` (lines 641–658)
- `SetCodec()` (lines 992–997)
- `SetQuality()` (lines 999–1004)
- `SetBitrate()` (lines 1006–1028)
- `SetFPS()` (lines 1098–1103)
- `SetDimensions()` (lines 1105–1120)
- `SetPixelFormat()` (lines 1092–1096)
- `Close()` (lines 1122–1127)
- `shutdown()` (lines 1129–1174)
- `Name()` (lines 1176–1181)
- `IsHardware()` (lines 1183–1185)
- `IsPlaceholder()` (lines 1187–1189)

---

### Task 5: Split `encoder_mft_windows.go` → `mft_encode_windows.go` (encode pipeline)

**Files:**
- Create: `agent/internal/remote/desktop/mft_encode_windows.go`
- Source: `agent/internal/remote/desktop/encoder_mft_windows.go` (lines 662–988, 1032–1090, 1220–1366)

**Step 1: Create `mft_encode_windows.go`**

Copy these sections:
- Build tag: `//go:build windows`
- Package declaration
- Imports: `fmt`, `log/slog`, `syscall`, `unsafe`
- `Encode()` (lines 662–742)
- `vtblFn()` (lines 744–747)
- `createSample()` (lines 749–810)
- `drainOutput()` (lines 812–961)
- `extractSampleData()` (lines 963–988)
- `ForceKeyframe()` (lines 1032–1042)
- `Flush()` (lines 1048–1069)
- `forceKeyframeLocked()` (lines 1071–1090)
- `EncodeTexture()` (lines 1220–1366)

---

### Task 6: Split `encoder_mft_windows.go` → `mft_gpu_windows.go` (GPU pipeline)

**Files:**
- Create: `agent/internal/remote/desktop/mft_gpu_windows.go`
- Delete: `agent/internal/remote/desktop/encoder_mft_windows.go`

**Step 1: Create `mft_gpu_windows.go`**

Copy these sections:
- Build tag: `//go:build windows`
- Package declaration
- Imports: `fmt`, `log/slog`
- `tryInitGPUPipeline()` (lines 294–340)
- `teardownDXGIManager()` (lines 344–360)
- `SetD3D11Device()` (lines 1191–1207)
- `SupportsGPUInput()` (lines 1209–1216)

**Step 2: Delete `encoder_mft_windows.go`**

All content has been distributed. Delete the original file.

**Step 3: Verify**

```bash
cd /Users/toddhebebrand/breeze/agent && GOOS=windows GOARCH=amd64 go vet ./internal/remote/desktop/
```

**Step 4: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/remote/desktop/mft_windows.go agent/internal/remote/desktop/mft_encode_windows.go agent/internal/remote/desktop/mft_gpu_windows.go
git rm agent/internal/remote/desktop/encoder_mft_windows.go
git commit -m "refactor: split encoder_mft_windows.go into 3 focused files

Split the 1366-line MFT encoder into:
- mft_windows.go: struct, discovery, configuration, setters
- mft_encode_windows.go: CPU/GPU encode pipeline, keyframe/flush
- mft_gpu_windows.go: DXGI device manager, GPU converter integration

Pure file reorganization — no API or behavior changes.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Split `webrtc.go` → `session.go` (lifecycle)

**Files:**
- Create: `agent/internal/remote/desktop/session.go`
- Source: `agent/internal/remote/desktop/webrtc.go` (lines 1–172, 533–705, 1412–1420)

**Step 1: Create `session.go`**

Copy these sections:
- Package declaration
- Imports: `encoding/json`, `fmt`, `log/slog`, `strings`, `sync`, `sync/atomic`, `time`, `github.com/pion/webrtc/v3`, `github.com/breeze-rmm/agent/internal/remote/clipboard`, `github.com/breeze-rmm/agent/internal/remote/filedrop`
  - Trim imports to only what this file needs: `fmt`, `log/slog`, `sync`, `sync/atomic`, `time`, `github.com/pion/webrtc/v3`, `github.com/breeze-rmm/agent/internal/remote/clipboard`, `github.com/breeze-rmm/agent/internal/remote/filedrop`
- Constants: `defaultFrameRate`, `maxFrameRate`, `iceGatherTimeout` (lines 20–25)
- `captureMode` type + constants (lines 27–36)
- `Session` struct (lines 38–107)
- `SessionManager` struct (lines 109–118)
- `NewSessionManager()` (lines 121–125)
- `ICEServerConfig` struct (lines 127–134)
- `parseICEServers()` (lines 137–172)
- `StopSession()` (lines 533–544)
- `StopAllSessions()` (lines 547–559)
- `Stop()` (lines 562–593)
- `doCleanup()` (lines 673–705)
- `getFPS()` (lines 1412–1420)

---

### Task 8: Split `webrtc.go` → `session_webrtc.go` (WebRTC setup)

**Files:**
- Create: `agent/internal/remote/desktop/session_webrtc.go`
- Source: `agent/internal/remote/desktop/webrtc.go` (lines 176–530, 1474–1478)

**Step 1: Create `session_webrtc.go`**

Copy these sections:
- Package declaration
- Imports: `fmt`, `log/slog`, `time`, `github.com/pion/rtcp`, `github.com/pion/webrtc/v3`, `github.com/pion/webrtc/v3/pkg/media`, `github.com/breeze-rmm/agent/internal/remote/clipboard`, `github.com/breeze-rmm/agent/internal/remote/filedrop`
- `StartSession()` (lines 176–530)
- `AddICECandidate()` (lines 1474–1478)

---

### Task 9: Split `webrtc.go` → `session_capture.go` (capture loops)

**Files:**
- Create: `agent/internal/remote/desktop/session_capture.go`
- Source: `agent/internal/remote/desktop/webrtc.go` (lines 711–1200, 1483–1559)

**Step 1: Create `session_capture.go`**

Copy these sections:
- Package declaration
- Imports: `encoding/json`, `fmt`, `log/slog`, `sync/atomic`, `time`, `github.com/pion/webrtc/v3/pkg/media`
- `captureLoop()` (lines 711–729)
- `captureLoopDXGI()` (lines 734–910)
- `captureLoopTicker()` (lines 950–1014)
- `captureAndSendFrame()` (lines 1017–1123)
- `captureAndSendFrameGPU()` (lines 1129–1200)
- `handleDesktopSwitch()` (lines 1483–1524)
- `applyDisplayOffset()` (lines 1530–1559)

---

### Task 10: Split `webrtc.go` → `session_control.go` (control + input messages)

**Files:**
- Create: `agent/internal/remote/desktop/session_control.go`
- Source: `agent/internal/remote/desktop/webrtc.go` (lines 1230–1410)

**Step 1: Create `session_control.go`**

Copy these sections:
- Package declaration
- Imports: `encoding/json`, `log/slog`
- `handleInputMessage()` (lines 1230–1250)
- `handleControlMessage()` (lines 1253–1410)

---

### Task 11: Split `webrtc.go` → `session_stream.go` (streaming goroutines)

**Files:**
- Create: `agent/internal/remote/desktop/session_stream.go`
- Delete: `agent/internal/remote/desktop/webrtc.go`

**Step 1: Create `session_stream.go`**

Copy these sections:
- Package declaration
- Imports: `fmt`, `log/slog`, `strings`, `time`, `github.com/pion/webrtc/v3`, `github.com/pion/webrtc/v3/pkg/media`
- `startStreaming()` (lines 595–671)
- `cursorStreamLoop()` (lines 915–946)
- `metricsLogger()` (lines 1203–1227)
- `adaptiveLoop()` (lines 1422–1452)
- `extractRemoteInboundVideoStats()` (lines 1454–1471)
- `describeH264NALUs()` (lines 1563–1603)

**Step 2: Delete `webrtc.go`**

All content has been distributed. Delete the original file.

**Step 3: Verify**

```bash
cd /Users/toddhebebrand/breeze/agent && GOOS=windows GOARCH=amd64 go vet ./internal/remote/desktop/
```

**Step 4: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/remote/desktop/session.go agent/internal/remote/desktop/session_webrtc.go agent/internal/remote/desktop/session_capture.go agent/internal/remote/desktop/session_control.go agent/internal/remote/desktop/session_stream.go
git rm agent/internal/remote/desktop/webrtc.go
git commit -m "refactor: split webrtc.go into 5 focused files

Split the 1603-line WebRTC session file into:
- session.go: Session/SessionManager lifecycle
- session_webrtc.go: WebRTC peer connection setup
- session_capture.go: DXGI/ticker capture loops, frame sending
- session_control.go: control + input message handling
- session_stream.go: cursor, metrics, adaptive, streaming goroutines

Pure file reorganization — no API or behavior changes.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 12: Final verification and cleanup

**Step 1: Verify all platforms vet cleanly**

```bash
cd /Users/toddhebebrand/breeze/agent
GOOS=windows GOARCH=amd64 go vet ./internal/remote/desktop/
GOOS=darwin GOARCH=amd64 go vet ./internal/remote/desktop/
GOOS=linux GOARCH=amd64 go vet ./internal/remote/desktop/
```

**Step 2: Verify no original files remain**

```bash
ls agent/internal/remote/desktop/webrtc.go agent/internal/remote/desktop/capture_dxgi_windows.go agent/internal/remote/desktop/encoder_mft_windows.go 2>&1
```

Expected: all three report "No such file or directory"

**Step 3: Verify line counts are reasonable**

```bash
wc -l agent/internal/remote/desktop/{session,session_webrtc,session_capture,session_control,session_stream,dxgi_windows,dxgi_capture_windows,dxgi_desktop_windows,mft_windows,mft_encode_windows,mft_gpu_windows}.go
```

Expected: all files between 50–550 lines, total approximately matches original 4,154 lines.

**Step 4: Verify existing tests still pass**

```bash
cd /Users/toddhebebrand/breeze/agent && go test ./internal/remote/desktop/ -v -count=1
```

**Step 5: Final commit if any fixups were needed**

Only commit if Step 1-4 revealed issues that required fixes.
