package desktop

import (
	"errors"
	"fmt"
	"sync"
)

type softwareEncoder struct {
	mu  sync.Mutex
	cfg EncoderConfig
}

func newSoftwareEncoder(cfg EncoderConfig) (encoderBackend, error) {
	return &softwareEncoder{cfg: cfg}, nil
}

func (s *softwareEncoder) Encode(frame []byte) ([]byte, error) {
	if len(frame) == 0 {
		return nil, errors.New("empty frame")
	}
	// Placeholder passthrough until x264/vpx bindings are integrated.
	out := make([]byte, len(frame))
	copy(out, frame)
	return out, nil
}

func (s *softwareEncoder) SetCodec(codec Codec) error {
	if !codec.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidCodec, codec)
	}
	s.mu.Lock()
	s.cfg.Codec = codec
	s.mu.Unlock()
	return nil
}

func (s *softwareEncoder) SetQuality(quality QualityPreset) error {
	if !quality.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidQuality, quality)
	}
	s.mu.Lock()
	s.cfg.Quality = quality
	s.mu.Unlock()
	return nil
}

func (s *softwareEncoder) SetBitrate(bitrate int) error {
	if bitrate <= 0 {
		return ErrInvalidBitrate
	}
	s.mu.Lock()
	s.cfg.Bitrate = bitrate
	s.mu.Unlock()
	return nil
}

func (s *softwareEncoder) SetFPS(fps int) error {
	if fps <= 0 {
		return ErrInvalidFPS
	}
	s.mu.Lock()
	s.cfg.FPS = fps
	s.mu.Unlock()
	return nil
}

func (s *softwareEncoder) Close() error {
	return nil
}

func (s *softwareEncoder) Name() string {
	return "software"
}

func (s *softwareEncoder) IsHardware() bool {
	return false
}
