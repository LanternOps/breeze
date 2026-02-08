//go:build windows && !cgo

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
	transform uintptr // IMFTransform
	inited    bool
	isHW      bool

	// Frame timing
	frameIdx  uint64
	startTime time.Time

	// Thread affinity
	threadLocked bool
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

	// Configure output type (H264) — must be set BEFORE input
	if err := m.setOutputType(transform, width, height); err != nil {
		comRelease(transform)
		procMFShutdown.Call()
		return fmt.Errorf("set output type: %w", err)
	}

	// Configure input type (NV12)
	if err := m.setInputType(transform, width, height); err != nil {
		comRelease(transform)
		procMFShutdown.Call()
		return fmt.Errorf("set input type: %w", err)
	}

	// Enable low-latency mode
	m.setLowLatency(transform)

	// Begin streaming
	comCall(transform, vtblProcessMessage, mftMessageNotifyBeginStreaming, 0)
	comCall(transform, vtblProcessMessage, mftMessageNotifyStartOfStream, 0)

	m.transform = transform
	m.width = width
	m.height = height
	m.stride = stride
	m.isHW = isHW
	m.inited = true

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
		return
	}
	defer comRelease(attrs)
	comCall(attrs, vtblSetUINT32,
		uintptr(unsafe.Pointer(&mfLowLatency)),
		uintptr(uint32(1)),
	)
}

// Encode takes BGRA pixel data, converts to NV12, encodes to H264.
// Returns nil, nil when the MFT is buffering (no output yet).
func (m *mftEncoder) Encode(frame []byte) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(frame) == 0 {
		return nil, fmt.Errorf("empty frame")
	}

	// Lazy init: need dimensions to configure MFT
	if !m.inited {
		// Infer dimensions from BGRA frame size
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

	// Convert BGRA → NV12
	nv12 := bgraToNV12(frame, m.width, m.height, m.stride)
	defer putNV12Buffer(nv12)

	// Create MF sample with NV12 data
	sample, err := m.createSample(nv12)
	if err != nil {
		return nil, fmt.Errorf("create sample: %w", err)
	}
	defer comRelease(sample)

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

	comCall(pSample, vtblSetSampleTime, uintptr(sampleTime))
	comCall(pSample, vtblSetSampleDuration, uintptr(frameDuration100ns))

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
	// Create output buffer
	var pOutputBuffer uintptr
	outputBufSize := m.width * m.height // generous estimate for H264
	hr, _, _ := procMFCreateMemoryBuffer.Call(
		uintptr(uint32(outputBufSize)),
		uintptr(unsafe.Pointer(&pOutputBuffer)),
	)
	if int32(hr) < 0 {
		return nil, fmt.Errorf("MFCreateMemoryBuffer for output: 0x%08X", uint32(hr))
	}

	// Create output sample
	var pOutputSample uintptr
	hr, _, _ = procMFCreateSample.Call(uintptr(unsafe.Pointer(&pOutputSample)))
	if int32(hr) < 0 {
		comRelease(pOutputBuffer)
		return nil, fmt.Errorf("MFCreateSample for output: 0x%08X", uint32(hr))
	}
	comCall(pOutputSample, vtblAddBuffer, pOutputBuffer)
	comRelease(pOutputBuffer) // sample owns it now

	outputData := mftOutputDataBuffer{
		dwStreamID: 0,
		pSample:    pOutputSample,
	}
	var status uint32

	ret, _, _ := syscall.SyscallN(
		m.vtblFn(vtblProcessOutput),
		m.transform,
		0, // flags
		1, // output buffer count
		uintptr(unsafe.Pointer(&outputData)),
		uintptr(unsafe.Pointer(&status)),
	)

	if uint32(ret) == mfETransformNeedInput {
		comRelease(pOutputSample)
		return nil, nil // No output ready yet
	}
	if int32(ret) < 0 {
		comRelease(pOutputSample)
		return nil, fmt.Errorf("ProcessOutput: 0x%08X", uint32(ret))
	}

	// Extract encoded data from output sample
	var pContiguous uintptr
	_, err := comCall(pOutputSample, vtblConvertToContiguous, uintptr(unsafe.Pointer(&pContiguous)))
	comRelease(pOutputSample)
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

	// Copy NAL data
	nalData := make([]byte, dataLen)
	src := unsafe.Slice((*byte)(unsafe.Pointer(pData)), dataLen)
	copy(nalData, src)

	comCall(pContiguous, vtblBufUnlock)

	return nalData, nil
}

// --- encoderBackend interface ---

func (m *mftEncoder) SetCodec(codec Codec) error {
	if codec != CodecH264 {
		return fmt.Errorf("MFT encoder only supports H264")
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
	m.cfg.Bitrate = bitrate
	m.mu.Unlock()
	// TODO: dynamically update MFT bitrate via ICodecAPI if available
	return nil
}

func (m *mftEncoder) SetFPS(fps int) error {
	m.mu.Lock()
	m.cfg.FPS = fps
	m.mu.Unlock()
	return nil
}

func (m *mftEncoder) SetDimensions(w, h int) error {
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
	// Flush
	comCall(m.transform, vtblProcessMessage, mftMessageCommandFlush, 0)
	comCall(m.transform, vtblProcessMessage, mftMessageNotifyEndStreaming, 0)
	comRelease(m.transform)
	m.transform = 0
	m.inited = false

	procMFShutdown.Call()
	procCoUninitialize.Call()

	if m.threadLocked {
		runtime.UnlockOSThread()
		m.threadLocked = false
	}
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
