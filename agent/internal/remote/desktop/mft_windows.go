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

// vbvSizeForBitrate returns the VBV buffer size (in bits) for a given bitrate,
// targeting 500ms of headroom (bitrate / 2). The floor of 500K bits ensures
// I-frames remain viable even at MinBitrate (500 Kbps), where the 500ms
// ratio would yield only 250K — too small for a 1080p keyframe.
func vbvSizeForBitrate(bitrate int) uint32 {
	vbvSize := uint32(bitrate / 2)
	if vbvSize < 500000 {
		vbvSize = 500000
	}
	return vbvSize
}

// mftEncoder implements encoderBackend using Windows Media Foundation Transform.
// It discovers and uses hardware H264 encoders (NVENC, QuickSync, AMD VCE)
// via the MFT enumeration API, falling back to the software H264 MFT.
type mftEncoder struct {
	mu sync.Mutex

	cfg    EncoderConfig
	width  int
	height int
	stride int

	// COM handles (persistent across frames)
	transform       uintptr // IMFTransform
	codecAPI        uintptr // ICodecAPI (for dynamic bitrate), may be 0
	inited          bool
	isHW            bool
	providesSamples bool // MFT allocates its own output samples
	outputBufSize   int  // required output buffer size from GetOutputStreamInfo

	// Frame timing
	frameIdx  uint64
	startTime time.Time

	// Thread affinity
	threadLocked bool

	// Pixel format of incoming frames
	pixelFormat PixelFormat

	// GPU zero-copy pipeline
	d3d11Device    uintptr // ID3D11Device (from capturer, not owned)
	d3d11Context   uintptr // ID3D11DeviceContext (from capturer, not owned)
	gpuConv        *gpuConverter
	gpuFrameCount  uint64 // frames since gpuConv was (re)created, for diagnostic logging
	dxgiManager    uintptr // IMFDXGIDeviceManager
	dxgiResetToken uint32
	gpuEnabled     bool
	gpuFailed      bool // permanently disabled after init failure

	// Keyframe forcing: set when we want the next output to be an IDR.
	forceKeyframePending bool

	// Diagnostic: consecutive Encode() calls that returned nil (MFT buffering).
	consecutiveNilOutputs int
	// lastStallFlush prevents rapid flush loops when the MFT is fundamentally
	// broken (not just warming up). Minimum 5s between stall-triggered flushes.
	lastStallFlush time.Time
}

func init() {
	registerHardwareFactory(newMFTEncoder)
}

func newMFTEncoder(cfg EncoderConfig) (encoderBackend, error) {
	if cfg.Codec != CodecH264 {
		return nil, fmt.Errorf("MFT encoder only supports H264, got %s", cfg.Codec)
	}
	// Probe for hardware MFTs at creation time so the factory fails fast
	// when no GPU encoder is available. This lets newBackend() fall through
	// to OpenH264 instead of returning a struct that fails lazily on Encode().
	if !probeHardwareMFT() {
		return nil, fmt.Errorf("no hardware H264 MFT available")
	}
	return &mftEncoder{
		cfg:       cfg,
		startTime: time.Now(),
	}, nil
}

// probeHardwareMFT checks if a hardware H264 encoder MFT exists without
// fully initializing it. Returns false on headless servers / basic GPUs
// (e.g. Matrox G200) that lack hardware H264 encoding.
func probeHardwareMFT() bool {
	// COM init (best-effort, may already be initialized)
	hr, _, _ := procCoInitializeEx.Call(0, coinitMultithreaded)
	if int32(hr) < 0 && uint32(hr) != 0x80010106 {
		return false
	}
	procMFStartup.Call(mfVersion, mfStartupFull)

	inputType := mftRegisterTypeInfo{mfMediaTypeVideo, mfVideoFormatNV12}
	outputType := mftRegisterTypeInfo{mfMediaTypeVideo, mfVideoFormatH264}

	var ppActivate uintptr
	var count uint32
	hr, _, _ = procMFTEnumEx.Call(
		uintptr(unsafe.Pointer(&mftCategoryVideoEncoder)),
		uintptr(mftEnumFlagHardware|mftEnumFlagSortAndFilter),
		uintptr(unsafe.Pointer(&inputType)),
		uintptr(unsafe.Pointer(&outputType)),
		uintptr(unsafe.Pointer(&ppActivate)),
		uintptr(unsafe.Pointer(&count)),
	)
	if int32(hr) < 0 || count == 0 {
		return false
	}
	// Release all IMFActivate objects and free the array
	activateArray := unsafe.Slice((*uintptr)(unsafe.Pointer(ppActivate)), count)
	for _, a := range activateArray {
		comRelease(a)
	}
	procCoTaskMemFree.Call(ppActivate)
	return true
}

// initialize sets up COM, finds an MFT H264 encoder, and configures it.
// Called lazily on the first Encode with known dimensions.
func (m *mftEncoder) initialize(width, height, stride int) error {
	// Lock this goroutine to an OS thread for COM thread affinity
	if !m.threadLocked {
		runtime.LockOSThread()
		m.threadLocked = true
	}

	// COM init
	hr, _, _ := procCoInitializeEx.Call(0, coinitMultithreaded)
	if int32(hr) < 0 && uint32(hr) != 0x80010106 { // ignore RPC_E_CHANGED_MODE
		return fmt.Errorf("CoInitializeEx failed: 0x%08X", uint32(hr))
	}

	// MFStartup
	hr, _, _ = procMFStartup.Call(mfVersion, mfStartupFull)
	if int32(hr) < 0 {
		return fmt.Errorf("MFStartup failed: 0x%08X", uint32(hr))
	}

	// Find H264 encoder — try hardware first
	transform, isHW, err := m.findEncoder(width, height)
	if err != nil {
		procMFShutdown.Call()
		return fmt.Errorf("no H264 encoder found: %w", err)
	}

	// Hardware MFTs are async and must be unlocked before configuration.
	// Without this, SetOutputType/SetInputType return MF_E_TRANSFORM_ASYNC_LOCKED.
	if isHW {
		if err := m.unlockAsyncMFT(transform); err != nil {
			slog.Warn("Failed to unlock async MFT, falling back to software", "error", err.Error())
			comRelease(transform)
			transform, err = m.enumAndActivate(
				mftEnumFlagSyncMFT|mftEnumFlagSortAndFilter,
				&mftRegisterTypeInfo{mfMediaTypeVideo, mfVideoFormatNV12},
				&mftRegisterTypeInfo{mfMediaTypeVideo, mfVideoFormatH264},
			)
			if err != nil {
				procMFShutdown.Call()
				return fmt.Errorf("software MFT fallback after async unlock failure: %w", err)
			}
			isHW = false
		}
	}

	// Configure output type (H264) — must be set BEFORE input
	if err := m.setOutputType(transform, width, height); err != nil {
		comRelease(transform)
		procMFShutdown.Call()
		return fmt.Errorf("set output type: %w", err)
	}

	// Configure input type (NV12)
	if err := m.setInputType(transform, width, height); err != nil {
		// Hardware encoder may reject this format — fall back to software MFT
		if isHW {
			comRelease(transform)
			slog.Warn("Hardware MFT rejected input type, falling back to software", "error", err.Error())
			transform, err = m.enumAndActivate(mftEnumFlagSyncMFT|mftEnumFlagSortAndFilter, &mftRegisterTypeInfo{mfMediaTypeVideo, mfVideoFormatNV12}, &mftRegisterTypeInfo{mfMediaTypeVideo, mfVideoFormatH264})
			if err != nil {
				procMFShutdown.Call()
				return fmt.Errorf("software MFT fallback failed: %w", err)
			}
			isHW = false
			if err := m.setOutputType(transform, width, height); err != nil {
				comRelease(transform)
				procMFShutdown.Call()
				return fmt.Errorf("set output type (software fallback): %w", err)
			}
			if err := m.setInputType(transform, width, height); err != nil {
				comRelease(transform)
				procMFShutdown.Call()
				return fmt.Errorf("set input type (software fallback): %w", err)
			}
		} else {
			comRelease(transform)
			procMFShutdown.Call()
			return fmt.Errorf("set input type: %w", err)
		}
	}

	// Enable low-latency mode
	m.setLowLatency(transform)

	// Begin streaming
	if _, err := comCall(transform, vtblProcessMessage, mftMessageNotifyBeginStreaming, 0); err != nil {
		slog.Warn("MFT BeginStreaming failed (non-fatal)", "error", err.Error())
	}
	if _, err := comCall(transform, vtblProcessMessage, mftMessageNotifyStartOfStream, 0); err != nil {
		slog.Warn("MFT StartOfStream failed (non-fatal)", "error", err.Error())
	}

	m.transform = transform
	m.width = width
	m.height = height
	m.stride = stride
	m.isHW = isHW
	m.inited = true

	// Query output stream info for buffer requirements and sample allocation
	var streamInfo mftOutputStreamInfo
	hr, _, _ = syscall.SyscallN(
		m.vtblFn(vtblGetOutputStreamInfo),
		m.transform,
		0, // stream ID
		uintptr(unsafe.Pointer(&streamInfo)),
	)
	if int32(hr) >= 0 {
		m.providesSamples = (streamInfo.dwFlags & mftOutputStreamProvidesSamples) != 0
		m.outputBufSize = int(streamInfo.cbSize)
	}
	// Ensure we have a reasonable minimum buffer size
	if m.outputBufSize <= 0 {
		// Default: uncompressed frame size (generous for H264 output)
		m.outputBufSize = width * height * 3 / 2
	}

	// Acquire ICodecAPI for dynamic bitrate control.
	// QueryInterface on the transform for IID_ICodecAPI.
	var codecAPI uintptr
	_, qiErr := comCall(m.transform, vtblQueryInterface,
		uintptr(unsafe.Pointer(&iidICodecAPI)),
		uintptr(unsafe.Pointer(&codecAPI)),
	)
	if qiErr == nil && codecAPI != 0 {
		m.codecAPI = codecAPI

		// Set GOP size (keyframe interval) = 3 seconds at configured FPS.
		// Longer GOPs reduce the frequency of large I-frames that cause
		// visible quality dips under CBR rate control. WebRTC PLI/FIR
		// handles on-demand keyframe recovery for packet loss cases.
		cfgFPS := m.cfg.FPS
		if cfgFPS <= 0 {
			cfgFPS = 30
		}
		gopSize := uint32(cfgFPS * 3)
		if gopSize < 30 {
			gopSize = 30
		}
		gv := comVariant{vt: vtUI4, val: uint64(gopSize)}
		if _, err := comCall(codecAPI, vtblCodecAPISetValue,
			uintptr(unsafe.Pointer(&codecAPIAVEncMPVGOPSize)),
			uintptr(unsafe.Pointer(&gv)),
		); err != nil {
			slog.Debug("ICodecAPI SetValue(GOPSize) failed (non-fatal)", "gopSize", gopSize, "error", err.Error())
		} else {
			slog.Debug("GOP size set via ICodecAPI", "gopSize", gopSize)
		}

		// Zero-latency configuration: eliminate encoder frame buffering.
		// Screen sharing is real-time — every frame in should produce a frame
		// out immediately. Buffering only adds lag.

		// 1. Disable B-frames: B-frames require future reference frames,
		//    adding 1+ frame of reordering latency.
		bv := comVariant{vt: vtUI4, val: 0}
		if _, err := comCall(codecAPI, vtblCodecAPISetValue,
			uintptr(unsafe.Pointer(&codecAPIAVEncMPVDefaultBPictureCount)),
			uintptr(unsafe.Pointer(&bv)),
		); err != nil {
			slog.Debug("ICodecAPI SetValue(BPictureCount=0) failed (non-fatal)", "error", err.Error())
		}

		// 2. Quality-based VBR rate control. CBR on Windows 8+ buffers frames
		//    internally for bitrate smoothing, causing multi-second stalls where
		//    ProcessInput succeeds but ProcessOutput returns nothing. Quality VBR
		//    optimizes for consistent quality per frame, producing output
		//    immediately without internal buffering. This is critical on Windows
		//    Server where the software MFT is unsupported and stall-prone.
		rv := comVariant{vt: vtUI4, val: uint64(eAVEncCommonRateControlMode_Quality)}
		if _, err := comCall(codecAPI, vtblCodecAPISetValue,
			uintptr(unsafe.Pointer(&codecAPIAVEncCommonRateControlMode)),
			uintptr(unsafe.Pointer(&rv)),
		); err != nil {
			slog.Debug("ICodecAPI SetValue(RateControl=Quality) failed, trying CBR", "error", err.Error())
			// Fall back to CBR if Quality mode isn't supported
			rv.val = uint64(eAVEncCommonRateControlMode_CBR)
			if _, cbrErr := comCall(codecAPI, vtblCodecAPISetValue,
				uintptr(unsafe.Pointer(&codecAPIAVEncCommonRateControlMode)),
				uintptr(unsafe.Pointer(&rv)),
			); cbrErr != nil {
				slog.Warn("CBR rate control also failed — encoder has no rate control configured", "error", cbrErr.Error())
			}
			// CBR needs a VBV buffer
			vbvSize := vbvSizeForBitrate(m.cfg.Bitrate)
			vbv := comVariant{vt: vtUI4, val: uint64(vbvSize)}
			if _, vbvErr := comCall(codecAPI, vtblCodecAPISetValue,
				uintptr(unsafe.Pointer(&codecAPIAVEncCommonBufferSize)),
				uintptr(unsafe.Pointer(&vbv)),
			); vbvErr != nil {
				slog.Warn("VBV buffer configuration failed", "error", vbvErr.Error())
			}
		} else {
			// Quality VBR: set QP target (24 = good balance for screen content)
			qp := comVariant{vt: vtUI4, val: 24}
			comCall(codecAPI, vtblCodecAPISetValue,
				uintptr(unsafe.Pointer(&codecAPIAVEncVideoEncodeQP)),
				uintptr(unsafe.Pointer(&qp)),
			)
		}

		// 3. CODECAPI_AVLowLatencyMode: forces single-frame encoding mode.
		//    MF_LOW_LATENCY (set via IMFAttributes) is a different property
		//    that controls pipeline delay. CODECAPI_AVLowLatencyMode controls
		//    whether the encoder uses multi-frame or single-frame mode.
		//    VT_BOOL: VARIANT_TRUE = -1
		llv := comVariant{vt: vtBool, val: uint64(0xFFFF)} // VARIANT_TRUE
		if _, err := comCall(codecAPI, vtblCodecAPISetValue,
			uintptr(unsafe.Pointer(&codecAPIAVLowLatencyMode)),
			uintptr(unsafe.Pointer(&llv)),
		); err != nil {
			slog.Debug("ICodecAPI SetValue(AVLowLatencyMode) failed (non-fatal)", "error", err.Error())
		}

		// 4. Quality vs speed: 0 = fastest encoding, minimize per-frame latency.
		//    Higher values (up to 100) favor quality over speed.
		qvs := comVariant{vt: vtUI4, val: 0}
		if _, err := comCall(codecAPI, vtblCodecAPISetValue,
			uintptr(unsafe.Pointer(&codecAPIAVEncCommonQualityVsSpeed)),
			uintptr(unsafe.Pointer(&qvs)),
		); err != nil {
			slog.Debug("ICodecAPI SetValue(QualityVsSpeed=0) failed (non-fatal)", "error", err.Error())
		}
	} else {
		slog.Debug("ICodecAPI not available on this MFT (dynamic bitrate disabled)", "error", fmt.Sprintf("%v", qiErr))
	}

	// If streaming requested a keyframe before init, apply now (best-effort).
	if m.forceKeyframePending {
		_ = m.forceKeyframeLocked()
	}

	// NOTE: We no longer set up the DXGI device manager on the MFT.
	// The GPU pipeline uses VideoProcessorBlt for BGRA→NV12 on the GPU,
	// then reads back NV12 to CPU and feeds it as a regular memory buffer.
	// This avoids DXGI surface buffer compatibility issues with hardware MFTs.

	hwStr := "software"
	if isHW {
		hwStr = "hardware"
	}
	slog.Info("MFT H264 encoder initialized",
		"type", hwStr,
		"width", width,
		"height", height,
		"bitrate", m.cfg.Bitrate,
		"fps", m.cfg.FPS,
		"rateControl", "quality-vbr",
		"providesSamples", m.providesSamples,
		"outputBufSize", m.outputBufSize,
		"hasCodecAPI", m.codecAPI != 0,
		"gpuPipeline", m.gpuEnabled,
	)
	return nil
}

// findEncoder enumerates MFT encoders, trying hardware first.
func (m *mftEncoder) findEncoder(width, height int) (uintptr, bool, error) {
	inputType := mftRegisterTypeInfo{
		guidMajorType: mfMediaTypeVideo,
		guidSubtype:   mfVideoFormatNV12,
	}
	outputType := mftRegisterTypeInfo{
		guidMajorType: mfMediaTypeVideo,
		guidSubtype:   mfVideoFormatH264,
	}

	// Hardware only — software H264 encoding is handled by OpenH264 which
	// provides deterministic 1-in-1-out encoding. The Windows software MFT
	// stalls for 20-60 frames on Server editions and is not officially
	// supported (Microsoft docs: "Minimum supported server: None supported").
	transform, err := m.enumAndActivate(
		mftEnumFlagHardware|mftEnumFlagSortAndFilter,
		&inputType, &outputType,
	)
	if err == nil {
		return transform, true, nil
	}

	return 0, false, fmt.Errorf("no hardware H264 encoder available (software encoding handled by OpenH264)")
}

func (m *mftEncoder) enumAndActivate(flags uint32, inputType, outputType *mftRegisterTypeInfo) (uintptr, error) {
	var ppActivate uintptr
	var count uint32

	hr, _, _ := procMFTEnumEx.Call(
		uintptr(unsafe.Pointer(&mftCategoryVideoEncoder)),
		uintptr(flags),
		uintptr(unsafe.Pointer(inputType)),
		uintptr(unsafe.Pointer(outputType)),
		uintptr(unsafe.Pointer(&ppActivate)),
		uintptr(unsafe.Pointer(&count)),
	)
	if int32(hr) < 0 || count == 0 {
		return 0, fmt.Errorf("MFTEnumEx found 0 encoders (flags=0x%X)", flags)
	}

	// ppActivate is a pointer to an array of IMFActivate pointers
	// Get the first one
	activatePtr := *(*uintptr)(unsafe.Pointer(ppActivate))

	// ActivateObject(IID_IMFTransform, &transform)
	var transform uintptr
	_, err := comCall(activatePtr, vtblActivateObject,
		uintptr(unsafe.Pointer(&iidIMFTransform)),
		uintptr(unsafe.Pointer(&transform)),
	)

	// Release all IMFActivate objects and free the array
	activateArray := unsafe.Slice((*uintptr)(unsafe.Pointer(ppActivate)), count)
	for _, a := range activateArray {
		comRelease(a)
	}
	procCoTaskMemFree.Call(ppActivate)

	if err != nil {
		return 0, fmt.Errorf("ActivateObject failed: %w", err)
	}
	return transform, nil
}

func (m *mftEncoder) setOutputType(transform uintptr, width, height int) error {
	var mediaType uintptr
	hr, _, _ := procMFCreateMediaType.Call(uintptr(unsafe.Pointer(&mediaType)))
	if int32(hr) < 0 {
		return fmt.Errorf("MFCreateMediaType failed: 0x%08X", uint32(hr))
	}
	defer comRelease(mediaType)

	// Major type = Video
	if _, err := comCall(mediaType, vtblSetGUID,
		uintptr(unsafe.Pointer(&mfMTMajorType)),
		uintptr(unsafe.Pointer(&mfMediaTypeVideo)),
	); err != nil {
		return err
	}

	// Subtype = H264
	if _, err := comCall(mediaType, vtblSetGUID,
		uintptr(unsafe.Pointer(&mfMTSubtype)),
		uintptr(unsafe.Pointer(&mfVideoFormatH264)),
	); err != nil {
		return err
	}

	// Bitrate
	if _, err := comCall(mediaType, vtblSetUINT32,
		uintptr(unsafe.Pointer(&mfMTAvgBitrate)),
		uintptr(uint32(m.cfg.Bitrate)),
	); err != nil {
		return err
	}

	// Interlace mode = progressive
	if _, err := comCall(mediaType, vtblSetUINT32,
		uintptr(unsafe.Pointer(&mfMTInterlaceMode)),
		uintptr(uint32(mfVideoInterlaceProgressive)),
	); err != nil {
		return err
	}

	// Frame size
	frameSize := pack64(uint32(width), uint32(height))
	if _, err := comCall(mediaType, vtblSetUINT64,
		uintptr(unsafe.Pointer(&mfMTFrameSize)),
		uintptr(frameSize),
	); err != nil {
		return err
	}

	// Frame rate
	fps := m.cfg.FPS
	if fps <= 0 {
		fps = 30
	}
	frameRate := pack64(uint32(fps), 1)
	if _, err := comCall(mediaType, vtblSetUINT64,
		uintptr(unsafe.Pointer(&mfMTFrameRate)),
		uintptr(frameRate),
	); err != nil {
		return err
	}

	// H264 profile = Main (CABAC entropy coding = 10-15% better compression than
	// Baseline's CAVLC, critical for text clarity in screen sharing).
	// No B-frames needed — Main profile without B-frames still enables CABAC.
	if _, err := comCall(mediaType, vtblSetUINT32,
		uintptr(unsafe.Pointer(&mfMTMpeg2Profile)),
		uintptr(eAVEncH264VProfileMain),
	); err != nil {
		// Non-fatal: encoder will use default profile
		slog.Debug("Failed to set Main profile", "error", err.Error())
	}

	// Pixel aspect ratio = 1:1
	par := pack64(1, 1)
	if _, err := comCall(mediaType, vtblSetUINT64,
		uintptr(unsafe.Pointer(&mfMTPixelAspectRatio)),
		uintptr(par),
	); err != nil {
		return err
	}

	// Set on transform
	if _, err := comCall(transform, vtblSetOutputType,
		0, // stream ID
		mediaType,
		0, // flags
	); err != nil {
		return fmt.Errorf("SetOutputType: %w", err)
	}

	return nil
}

func (m *mftEncoder) setInputType(transform uintptr, width, height int) error {
	var mediaType uintptr
	hr, _, _ := procMFCreateMediaType.Call(uintptr(unsafe.Pointer(&mediaType)))
	if int32(hr) < 0 {
		return fmt.Errorf("MFCreateMediaType failed: 0x%08X", uint32(hr))
	}
	defer comRelease(mediaType)

	// Major type = Video
	if _, err := comCall(mediaType, vtblSetGUID,
		uintptr(unsafe.Pointer(&mfMTMajorType)),
		uintptr(unsafe.Pointer(&mfMediaTypeVideo)),
	); err != nil {
		return err
	}

	// Subtype = NV12
	if _, err := comCall(mediaType, vtblSetGUID,
		uintptr(unsafe.Pointer(&mfMTSubtype)),
		uintptr(unsafe.Pointer(&mfVideoFormatNV12)),
	); err != nil {
		return err
	}

	// Interlace = progressive
	if _, err := comCall(mediaType, vtblSetUINT32,
		uintptr(unsafe.Pointer(&mfMTInterlaceMode)),
		uintptr(uint32(mfVideoInterlaceProgressive)),
	); err != nil {
		return err
	}

	// Frame size
	frameSize := pack64(uint32(width), uint32(height))
	if _, err := comCall(mediaType, vtblSetUINT64,
		uintptr(unsafe.Pointer(&mfMTFrameSize)),
		uintptr(frameSize),
	); err != nil {
		return err
	}

	// Frame rate
	fps := m.cfg.FPS
	if fps <= 0 {
		fps = 30
	}
	frameRate := pack64(uint32(fps), 1)
	if _, err := comCall(mediaType, vtblSetUINT64,
		uintptr(unsafe.Pointer(&mfMTFrameRate)),
		uintptr(frameRate),
	); err != nil {
		return err
	}

	// Pixel aspect ratio
	par := pack64(1, 1)
	if _, err := comCall(mediaType, vtblSetUINT64,
		uintptr(unsafe.Pointer(&mfMTPixelAspectRatio)),
		uintptr(par),
	); err != nil {
		return err
	}

	// Default stride (NV12 Y plane stride = width).
	// Required by some hardware MFT encoders.
	if _, err := comCall(mediaType, vtblSetUINT32,
		uintptr(unsafe.Pointer(&mfMTDefaultStride)),
		uintptr(uint32(width)),
	); err != nil {
		return err
	}

	// Set on transform
	if _, err := comCall(transform, vtblSetInputType,
		0, // stream ID
		mediaType,
		0, // flags
	); err != nil {
		return fmt.Errorf("SetInputType: %w", err)
	}

	return nil
}

func (m *mftEncoder) setLowLatency(transform uintptr) {
	var attrs uintptr
	_, err := comCall(transform, vtblGetAttributes, uintptr(unsafe.Pointer(&attrs)))
	if err != nil || attrs == 0 {
		slog.Warn("MFT GetAttributes failed, cannot set low-latency", "error", fmt.Sprintf("%v", err))
		return
	}
	defer comRelease(attrs)
	_, err = comCall(attrs, vtblSetUINT32,
		uintptr(unsafe.Pointer(&mfLowLatency)),
		uintptr(uint32(1)),
	)
	if err != nil {
		slog.Warn("Failed to set MF_LOW_LATENCY", "error", err.Error())
	}
}

// unlockAsyncMFT sets MF_TRANSFORM_ASYNC_UNLOCK = TRUE on a hardware MFT.
// Hardware MFTs (NVENC, QuickSync, AMD VCE) are async and locked by default.
// Without unlocking, all configuration calls return MF_E_TRANSFORM_ASYNC_LOCKED.
func (m *mftEncoder) unlockAsyncMFT(transform uintptr) error {
	var attrs uintptr
	_, err := comCall(transform, vtblGetAttributes, uintptr(unsafe.Pointer(&attrs)))
	if err != nil || attrs == 0 {
		return fmt.Errorf("GetAttributes for async unlock: %w", err)
	}
	defer comRelease(attrs)

	_, err = comCall(attrs, vtblSetUINT32,
		uintptr(unsafe.Pointer(&mfTransformAsyncUnlock)),
		uintptr(uint32(1)), // TRUE
	)
	if err != nil {
		return fmt.Errorf("SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK): %w", err)
	}
	slog.Info("Hardware MFT async unlock succeeded")
	return nil
}

// --- encoderBackend interface ---

func (m *mftEncoder) SetCodec(codec Codec) error {
	if codec != CodecH264 {
		return fmt.Errorf("%w: MFT encoder only supports H264, got %s", ErrInvalidCodec, codec)
	}
	return nil
}

func (m *mftEncoder) SetQuality(quality QualityPreset) error {
	m.mu.Lock()
	m.cfg.Quality = quality
	m.mu.Unlock()
	return nil
}

func (m *mftEncoder) SetBitrate(bitrate int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cfg.Bitrate = bitrate

	if m.codecAPI == 0 || !m.inited {
		return nil
	}

	// Apply bitrate dynamically via ICodecAPI::SetValue(CODECAPI_AVEncCommonMeanBitRate, VT_UI4)
	v := comVariant{vt: vtUI4}
	v.val = uint64(uint32(bitrate))
	_, err := comCall(m.codecAPI, vtblCodecAPISetValue,
		uintptr(unsafe.Pointer(&codecAPIAVEncCommonMeanBitRate)),
		uintptr(unsafe.Pointer(&v)),
	)
	if err != nil {
		slog.Debug("ICodecAPI SetValue(bitrate) failed", "bitrate", bitrate, "error", err.Error())
		return nil // non-fatal: adaptive loop will keep trying
	}
	slog.Debug("Dynamic bitrate applied via ICodecAPI", "bitrate", bitrate)

	// Update VBV buffer to maintain 500ms ratio at new bitrate.
	// Without this, a bitrate reduction leaves the VBV oversized (allows
	// transient rate spikes, less severe than the inverse) but a bitrate
	// increase leaves it undersized (causes burst-starve).
	vbvSize := vbvSizeForBitrate(bitrate)
	vbv := comVariant{vt: vtUI4, val: uint64(vbvSize)}
	if _, err := comCall(m.codecAPI, vtblCodecAPISetValue,
		uintptr(unsafe.Pointer(&codecAPIAVEncCommonBufferSize)),
		uintptr(unsafe.Pointer(&vbv)),
	); err != nil {
		slog.Warn("ICodecAPI SetValue(BufferSize) failed during bitrate update — encoder VBV/bitrate mismatch",
			"vbvSize", vbvSize, "bitrate", bitrate, "error", err.Error())
	}

	return nil
}

func (m *mftEncoder) SetPixelFormat(pf PixelFormat) {
	m.mu.Lock()
	m.pixelFormat = pf
	m.mu.Unlock()
}

func (m *mftEncoder) SetFPS(fps int) error {
	m.mu.Lock()
	m.cfg.FPS = fps
	m.mu.Unlock()
	return nil
}

func (m *mftEncoder) SetDimensions(w, h int) error {
	// NV12 requires even dimensions; H264 macroblocks prefer multiples of 16.
	// Round down to even to avoid MF_E_INVALIDMEDIATYPE from SetInputType.
	w = w &^ 1
	h = h &^ 1
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.inited && (m.width != w || m.height != h) {
		// Resolution changed — need to reinitialize
		m.shutdown()
	}
	m.width = w
	m.height = h
	m.stride = w * 4
	return nil
}

func (m *mftEncoder) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.shutdown()
	return nil
}

func (m *mftEncoder) shutdown() {
	if !m.inited {
		return
	}
	// Release GPU converter first
	if m.gpuConv != nil {
		m.gpuConv.Close()
		m.gpuConv = nil
	}
	m.gpuFrameCount = 0
	m.gpuEnabled = false
	m.gpuFailed = false
	m.forceKeyframePending = false

	// Release DXGI device manager
	if m.dxgiManager != 0 {
		comRelease(m.dxgiManager)
		m.dxgiManager = 0
	}

	// Release ICodecAPI before the transform
	if m.codecAPI != 0 {
		comRelease(m.codecAPI)
		m.codecAPI = 0
	}
	// Flush
	comCall(m.transform, vtblProcessMessage, mftMessageCommandFlush, 0)
	comCall(m.transform, vtblProcessMessage, mftMessageNotifyEndStreaming, 0)
	comRelease(m.transform)
	m.transform = 0
	m.inited = false
	m.frameIdx = 0
	m.startTime = time.Now()

	procMFShutdown.Call()
	procCoUninitialize.Call()

	// NOTE: We intentionally do NOT call runtime.UnlockOSThread() here.
	// LockOSThread was called from the capture goroutine via Encode→initialize.
	// shutdown() may be called from a different goroutine (e.g., Session.Stop).
	// Calling UnlockOSThread from the wrong goroutine would unlock that goroutine's
	// thread instead. The locked thread is released when the capture goroutine exits.
	m.threadLocked = false

	slog.Info("MFT H264 encoder shut down")
}

func (m *mftEncoder) Name() string {
	if m.isHW {
		return "mft-hardware"
	}
	return "mft-software"
}

func (m *mftEncoder) IsHardware() bool {
	return m.isHW
}

func (m *mftEncoder) IsPlaceholder() bool {
	return false
}
