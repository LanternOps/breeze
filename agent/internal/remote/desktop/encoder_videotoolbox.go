//go:build darwin
// +build darwin

package desktop

import (
	"errors"
	"fmt"
	"sync"
)

type videotoolboxEncoder struct {
	mu  sync.Mutex
	cfg EncoderConfig
}

func init() {
	registerHardwareFactory(newVideoToolboxEncoder)
}

func newVideoToolboxEncoder(cfg EncoderConfig) (encoderBackend, error) {
	if cfg.Codec != CodecH264 && cfg.Codec != CodecAV1 {
		return nil, fmt.Errorf("videotoolbox unsupported codec: %s", cfg.Codec)
	}
	return &videotoolboxEncoder{cfg: cfg}, nil
}

func (v *videotoolboxEncoder) Encode(frame []byte) ([]byte, error) {
	if len(frame) == 0 {
		return nil, errors.New("empty frame")
	}
	// Placeholder passthrough until VideoToolbox bindings are integrated.
	out := make([]byte, len(frame))
	copy(out, frame)
	return out, nil
}

func (v *videotoolboxEncoder) SetCodec(codec Codec) error {
	if !codec.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidCodec, codec)
	}
	if codec != CodecH264 && codec != CodecAV1 {
		return fmt.Errorf("videotoolbox unsupported codec: %s", codec)
	}
	v.mu.Lock()
	v.cfg.Codec = codec
	v.mu.Unlock()
	return nil
}

func (v *videotoolboxEncoder) SetQuality(quality QualityPreset) error {
	if !quality.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidQuality, quality)
	}
	v.mu.Lock()
	v.cfg.Quality = quality
	v.mu.Unlock()
	return nil
}

func (v *videotoolboxEncoder) SetBitrate(bitrate int) error {
	if bitrate <= 0 {
		return ErrInvalidBitrate
	}
	v.mu.Lock()
	v.cfg.Bitrate = bitrate
	v.mu.Unlock()
	return nil
}

func (v *videotoolboxEncoder) SetFPS(fps int) error {
	if fps <= 0 {
		return ErrInvalidFPS
	}
	v.mu.Lock()
	v.cfg.FPS = fps
	v.mu.Unlock()
	return nil
}

func (v *videotoolboxEncoder) Close() error {
	return nil
}

func (v *videotoolboxEncoder) Name() string {
	return "videotoolbox"
}

func (v *videotoolboxEncoder) IsHardware() bool {
	return true
}
