//go:build windows

package desktop

import (
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

// =============================================================================
// NVENC Encoder — Direct NVIDIA GPU encoding via nvEncodeAPI64.dll
//
// Bypasses the MFT wrapper entirely: loads NVENC at runtime, opens an encode
// session on the D3D11 device, and encodes BGRA GPU textures directly to H264
// NALUs. No CPU readback, no VideoProcessorBlt, no MFT stall bugs.
//
// Registered as a vendor-specific hardware factory for "nvidia". The encoder
// factory tries this first on NVIDIA GPUs, falling back to MFT → OpenH264.
// =============================================================================

var (
	nvencDLL      = syscall.NewLazyDLL("nvEncodeAPI64.dll")
	nvencLoadOnce sync.Once
	nvencLoadErr  error
)

func loadNVENCDLL() error {
	nvencLoadOnce.Do(func() {
		nvencLoadErr = nvencDLL.Load()
		if nvencLoadErr != nil {
			slog.Debug("NVENC not available", "error", nvencLoadErr.Error())
		} else {
			slog.Info("NVENC library loaded (nvEncodeAPI64.dll)")
		}
	})
	return nvencLoadErr
}

func init() {
	registerHardwareFactoryForVendor("nvidia", newNVENCEncoder)
}

func newNVENCEncoder(cfg EncoderConfig) (encoderBackend, error) {
	if cfg.Codec != CodecH264 {
		return nil, fmt.Errorf("nvenc: only H264 supported, got %s", cfg.Codec)
	}
	if err := loadNVENCDLL(); err != nil {
		return nil, err
	}
	return &nvencEncoder{cfg: cfg}, nil
}

// nvencEncoder implements encoderBackend using NVIDIA's NVENC hardware encoder.
type nvencEncoder struct {
	mu          sync.Mutex
	cfg         EncoderConfig
	width       int
	height      int
	pixelFormat PixelFormat
	forceIDR    bool
	frameIdx    uint64

	// NVENC API state
	funcs   nvencFuncList
	encoder uintptr // NV_ENC_ENCODE_SESSION handle

	// D3D11 device from the DXGI capturer
	d3d11Device uintptr
	d3d11Ctx    uintptr

	// Config kept alive for encoder lifetime (passed by pointer during init)
	config nvencConfig

	// Per-frame resources
	registeredRes uintptr // NV_ENC_REGISTERED_PTR
	bitstreamBuf  uintptr // output bitstream buffer handle
	lastTexture   uintptr // cached texture for re-registration detection

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

func (e *nvencEncoder) SetCodec(c Codec) error {
	if c != CodecH264 {
		return fmt.Errorf("%w: nvenc only supports H264, got %s", ErrInvalidCodec, c)
	}
	return nil
}

func (e *nvencEncoder) SetQuality(_ QualityPreset) error { return nil }
func (e *nvencEncoder) SetPixelFormat(pf PixelFormat)    { e.pixelFormat = pf }

func (e *nvencEncoder) SetBitrate(bitrate int) error {
	if bitrate <= 0 {
		return ErrInvalidBitrate
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cfg.Bitrate = bitrate
	// TODO: dynamic reconfigure via NvEncReconfigureEncoder
	return nil
}

func (e *nvencEncoder) SetFPS(fps int) error {
	if fps <= 0 {
		return ErrInvalidFPS
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cfg.FPS = fps
	return nil
}

func (e *nvencEncoder) SetDimensions(w, h int) error {
	w = w &^ 1 // H264 requires even dimensions
	h = h &^ 1
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
	if e.inited && device != e.d3d11Device {
		e.shutdown() // D3D11 device changed — must reinitialize
	}
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

func (e *nvencEncoder) Flush() error {
	return e.ForceKeyframe()
}

func (e *nvencEncoder) Encode(_ []byte) ([]byte, error) {
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

	// Re-register texture if the pointer changed (display/monitor switch)
	if bgraTexture != e.lastTexture {
		if e.registeredRes != 0 {
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

// =============================================================================
// Initialization
// =============================================================================

func (e *nvencEncoder) initialize() error {
	if e.d3d11Device == 0 {
		return fmt.Errorf("no D3D11 device — call SetD3D11Device first")
	}
	if e.width == 0 || e.height == 0 {
		return fmt.Errorf("dimensions not set — call SetDimensions first")
	}

	// Step 1: Get the NVENC function pointer table
	createInstanceProc := nvencDLL.NewProc("NvEncodeAPICreateInstance")
	e.funcs = nvencFuncList{}
	e.funcs.Version = nvencStructVer(2)
	r, _, _ := createInstanceProc.Call(uintptr(unsafe.Pointer(&e.funcs)))
	if r != nvencSuccess {
		return fmt.Errorf("NvEncodeAPICreateInstance failed: %s (0x%X)", nvencStatusStr(r), r)
	}

	// Step 2: Open encode session with D3D11 device
	var sessionParams nvencOpenSessionParams
	sessionParams.Version = nvencStructVer(1)
	sessionParams.DeviceType = nvencDeviceTypeDX
	sessionParams.Device = e.d3d11Device
	sessionParams.APIVersion = nvencAPIVersion
	r, _, _ = syscall.SyscallN(
		e.funcs.OpenEncodeSessionEx,
		uintptr(unsafe.Pointer(&sessionParams)),
		uintptr(unsafe.Pointer(&e.encoder)),
	)
	if r != nvencSuccess {
		return fmt.Errorf("NvEncOpenEncodeSessionEx failed: %s (0x%X)", nvencStatusStr(r), r)
	}

	// Step 3: Get preset config defaults for ultra-low-latency
	var presetCfg nvencPresetConfig
	*(*uint32)(unsafe.Pointer(&presetCfg[0])) = nvencStructVerExt(5)       // preset config version
	*(*uint32)(unsafe.Pointer(&presetCfg[8])) = nvencStructVerExt(9)       // embedded NV_ENC_CONFIG version
	*(*uint32)(unsafe.Pointer(&presetCfg[8+ncfgRCVersion])) = nvencStructVer(1) // embedded RC_PARAMS version

	r, _, _ = syscall.SyscallN(
		e.funcs.GetPresetConfigEx,
		e.encoder,
		uintptr(unsafe.Pointer(&nvencCodecH264GUID)),
		uintptr(unsafe.Pointer(&nvencPresetP4GUID)),
		uintptr(nvencTuningUltraLowLat),
		uintptr(unsafe.Pointer(&presetCfg)),
	)
	runtime.KeepAlive(presetCfg)
	if r != nvencSuccess {
		syscall.SyscallN(e.funcs.DestroyEncoder, e.encoder)
		e.encoder = 0
		return fmt.Errorf("NvEncGetEncodePresetConfigEx failed: %s (0x%X)", nvencStatusStr(r), r)
	}

	// Step 4: Extract and customize the config
	copy(e.config[:], presetCfg[8:8+3584])

	fps := e.cfg.FPS
	if fps <= 0 {
		fps = 30
	}
	bitrate := e.cfg.Bitrate
	if bitrate <= 0 {
		bitrate = 2_500_000
	}

	// Profile: High for better compression
	ncfgPutGUID(&e.config, ncfgProfileGUID, nvencProfileAutoGUID)

	// GOP: IDR every 10 seconds, no B-frames
	idrPeriod := uint32(fps * 10)
	if idrPeriod < 30 {
		idrPeriod = 30
	}
	ncfgPutU32(&e.config, ncfgGOPLength, idrPeriod)
	ncfgPutU32(&e.config, ncfgFrameIntervalP, 1) // no B-frames (IP only)

	// Rate control: CBR
	ncfgPutU32(&e.config, ncfgRCMode, nvencRCCBR)
	ncfgPutU32(&e.config, ncfgRCAvgBR, uint32(bitrate))
	ncfgPutU32(&e.config, ncfgRCMaxBR, uint32(bitrate))
	ncfgPutU32(&e.config, ncfgRCVBVBuf, uint32(bitrate/fps)) // 1 frame buffer
	ncfgPutU32(&e.config, ncfgRCVBVInit, uint32(bitrate/fps))

	// H264: IDR period, repeat SPS/PPS for stream robustness
	ncfgPutU32(&e.config, ncfgH264IDRPeriod, idrPeriod)
	bits := ncfgGetU32(&e.config, ncfgH264Bitfields)
	bits |= ncfgH264RepeatSPSPPS
	ncfgPutU32(&e.config, ncfgH264Bitfields, bits)

	// Step 5: Initialize the encoder
	var initParams nvencInitParams
	initParams.Version = nvencStructVerExt(7)
	initParams.EncodeGUID = nvencCodecH264GUID
	initParams.PresetGUID = nvencPresetP4GUID
	initParams.EncodeWidth = uint32(e.width)
	initParams.EncodeHeight = uint32(e.height)
	initParams.DarWidth = uint32(e.width)
	initParams.DarHeight = uint32(e.height)
	initParams.FrameRateNum = uint32(fps)
	initParams.FrameRateDen = 1
	initParams.EnablePTD = 1 // picture type decision
	initParams.EncodeConfig = uintptr(unsafe.Pointer(&e.config))
	initParams.TuningInfo = nvencTuningUltraLowLat

	r, _, _ = syscall.SyscallN(
		e.funcs.InitializeEncoder,
		e.encoder,
		uintptr(unsafe.Pointer(&initParams)),
	)
	runtime.KeepAlive(e.config)
	runtime.KeepAlive(initParams)
	if r != nvencSuccess {
		syscall.SyscallN(e.funcs.DestroyEncoder, e.encoder)
		e.encoder = 0
		return fmt.Errorf("NvEncInitializeEncoder failed: %s (0x%X)", nvencStatusStr(r), r)
	}

	// Step 6: Create output bitstream buffer
	var createBuf nvencCreateBitstreamBuffer
	createBuf.Version = nvencStructVer(1)
	r, _, _ = syscall.SyscallN(
		e.funcs.CreateBitstreamBuffer,
		e.encoder,
		uintptr(unsafe.Pointer(&createBuf)),
	)
	if r != nvencSuccess {
		syscall.SyscallN(e.funcs.DestroyEncoder, e.encoder)
		e.encoder = 0
		return fmt.Errorf("NvEncCreateBitstreamBuffer failed: %s (0x%X)", nvencStatusStr(r), r)
	}
	e.bitstreamBuf = createBuf.Buffer

	e.inited = true
	e.frameIdx = 0
	slog.Info("NVENC encoder initialized",
		"width", e.width, "height", e.height,
		"bitrate", bitrate, "fps", fps,
		"preset", "P4", "tuning", "ultra-low-latency",
	)
	return nil
}

// =============================================================================
// Per-frame encoding
// =============================================================================

func (e *nvencEncoder) registerTexture(texture uintptr) error {
	var reg nvencRegisterResource
	reg.Version = nvencStructVer(5)
	reg.ResType = nvencInputResDX
	reg.Width = uint32(e.width)
	reg.Height = uint32(e.height)
	reg.Resource = texture
	reg.BufFormat = nvencBufFmtARGB // BGRA textures are registered as ARGB
	reg.BufUsage = nvencBufUsageInput

	r, _, _ := syscall.SyscallN(
		e.funcs.RegisterResource,
		e.encoder,
		uintptr(unsafe.Pointer(&reg)),
	)
	if r != nvencSuccess {
		return fmt.Errorf("NvEncRegisterResource failed: %s (0x%X)", nvencStatusStr(r), r)
	}
	e.registeredRes = reg.Registered
	return nil
}

func (e *nvencEncoder) unregisterResource() {
	if e.registeredRes == 0 {
		return
	}
	syscall.SyscallN(e.funcs.UnregisterResource, e.encoder, e.registeredRes)
	e.registeredRes = 0
	e.lastTexture = 0
}

func (e *nvencEncoder) encodeFrame() ([]byte, error) {
	// Map input resource
	var mapRes nvencMapInputResource
	mapRes.Version = nvencStructVer(4)
	mapRes.Registered = e.registeredRes

	r, _, _ := syscall.SyscallN(
		e.funcs.MapInputResource,
		e.encoder,
		uintptr(unsafe.Pointer(&mapRes)),
	)
	if r != nvencSuccess {
		return nil, fmt.Errorf("NvEncMapInputResource failed: %s (0x%X)", nvencStatusStr(r), r)
	}
	mappedHandle := mapRes.Mapped
	mappedFmt := mapRes.MappedFmt

	// Encode picture
	var picParams nvencPicParams
	picParams.Version = nvencStructVerExt(7)
	picParams.InputWidth = uint32(e.width)
	picParams.InputHeight = uint32(e.height)
	picParams.InputBuffer = mappedHandle
	picParams.OutputBitstream = e.bitstreamBuf
	picParams.BufferFmt = mappedFmt
	picParams.PictureStruct = nvencPicStructFrame
	picParams.FrameIdx = uint32(e.frameIdx)

	if e.forceIDR {
		picParams.EncodePicFlags = nvencPicFlagForceIDR | nvencPicFlagSPSPPS
		e.forceIDR = false
	}
	// First frame should always be IDR with SPS/PPS
	if e.frameIdx == 0 {
		picParams.EncodePicFlags |= nvencPicFlagForceIDR | nvencPicFlagSPSPPS
	}

	e.frameIdx++

	r, _, _ = syscall.SyscallN(
		e.funcs.EncodePicture,
		e.encoder,
		uintptr(unsafe.Pointer(&picParams)),
	)

	// Unmap regardless of encode result
	syscall.SyscallN(e.funcs.UnmapInputResource, e.encoder, mappedHandle)

	if r != nvencSuccess {
		return nil, fmt.Errorf("NvEncEncodePicture failed: %s (0x%X)", nvencStatusStr(r), r)
	}

	// Lock bitstream to read the H264 NALUs
	var lockBS nvencLockBitstream
	lockBS.Version = nvencStructVerExt(2)
	lockBS.OutputBitstream = e.bitstreamBuf

	r, _, _ = syscall.SyscallN(
		e.funcs.LockBitstream,
		e.encoder,
		uintptr(unsafe.Pointer(&lockBS)),
	)
	if r != nvencSuccess {
		return nil, fmt.Errorf("NvEncLockBitstream failed: %s (0x%X)", nvencStatusStr(r), r)
	}

	// Copy the compressed H264 data to a Go byte slice
	var out []byte
	if lockBS.BitstreamSize > 0 && lockBS.DataPtr != 0 {
		out = make([]byte, lockBS.BitstreamSize)
		copy(out, unsafe.Slice((*byte)(unsafe.Pointer(lockBS.DataPtr)), lockBS.BitstreamSize))
	}

	syscall.SyscallN(e.funcs.UnlockBitstream, e.encoder, e.bitstreamBuf)

	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

// =============================================================================
// Shutdown
// =============================================================================

func (e *nvencEncoder) shutdown() {
	if !e.inited {
		return
	}
	if e.registeredRes != 0 {
		e.unregisterResource()
	}
	if e.bitstreamBuf != 0 {
		syscall.SyscallN(e.funcs.DestroyBitstreamBuffer, e.encoder, e.bitstreamBuf)
		e.bitstreamBuf = 0
	}
	if e.encoder != 0 {
		syscall.SyscallN(e.funcs.DestroyEncoder, e.encoder)
		e.encoder = 0
	}
	e.inited = false
	e.lastTexture = 0
	slog.Info("NVENC encoder shut down")
}
