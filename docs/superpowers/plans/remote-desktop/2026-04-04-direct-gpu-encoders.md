# Direct GPU Encoders (NVENC + AMF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bypass the buggy MFT wrapper by calling NVIDIA NVENC and AMD AMF encoder APIs directly via purego, eliminating hardware encoder stalls and achieving 1-2ms encode latency with true zero-copy GPU texture input.

**Architecture:** Two new `encoderBackend` implementations (`nvencEncoder`, `amfEncoder`) load vendor DLLs at runtime via purego — same pattern as the existing OpenH264 encoder. Each registers via `registerHardwareFactory()` with higher priority than MFT. The API includes `gpuVendor` in the `start_desktop` payload from device inventory so the agent can skip irrelevant encoder probes. Both encoders accept BGRA GPU textures directly via `EncodeTexture()` — no VideoProcessorBlt or CPU readback needed.

**Tech Stack:** Go, purego (runtime DLL loading), NVIDIA Video Codec SDK 12.2 (`nvEncodeAPI64.dll`), AMD AMF 1.4 (`amfrt64.dll`), D3D11 interop, pion/webrtc

---

## File Map

### GPU-Aware Pre-Selection (API + Agent)
| File | Action | Responsibility |
|---|---|---|
| `apps/api/src/routes/remote/sessions.ts` | Modify | Look up `gpu_model` from `device_hardware`, include `gpuVendor` in payload |
| `agent/internal/remote/desktop/encoder.go` | Modify | Add `GPUVendor` field to `EncoderConfig`; vendor-aware `tryHardware` |
| `agent/internal/heartbeat/handlers_desktop.go` | Modify | Parse `gpuVendor` from command payload, pass to encoder config |

### NVENC Direct Encoder
| File | Action | Responsibility |
|---|---|---|
| `agent/internal/remote/desktop/nvenc_types_windows.go` | Create | NVENC API constants, GUIDs, struct definitions matching SDK 12.2 |
| `agent/internal/remote/desktop/encoder_nvenc.go` | Rewrite | Full NVENC encoder: DLL load, session, configure, encode, bitstream readback |
| `agent/internal/remote/desktop/encoder_nvenc_test.go` | Create | Test graceful failure on non-NVIDIA, factory registration, config |

### AMF Direct Encoder
| File | Action | Responsibility |
|---|---|---|
| `agent/internal/remote/desktop/amf_types_windows.go` | Create | AMF API constants, GUIDs, struct definitions matching AMF 1.4 |
| `agent/internal/remote/desktop/encoder_amf_windows.go` | Create | Full AMF encoder: DLL load, context, configure, encode, buffer readback |
| `agent/internal/remote/desktop/encoder_amf_windows_test.go` | Create | Test graceful failure on non-AMD, factory registration, config |

---

## Task 1: Add GPUVendor to EncoderConfig and vendor-aware factory

**Files:**
- Modify: `agent/internal/remote/desktop/encoder.go`

This task adds GPU vendor awareness to the encoder factory so it tries the matching direct encoder first instead of probing all factories sequentially.

- [ ] **Step 1: Add GPUVendor field to EncoderConfig**

In `encoder.go`, find the `EncoderConfig` struct (line 44) and add a `GPUVendor` field:

```go
type EncoderConfig struct {
	Codec          Codec
	Quality        QualityPreset
	Bitrate        int
	FPS            int
	PreferHardware bool
	GPUVendor      string // "nvidia", "amd", "intel", or "" for auto-detect
}
```

- [ ] **Step 2: Add vendor tag to backendFactory registration**

Add a new type for tagged factories and update registration:

```go
type taggedFactory struct {
	vendor  string // "" means universal (MFT)
	factory backendFactory
}

var (
	hardwareFactoriesMu sync.Mutex
	hardwareFactories   []taggedFactory
)

func registerHardwareFactory(factory backendFactory) {
	registerHardwareFactoryForVendor("", factory)
}

func registerHardwareFactoryForVendor(vendor string, factory backendFactory) {
	hardwareFactoriesMu.Lock()
	defer hardwareFactoriesMu.Unlock()
	hardwareFactories = append(hardwareFactories, taggedFactory{vendor: vendor, factory: factory})
}
```

- [ ] **Step 3: Update tryHardware to prefer matching vendor**

Replace the existing `tryHardware` function:

```go
func tryHardware(cfg EncoderConfig) encoderBackend {
	hardwareFactoriesMu.Lock()
	factories := append([]taggedFactory(nil), hardwareFactories...)
	hardwareFactoriesMu.Unlock()

	// First pass: try vendor-specific factories matching GPUVendor
	if cfg.GPUVendor != "" {
		for _, tf := range factories {
			if tf.vendor == cfg.GPUVendor {
				backend, err := tf.factory(cfg)
				if err == nil && backend != nil {
					return backend
				}
			}
		}
	}

	// Second pass: try all factories in registration order
	for _, tf := range factories {
		backend, err := tf.factory(cfg)
		if err == nil && backend != nil {
			return backend
		}
	}
	return nil
}
```

- [ ] **Step 4: Build and verify**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/`
Expected: Clean build. Existing MFT registration (`registerHardwareFactory(newMFTEncoder)`) still works because it calls the new `registerHardwareFactoryForVendor("", ...)` wrapper.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/encoder.go
git commit -m "feat(desktop): add GPUVendor to EncoderConfig for vendor-aware encoder selection

The encoder factory now supports vendor-tagged hardware factories.
When GPUVendor is set (from device inventory), matching vendors are
tried first, skipping irrelevant DLL probes. Falls back to trying
all factories in registration order when no match or vendor unknown."
```

---

## Task 2: Pass gpuVendor from API through to encoder config

**Files:**
- Modify: `apps/api/src/routes/remote/sessions.ts`
- Modify: `agent/internal/heartbeat/handlers_desktop.go`
- Modify: `agent/internal/remote/desktop/session_webrtc.go`

- [ ] **Step 1: Look up GPU vendor in the API and include in payload**

In `sessions.ts`, find the `POST /sessions/:id/offer` handler (around line 657). Before the `sendCommandToAgent` call, look up the device's GPU from `device_hardware`:

```typescript
// Look up GPU vendor from device hardware inventory for encoder pre-selection
let gpuVendor: string | undefined;
const [hw] = await db.select({ gpuModel: deviceHardware.gpuModel })
  .from(deviceHardware)
  .where(eq(deviceHardware.deviceId, device.id))
  .limit(1);
if (hw?.gpuModel) {
  const gpuLower = hw.gpuModel.toLowerCase();
  if (gpuLower.includes('nvidia') || gpuLower.includes('geforce') || gpuLower.includes('quadro') || gpuLower.includes('rtx')) {
    gpuVendor = 'nvidia';
  } else if (gpuLower.includes('radeon') || gpuLower.includes('amd')) {
    gpuVendor = 'amd';
  } else if (gpuLower.includes('intel') || gpuLower.includes('uhd') || gpuLower.includes('iris')) {
    gpuVendor = 'intel';
  }
}
```

Then add to the payload:

```typescript
payload: {
  sessionId,
  offer: data.offer,
  iceServers: getIceServers(),
  ...(data.displayIndex != null ? { displayIndex: data.displayIndex } : {}),
  ...(data.targetSessionId != null ? { targetSessionId: data.targetSessionId } : {}),
  ...(gpuVendor ? { gpuVendor } : {}),
}
```

Check imports: `deviceHardware` table is in `apps/api/src/db/schema/`. Add the import if not already present.

- [ ] **Step 2: Parse gpuVendor in the agent's handleStartDesktop**

In `handlers_desktop.go`, find `handleStartDesktop` (line 131). After the `displayIndex` parsing block, add:

```go
gpuVendor := ""
if v, ok := cmd.Payload["gpuVendor"].(string); ok {
    gpuVendor = v
}
```

This needs to be passed through to the helper's `DesktopStartRequest`. Check if `ipc.DesktopStartRequest` has a `GPUVendor` field. If not, add one to `agent/internal/ipc/message.go`:

```go
type DesktopStartRequest struct {
    SessionID    string          `json:"sessionId"`
    Offer        string          `json:"offer"`
    ICEServers   json.RawMessage `json:"iceServers,omitempty"`
    DisplayIndex int             `json:"displayIndex,omitempty"`
    GPUVendor    string          `json:"gpuVendor,omitempty"`
}
```

- [ ] **Step 3: Pass GPUVendor to EncoderConfig in StartSession**

In `session_webrtc.go`, find the `NewVideoEncoder(EncoderConfig{...})` call (around line 232). The `StartSession` function needs to accept `gpuVendor` as a parameter. Check the current signature:

```go
func (m *SessionManager) StartSession(sessionID string, offer string, iceServers []ICEServerConfig, displayIndex ...int) (answer string, err error)
```

Add `gpuVendor` to the options. The cleanest approach is an options pattern or adding it to the variadic, but to minimize changes, add it as a field on `SessionManager` that's set before `StartSession` is called:

```go
// In session.go or session_webrtc.go:
func (m *SessionManager) SetGPUVendor(vendor string) {
    m.mu.Lock()
    m.gpuVendor = vendor
    m.mu.Unlock()
}
```

Then in `StartSession`, use it when creating the encoder:

```go
enc, err := NewVideoEncoder(EncoderConfig{
    Codec:          CodecH264,
    Quality:        QualityAuto,
    Bitrate:        initBitrate,
    FPS:            maxFrameRate,
    PreferHardware: true,
    GPUVendor:      m.gpuVendor,
})
```

The helper's `handleDesktopStart` in `userhelper/desktop.go` should call `m.mgr.SetGPUVendor(req.GPUVendor)` before `m.mgr.StartSession(...)`.

- [ ] **Step 4: Build and verify**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./...`
Expected: Clean build.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/remote/sessions.ts \
       agent/internal/heartbeat/handlers_desktop.go \
       agent/internal/remote/desktop/session_webrtc.go \
       agent/internal/remote/desktop/session.go \
       agent/internal/ipc/message.go \
       agent/internal/userhelper/desktop.go
git commit -m "feat(desktop): pass gpuVendor from device inventory to encoder factory

API looks up gpu_model from device_hardware and classifies vendor
(nvidia/amd/intel). Passed through start_desktop payload → IPC →
SessionManager → EncoderConfig.GPUVendor. The encoder factory uses
this to try the matching direct encoder first."
```

---

## Task 3: NVENC type definitions

**Files:**
- Create: `agent/internal/remote/desktop/nvenc_types_windows.go`

These structs MUST match the NVIDIA Video Codec SDK 12.2 headers (`nvEncodeAPI.h`). The reserved field sizes determine struct alignment — wrong sizes cause crashes.

**Reference:** Download the SDK headers from https://developer.nvidia.com/video-codec-sdk or reference the header file directly. The key structs are `NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS`, `NV_ENC_INITIALIZE_PARAMS`, `NV_ENC_CONFIG`, `NV_ENC_REGISTER_RESOURCE`, `NV_ENC_MAP_INPUT_RESOURCE`, `NV_ENC_PIC_PARAMS`, `NV_ENC_LOCK_BITSTREAM`, and `NV_ENCODE_API_FUNCTION_LIST`.

- [ ] **Step 1: Create the types file with constants and GUIDs**

Create `agent/internal/remote/desktop/nvenc_types_windows.go`:

```go
//go:build windows

package desktop

import "unsafe"

// NVENC API version — must match the SDK headers used for struct layouts.
// Update these when upgrading to a newer SDK version.
const (
	nvencAPIVersionMajor = 12
	nvencAPIVersionMinor = 2
	nvencAPIVersion      = (nvencAPIVersionMajor << 4) | nvencAPIVersionMinor
)

// nvencStructVer computes the versioned struct size field required by all
// NVENC API structs: low 16 bits = struct size, high 16 bits = API version.
func nvencStructVer(structSize uintptr) uint32 {
	return uint32(structSize) | (nvencAPIVersion << 16)
}

// NVENC codec and preset GUIDs — binary representation of the SDK-defined GUIDs.
// These are passed to nvEncInitializeEncoder to select H264 + low-latency preset.
var (
	// NV_ENC_CODEC_H264_GUID = {6BC82762-4E63-4CA4-AA85-1E50F321F6BF}
	nvencCodecH264GUID = [16]byte{
		0x62, 0x27, 0xC8, 0x6B, 0x63, 0x4E, 0xA4, 0x4C,
		0xAA, 0x85, 0x1E, 0x50, 0xF3, 0x21, 0xF6, 0xBF,
	}

	// NV_ENC_PRESET_P4_GUID = {FC0A8D3E-...} — balanced quality/performance
	// Verify exact bytes from nvEncodeAPI.h NV_ENC_PRESET_P4_GUID definition.
	nvencPresetP4GUID [16]byte

	// NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY = 3
	nvencTuningUltraLowLatency uint32 = 3
)

// NVENC constants
const (
	nvencDeviceTypeDirectX    = 1
	nvencInputResourceDirectX = 2
	nvencBufferFormatARGB     = 0x00000020
	nvencBufferFormatNV12     = 0x00000001
	nvencRCModeCBR            = 2
	nvencPicFlagForceIDR      = 0x00000004
)

// NV_ENCODE_API_FUNCTION_LIST — the function pointer table returned by
// NvEncodeAPICreateInstance. Field order matches nvEncodeAPI.h exactly.
// Each field is a function pointer (uintptr on Windows amd64).
//
// CRITICAL: The field ORDER and COUNT must match the SDK header.
// Verify against nvEncodeAPI.h version 12.2.
type nvencFuncList struct {
	Version                      uint32
	Reserved                     uint32
	NvEncOpenEncodeSession       uintptr // index 0 — deprecated, use Ex
	NvEncGetEncodeGUIDCount      uintptr // index 1
	NvEncGetEncodeGUIDs          uintptr // index 2
	NvEncGetEncodeProfileGUIDCount uintptr // index 3
	NvEncGetEncodeProfileGUIDs   uintptr // index 4
	NvEncGetInputFormatCount     uintptr // index 5
	NvEncGetInputFormats         uintptr // index 6
	NvEncGetEncodeCaps           uintptr // index 7
	NvEncGetEncodePresetCount    uintptr // index 8
	NvEncGetEncodePresetGUIDs    uintptr // index 9
	NvEncGetEncodePresetConfig   uintptr // index 10
	NvEncInitializeEncoder       uintptr // index 11
	NvEncCreateInputBuffer       uintptr // index 12
	NvEncDestroyInputBuffer      uintptr // index 13
	NvEncCreateBitstreamBuffer   uintptr // index 14
	NvEncDestroyBitstreamBuffer  uintptr // index 15
	NvEncEncodePicture           uintptr // index 16
	NvEncLockBitstream           uintptr // index 17
	NvEncUnlockBitstream         uintptr // index 18
	NvEncLockInputBuffer         uintptr // index 19
	NvEncUnlockInputBuffer       uintptr // index 20
	NvEncGetEncodeStats          uintptr // index 21
	NvEncGetSequenceParams       uintptr // index 22
	NvEncRegisterAsyncEvent      uintptr // index 23
	NvEncUnregisterAsyncEvent    uintptr // index 24
	NvEncMapInputResource        uintptr // index 25
	NvEncUnmapInputResource      uintptr // index 26
	NvEncDestroyEncoder          uintptr // index 27
	NvEncInvalidateRefFrames     uintptr // index 28
	NvEncOpenEncodeSessionEx     uintptr // index 29
	NvEncRegisterResource        uintptr // index 30
	NvEncUnregisterResource      uintptr // index 31
	NvEncReconfigureEncoder      uintptr // index 32
	// ... additional fields may exist in newer SDK versions
	Reserved2 [219]uintptr // pad to expected struct size
}

// NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS
// CRITICAL: Verify struct size against sizeof(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS) in SDK.
type nvencOpenSessionParams struct {
	Version    uint32
	DeviceType uint32 // nvencDeviceTypeDirectX = 1
	Device     uintptr
	Reserved   uintptr
	APIVersion uint32
	Reserved2  [253]uint32
}

// NV_ENC_REGISTER_RESOURCE
type nvencRegisterResource struct {
	Version            uint32
	ResourceType       uint32 // nvencInputResourceDirectX
	Width              uint32
	Height             uint32
	Pitch              uint32
	SubResourceIndex   uint32
	ResourceToRegister uintptr
	RegisteredResource uintptr
	BufferFormat        uint32
	BufferUsage        uint32
	Reserved           [247]uint32
}

// NV_ENC_MAP_INPUT_RESOURCE
type nvencMapInputResource struct {
	Version          uint32
	SubResourceIndex uint32
	InputResource    uintptr // from RegisterResource.RegisteredResource
	MappedResource   uintptr // output: mapped handle for EncodePicture
	MappedBufferFmt  uint32
	Reserved         [251]uint32
}

// NV_ENC_LOCK_BITSTREAM
type nvencLockBitstream struct {
	Version              uint32
	DoNotWait            uint32
	LockFlags            uint32
	Reserved             uint32
	BitstreamBufferPtr   uintptr
	SliceOffsets         uintptr
	FrameIdx             uint32
	HWEncodeStatus       uint32
	NumSlices            uint32
	BitstreamSizeInBytes uint32
	OutputTimeStamp      int64
	OutputDuration       int64
	BitstreamDataPtr     uintptr
	PictureType          uint32
	PictureStruct        uint32
	FrameAvgQP           uint32
	Reserved2            [229]uint32
}

// Size assertions — these MUST match the SDK. If they don't, the reserved
// field padding needs adjustment. Run these on a Windows machine with the
// SDK headers available.
func init() {
	// Uncomment during development to verify struct sizes:
	// if unsafe.Sizeof(nvencFuncList{}) != expectedSize { panic("nvencFuncList size mismatch") }
	_ = unsafe.Sizeof(nvencOpenSessionParams{})
	_ = unsafe.Sizeof(nvencRegisterResource{})
}
```

**IMPORTANT NOTE TO IMPLEMENTER:** The reserved field sizes (`[253]uint32`, `[247]uint32`, etc.) are estimates. You MUST verify these against the actual NVIDIA Video Codec SDK 12.2 `nvEncodeAPI.h` header before testing. Wrong sizes will cause memory corruption. The SDK can be downloaded from https://developer.nvidia.com/video-codec-sdk (free registration).

To verify: compile a small C program that prints `sizeof(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS)` etc. and match your Go struct sizes.

- [ ] **Step 2: Build and verify**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/`

- [ ] **Step 3: Commit**

```bash
git add agent/internal/remote/desktop/nvenc_types_windows.go
git commit -m "feat(desktop): NVENC API type definitions for Video Codec SDK 12.2

Defines Go structs matching NVIDIA nvEncodeAPI.h types. Includes
function list, session params, resource registration, encode params,
and bitstream lock structs. Reserved field sizes must be verified
against the actual SDK headers before testing on NVIDIA hardware."
```

---

## Task 4: NVENC encoder implementation — DLL loading and session management

**Files:**
- Rewrite: `agent/internal/remote/desktop/encoder_nvenc.go`

- [ ] **Step 1: Replace the placeholder with real DLL loading**

Replace the entire file. Remove the `//go:build nvenc` tag:

```go
//go:build windows

package desktop

import (
	"fmt"
	"log/slog"
	"sync"
	"syscall"
	"unsafe"

	"github.com/ebitengine/purego"
)

var (
	nvencDLL     uintptr
	nvencLoadMu  sync.Mutex
	nvencLoaded  bool
	nvencLoadErr error
)

func init() {
	registerHardwareFactoryForVendor("nvidia", newNVENCEncoder)
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
		slog.Debug("NVENC not available", "error", nvencLoadErr.Error())
		return nvencLoadErr
	}
	nvencLoaded = true
	slog.Info("NVENC library loaded (nvEncodeAPI64.dll)")
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

type nvencEncoder struct {
	mu          sync.Mutex
	cfg         EncoderConfig
	width       int
	height      int
	pixelFormat PixelFormat
	forceIDR    bool
	frameIdx    uint64

	// NVENC state
	funcs       nvencFuncList
	encoder     uintptr
	d3d11Device uintptr
	d3d11Ctx    uintptr

	// Registered input + output buffers
	registeredResource uintptr
	bitstreamBuffer    uintptr
	lastTexture        uintptr

	inited bool
}

// --- encoderBackend interface ---

func (e *nvencEncoder) Name() string {
	if e.inited {
		return "nvenc-hardware"
	}
	return "nvenc"
}

func (e *nvencEncoder) IsHardware() bool    { return true }
func (e *nvencEncoder) IsPlaceholder() bool { return false }
func (e *nvencEncoder) SetCodec(c Codec) error { return nil }
func (e *nvencEncoder) SetQuality(q QualityPreset) error { return nil }
func (e *nvencEncoder) SetPixelFormat(pf PixelFormat) { e.pixelFormat = pf }

func (e *nvencEncoder) SetBitrate(bitrate int) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cfg.Bitrate = bitrate
	// Dynamic bitrate change via NvEncReconfigureEncoder can be added later
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
	e.width = w & ^1 // even dimensions for H264
	e.height = h & ^1
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

	// Re-register texture if it changed (monitor switch)
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
	if e.bitstreamBuffer != 0 {
		syscall.SyscallN(e.funcs.NvEncDestroyBitstreamBuffer, e.encoder, e.bitstreamBuffer)
		e.bitstreamBuffer = 0
	}
	if e.encoder != 0 {
		syscall.SyscallN(e.funcs.NvEncDestroyEncoder, e.encoder)
		e.encoder = 0
	}
	e.inited = false
	slog.Info("NVENC encoder shut down")
}
```

- [ ] **Step 2: Implement initialize() — load function list and open session**

Add to the same file:

```go
func (e *nvencEncoder) initialize() error {
	if e.d3d11Device == 0 {
		return fmt.Errorf("no D3D11 device")
	}
	if e.width == 0 || e.height == 0 {
		return fmt.Errorf("dimensions not set")
	}

	// Step 1: Get function list via NvEncodeAPICreateInstance
	createInstanceAddr, err := purego.Dlsym(nvencDLL, "NvEncodeAPICreateInstance")
	if err != nil {
		return fmt.Errorf("NvEncodeAPICreateInstance not found: %w", err)
	}

	e.funcs.Version = nvencStructVer(unsafe.Sizeof(e.funcs))
	r1, _, _ := syscall.SyscallN(createInstanceAddr, uintptr(unsafe.Pointer(&e.funcs)))
	if r1 != 0 {
		return fmt.Errorf("NvEncodeAPICreateInstance failed: 0x%X", r1)
	}

	// Step 2: Open encode session with D3D11 device
	var params nvencOpenSessionParams
	params.Version = nvencStructVer(unsafe.Sizeof(params))
	params.DeviceType = nvencDeviceTypeDirectX
	params.Device = e.d3d11Device
	params.APIVersion = nvencAPIVersion

	r1, _, _ = syscall.SyscallN(
		e.funcs.NvEncOpenEncodeSessionEx,
		uintptr(unsafe.Pointer(&params)),
		uintptr(unsafe.Pointer(&e.encoder)),
	)
	if r1 != 0 {
		return fmt.Errorf("NvEncOpenEncodeSessionEx failed: 0x%X", r1)
	}

	// Step 3: Initialize encoder (H264, CBR, ultra-low-latency)
	if err := e.configureEncoder(); err != nil {
		syscall.SyscallN(e.funcs.NvEncDestroyEncoder, e.encoder)
		e.encoder = 0
		return err
	}

	// Step 4: Create output bitstream buffer
	if err := e.createBitstreamBuffer(); err != nil {
		syscall.SyscallN(e.funcs.NvEncDestroyEncoder, e.encoder)
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
```

- [ ] **Step 3: Implement configureEncoder, createBitstreamBuffer, registerTexture, unregisterResource, encodeFrame**

These methods make the actual NVENC API calls. Each follows the pattern:
1. Fill a versioned params struct
2. Call via `syscall.SyscallN(e.funcs.NvEncXxx, e.encoder, uintptr(unsafe.Pointer(&params)))`
3. Check return code (0 = success)

**configureEncoder:** Calls `NvEncGetEncodePresetConfig` then `NvEncInitializeEncoder` with H264 codec GUID, P4 preset, CBR rate control, ultra-low-latency tuning.

**createBitstreamBuffer:** Calls `NvEncCreateBitstreamBuffer` to allocate the output buffer.

**registerTexture:** Calls `NvEncRegisterResource` with the BGRA texture handle, `NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX`, and `NV_ENC_BUFFER_FORMAT_ARGB`.

**unregisterResource:** Calls `NvEncUnregisterResource`.

**encodeFrame:** The per-frame encode sequence:
1. `NvEncMapInputResource` → mapped handle
2. Fill `NV_ENC_PIC_PARAMS` with mapped handle + bitstream buffer + optional IDR flag
3. `NvEncEncodePicture` → encode
4. `NvEncUnmapInputResource`
5. `NvEncLockBitstream` → get pointer + size
6. Copy H264 NALUs to Go byte slice
7. `NvEncUnlockBitstream`

**IMPORTANT:** The exact struct layouts for `NV_ENC_INITIALIZE_PARAMS`, `NV_ENC_CONFIG`, and `NV_ENC_PIC_PARAMS` are complex (hundreds of fields). Reference the NVIDIA SDK 12.2 `nvEncodeAPI.h` header and the SDK sample `AppEncD3D11/AppEncD3D11.cpp` for the correct initialization sequence. The `NV_ENC_CONFIG` struct alone is ~2KB with nested `NV_ENC_CONFIG_H264` and `NV_ENC_RC_PARAMS` sub-structs.

- [ ] **Step 4: Build**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./internal/remote/desktop/`

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/encoder_nvenc.go
git commit -m "feat(desktop): NVENC encoder via purego — session, configure, encode

Full NVENC integration: loads nvEncodeAPI64.dll at runtime, opens
encode session on D3D11 device, configures H264 CBR ultra-low-latency,
registers BGRA textures directly (no color conversion needed).
Per-frame: map → encode → lock bitstream → copy NALUs → unlock.
Falls back to MFT on non-NVIDIA machines."
```

---

## Task 5: NVENC tests — graceful failure and factory registration

**Files:**
- Create: `agent/internal/remote/desktop/encoder_nvenc_test.go`

- [ ] **Step 1: Write tests**

```go
//go:build windows

package desktop

import "testing"

func TestNVENC_FactoryRegistered(t *testing.T) {
	// Verify NVENC factory is in the hardware factories list
	hardwareFactoriesMu.Lock()
	found := false
	for _, tf := range hardwareFactories {
		if tf.vendor == "nvidia" {
			found = true
			break
		}
	}
	hardwareFactoriesMu.Unlock()
	if !found {
		t.Error("NVENC factory not registered with vendor tag 'nvidia'")
	}
}

func TestNVENC_GracefulFailureOnNonNVIDIA(t *testing.T) {
	// On a machine without NVIDIA GPU, newNVENCEncoder should fail gracefully
	cfg := EncoderConfig{Codec: CodecH264, PreferHardware: true}
	enc, err := newNVENCEncoder(cfg)
	if err == nil && enc != nil && !enc.IsPlaceholder() {
		// We have an NVIDIA GPU — this test is only meaningful on non-NVIDIA
		enc.Close()
		t.Skip("NVIDIA GPU present, skipping non-NVIDIA test")
	}
	// Should have gotten an error about DLL not found
	if err == nil {
		t.Error("expected error on non-NVIDIA machine")
	}
}

func TestNVENC_RejectsNonH264(t *testing.T) {
	cfg := EncoderConfig{Codec: "vp9", PreferHardware: true}
	_, err := newNVENCEncoder(cfg)
	if err == nil {
		t.Error("expected error for non-H264 codec")
	}
}
```

- [ ] **Step 2: Run tests**

Run: `cd agent && GOOS=windows go test ./internal/remote/desktop/ -run TestNVENC -v`
Note: On macOS dev machine, these will be skipped (Windows build tag). Verify compilation: `GOOS=windows GOARCH=amd64 go vet ./internal/remote/desktop/`

- [ ] **Step 3: Commit**

```bash
git add agent/internal/remote/desktop/encoder_nvenc_test.go
git commit -m "test(desktop): NVENC encoder factory registration and graceful failure tests"
```

---

## Task 6: AMF type definitions

**Files:**
- Create: `agent/internal/remote/desktop/amf_types_windows.go`

Same pattern as Task 3 but for AMD AMF 1.4. Key types: `AMFFactory`, `AMFContext`, `AMFComponent` (encoder), `AMFSurface`, `AMFBuffer`, `AMFData`.

**Reference:** AMD AMF SDK is open source at https://github.com/GPUOpen-LibrariesAndSDKs/AMF. The header files are in `amf/public/include/`. Key headers: `Factory.h`, `Context.h`, `Component.h`, `Surface.h`, `VideoEncoderVCE.h`.

AMF uses a COM-like vtable pattern with `AMFInterface` base class. Each method is a vtable index call via `syscall.SyscallN`.

- [ ] **Step 1: Create the types file**

Create `agent/internal/remote/desktop/amf_types_windows.go` with AMF constants, vtable indices, property names, and surface format constants. Reference the AMF SDK headers for exact values.

Key constants needed:
- `AMF_VIDEO_ENCODER_USAGE_ULTRA_LOW_LATENCY`
- `AMF_VIDEO_ENCODER_RATE_CONTROL_METHOD_CBR`
- `AMF_SURFACE_BGRA` / `AMF_SURFACE_NV12`
- `AMF_MEMORY_DX11`
- Encoder property names: `AMF_VIDEO_ENCODER_TARGET_BITRATE`, `AMF_VIDEO_ENCODER_FRAMERATE`, etc.

- [ ] **Step 2: Build and commit**

```bash
git add agent/internal/remote/desktop/amf_types_windows.go
git commit -m "feat(desktop): AMF API type definitions for AMD Advanced Media Framework 1.4"
```

---

## Task 7: AMF encoder implementation

**Files:**
- Create: `agent/internal/remote/desktop/encoder_amf_windows.go`

Follows the same structure as NVENC (Task 4) but with AMF API calls.

- [ ] **Step 1: Implement DLL loading and factory**

```go
//go:build windows

package desktop

// ... same singleton pattern as NVENC ...

func init() {
	registerHardwareFactoryForVendor("amd", newAMFEncoder)
}

func loadAMF() error {
	// Load amfrt64.dll via purego.Dlopen
	// Get AMFCreateFactory function pointer
}
```

- [ ] **Step 2: Implement AMF encode session**

AMF flow differs from NVENC:
1. `AMFFactory::CreateContext()` → `AMFContext`
2. `context.InitDX11(d3d11Device)` — bind D3D11 device
3. `AMFFactory::CreateComponent("AMFVideoEncoderVCE_AVC")` → encoder
4. Set properties: usage, bitrate, framerate, rate control
5. `encoder.Init(AMF_SURFACE_BGRA, width, height)`

Per frame:
1. `context.CreateSurfaceFromDX11Native(texture)` → `AMFSurface`
2. `encoder.SubmitInput(surface)`
3. `encoder.QueryOutput()` → `AMFData`
4. Cast to `AMFBuffer`, call `GetNative()` for bitstream pointer + `GetSize()` for length
5. Copy H264 NALUs
6. Release surface and buffer

All methods are vtable calls. AMF vtable indices are defined in the SDK headers.

- [ ] **Step 3: Build and commit**

```bash
git add agent/internal/remote/desktop/encoder_amf_windows.go
git commit -m "feat(desktop): AMF encoder via purego — context, configure, encode

Full AMD AMF integration: loads amfrt64.dll at runtime, creates context
with D3D11 device, configures H264 VCE with CBR ultra-low-latency.
Per-frame: create surface from DX11 texture → submit → query output →
copy NALUs. Falls back to MFT on non-AMD machines."
```

---

## Task 8: AMF tests

**Files:**
- Create: `agent/internal/remote/desktop/encoder_amf_windows_test.go`

Same pattern as Task 5 — test factory registration with `"amd"` vendor tag, graceful failure on non-AMD, codec validation.

- [ ] **Step 1: Write and commit tests**

```bash
git add agent/internal/remote/desktop/encoder_amf_windows_test.go
git commit -m "test(desktop): AMF encoder factory registration and graceful failure tests"
```

---

## Task 9: Integration test on real hardware

**Files:** None — this is a manual verification task.

- [ ] **Step 1: Build Windows agent with all changes**

```bash
cd agent
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "-X main.version=dev-nvenc-amf" -o bin/breeze-agent-dev ./cmd/breeze-agent
```

- [ ] **Step 2: Deploy to Kit (AMD RX 590) and verify AMF**

Push via dev-push. Connect desktop. Check logs for:
```
AMF library loaded (amfrt64.dll)
AMF encoder initialized — width=2560 height=1440 bitrate=2500000
```

Verify: no stalls, sustained 60fps, encode latency <3ms.

- [ ] **Step 3: Deploy to an NVIDIA machine and verify NVENC**

Check logs for:
```
NVENC library loaded (nvEncodeAPI64.dll)
NVENC encoder initialized — width=... height=...
```

- [ ] **Step 4: Deploy to Intel machine and verify fallback**

Both NVENC and AMF DLLs should fail to load. MFT should be used:
```
NVENC not available: nvEncodeAPI64.dll not available
AMF not available: amfrt64.dll not available
MFT H264 encoder initialized — type: hardware
```

- [ ] **Step 5: Commit any fixes discovered during testing**

---

## Verification Checklist

After all tasks, verify the encoder priority works correctly:

| Machine | Expected encoder | Fallback |
|---|---|---|
| NVIDIA GPU | NVENC direct | MFT → OpenH264 |
| AMD GPU (Kit) | AMF direct | MFT → OpenH264 |
| Intel iGPU | MFT (Quick Sync) | OpenH264 |
| No GPU / headless | OpenH264 | — |

Query to check:
```sql
SELECT timestamp, message, fields::text FROM agent_logs
WHERE device_id = '<device-id>'
  AND (message LIKE 'NVENC%' OR message LIKE 'AMF%' OR message LIKE 'MFT%' OR message LIKE 'OpenH264%')
  AND message LIKE '%initialized%'
ORDER BY timestamp DESC LIMIT 5;
```
