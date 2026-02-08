package desktop

import (
	"errors"
	"fmt"
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

type encoderBackend interface {
	Encode(frame []byte) ([]byte, error)
	SetCodec(codec Codec) error
	SetQuality(quality QualityPreset) error
	SetBitrate(bitrate int) error
	SetFPS(fps int) error
	SetDimensions(width, height int) error
	Close() error
	Name() string
	IsHardware() bool
}

type backendFactory func(cfg EncoderConfig) (encoderBackend, error)

var (
	hardwareFactoriesMu sync.Mutex
	hardwareFactories   []backendFactory
)

func registerHardwareFactory(factory backendFactory) {
	hardwareFactoriesMu.Lock()
	defer hardwareFactoriesMu.Unlock()
	hardwareFactories = append(hardwareFactories, factory)
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
	factories := append([]backendFactory(nil), hardwareFactories...)
	hardwareFactoriesMu.Unlock()
	for _, factory := range factories {
		backend, err := factory(cfg)
		if err == nil && backend != nil {
			return backend
		}
	}
	return nil
}
