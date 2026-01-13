//go:build quicksync
// +build quicksync

package desktop

import (
	"errors"
	"fmt"
	"sync"
)

type quicksyncEncoder struct {
	mu  sync.Mutex
	cfg EncoderConfig
}

func init() {
	registerHardwareFactory(newQuickSyncEncoder)
}

func newQuickSyncEncoder(cfg EncoderConfig) (encoderBackend, error) {
	if cfg.Codec != CodecH264 && cfg.Codec != CodecVP9 && cfg.Codec != CodecAV1 {
		return nil, fmt.Errorf("quicksync unsupported codec: %s", cfg.Codec)
	}
	return &quicksyncEncoder{cfg: cfg}, nil
}

func (q *quicksyncEncoder) Encode(frame []byte) ([]byte, error) {
	if len(frame) == 0 {
		return nil, errors.New("empty frame")
	}
	// Placeholder passthrough until Quick Sync bindings are integrated.
	out := make([]byte, len(frame))
	copy(out, frame)
	return out, nil
}

func (q *quicksyncEncoder) SetCodec(codec Codec) error {
	if !codec.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidCodec, codec)
	}
	if codec != CodecH264 && codec != CodecVP9 && codec != CodecAV1 {
		return fmt.Errorf("quicksync unsupported codec: %s", codec)
	}
	q.mu.Lock()
	q.cfg.Codec = codec
	q.mu.Unlock()
	return nil
}

func (q *quicksyncEncoder) SetQuality(quality QualityPreset) error {
	if !quality.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidQuality, quality)
	}
	q.mu.Lock()
	q.cfg.Quality = quality
	q.mu.Unlock()
	return nil
}

func (q *quicksyncEncoder) SetBitrate(bitrate int) error {
	if bitrate <= 0 {
		return ErrInvalidBitrate
	}
	q.mu.Lock()
	q.cfg.Bitrate = bitrate
	q.mu.Unlock()
	return nil
}

func (q *quicksyncEncoder) SetFPS(fps int) error {
	if fps <= 0 {
		return ErrInvalidFPS
	}
	q.mu.Lock()
	q.cfg.FPS = fps
	q.mu.Unlock()
	return nil
}

func (q *quicksyncEncoder) Close() error {
	return nil
}

func (q *quicksyncEncoder) Name() string {
	return "quicksync"
}

func (q *quicksyncEncoder) IsHardware() bool {
	return true
}
