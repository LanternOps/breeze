# Desktop Package File Decomposition

**Date:** 2026-02-19
**Status:** Approved

## Goal

Split three large files in `agent/internal/remote/desktop/` into smaller, focused files for maintainability. Pure file reorganization — no API changes, no new exports, no behavior changes.

## Current State

| File | Lines | Responsibilities |
|------|-------|-----------------|
| `webrtc.go` | 1,603 | Session lifecycle, WebRTC setup, 2 capture loops, frame encoding/sending, input handling, control messages, cursor streaming, metrics, adaptive loop, monitor switching |
| `encoder_mft_windows.go` | 1,366 | MFT discovery, COM config, CPU encode, GPU encode, DXGI device manager, codec API, keyframe/flush |
| `capture_dxgi_windows.go` | 1,185 | D3D11/DXGI init, CPU capture, GPU texture capture, desktop switching, GDI fallback, rotation, diagnostics |

## Design

### 1. `webrtc.go` → 5 files

**session.go** (~250 lines) — Session lifecycle
- `Session` struct definition (all fields)
- `SessionManager` struct, `NewSessionManager()`, `StopSession()`, `StopAllSessions()`
- `Session.Stop()`, `doCleanup()`
- `ICEServerConfig`, `parseICEServers()`
- `getFPS()`, captureMode type

**session_webrtc.go** (~300 lines) — WebRTC negotiation
- `StartSession()` (peer connection, tracks, data channels, SDP exchange, ICE gathering)
- `AddICECandidate()`

**session_capture.go** (~400 lines) — Capture loops
- `captureLoop()` (top-level dispatcher)
- `captureLoopDXGI()` (tight-loop with idle detection)
- `captureLoopTicker()` (ticker-paced for GDI/macOS/Linux)
- `captureAndSendFrame()` (CPU capture+encode path)
- `captureAndSendFrameGPU()` (GPU texture capture+encode path)
- `handleDesktopSwitch()` (desktop transition handling)

**session_control.go** (~300 lines) — Control + input messages
- `handleControlMessage()` (all switch cases: set_bitrate, set_fps, request_keyframe, list_monitors, toggle_audio, send_sas, lock_workstation, switch_monitor)
- `handleInputMessage()`

**session_stream.go** (~300 lines) — Background streaming goroutines
- `startStreaming()` (launches all goroutines)
- `cursorStreamLoop()` (120Hz cursor position streaming)
- `metricsLogger()` (periodic metric logging)
- `adaptiveLoop()` (RTCP stats → adaptive bitrate)
- `extractRemoteInboundVideoStats()`
- `applyDisplayOffset()`
- `describeH264NALUs()`

### 2. `capture_dxgi_windows.go` → 3 files

All files: `//go:build windows && !cgo`

**dxgi_windows.go** (~400 lines) — Types, init, teardown
- DLL procs, constants, COM GUIDs
- All struct types (d3d11Texture2DDesc, dxgiOutDuplDesc, dxgiOutDuplFrameInfo, etc.)
- `dxgiCapturer` struct definition
- `newPlatformCapturer()`, `initDXGI()`, `releaseDXGI()`, `Close()`
- `comVtblFn()` helper
- Interface compile-time assertions

**dxgi_capture_windows.go** (~400 lines) — Frame acquisition
- `Capture()` (CPU path: AcquireNextFrame → Map → read pixels)
- `CaptureTexture()` (GPU path: AcquireNextFrame → CopyResource to GPU texture)
- `ReleaseTexture()`
- `CaptureRegion()` (crop helper)
- `readRotated()` (rotation transform)
- `GetScreenBounds()`, `GetD3D11Device()`, `GetD3D11Context()`
- `IsBGRA()`, `TightLoop()`, `AccumulatedFrames()`
- `sampleCursorForCrossThread()`

**dxgi_desktop_windows.go** (~300 lines) — Desktop switching
- `switchToInputDesktop()` (thread desktop switch for UAC/lock screen)
- `checkDesktopSwitch()` (periodic desktop name comparison)
- `desktopName()` (GetUserObjectInformationW wrapper)
- `switchToGDI()` (GDI fallback activation)
- `closeDesktopHandle()`
- `ConsumeDesktopSwitch()`, `OnSecureDesktop()`

### 3. `encoder_mft_windows.go` → 3 files

All files: `//go:build windows`

**mft_windows.go** (~450 lines) — MFT struct, discovery, configuration
- `mftEncoder` struct definition
- `init()`, `newMFTEncoder()`
- `initialize()` (COM setup, MFT discovery, media type config, ICodecAPI)
- `findEncoder()`, `enumAndActivate()`
- `setOutputType()`, `setInputType()`, `setLowLatency()`, `unlockAsyncMFT()`
- `shutdown()`, `Close()`
- `Name()`, `IsHardware()`, `IsPlaceholder()`
- All setter methods: SetCodec, SetQuality, SetBitrate, SetFPS, SetDimensions, SetPixelFormat

**mft_encode_windows.go** (~500 lines) — Encode pipeline
- `Encode()` (CPU path: RGBA/BGRA → NV12 → MFT)
- `EncodeTexture()` (GPU path: GPU BGRA→NV12 + readback → MFT)
- `createSample()` (MF sample creation with timing)
- `drainOutput()` (ProcessOutput loop + stream change handling)
- `extractSampleData()` (ContiguousBuffer → byte slice)
- `ForceKeyframe()`, `forceKeyframeLocked()`, `Flush()`
- `vtblFn()` helper

**mft_gpu_windows.go** (~200 lines) — GPU pipeline management
- `tryInitGPUPipeline()` (DXGI device manager setup)
- `teardownDXGIManager()` (revert to CPU buffer mode)
- `SetD3D11Device()`, `SupportsGPUInput()`

## Constraints

- All files stay in `package desktop`
- No new exports — all functions and types remain package-private where they already are
- Build tags preserved exactly as on the original files
- Old files are deleted, not left as stubs
- No behavior changes — this is a pure file reorganization
