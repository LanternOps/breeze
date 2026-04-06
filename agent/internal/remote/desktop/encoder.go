package desktop

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
)

type Codec string

const (
	CodecH264 Codec = "h264"
	CodecVP9  Codec = "vp9"
	CodecVP8  Codec = "vp8"
	CodecAV1  Codec = "av1"
)

type QualityPreset string

const (
	QualityAuto   QualityPreset = "auto"
	QualityLow    QualityPreset = "low"
	QualityMedium QualityPreset = "medium"
	QualityHigh   QualityPreset = "high"
	QualityUltra  QualityPreset = "ultra"
)

// PixelFormat describes the input pixel byte order.
type PixelFormat int

const (
	PixelFormatRGBA PixelFormat = iota
	PixelFormatBGRA
)

var (
	ErrInvalidCodec   = errors.New("invalid codec")
	ErrInvalidQuality = errors.New("invalid quality preset")
	ErrInvalidBitrate = errors.New("invalid bitrate")
	ErrInvalidFPS     = errors.New("invalid fps")
)

type EncoderConfig struct {
	Codec          Codec
	Quality        QualityPreset
	Bitrate        int
	FPS            int
	PreferHardware bool
	GPUVendor      string // "nvidia", "amd", "intel", or "" for auto-detect
}

func DefaultEncoderConfig() EncoderConfig {
	return EncoderConfig{
		Codec:          CodecH264,
		Quality:        QualityAuto,
		Bitrate:        2_500_000,
		FPS:            30,
		PreferHardware: false,
	}
}

type VideoEncoder struct {
	mu      sync.Mutex
	cfg     EncoderConfig
	backend encoderBackend
}

// optionalKeyframeForcer is implemented by encoder backends that can force the
// next output to be an IDR/keyframe (useful for WebRTC startup and PLI/FIR).
type optionalKeyframeForcer interface {
	ForceKeyframe() error
}

// optionalStallDetector is implemented by encoder backends that can detect
// permanent stall conditions (e.g., MFT Quality VBR on certain GPUs).
type optionalStallDetector interface {
	IsPermanentlyStalled() bool
	// AdvanceStallDetection progresses the stall state machine without
	// requiring a new frame. Called from the capture loop during idle
	// periods when no Encode() calls happen but the encoder may be stalled.
	AdvanceStallDetection()
}

type encoderBackend interface {
	Encode(frame []byte) ([]byte, error)
	SetCodec(codec Codec) error
	SetQuality(quality QualityPreset) error
	SetBitrate(bitrate int) error
	SetFPS(fps int) error
	SetDimensions(width, height int) error
	SetPixelFormat(pf PixelFormat)
	Close() error
	Name() string
	IsHardware() bool
	IsPlaceholder() bool

	// GPU zero-copy pipeline methods
	SetD3D11Device(device, context uintptr)
	SupportsGPUInput() bool
	EncodeTexture(bgraTexture uintptr) ([]byte, error)
}

type backendFactory func(cfg EncoderConfig) (encoderBackend, error)

type taggedFactory struct {
	vendor  string // "" means universal (e.g., MFT works on all GPUs)
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

func NewVideoEncoder(cfg EncoderConfig) (*VideoEncoder, error) {
	cfg = applyDefaults(cfg)
	if err := validateConfig(cfg); err != nil {
		return nil, err
	}

	backend, err := newBackend(cfg)
	if err != nil {
		return nil, err
	}

	return &VideoEncoder{
		cfg:     cfg,
		backend: backend,
	}, nil
}

func (v *VideoEncoder) Encode(frame []byte) ([]byte, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.backend == nil {
		return nil, errors.New("encoder not initialized")
	}
	return v.backend.Encode(frame)
}

func (v *VideoEncoder) SetCodec(codec Codec) error {
	if !codec.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidCodec, codec)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := v.backend.SetCodec(codec); err != nil {
		return err
	}
	v.cfg.Codec = codec
	return nil
}

func (v *VideoEncoder) SetQuality(quality QualityPreset) error {
	if !quality.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidQuality, quality)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := v.backend.SetQuality(quality); err != nil {
		return err
	}
	v.cfg.Quality = quality
	return nil
}

func (v *VideoEncoder) SetBitrate(bitrate int) error {
	if bitrate <= 0 {
		return ErrInvalidBitrate
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := v.backend.SetBitrate(bitrate); err != nil {
		return err
	}
	v.cfg.Bitrate = bitrate
	return nil
}

func (v *VideoEncoder) SetFPS(fps int) error {
	if fps <= 0 {
		return ErrInvalidFPS
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := v.backend.SetFPS(fps); err != nil {
		return err
	}
	v.cfg.FPS = fps
	return nil
}

func (v *VideoEncoder) SetDimensions(width, height int) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.backend.SetDimensions(width, height)
}

func (v *VideoEncoder) SetPixelFormat(pf PixelFormat) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.backend != nil {
		v.backend.SetPixelFormat(pf)
	}
}

func (v *VideoEncoder) Close() error {
	v.mu.Lock()
	backend := v.backend
	v.backend = nil
	v.mu.Unlock()
	if backend == nil {
		return nil
	}
	return backend.Close()
}

// Flush drops all buffered frames from the encoder pipeline and forces the
// next output to be an IDR keyframe. Used on mouse clicks so the viewer
// immediately shows the result of the click instead of displaying stale
// animation frames queued before the click.
func (v *VideoEncoder) Flush() {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.backend == nil {
		return
	}
	type flusher interface{ Flush() error }
	if f, ok := v.backend.(flusher); ok {
		if err := f.Flush(); err != nil {
			slog.Warn("Encoder flush failed", "error", err.Error())
		}
	}
}

// ForceKeyframe requests the encoder output an IDR/keyframe as soon as possible.
// If the backend doesn't support it, this is a no-op.
func (v *VideoEncoder) ForceKeyframe() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.backend == nil {
		return errors.New("encoder not initialized")
	}
	if kf, ok := v.backend.(optionalKeyframeForcer); ok {
		return kf.ForceKeyframe()
	}
	return nil
}

// IsPermanentlyStalled returns true if the encoder backend has detected an
// unrecoverable stall (e.g., MFT flush recovery repeatedly failed).
func (v *VideoEncoder) IsPermanentlyStalled() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if sd, ok := v.backend.(optionalStallDetector); ok {
		return sd.IsPermanentlyStalled()
	}
	return false
}

// AdvanceStallDetection progresses the stall state machine without a new frame.
// Call during idle periods when no Encode() calls happen but the encoder may
// be mid-stall (consecutiveNilOutputs > 0).
func (v *VideoEncoder) AdvanceStallDetection() {
	v.mu.Lock()
	defer v.mu.Unlock()
	if sd, ok := v.backend.(optionalStallDetector); ok {
		sd.AdvanceStallDetection()
	}
}

func (v *VideoEncoder) BackendName() string {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.backend == nil {
		return ""
	}
	return v.backend.Name()
}

func (v *VideoEncoder) BackendIsHardware() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.backend == nil {
		return false
	}
	return v.backend.IsHardware()
}

func (v *VideoEncoder) BackendIsPlaceholder() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.backend == nil {
		return true
	}
	return v.backend.IsPlaceholder()
}

func (v *VideoEncoder) SetD3D11Device(device, context uintptr) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.backend != nil {
		v.backend.SetD3D11Device(device, context)
	}
}

func (v *VideoEncoder) SupportsGPUInput() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.backend == nil {
		return false
	}
	return v.backend.SupportsGPUInput()
}

func (v *VideoEncoder) EncodeTexture(bgraTexture uintptr) ([]byte, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.backend == nil {
		return nil, errors.New("encoder not initialized")
	}
	return v.backend.EncodeTexture(bgraTexture)
}

func (c Codec) valid() bool {
	switch c {
	case CodecH264, CodecVP9, CodecVP8, CodecAV1:
		return true
	default:
		return false
	}
}

func (q QualityPreset) valid() bool {
	switch q {
	case QualityAuto, QualityLow, QualityMedium, QualityHigh, QualityUltra:
		return true
	default:
		return false
	}
}

func applyDefaults(cfg EncoderConfig) EncoderConfig {
	defaults := DefaultEncoderConfig()
	if cfg.Codec == "" {
		cfg.Codec = defaults.Codec
	}
	if cfg.Quality == "" {
		cfg.Quality = defaults.Quality
	}
	if cfg.Bitrate == 0 {
		cfg.Bitrate = defaults.Bitrate
	}
	if cfg.FPS == 0 {
		cfg.FPS = defaults.FPS
	}
	return cfg
}

func validateConfig(cfg EncoderConfig) error {
	if !cfg.Codec.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidCodec, cfg.Codec)
	}
	if !cfg.Quality.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidQuality, cfg.Quality)
	}
	if cfg.Bitrate <= 0 {
		return ErrInvalidBitrate
	}
	if cfg.FPS <= 0 {
		return ErrInvalidFPS
	}
	return nil
}

func newBackend(cfg EncoderConfig) (encoderBackend, error) {
	if cfg.PreferHardware {
		if backend := tryHardware(cfg); backend != nil {
			return backend, nil
		}
	}
	return newSoftwareEncoder(cfg)
}

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
