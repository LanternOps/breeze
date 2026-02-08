//go:build nvenc
// +build nvenc

package desktop

import (
	"errors"
	"fmt"
	"sync"
)

type nvencEncoder struct {
	mu  sync.Mutex
	cfg EncoderConfig
}

func init() {
	registerHardwareFactory(newNVENCEncoder)
}

func newNVENCEncoder(cfg EncoderConfig) (encoderBackend, error) {
	if cfg.Codec != CodecH264 && cfg.Codec != CodecAV1 {
		return nil, fmt.Errorf("nvenc unsupported codec: %s", cfg.Codec)
	}
	return &nvencEncoder{cfg: cfg}, nil
}

func (n *nvencEncoder) Encode(frame []byte) ([]byte, error) {
	if len(frame) == 0 {
		return nil, errors.New("empty frame")
	}
	// Placeholder passthrough until NVENC bindings are integrated.
	out := make([]byte, len(frame))
	copy(out, frame)
	return out, nil
}

func (n *nvencEncoder) SetCodec(codec Codec) error {
	if !codec.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidCodec, codec)
	}
	if codec != CodecH264 && codec != CodecAV1 {
		return fmt.Errorf("nvenc unsupported codec: %s", codec)
	}
	n.mu.Lock()
	n.cfg.Codec = codec
	n.mu.Unlock()
	return nil
}

func (n *nvencEncoder) SetQuality(quality QualityPreset) error {
	if !quality.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidQuality, quality)
	}
	n.mu.Lock()
	n.cfg.Quality = quality
	n.mu.Unlock()
	return nil
}

func (n *nvencEncoder) SetBitrate(bitrate int) error {
	if bitrate <= 0 {
		return ErrInvalidBitrate
	}
	n.mu.Lock()
	n.cfg.Bitrate = bitrate
	n.mu.Unlock()
	return nil
}

func (n *nvencEncoder) SetFPS(fps int) error {
	if fps <= 0 {
		return ErrInvalidFPS
	}
	n.mu.Lock()
	n.cfg.FPS = fps
	n.mu.Unlock()
	return nil
}

func (n *nvencEncoder) SetDimensions(width, height int) error {
	return nil
}

func (n *nvencEncoder) Close() error {
	return nil
}

func (n *nvencEncoder) Name() string {
	return "nvenc"
}

func (n *nvencEncoder) IsHardware() bool {
	return true
}
