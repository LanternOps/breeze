//go:build windows

package desktop

import (
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// =============================================================================
// AMF Encoder — Direct AMD GPU encoding via amfrt64.dll
//
// Bypasses the MFT wrapper: loads the AMF runtime, creates an AMFContext bound
// to the D3D11 device, and encodes BGRA GPU textures directly to H264 NALUs
// via the VCE hardware encoder. No CPU readback, no VideoProcessorBlt.
//
// Includes stall detection + recovery: tracks consecutive nil outputs, attempts
// flush→reinit on stall, and marks permanently stalled after repeated failures
// so the capture loop can swap to OpenH264.
//
// Registered as a vendor-specific hardware factory for "amd".
// =============================================================================

var (
	amfDLL      = syscall.NewLazyDLL("amfrt64.dll")
	amfLoadOnce sync.Once
	amfLoadErr  error
)

func loadAMFDLL() error {
	amfLoadOnce.Do(func() {
		amfLoadErr = amfDLL.Load()
		if amfLoadErr != nil {
			slog.Debug("AMF not available", "error", amfLoadErr.Error())
		} else {
			slog.Info("AMF library loaded (amfrt64.dll)")
		}
	})
	return amfLoadErr
}

func init() {
	registerHardwareFactoryForVendor("amd", newAMFEncoder)
}

func newAMFEncoder(cfg EncoderConfig) (encoderBackend, error) {
	if cfg.Codec != CodecH264 {
		return nil, fmt.Errorf("amf: only H264 supported, got %s", cfg.Codec)
	}
	if err := loadAMFDLL(); err != nil {
		return nil, err
	}
	return &amfEncoder{cfg: cfg}, nil
}

// Stall detection thresholds
const (
	amfStallThreshold     = 8 // consecutive nil outputs before flush attempt
	amfMaxFlushRecoveries = 3 // flush+reinit cycles before permanent stall
	amfMinFlushInterval   = 1 * time.Second // must be < 3s startup stall guard
)

// amfEncoder implements encoderBackend using AMD's AMF hardware encoder.
type amfEncoder struct {
	mu          sync.Mutex
	cfg         EncoderConfig
	width       int
	height      int
	pixelFormat PixelFormat
	forceIDR    bool
	frameIdx    uint64

	// D3D11 device from the DXGI capturer
	d3d11Device uintptr
	d3d11Ctx    uintptr

	// AMF objects (COM-style vtable pointers)
	factory uintptr // AMFFactory*
	context uintptr // AMFContext*
	encoder uintptr // AMFComponent* (encoder)

	// Stall detection state
	consecutiveNilOutputs int
	lastFlushTime         time.Time
	flushRecoveryCount    int
	outputSinceFlush      bool
	permanentlyStalled    bool

	inited bool
}

// --- encoderBackend interface ---

func (e *amfEncoder) Name() string {
	if e.inited {
		return "amf-hardware"
	}
	return "amf"
}

func (e *amfEncoder) IsHardware() bool    { return true }
func (e *amfEncoder) IsPlaceholder() bool { return false }

func (e *amfEncoder) SetCodec(c Codec) error {
	if c != CodecH264 {
		return fmt.Errorf("%w: amf only supports H264, got %s", ErrInvalidCodec, c)
	}
	return nil
}

func (e *amfEncoder) SetQuality(_ QualityPreset) error { return nil }
func (e *amfEncoder) SetPixelFormat(pf PixelFormat)    { e.pixelFormat = pf }

func (e *amfEncoder) SetBitrate(bitrate int) error {
	if bitrate <= 0 {
		return ErrInvalidBitrate
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cfg.Bitrate = bitrate
	if e.inited && e.encoder != 0 {
		_ = amfSetPropInt64(e.encoder, amfPropTargetBitrate, int64(bitrate))
		_ = amfSetPropInt64(e.encoder, amfPropPeakBitrate, int64(bitrate*3/2))
	}
	return nil
}

func (e *amfEncoder) SetFPS(fps int) error {
	if fps <= 0 {
		return ErrInvalidFPS
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cfg.FPS = fps
	if e.inited && e.encoder != 0 {
		_ = amfSetPropRate(e.encoder, amfPropFrameRate, uint32(fps), 1)
	}
	return nil
}

func (e *amfEncoder) SetDimensions(w, h int) error {
	w = w &^ 1
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

func (e *amfEncoder) SetD3D11Device(device, context uintptr) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.inited && device != e.d3d11Device {
		e.shutdown()
	}
	e.d3d11Device = device
	e.d3d11Ctx = context
}

func (e *amfEncoder) SupportsGPUInput() bool {
	return e.d3d11Device != 0
}

// IsGPUOnly reports that AMF cannot accept CPU pixel data via Encode().
// Callers must use EncodeTexture() with a D3D11 texture, or swap to a
// CPU-capable encoder (OpenH264) before falling back to the CPU path.
func (e *amfEncoder) IsGPUOnly() bool {
	return true
}

func (e *amfEncoder) ForceKeyframe() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.forceIDR = true
	return nil
}

func (e *amfEncoder) Flush() error {
	return e.ForceKeyframe()
}

// --- optionalStallDetector interface ---

func (e *amfEncoder) IsPermanentlyStalled() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.permanentlyStalled
}

func (e *amfEncoder) AdvanceStallDetection() {
	e.mu.Lock()
	defer e.mu.Unlock()
	// Called from the capture loop during idle periods. If we have pending
	// nil outputs, check whether we should attempt recovery now.
	if e.consecutiveNilOutputs >= amfStallThreshold {
		e.attemptStallRecovery()
	}
}

func (e *amfEncoder) Encode(_ []byte) ([]byte, error) {
	return nil, fmt.Errorf("amf: CPU Encode not supported, use EncodeTexture")
}

func (e *amfEncoder) EncodeTexture(bgraTexture uintptr) ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.permanentlyStalled {
		return nil, nil
	}

	if !e.inited {
		if err := e.initialize(); err != nil {
			return nil, fmt.Errorf("amf init: %w", err)
		}
	}

	out, err := e.encodeFrame(bgraTexture)
	if err != nil {
		return nil, err
	}

	if out != nil {
		e.consecutiveNilOutputs = 0
		e.outputSinceFlush = true
		return out, nil
	}

	// No output — advance stall detection
	e.consecutiveNilOutputs++
	if e.consecutiveNilOutputs >= amfStallThreshold {
		e.attemptStallRecovery()
	}
	return nil, nil
}

func (e *amfEncoder) Close() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.shutdown()
	return nil
}

// =============================================================================
// Stall recovery
// =============================================================================

func (e *amfEncoder) attemptStallRecovery() {
	if e.permanentlyStalled {
		return
	}

	// Throttle flush attempts to prevent rapid loops
	if time.Since(e.lastFlushTime) < amfMinFlushInterval {
		return
	}
	e.lastFlushTime = time.Now()

	if !e.outputSinceFlush {
		e.flushRecoveryCount++
	} else {
		e.flushRecoveryCount = 0
	}
	e.outputSinceFlush = false

	if e.flushRecoveryCount >= amfMaxFlushRecoveries {
		slog.Warn("AMF encoder permanently stalled — flush recovery exhausted",
			"flushCycles", e.flushRecoveryCount,
			"consecutiveNilOutputs", e.consecutiveNilOutputs)
		e.permanentlyStalled = true
		return
	}

	slog.Warn("AMF encoder stall detected, attempting flush+reinit recovery",
		"consecutiveNilOutputs", e.consecutiveNilOutputs,
		"flushCycle", e.flushRecoveryCount+1)

	// Try 1: Flush the encoder pipeline
	if e.encoder != 0 {
		amfCall(e.encoder, amfCompFlush)
		// Try to drain any stuck output
		for i := 0; i < 5; i++ {
			var data uintptr
			r := amfCall(e.encoder, amfCompQueryOutput, uintptr(unsafe.Pointer(&data)))
			if r == amfOK && data != 0 {
				amfReleaseObj(data)
				slog.Info("AMF flush produced output — recovery may succeed")
				e.consecutiveNilOutputs = 0
				e.outputSinceFlush = true
				return
			}
			if r != amfRepeat && r != amfOK {
				break
			}
		}
	}

	// Try 2: Full reinit — destroy and recreate the encoder component
	slog.Info("AMF flush produced no output, attempting full reinit")
	e.reinitEncoder()
	e.consecutiveNilOutputs = 0
	e.forceIDR = true // next frame must be IDR after reinit
}

func (e *amfEncoder) reinitEncoder() {
	// Tear down encoder component only (keep context + factory)
	if e.encoder != 0 {
		amfCall(e.encoder, amfCompDrain)
		amfCall(e.encoder, amfCompTerminate)
		amfReleaseObj(e.encoder)
		e.encoder = 0
	}

	// Recreate encoder component
	encoderID, _ := syscall.UTF16PtrFromString(amfEncoderAVC)
	var enc uintptr
	r := amfCall(e.factory, amfFactoryCreateComponent,
		e.context,
		uintptr(unsafe.Pointer(encoderID)),
		uintptr(unsafe.Pointer(&enc)),
	)
	runtime.KeepAlive(encoderID)
	if r != amfOK || enc == 0 {
		slog.Error("AMF reinit: CreateComponent failed", "error", amfResultStr(r))
		e.permanentlyStalled = true
		return
	}
	e.encoder = enc

	// Reconfigure with current settings
	e.configureEncoder()

	r = amfCall(e.encoder, amfCompInit,
		uintptr(amfSurfaceBGRA),
		uintptr(int32(e.width)),
		uintptr(int32(e.height)),
	)
	if r != amfOK {
		slog.Error("AMF reinit: Init failed", "error", amfResultStr(r))
		amfReleaseObj(e.encoder)
		e.encoder = 0
		e.permanentlyStalled = true
		return
	}

	e.frameIdx = 0
	slog.Info("AMF encoder reinitialized after stall recovery",
		"width", e.width, "height", e.height)
}

// =============================================================================
// Initialization
// =============================================================================

func (e *amfEncoder) initialize() error {
	if e.d3d11Device == 0 {
		return fmt.Errorf("no D3D11 device — call SetD3D11Device first")
	}
	if e.width == 0 || e.height == 0 {
		return fmt.Errorf("dimensions not set — call SetDimensions first")
	}

	// Step 1: Get AMFFactory via AMFInit
	amfInitProc := amfDLL.NewProc("AMFInit")
	var factory uintptr
	r, _, _ := amfInitProc.Call(
		uintptr(amfVersion14),
		uintptr(unsafe.Pointer(&factory)),
	)
	if r != amfOK || factory == 0 {
		return fmt.Errorf("AMFInit failed: %s (0x%X)", amfResultStr(r), r)
	}
	e.factory = factory

	// Step 2: Create AMFContext
	var ctx uintptr
	r = amfCall(e.factory, amfFactoryCreateContext, uintptr(unsafe.Pointer(&ctx)))
	if r != amfOK || ctx == 0 {
		return fmt.Errorf("AMFFactory::CreateContext failed: %s", amfResultStr(r))
	}
	e.context = ctx

	// Step 3: Initialize context with D3D11 device
	r = amfCall(e.context, amfCtxInitDX11, e.d3d11Device, uintptr(amfDX11_0))
	if r != amfOK {
		amfReleaseObj(e.context)
		e.context = 0
		return fmt.Errorf("AMFContext::InitDX11 failed: %s", amfResultStr(r))
	}

	// Step 4: Create H264 encoder component
	encoderID, _ := syscall.UTF16PtrFromString(amfEncoderAVC)
	var enc uintptr
	r = amfCall(e.factory, amfFactoryCreateComponent,
		e.context,
		uintptr(unsafe.Pointer(encoderID)),
		uintptr(unsafe.Pointer(&enc)),
	)
	runtime.KeepAlive(encoderID)
	if r != amfOK || enc == 0 {
		amfReleaseObj(e.context)
		e.context = 0
		return fmt.Errorf("AMFFactory::CreateComponent(AVC) failed: %s", amfResultStr(r))
	}
	e.encoder = enc

	// Step 5: Configure encoder
	e.configureEncoder()

	// Step 6: Initialize encoder with BGRA surface format
	r = amfCall(e.encoder, amfCompInit,
		uintptr(amfSurfaceBGRA),
		uintptr(int32(e.width)),
		uintptr(int32(e.height)),
	)
	if r != amfOK {
		amfReleaseObj(e.encoder)
		amfReleaseObj(e.context)
		e.encoder = 0
		e.context = 0
		return fmt.Errorf("AMFComponent::Init(BGRA, %dx%d) failed: %s", e.width, e.height, amfResultStr(r))
	}

	e.inited = true
	e.frameIdx = 0
	e.consecutiveNilOutputs = 0
	e.flushRecoveryCount = 0
	e.outputSinceFlush = false
	e.permanentlyStalled = false

	fps := e.cfg.FPS
	if fps <= 0 {
		fps = 30
	}
	slog.Info("AMF encoder initialized",
		"width", e.width, "height", e.height,
		"bitrate", e.cfg.Bitrate, "fps", fps,
		"usage", "low-latency", "rc", "latency-constrained-vbr",
	)
	return nil
}

// configureEncoder sets encoder properties. Called during init and reinit.
func (e *amfEncoder) configureEncoder() {
	fps := e.cfg.FPS
	if fps <= 0 {
		fps = 30
	}
	bitrate := e.cfg.Bitrate
	if bitrate <= 0 {
		bitrate = 2_500_000
	}

	idrPeriod := int64(fps * 10)
	if idrPeriod < 30 {
		idrPeriod = 30
	}

	// Static properties (before Init)
	// Use LOW_LATENCY instead of ULTRA_LOW_LATENCY — ULL on Polaris (RX 590)
	// can cause VCE internal buffer underruns that manifest as stalls.
	amfSetPropInt64(e.encoder, amfPropUsage, int64(amfUsageLowLatency))
	amfSetPropInt64(e.encoder, amfPropProfile, int64(amfProfileHigh))
	amfSetPropInt64(e.encoder, amfPropQualityPreset, int64(amfQualitySpeed))

	// Latency-constrained VBR: allows VCE to vary bitrate within latency
	// bounds, reducing internal buffer pressure vs strict CBR.
	amfSetPropInt64(e.encoder, amfPropRateControl, int64(amfRCLatencyVBR))
	amfSetPropBool(e.encoder, amfPropLowLatency, true)

	// Dynamic properties
	amfSetPropInt64(e.encoder, amfPropTargetBitrate, int64(bitrate))
	amfSetPropInt64(e.encoder, amfPropPeakBitrate, int64(bitrate*3/2))
	amfSetPropRate(e.encoder, amfPropFrameRate, uint32(fps), 1)
	amfSetPropInt64(e.encoder, amfPropIDRPeriod, idrPeriod)
	amfSetPropInt64(e.encoder, amfPropBPicPattern, 0)
	amfSetPropInt64(e.encoder, amfPropSlicesPerFrame, 1)

	// Filler data off — reduces unnecessary bitstream padding that can
	// contribute to VCE buffer pressure on older Polaris hardware.
	amfSetPropBool(e.encoder, amfPropFillerData, false)
	amfSetPropBool(e.encoder, amfPropEnforceHRD, false)
}

// =============================================================================
// Per-frame encoding
// =============================================================================

func (e *amfEncoder) encodeFrame(bgraTexture uintptr) ([]byte, error) {
	// Create an AMFSurface wrapping the DX11 texture
	var surface uintptr
	r := amfCall(e.context, amfCtxCreateSurfFromDX11,
		bgraTexture,
		uintptr(unsafe.Pointer(&surface)),
		0, // observer = nil
	)
	if r != amfOK || surface == 0 {
		return nil, fmt.Errorf("CreateSurfaceFromDX11Native failed: %s", amfResultStr(r))
	}

	// Set per-frame properties on the surface
	if e.forceIDR || e.frameIdx == 0 {
		amfSetPropInt64(surface, amfPropForcePicType, int64(amfPicTypeIDR))
		amfSetPropBool(surface, amfPropInsertSPS, true)
		amfSetPropBool(surface, amfPropInsertPPS, true)
		e.forceIDR = false
	}

	// Set presentation timestamp (100ns units — AMF convention)
	pts := int64(e.frameIdx) * 10_000_000 / int64(e.cfg.FPS)
	if e.cfg.FPS <= 0 {
		pts = int64(e.frameIdx) * 333_333
	}
	amfCall(surface, amfDataSetPts, uintptr(pts))

	e.frameIdx++

	// Submit input — retry if encoder queue is full
	for retries := 0; retries < 5; retries++ {
		r = amfCall(e.encoder, amfCompSubmitInput, surface)
		if r == amfOK {
			break
		}
		if r == amfInputFull {
			e.drainOutput()
			continue
		}
		amfReleaseObj(surface)
		return nil, fmt.Errorf("AMF SubmitInput failed: %s", amfResultStr(r))
	}
	amfReleaseObj(surface)

	if r != amfOK {
		return nil, fmt.Errorf("AMF SubmitInput failed after retries: %s", amfResultStr(r))
	}

	// Query output — poll with real delays to give VCE hardware time to encode.
	// At 2560x1440, the hardware encoder may need 2-5ms to produce a frame.
	// Total budget: ~20ms (acceptable for 30-60fps streaming).
	for retries := 0; retries < 20; retries++ {
		var data uintptr
		r = amfCall(e.encoder, amfCompQueryOutput, uintptr(unsafe.Pointer(&data)))
		if r == amfOK && data != 0 {
			out := e.readBitstream(data)
			amfReleaseObj(data)
			return out, nil
		}
		if r == amfRepeat || r == amfOK {
			// Give the hardware encoder real time to complete
			time.Sleep(1 * time.Millisecond)
			continue
		}
		if r == amfEOF {
			return nil, nil
		}
		return nil, fmt.Errorf("AMF QueryOutput failed: %s", amfResultStr(r))
	}
	return nil, nil // no output after 20ms — stall detection handles this
}

func (e *amfEncoder) readBitstream(data uintptr) []byte {
	size := amfCall(data, amfBufGetSize)
	if size == 0 {
		return nil
	}
	ptr := amfCall(data, amfBufGetNative)
	if ptr == 0 {
		return nil
	}
	out := make([]byte, size)
	copy(out, unsafe.Slice((*byte)(unsafe.Pointer(ptr)), size))
	return out
}

func (e *amfEncoder) drainOutput() {
	var data uintptr
	r := amfCall(e.encoder, amfCompQueryOutput, uintptr(unsafe.Pointer(&data)))
	if r == amfOK && data != 0 {
		amfReleaseObj(data)
	}
}

// =============================================================================
// Shutdown
// =============================================================================

func (e *amfEncoder) shutdown() {
	if !e.inited {
		return
	}
	if e.encoder != 0 {
		amfCall(e.encoder, amfCompDrain)
		amfCall(e.encoder, amfCompTerminate)
		amfReleaseObj(e.encoder)
		e.encoder = 0
	}
	if e.context != 0 {
		amfCall(e.context, amfCtxTerminate)
		amfReleaseObj(e.context)
		e.context = 0
	}
	e.factory = 0
	e.inited = false
	slog.Info("AMF encoder shut down")
}
