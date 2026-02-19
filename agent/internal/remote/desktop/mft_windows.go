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
