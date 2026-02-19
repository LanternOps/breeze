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
}

func init() {
	registerHardwareFactory(newMFTEncoder)
}

func newMFTEncoder(cfg EncoderConfig) (encoderBackend, error) {
	if cfg.Codec != CodecH264 {
		return nil, fmt.Errorf("MFT encoder only supports H264, got %s", cfg.Codec)
	}
	return &mftEncoder{
		cfg:       cfg,
		startTime: time.Now(),
	}, nil
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
			slog.Warn("Failed to unlock async MFT, falling back to software", "error", err)
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
			slog.Warn("Hardware MFT rejected input type, falling back to software", "error", err)
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
		slog.Warn("MFT BeginStreaming failed (non-fatal)", "error", err)
	}
	if _, err := comCall(transform, vtblProcessMessage, mftMessageNotifyStartOfStream, 0); err != nil {
		slog.Warn("MFT StartOfStream failed (non-fatal)", "error", err)
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

		// Set GOP size (keyframe interval) = 2 seconds at configured FPS.
		// Short GOPs mean faster recovery from packet loss — viewer never
		// waits more than 2s for a fresh IDR. WebRTC PLI/FIR also handles
		// on-demand keyframe recovery for immediate cases.
		cfgFPS := m.cfg.FPS
		if cfgFPS <= 0 {
			cfgFPS = 30
		}
		gopSize := uint32(cfgFPS * 2)
		if gopSize < 20 {
			gopSize = 20
		}
		gv := comVariant{vt: vtUI4, val: uint64(gopSize)}
		if _, err := comCall(codecAPI, vtblCodecAPISetValue,
			uintptr(unsafe.Pointer(&codecAPIAVEncMPVGOPSize)),
			uintptr(unsafe.Pointer(&gv)),
		); err != nil {
			slog.Debug("ICodecAPI SetValue(GOPSize) failed (non-fatal)", "gopSize", gopSize, "error", err)
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
			slog.Debug("ICodecAPI SetValue(BPictureCount=0) failed (non-fatal)", "error", err)
		}

		// 2. CBR rate control: VBR defers output to optimize compression.
		//    CBR produces output immediately at the target bitrate.
		rv := comVariant{vt: vtUI4, val: uint64(eAVEncCommonRateControlMode_CBR)}
		if _, err := comCall(codecAPI, vtblCodecAPISetValue,
			uintptr(unsafe.Pointer(&codecAPIAVEncCommonRateControlMode)),
			uintptr(unsafe.Pointer(&rv)),
		); err != nil {
			slog.Debug("ICodecAPI SetValue(RateControl=CBR) failed (non-fatal)", "error", err)
		}

		// 3. Minimize VBV buffer: limits how many frames the encoder can queue
		//    internally. Set to ~1 frame worth of bits at current bitrate/fps.
		bitsPerFrame := uint32(m.cfg.Bitrate / max(m.cfg.FPS, 1))
		if bitsPerFrame < 50000 {
			bitsPerFrame = 50000
		}
		vbv := comVariant{vt: vtUI4, val: uint64(bitsPerFrame)}
		if _, err := comCall(codecAPI, vtblCodecAPISetValue,
			uintptr(unsafe.Pointer(&codecAPIAVEncCommonBufferSize)),
			uintptr(unsafe.Pointer(&vbv)),
		); err != nil {
			slog.Debug("ICodecAPI SetValue(BufferSize) failed (non-fatal)", "error", err)
		}
	} else {
		slog.Debug("ICodecAPI not available on this MFT (dynamic bitrate disabled)", "error", qiErr)
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
		"providesSamples", m.providesSamples,
		"outputBufSize", m.outputBufSize,
		"hasCodecAPI", m.codecAPI != 0,
		"gpuPipeline", m.gpuEnabled,
	)
	return nil
}

// tryInitGPUPipeline attempts to set up DXGI device manager + GPU color converter.
// On failure, logs a warning and falls back to CPU path.
func (m *mftEncoder) tryInitGPUPipeline() {
	// 1. Create DXGI device manager
	var token uint32
	var manager uintptr
	hr, _, _ := procMFCreateDXGIDeviceManager.Call(
		uintptr(unsafe.Pointer(&token)),
		uintptr(unsafe.Pointer(&manager)),
	)
	if int32(hr) < 0 {
		slog.Warn("MFCreateDXGIDeviceManager failed, using CPU path", "hr", fmt.Sprintf("0x%08X", uint32(hr)))
		return
	}

	// 2. ResetDevice(d3d11Device, token)
	_, err := comCall(manager, vtblDXGIManagerResetDevice, m.d3d11Device, uintptr(token))
	if err != nil {
		comRelease(manager)
		slog.Warn("DXGI device manager ResetDevice failed, using CPU path", "error", err)
		return
	}

	// 3. Set MF_SA_D3D11_AWARE = TRUE on MFT attributes
	var attrs uintptr
	_, err = comCall(m.transform, vtblGetAttributes, uintptr(unsafe.Pointer(&attrs)))
	if err == nil && attrs != 0 {
		comCall(attrs, vtblSetUINT32,
			uintptr(unsafe.Pointer(&mfSAD3D11Aware)),
			uintptr(uint32(1)),
		)
		comRelease(attrs)
	}

	// 4. ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager)
	_, err = comCall(m.transform, vtblProcessMessage, uintptr(mftMessageSetD3DManager), manager)
	if err != nil {
		comRelease(manager)
		slog.Warn("MFT SET_D3D_MANAGER failed, using CPU path", "error", err)
		return
	}

	m.dxgiManager = manager
	m.dxgiResetToken = token

	slog.Info("DXGI device manager configured for MFT")
	// gpuConv will be initialized lazily on first EncodeTexture call
	// since we need the BGRA staging texture handle at that point
}

// teardownDXGIManager removes the DXGI device manager from the MFT,
// reverting it to CPU buffer mode. Called when GPU converter init fails.
func (m *mftEncoder) teardownDXGIManager() {
	if m.dxgiManager == 0 {
		return
	}
	// Tell MFT to stop using the D3D manager (pass NULL)
	comCall(m.transform, vtblProcessMessage, uintptr(mftMessageSetD3DManager), 0)
	comRelease(m.dxgiManager)
	m.dxgiManager = 0

	// Some hardware MFTs appear to get "stuck" after switching D3D manager state.
	// A flush + restart messages help restore CPU buffer mode.
	comCall(m.transform, vtblProcessMessage, mftMessageCommandFlush, 0)
	comCall(m.transform, vtblProcessMessage, mftMessageNotifyBeginStreaming, 0)
	comCall(m.transform, vtblProcessMessage, mftMessageNotifyStartOfStream, 0)

	slog.Info("DXGI device manager removed from MFT (GPU converter failed)")
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

	// Try hardware first
	transform, err := m.enumAndActivate(
		mftEnumFlagHardware|mftEnumFlagSortAndFilter,
		&inputType, &outputType,
	)
	if err == nil {
		return transform, true, nil
	}

	// Fall back to sync (software) MFT
	transform, err = m.enumAndActivate(
		mftEnumFlagSyncMFT|mftEnumFlagSortAndFilter,
		&inputType, &outputType,
	)
	if err == nil {
		return transform, false, nil
	}

	// Last resort: try all
	transform, err = m.enumAndActivate(
		mftEnumFlagAll,
		&inputType, &outputType,
	)
	if err == nil {
		return transform, false, nil
	}

	return 0, false, fmt.Errorf("no H264 encoder available")
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
		slog.Debug("Failed to set Main profile", "error", err)
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
		slog.Warn("MFT GetAttributes failed, cannot set low-latency", "error", err)
		return
	}
	defer comRelease(attrs)
	_, err = comCall(attrs, vtblSetUINT32,
		uintptr(unsafe.Pointer(&mfLowLatency)),
		uintptr(uint32(1)),
	)
	if err != nil {
		slog.Warn("Failed to set MF_LOW_LATENCY", "error", err)
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

// Encode takes RGBA or BGRA pixel data (per SetPixelFormat), converts to NV12, and encodes to H264.
// Returns nil, nil when the MFT is buffering (no output yet).
func (m *mftEncoder) Encode(frame []byte) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(frame) == 0 {
		return nil, fmt.Errorf("empty frame")
	}

	// Lazy init: need dimensions to configure MFT
	if !m.inited {
		// Infer dimensions from RGBA frame size
		// frame is from img.Pix where img is width*height*4 bytes
		pixelCount := len(frame) / 4
		if m.width == 0 || m.height == 0 {
			// Can't initialize without known dimensions
			return nil, fmt.Errorf("MFT encoder: call SetDimensions before Encode")
		}
		if pixelCount != m.width*m.height {
			return nil, fmt.Errorf("frame size %d doesn't match %dx%d", pixelCount, m.width, m.height)
		}
		if err := m.initialize(m.width, m.height, m.width*4); err != nil {
			return nil, err
		}
	}

	// Convert pixels → NV12
	var nv12 []byte
	if m.pixelFormat == PixelFormatBGRA {
		nv12 = bgraToNV12(frame, m.width, m.height, m.stride)
	} else {
		nv12 = rgbaToNV12(frame, m.width, m.height, m.stride)
	}
	defer putNV12Buffer(nv12)

	// Create MF sample with NV12 data
	sample, err := m.createSample(nv12)
	if err != nil {
		return nil, fmt.Errorf("create sample: %w", err)
	}
	defer comRelease(sample)

	// If requested, force an IDR as early as possible in this stream.
	if m.forceKeyframePending {
		_ = m.forceKeyframeLocked()
	}

	// Feed to encoder
	ret, _, _ := syscall.SyscallN(
		m.vtblFn(vtblProcessInput),
		m.transform,
		0, // stream ID
		sample,
		0, // flags
	)

	if uint32(ret) == mfENotAccepting {
		// Drain output first, then retry
		out, err := m.drainOutput()
		if err != nil {
			return nil, err
		}
		ret, _, _ = syscall.SyscallN(
			m.vtblFn(vtblProcessInput),
			m.transform,
			0,
			sample,
			0,
		)
		if int32(ret) < 0 {
			return out, nil // Return what we drained
		}
		if out != nil {
			return out, nil
		}
	} else if int32(ret) < 0 {
		return nil, fmt.Errorf("ProcessInput failed: 0x%08X", uint32(ret))
	}

	// Try to get output
	return m.drainOutput()
}

func (m *mftEncoder) vtblFn(idx int) uintptr {
	vtablePtr := *(*uintptr)(unsafe.Pointer(m.transform))
	return *(*uintptr)(unsafe.Pointer(vtablePtr + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
}

func (m *mftEncoder) createSample(nv12 []byte) (uintptr, error) {
	nv12Size := len(nv12)

	// Create memory buffer
	var pBuffer uintptr
	hr, _, _ := procMFCreateMemoryBuffer.Call(
		uintptr(uint32(nv12Size)),
		uintptr(unsafe.Pointer(&pBuffer)),
	)
	if int32(hr) < 0 {
		return 0, fmt.Errorf("MFCreateMemoryBuffer: 0x%08X", uint32(hr))
	}

	// Lock buffer, copy NV12 data, unlock
	var pData uintptr
	_, err := comCall(pBuffer, vtblBufLock, uintptr(unsafe.Pointer(&pData)), 0, 0)
	if err != nil {
		comRelease(pBuffer)
		return 0, fmt.Errorf("buffer Lock: %w", err)
	}

	// Copy NV12 data into the buffer
	dst := unsafe.Slice((*byte)(unsafe.Pointer(pData)), nv12Size)
	copy(dst, nv12)

	comCall(pBuffer, vtblBufUnlock)
	comCall(pBuffer, vtblBufSetCurrentLength, uintptr(uint32(nv12Size)))

	// Create sample
	var pSample uintptr
	hr, _, _ = procMFCreateSample.Call(uintptr(unsafe.Pointer(&pSample)))
	if int32(hr) < 0 {
		comRelease(pBuffer)
		return 0, fmt.Errorf("MFCreateSample: 0x%08X", uint32(hr))
	}

	// Set timing
	fps := m.cfg.FPS
	if fps <= 0 {
		fps = 30
	}
	frameDuration100ns := int64(10_000_000 / fps) // 100ns units
	sampleTime := int64(m.frameIdx) * frameDuration100ns
	m.frameIdx++

	if _, err := comCall(pSample, vtblSetSampleTime, uintptr(sampleTime)); err != nil {
		slog.Debug("SetSampleTime failed (non-fatal)", "error", err)
	}
	if _, err := comCall(pSample, vtblSetSampleDuration, uintptr(frameDuration100ns)); err != nil {
		slog.Debug("SetSampleDuration failed (non-fatal)", "error", err)
	}

	// Add buffer to sample
	_, err = comCall(pSample, vtblAddBuffer, pBuffer)
	comRelease(pBuffer) // sample now owns the buffer
	if err != nil {
		comRelease(pSample)
		return 0, fmt.Errorf("AddBuffer: %w", err)
	}

	return pSample, nil
}

func (m *mftEncoder) drainOutput() ([]byte, error) {
	var allNALs []byte
	streamChangeRetries := 0

	for {
		// Build output data buffer. If the MFT provides its own samples
		// (common for the software H264 encoder), we must NOT provide one.
		var callerSample uintptr
		outputData := mftOutputDataBuffer{dwStreamID: 0}

		if !m.providesSamples {
			// Caller must allocate the output sample + buffer
			var pOutputBuffer uintptr
			hr, _, _ := procMFCreateMemoryBuffer.Call(
				uintptr(uint32(m.outputBufSize)),
				uintptr(unsafe.Pointer(&pOutputBuffer)),
			)
			if int32(hr) < 0 {
				return allNALs, fmt.Errorf("MFCreateMemoryBuffer for output: 0x%08X", uint32(hr))
			}

			hr, _, _ = procMFCreateSample.Call(uintptr(unsafe.Pointer(&callerSample)))
			if int32(hr) < 0 {
				comRelease(pOutputBuffer)
				return allNALs, fmt.Errorf("MFCreateSample for output: 0x%08X", uint32(hr))
			}
			comCall(callerSample, vtblAddBuffer, pOutputBuffer)
			comRelease(pOutputBuffer)
			outputData.pSample = callerSample
		}
		// else: pSample stays 0 — MFT will fill it in

		var status uint32

		ret, _, _ := syscall.SyscallN(
			m.vtblFn(vtblProcessOutput),
			m.transform,
			0, // flags
			1, // output buffer count
			uintptr(unsafe.Pointer(&outputData)),
			uintptr(unsafe.Pointer(&status)),
		)

		// Determine which sample to use (MFT-provided or caller-provided)
		resultSample := outputData.pSample
		callerOwned := !m.providesSamples

		if uint32(ret) == mfETransformNeedInput || uint32(ret) == eUnexpected {
			// MF_E_TRANSFORM_NEED_INPUT: encoder needs more input before producing output.
			// E_UNEXPECTED: async hardware MFTs return this when output isn't ready yet.
			if callerOwned && callerSample != 0 {
				comRelease(callerSample)
			}
			if len(allNALs) > 0 {
				return allNALs, nil
			}
			return nil, nil
		}
		if uint32(ret) == mfETransformStreamChange {
			// Software H264 encoder signals this on its first output to
			// report chosen codec params (profile/level). Per MFT docs we
			// must renegotiate the output type, then re-check stream info.
			if callerOwned && callerSample != 0 {
				comRelease(callerSample)
			}
			streamChangeRetries++
			if streamChangeRetries > 5 {
				m.shutdown()
				return allNALs, fmt.Errorf("too many stream changes (%d), encoder reset", streamChangeRetries)
			}
			// Renegotiate: query the MFT's preferred output type and re-set it
			var newType uintptr
			hr, _, _ := syscall.SyscallN(
				m.vtblFn(vtblGetOutputAvailType),
				m.transform,
				0, // stream ID
				0, // type index
				uintptr(unsafe.Pointer(&newType)),
			)
			if int32(hr) >= 0 && newType != 0 {
				syscall.SyscallN(
					m.vtblFn(vtblSetOutputType),
					m.transform,
					0, // stream ID
					newType,
					0, // flags
				)
				comRelease(newType)
			}
			// Re-check if MFT now provides samples (can change after stream change)
			var streamInfo mftOutputStreamInfo
			hr2, _, _ := syscall.SyscallN(
				m.vtblFn(vtblGetOutputStreamInfo),
				m.transform,
				0,
				uintptr(unsafe.Pointer(&streamInfo)),
			)
			if int32(hr2) >= 0 {
				m.providesSamples = (streamInfo.dwFlags & mftOutputStreamProvidesSamples) != 0
				if int(streamInfo.cbSize) > m.outputBufSize {
					m.outputBufSize = int(streamInfo.cbSize)
				}
			}
			slog.Debug("MFT stream change, renegotiated output type",
				"attempt", streamChangeRetries,
				"providesSamples", m.providesSamples,
				"outputBufSize", m.outputBufSize,
			)
			continue
		}
		if uint32(ret) == mfEBufferTooSmall {
			// Output buffer too small — grow it and retry
			if callerOwned && callerSample != 0 {
				comRelease(callerSample)
			}
			m.outputBufSize *= 2
			slog.Info("MFT output buffer too small, growing", "newSize", m.outputBufSize)
			continue
		}
		if int32(ret) < 0 {
			if callerOwned && callerSample != 0 {
				comRelease(callerSample)
			}
			return allNALs, fmt.Errorf("ProcessOutput: 0x%08X", uint32(ret))
		}

		// Extract encoded data from whichever sample has the output
		if resultSample == 0 {
			return allNALs, fmt.Errorf("ProcessOutput succeeded but no output sample")
		}
		nalChunk, err := m.extractSampleData(resultSample)
		// Release: MFT-provided samples must be released by us too
		if m.providesSamples {
			comRelease(resultSample)
		} else if callerSample != 0 {
			comRelease(callerSample)
		}
		if err != nil {
			return allNALs, err
		}

		allNALs = append(allNALs, nalChunk...)

		if outputData.dwStatus&mftOutputDataBufferIncomplete == 0 {
			break
		}
	}

	return allNALs, nil
}

func (m *mftEncoder) extractSampleData(pSample uintptr) ([]byte, error) {
	var pContiguous uintptr
	_, err := comCall(pSample, vtblConvertToContiguous, uintptr(unsafe.Pointer(&pContiguous)))
	if err != nil {
		return nil, fmt.Errorf("ConvertToContiguousBuffer: %w", err)
	}
	defer comRelease(pContiguous)

	var pData uintptr
	var dataLen uint32
	_, err = comCall(pContiguous, vtblBufLock,
		uintptr(unsafe.Pointer(&pData)),
		0,
		uintptr(unsafe.Pointer(&dataLen)),
	)
	if err != nil {
		return nil, fmt.Errorf("output buffer Lock: %w", err)
	}

	nalData := make([]byte, dataLen)
	src := unsafe.Slice((*byte)(unsafe.Pointer(pData)), dataLen)
	copy(nalData, src)

	comCall(pContiguous, vtblBufUnlock)
	return nalData, nil
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
		slog.Debug("ICodecAPI SetValue(bitrate) failed", "bitrate", bitrate, "error", err)
		return nil // non-fatal: adaptive loop will keep trying
	}
	slog.Debug("Dynamic bitrate applied via ICodecAPI", "bitrate", bitrate)
	return nil
}

// ForceKeyframe requests the encoder emit an IDR/keyframe as soon as possible.
// Best-effort: if unsupported, it becomes a no-op.
func (m *mftEncoder) ForceKeyframe() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// If we're not initialized yet, remember the request and apply after init.
	if !m.inited {
		m.forceKeyframePending = true
		return nil
	}
	return m.forceKeyframeLocked()
}

// Flush drops all buffered frames from the MFT encoder pipeline and forces the
// next output to be an IDR keyframe. Used on mouse clicks so the viewer
// immediately shows the result of the click instead of displaying stale
// animation frames queued before the click.
func (m *mftEncoder) Flush() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.inited || m.transform == 0 {
		return nil
	}

	// 1. Flush all buffered input/output from the MFT pipeline.
	comCall(m.transform, vtblProcessMessage, mftMessageCommandFlush, 0)

	// 2. Restart the streaming session so the MFT accepts new input.
	comCall(m.transform, vtblProcessMessage, mftMessageNotifyBeginStreaming, 0)
	comCall(m.transform, vtblProcessMessage, mftMessageNotifyStartOfStream, 0)

	// 3. Force the next output to be an IDR keyframe so the viewer can
	//    decode immediately without waiting for a reference frame.
	m.forceKeyframePending = true
	_ = m.forceKeyframeLocked()

	return nil
}

func (m *mftEncoder) forceKeyframeLocked() error {
	if m.codecAPI == 0 {
		m.forceKeyframePending = false
		return nil
	}

	// ICodecAPI::SetValue(CODECAPI_AVEncVideoForceKeyFrame, VT_UI4=1)
	v := comVariant{vt: vtUI4, val: 1}
	_, err := comCall(m.codecAPI, vtblCodecAPISetValue,
		uintptr(unsafe.Pointer(&codecAPIAVEncVideoForceKeyFrame)),
		uintptr(unsafe.Pointer(&v)),
	)
	if err != nil {
		// Keep it pending; some hardware MFTs are picky during startup.
		m.forceKeyframePending = true
		return err
	}
	m.forceKeyframePending = false
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

func (m *mftEncoder) SetD3D11Device(device, context uintptr) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if device != m.d3d11Device && m.gpuConv != nil {
		// D3D11 device changed (monitor switch) — the GPU converter holds video
		// processor and texture resources bound to the old device. Close it so
		// EncodeTexture lazily re-creates it with the new device.
		m.gpuConv.Close()
		m.gpuConv = nil
		m.gpuFrameCount = 0
		m.gpuEnabled = false
		m.gpuFailed = false
		slog.Info("GPU converter reset for new D3D11 device (monitor switch)")
	}
	m.d3d11Device = device
	m.d3d11Context = context
}

func (m *mftEncoder) SupportsGPUInput() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.gpuFailed {
		return false
	}
	return m.gpuEnabled || m.d3d11Device != 0
}

// EncodeTexture encodes a BGRA GPU texture via the zero-copy GPU pipeline.
// Converts BGRA→NV12 on GPU, wraps as DXGI surface buffer, feeds to MFT.
func (m *mftEncoder) EncodeTexture(bgraTexture uintptr) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if bgraTexture == 0 {
		return nil, fmt.Errorf("nil BGRA texture")
	}

	// Lazy init MFT if needed
	if !m.inited {
		if m.width == 0 || m.height == 0 {
			return nil, fmt.Errorf("MFT encoder: call SetDimensions before EncodeTexture")
		}
		if err := m.initialize(m.width, m.height, m.width*4); err != nil {
			return nil, err
		}
	}

	// Lazy init GPU converter
	if m.gpuConv == nil {
		conv, err := newGPUConverter(m.d3d11Device, m.d3d11Context, bgraTexture, m.width, m.height)
		if err != nil {
			slog.Warn("GPU converter init failed, falling back to CPU path permanently", "error", err)
			m.gpuEnabled = false
			m.gpuFailed = true
			// Tear down DXGI device manager so MFT reverts to CPU buffer mode
			m.teardownDXGIManager()
			return nil, fmt.Errorf("GPU converter init: %w", err)
		}
		m.gpuConv = conv
		m.gpuEnabled = true
		slog.Info("MFT GPU pipeline enabled", "width", m.width, "height", m.height)
	}

	// If requested, force an IDR as early as possible in this stream.
	if m.forceKeyframePending {
		_ = m.forceKeyframeLocked()
	}

	// 1. GPU BGRA→NV12 conversion + readback to CPU memory.
	// We use ConvertAndReadback instead of the DXGI surface buffer path because
	// hardware MFT encoders often have issues reading DXGI surface buffers directly.
	// The GPU still does the expensive BGRA→NV12 color conversion; the only extra
	// cost is a ~5.5MB NV12 GPU→CPU readback (fast over PCIe).
	nv12, err := m.gpuConv.ConvertAndReadback()
	if err != nil {
		return nil, fmt.Errorf("GPU convert: %w", err)
	}
	defer putNV12Buffer(nv12)

	// Diagnostic: check NV12 Y-plane brightness at multiple positions.
	// Y=16 is limited-range black; varied values indicate real content.
	m.gpuFrameCount++
	if m.gpuFrameCount <= 3 || m.gpuFrameCount%300 == 0 {
		yPlaneSize := m.width * m.height
		checkLen := 1000
		if checkLen > yPlaneSize {
			checkLen = yPlaneSize
		}
		// Sample from START of Y plane (top of screen)
		topSum := 0
		for i := 0; i < checkLen; i++ {
			topSum += int(nv12[i])
		}
		// Sample from MIDDLE of Y plane (center of screen, where content is)
		midOffset := yPlaneSize / 2
		midEnd := midOffset + checkLen
		if midEnd > yPlaneSize {
			midEnd = yPlaneSize
		}
		midSum := 0
		for i := midOffset; i < midEnd; i++ {
			midSum += int(nv12[i])
		}
		// Count non-black pixels in entire Y plane (Y != 16)
		nonBlack := 0
		for i := 0; i < yPlaneSize; i++ {
			if nv12[i] != 16 {
				nonBlack++
			}
		}
		slog.Warn("NV12 content check",
			"frame", m.gpuFrameCount,
			"width", m.width, "height", m.height,
			"topYSum", topSum,
			"midYSum", midSum,
			"nonBlackPixels", nonBlack,
			"totalPixels", yPlaneSize,
		)

		// Self-healing: if the GPU Video Processor produces entirely black NV12
		// output (all Y=16, zero non-black pixels), permanently switch to CPU
		// BGRA→NV12 conversion. This occurs with certain monitor configurations
		// (e.g., portrait 1080x1920) due to driver-level issues.
		if m.gpuFrameCount <= 3 && nonBlack == 0 && yPlaneSize > 0 {
			slog.Warn("GPU converter producing all-black NV12, disabling GPU pipeline",
				"frame", m.gpuFrameCount,
				"width", m.width, "height", m.height,
			)
			m.gpuConv.Close()
			m.gpuConv = nil
			m.gpuEnabled = false
			m.gpuFailed = true
			return nil, fmt.Errorf("GPU converter produced all-black frame (display %dx%d)", m.width, m.height)
		}
	}

	// 2. Create MF sample with NV12 data (same path as CPU Encode)
	sample, err := m.createSample(nv12)
	if err != nil {
		return nil, fmt.Errorf("create sample: %w", err)
	}
	defer comRelease(sample)

	// 3. Feed to encoder
	ret, _, _ := syscall.SyscallN(
		m.vtblFn(vtblProcessInput),
		m.transform,
		0, // stream ID
		sample,
		0, // flags
	)

	if uint32(ret) == mfENotAccepting {
		out, err := m.drainOutput()
		if err != nil {
			return nil, err
		}
		ret, _, _ = syscall.SyscallN(
			m.vtblFn(vtblProcessInput),
			m.transform,
			0,
			sample,
			0,
		)
		if int32(ret) < 0 {
			return out, nil
		}
		if out != nil {
			return out, nil
		}
	} else if int32(ret) < 0 {
		return nil, fmt.Errorf("ProcessInput (GPU): 0x%08X", uint32(ret))
	}

	return m.drainOutput()
}
