package desktop

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
)

// ErrNoH264Encoder is returned when no real H264 encoder can be created: the
// software path resolved to the passthrough placeholder (OpenH264 failed to
// load) and no platform fallback produced an encoder either.
var ErrNoH264Encoder = errors.New("no H264 encoder available")

// placeholderFallbackFactory builds a real, CPU-input-capable H264 encoder for
// when OpenH264 cannot load and the software path would otherwise return the
// passthrough placeholder. Windows registers the Media Foundation encoder
// (hardware MFT, then Microsoft's software H264 MFT); other platforms leave it
// nil and keep failing with the OpenH264 cause (#11392).
var (
	placeholderFallbackMu      sync.Mutex
	placeholderFallbackFactory backendFactory
)

func registerPlaceholderFallbackFactory(factory backendFactory) {
	placeholderFallbackMu.Lock()
	defer placeholderFallbackMu.Unlock()
	placeholderFallbackFactory = factory
}

// openH264LoadError returns the cached OpenH264 load failure, or nil when the
// library loaded or no load has been attempted.
func openH264LoadError() error {
	openH264Mu.Lock()
	defer openH264Mu.Unlock()
	return openH264LoadErr
}

// openH264LoadErrorText is openH264LoadError for log fields.
func openH264LoadErrorText() string {
	if err := openH264LoadError(); err != nil {
		return err.Error()
	}
	return "unknown (no load failure recorded)"
}

// ReplacePlaceholderBackend swaps a placeholder backend for the platform's
// placeholder fallback encoder. It is a no-op returning nil when the backend
// is already a real encoder. When no fallback is registered, or the fallback
// fails, it returns an error wrapping ErrNoH264Encoder that names the OpenH264
// load failure and the fallback failure, and leaves the backend unchanged.
//
// Only session start calls this (StartSession). The mid-session swap to
// software (swapToSoftwareEncoder) deliberately does not: it runs because a
// hardware encoder stalled, and the fallback's first choice is the hardware
// MFT, which could be the encoder that just stalled.
func (v *VideoEncoder) ReplacePlaceholderBackend() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.backend != nil && !v.backend.IsPlaceholder() {
		return nil
	}

	openH264Cause := "OpenH264 failed to load: " + openH264LoadErrorText()

	placeholderFallbackMu.Lock()
	factory := placeholderFallbackFactory
	placeholderFallbackMu.Unlock()
	if factory == nil {
		return fmt.Errorf("%w: %s", ErrNoH264Encoder, openH264Cause)
	}

	fallback, err := factory(v.cfg)
	if err != nil {
		return fmt.Errorf("%w: %s; Media Foundation fallback failed: %v", ErrNoH264Encoder, openH264Cause, err)
	}
	if fallback == nil || fallback.IsPlaceholder() {
		if fallback != nil {
			_ = fallback.Close()
		}
		return fmt.Errorf("%w: %s; Media Foundation fallback returned no usable encoder", ErrNoH264Encoder, openH264Cause)
	}

	old := v.backend
	v.backend = fallback
	if old != nil {
		_ = old.Close()
	}
	slog.Warn("OpenH264 unavailable, using the placeholder fallback encoder instead of failing the session",
		"backend", fallback.Name(), "hardware", fallback.IsHardware(), "openh264Error", openH264LoadErrorText())
	return nil
}
