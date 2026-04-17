package desktop

import (
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"unsafe"

	openh264 "github.com/y9o/go-openh264"
)

// openH264Encoder implements encoderBackend using Cisco's OpenH264 library
// via purego (no cgo required). Provides deterministic 1-in-1-out encoding
// with no internal frame buffering, unlike the Windows MFT software encoder.
type openH264Encoder struct {
	mu          sync.Mutex
	cfg         EncoderConfig
	width       int
	height      int
	pixelFormat PixelFormat
	enc         *openh264.ISVCEncoder
	pinner      runtime.Pinner
	forceIDR    bool
	frameIdx    uint64
	inited      bool
}

var (
	openH264Mu      sync.Mutex
	openH264Loaded  bool
	openH264LoadErr error
)

// PreloadOpenH264 eagerly loads the OpenH264 library (downloading if needed).
// Call during agent startup so the DLL is ready before any desktop sessions.
// Load is attempted once — on failure, the placeholder encoder is used.
func PreloadOpenH264() {
	loadOpenH264()
}

func loadOpenH264() error {
	openH264Mu.Lock()
	defer openH264Mu.Unlock()

	if openH264Loaded {
		return nil
	}
	if openH264LoadErr != nil {
		// Already failed — don't retry on every Encode() call.
		// PreloadOpenH264 from startup goroutine is the retry path.
		return openH264LoadErr
	}

	libPath, err := findOpenH264Library()
	if err != nil {
		openH264LoadErr = fmt.Errorf("find OpenH264 library: %w", err)
		slog.Error("OpenH264 library not available — remote desktop will use placeholder encoder", "error", err.Error())
		return openH264LoadErr
	}
	if err := openh264.Open(libPath); err != nil {
		openH264LoadErr = fmt.Errorf("load OpenH264 library %s: %w", libPath, err)
		slog.Error("OpenH264 library failed to load — remote desktop will use placeholder encoder", "path", libPath, "error", err.Error())
		return openH264LoadErr
	}
	ver := openh264.WelsGetCodecVersion()
	slog.Info("OpenH264 library loaded",
		"path", libPath,
		"version", fmt.Sprintf("%d.%d.%d", ver.UMajor, ver.UMinor, ver.URevision),
	)
	openH264Loaded = true
	return nil
}

func newOpenH264Encoder(cfg EncoderConfig) (encoderBackend, error) {
	if cfg.Codec != CodecH264 {
		return nil, fmt.Errorf("OpenH264 only supports H264, got %s", cfg.Codec)
	}
	if err := loadOpenH264(); err != nil {
		return nil, err
	}
	return &openH264Encoder{cfg: cfg}, nil
}

// clampThreads returns a thread count suitable for OpenH264's
// IMultipleThreadIdc. Realtime H264 sees diminishing returns past 4 threads,
// and a minimum of 2 lets the encoder overlap slice encode with bitstream
// emit on even the smallest hosts.
func clampThreads(n int) int {
	if n < 2 {
		return 2
	}
	if n > 4 {
		return 4
	}
	return n
}

// initEncoder creates and configures the OpenH264 encoder. Called lazily on
// the first Encode() with known dimensions (matching MFT lazy-init pattern).
func (e *openH264Encoder) initEncoder() error {
	if e.width == 0 || e.height == 0 {
		return fmt.Errorf("OpenH264: call SetDimensions before Encode")
	}

	var enc *openh264.ISVCEncoder
	if ret := openh264.WelsCreateSVCEncoder(&enc); ret != 0 || enc == nil {
		return fmt.Errorf("WelsCreateSVCEncoder failed: %d", ret)
	}

	// Suppress OpenH264 internal logging (noisy at INFO/DEBUG levels)
	traceLevel := openh264.WELS_LOG_WARNING
	enc.SetOption(openh264.ENCODER_OPTION_TRACE_LEVEL, &traceLevel)

	var params openh264.SEncParamExt
	enc.GetDefaultParams(&params)

	fps := e.cfg.FPS
	if fps <= 0 {
		fps = 30
	}
	bitrate := e.cfg.Bitrate
	if bitrate <= 0 {
		bitrate = 2_500_000
	}

	params.IUsageType = openh264.SCREEN_CONTENT_REAL_TIME
	params.IPicWidth = int32(e.width)
	params.IPicHeight = int32(e.height)
	params.ITargetBitrate = int32(bitrate)
	params.IMaxBitrate = int32(bitrate * 2)
	params.FMaxFrameRate = float32(fps)
	params.IRCMode = openh264.RC_BITRATE_MODE
	params.ISpatialLayerNum = 1
	params.ITemporalLayerNum = 1
	// Clamp thread count to [2, 4]: realtime H264 sees marginal returns past 4
	// threads, and leaving headroom avoids stealing CPU from capture/compose
	// on CPU-bound hosts (e.g., Windows Server VMs with no GPU).
	params.IMultipleThreadIdc = uint16(clampThreads(runtime.NumCPU()))
	// Allow the encoder to drop frames when it can't keep up with FPS; without
	// this, frames queue and end-to-end latency grows without bound on CPU-bound
	// hosts. Rate control still honors bitrate targets.
	params.BEnableFrameSkip = true
	params.BEnableDenoise = false
	params.BEnableSceneChangeDetect = true
	params.BEnableBackgroundDetection = true
	params.BEnableAdaptiveQuant = true
	params.IEntropyCodingModeFlag = 0 // CAVLC (Baseline profile)
	params.IComplexityMode = openh264.MEDIUM_COMPLEXITY
	params.IMinQp = 18
	params.IMaxQp = 42

	// IDR every 4 seconds — tighter than 10s so packet-loss recovery doesn't
	// rely solely on PLI, still sparse enough to avoid scene-change-free
	// keyframes dominating the bitrate budget.
	idrInterval := uint32(fps * 4)
	if idrInterval < 30 {
		idrInterval = 30
	}
	params.UiIntraPeriod = idrInterval

	// Single spatial layer at full resolution
	params.SSpatialLayers[0].IVideoWidth = int32(e.width)
	params.SSpatialLayers[0].IVideoHeight = int32(e.height)
	params.SSpatialLayers[0].FFrameRate = float32(fps)
	params.SSpatialLayers[0].ISpatialBitrate = int32(bitrate)
	params.SSpatialLayers[0].IMaxSpatialBitrate = int32(bitrate * 2)
	params.SSpatialLayers[0].UiProfileIdc = openh264.PRO_BASELINE
	params.SSpatialLayers[0].UiLevelIdc = openh264.LEVEL_3_1
	params.SSpatialLayers[0].SSliceArgument.UiSliceMode = openh264.SM_SINGLE_SLICE

	if ret := enc.InitializeExt(&params); ret != 0 {
		openh264.WelsDestroySVCEncoder(enc)
		return fmt.Errorf("OpenH264 InitializeExt failed: %d", ret)
	}

	// Set input format to I420
	videoFmt := openh264.VideoFormatI420
	enc.SetOption(openh264.ENCODER_OPTION_DATAFORMAT, (*int)(unsafe.Pointer(&videoFmt)))

	e.enc = enc
	e.inited = true
	e.frameIdx = 0

	slog.Info("OpenH264 encoder initialized",
		"width", e.width,
		"height", e.height,
		"bitrate", bitrate,
		"fps", fps,
		"profile", "baseline",
		"complexity", "medium",
	)
	return nil
}

func (e *openH264Encoder) Encode(frame []byte) ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if len(frame) == 0 {
		return nil, errors.New("empty frame")
	}

	if e.width == 0 || e.height == 0 {
		return nil, fmt.Errorf("OpenH264: call SetDimensions before Encode")
	}

	// Defense-in-depth: silently accept a capture buffer that is exactly one
	// row of pixels too tall, so a capturer that forgot to AlignEven its output
	// cannot produce a tight error loop. See dimensions.go.
	var err error
	frame, err = FitRGBAFrame(frame, e.width, e.height)
	if err != nil {
		return nil, err
	}

	if !e.inited {
		if err := e.initEncoder(); err != nil {
			return nil, err
		}
	}

	// Convert RGBA/BGRA to I420
	stride := e.width * 4
	var i420 []byte
	if e.pixelFormat == PixelFormatBGRA {
		i420 = bgraToI420(frame, e.width, e.height, stride)
	} else {
		i420 = rgbaToI420(frame, e.width, e.height, stride)
	}
	defer putI420Buffer(i420)

	// Force IDR if requested
	if e.forceIDR {
		e.enc.ForceIntraFrame(true)
		e.forceIDR = false
	}

	// Pin I420 memory for the duration of the encode call
	ySize := e.width * e.height
	uvSize := ySize / 4
	e.pinner.Unpin()
	e.pinner.Pin(&i420[0])

	// Set up source picture — compute timestamp before struct init to avoid
	// division by zero when cfg.FPS is 0 (can happen before initEncoder sets it).
	var tsMs int64
	if e.cfg.FPS > 0 {
		tsMs = int64(e.frameIdx) * 1000 / int64(e.cfg.FPS)
	} else {
		tsMs = int64(e.frameIdx) * 33 // ~30fps default
	}
	srcPic := openh264.SSourcePicture{
		IColorFormat: openh264.VideoFormatI420,
		IPicWidth:    int32(e.width),
		IPicHeight:   int32(e.height),
		UiTimeStamp:  tsMs,
	}
	srcPic.IStride[0] = int32(e.width)     // Y stride
	srcPic.IStride[1] = int32(e.width / 2) // U stride
	srcPic.IStride[2] = int32(e.width / 2) // V stride
	srcPic.PData[0] = (*uint8)(unsafe.Pointer(&i420[0]))              // Y plane
	srcPic.PData[1] = (*uint8)(unsafe.Pointer(&i420[ySize]))          // U plane
	srcPic.PData[2] = (*uint8)(unsafe.Pointer(&i420[ySize+uvSize]))   // V plane

	e.frameIdx++

	// Encode
	var bsInfo openh264.SFrameBSInfo
	if ret := e.enc.EncodeFrame(&srcPic, &bsInfo); ret != openh264.CmResultSuccess {
		return nil, fmt.Errorf("OpenH264 EncodeFrame failed: %d", ret)
	}

	// Frame was skipped by rate control
	if bsInfo.EFrameType == openh264.VideoFrameTypeSkip || bsInfo.IFrameSizeInBytes == 0 {
		return nil, nil
	}

	// Extract NAL data from all layers
	out := make([]byte, 0, bsInfo.IFrameSizeInBytes)
	for i := int32(0); i < bsInfo.ILayerNum; i++ {
		layer := &bsInfo.SLayerInfo[i]
		if layer.INalCount == 0 || layer.PBsBuf == nil {
			continue
		}
		nalLens := unsafe.Slice(layer.PNalLengthInByte, layer.INalCount)
		var layerSize int32
		for _, l := range nalLens {
			layerSize += l
		}
		if layerSize > 0 {
			nalData := unsafe.Slice(layer.PBsBuf, layerSize)
			out = append(out, nalData...)
		}
	}

	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

func (e *openH264Encoder) ForceKeyframe() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.forceIDR = true
	return nil
}

func (e *openH264Encoder) Flush() error {
	// OpenH264 has no internal frame buffer — flush is just a keyframe request
	return e.ForceKeyframe()
}

func (e *openH264Encoder) SetBitrate(bitrate int) error {
	if bitrate <= 0 {
		return ErrInvalidBitrate
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cfg.Bitrate = bitrate
	if e.enc != nil && e.inited {
		br := openh264.SBitrateInfo{ILayer: openh264.SPATIAL_LAYER_0, IBitrate: int32(bitrate)}
		e.enc.SetOption(openh264.ENCODER_OPTION_BITRATE, (*int)(unsafe.Pointer(&br)))
		maxBr := openh264.SBitrateInfo{ILayer: openh264.SPATIAL_LAYER_0, IBitrate: int32(bitrate * 2)}
		e.enc.SetOption(openh264.ENCODER_OPTION_MAX_BITRATE, (*int)(unsafe.Pointer(&maxBr)))
	}
	return nil
}

func (e *openH264Encoder) SetFPS(fps int) error {
	if fps <= 0 {
		return ErrInvalidFPS
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cfg.FPS = fps
	if e.enc != nil && e.inited {
		fpsF := float32(fps)
		e.enc.SetOption(openh264.ENCODER_OPTION_FRAME_RATE, (*int)(unsafe.Pointer(&fpsF)))
	}
	return nil
}

func (e *openH264Encoder) SetDimensions(width, height int) error {
	// H264 requires even dimensions for 4:2:0 chroma subsampling
	width = width &^ 1
	height = height &^ 1
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.width == width && e.height == height {
		return nil
	}
	// OpenH264 doesn't support dynamic resolution — must reinitialize
	if e.enc != nil {
		e.pinner.Unpin()
		e.enc.Uninitialize()
		openh264.WelsDestroySVCEncoder(e.enc)
		e.enc = nil
		e.inited = false
	}
	e.width = width
	e.height = height
	return nil
}

func (e *openH264Encoder) SetCodec(codec Codec) error {
	if codec != CodecH264 {
		return fmt.Errorf("%w: OpenH264 only supports H264, got %s", ErrInvalidCodec, codec)
	}
	return nil
}

func (e *openH264Encoder) SetQuality(quality QualityPreset) error {
	e.mu.Lock()
	e.cfg.Quality = quality
	e.mu.Unlock()
	return nil
}

func (e *openH264Encoder) SetPixelFormat(pf PixelFormat) {
	e.mu.Lock()
	e.pixelFormat = pf
	e.mu.Unlock()
}

func (e *openH264Encoder) Close() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.enc != nil {
		e.pinner.Unpin()
		e.enc.Uninitialize()
		openh264.WelsDestroySVCEncoder(e.enc)
		e.enc = nil
		e.inited = false
		slog.Info("OpenH264 encoder shut down")
	}
	return nil
}

func (e *openH264Encoder) Name() string               { return "openh264" }
func (e *openH264Encoder) IsHardware() bool            { return false }
func (e *openH264Encoder) IsPlaceholder() bool         { return false }
func (e *openH264Encoder) SetD3D11Device(_, _ uintptr) {}
func (e *openH264Encoder) SupportsGPUInput() bool      { return false }
func (e *openH264Encoder) EncodeTexture(_ uintptr) ([]byte, error) {
	return nil, errors.New("GPU input not supported by OpenH264 encoder")
}
