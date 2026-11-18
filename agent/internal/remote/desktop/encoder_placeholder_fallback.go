package desktop

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
)

// ErrNoH264Encoder is returned when no real H264 encoder can be created: the
// software path resolved to the passthrough placeholder (OpenH264 failed to
// load) and no platform fallback produced a working encoder either.
var ErrNoH264Encoder = errors.New("no H264 encoder available")

// placeholderFallbackFactory builds a real, CPU-input-capable H264 encoder for
// when OpenH264 cannot load and the software path would otherwise return the
// passthrough placeholder. Windows registers the Media Foundation encoder
// (mft_windows.go); other platforms leave it nil and keep failing, now with
// the OpenH264 cause in the error (#11392). placeholderFallbackLabel names it
// in operator-facing errors.
var (
	placeholderFallbackMu      sync.Mutex
	placeholderFallbackFactory backendFactory
	placeholderFallbackLabel   string
)

func registerPlaceholderFallbackFactory(label string, factory backendFactory) {
	placeholderFallbackMu.Lock()
	defer placeholderFallbackMu.Unlock()
	placeholderFallbackLabel = label
	placeholderFallbackFactory = factory
}

func placeholderFallback() (string, backendFactory) {
	placeholderFallbackMu.Lock()
	defer placeholderFallbackMu.Unlock()
	return placeholderFallbackLabel, placeholderFallbackFactory
}

// optionalInitErrorReporter is implemented by backends that activate lazily
// and swallow an activation failure (mftEncoder.SetDimensions only logs it, to
// retry on the next Encode). InitError reports that failure, or nil once the
// backend is activated.
type optionalInitErrorReporter interface {
	InitError() error
}

// openH264LoadError returns the cached OpenH264 load failure, or nil when the
// library loaded or no load has been attempted.
func openH264LoadError() error {
	openH264Mu.Lock()
	defer openH264Mu.Unlock()
	return openH264LoadErr
}

// openH264LoadErrorText is openH264LoadError for log fields and error text.
func openH264LoadErrorText() string {
	if err := openH264LoadError(); err != nil {
		return err.Error()
	}
	return "no load failure recorded (load not attempted yet, or a retry is in progress; see the agent log)"
}

func openH264Cause() string {
	return "OpenH264 failed to load: " + openH264LoadErrorText()
}

// ReplacePlaceholderBackend swaps a placeholder backend for the platform's
// placeholder fallback encoder, built from this encoder's config (the
// fallback honours PreferHardware). It is a no-op returning nil when the
// backend is already a real encoder. When no fallback is registered, or the
// fallback fails, it returns an error wrapping ErrNoH264Encoder that names
// the OpenH264 load failure and the fallback failure, and leaves the backend
// unchanged.
//
// A lazily-activated fallback (MFT) can still fail at SetDimensions; callers
// check FallbackActivationError after it.
func (v *VideoEncoder) ReplacePlaceholderBackend() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.backend != nil && !v.backend.IsPlaceholder() {
		return nil
	}

	label, factory := placeholderFallback()
	if factory == nil {
		return fmt.Errorf("%w: %s", ErrNoH264Encoder, openH264Cause())
	}

	// Runs under v.mu: the factory only probes (no activation), and callers
	// hold an encoder that no other goroutine is using yet.
	fallback, err := factory(v.cfg)
	if err != nil {
		return fmt.Errorf("%w: %s; %s fallback failed: %v", ErrNoH264Encoder, openH264Cause(), label, err)
	}
	if fallback == nil || fallback.IsPlaceholder() {
		if fallback != nil {
			closeBackendLogged(fallback, "rejected placeholder fallback")
		}
		return fmt.Errorf("%w: %s; %s fallback returned no usable encoder", ErrNoH264Encoder, openH264Cause(), label)
	}

	old := v.backend
	v.backend = fallback
	if old != nil {
		closeBackendLogged(old, "replaced placeholder")
	}
	slog.Warn("OpenH264 unavailable, using the placeholder fallback encoder",
		"fallback", label, "backend", fallback.Name(), "openh264Error", openH264LoadErrorText())
	return nil
}

// FallbackActivationError reports a lazily-activated backend that failed to
// activate (see optionalInitErrorReporter) as an ErrNoH264Encoder error naming
// the OpenH264 cause. It returns nil for an activated backend or one that has
// no lazy activation.
func (v *VideoEncoder) FallbackActivationError() error {
	v.mu.Lock()
	backend := v.backend
	v.mu.Unlock()
	r, ok := backend.(optionalInitErrorReporter)
	if !ok {
		return nil
	}
	initErr := r.InitError()
	if initErr == nil {
		return nil
	}
	label, _ := placeholderFallback()
	if label == "" {
		label = "platform"
	}
	return fmt.Errorf("%w: %s; %s fallback encoder (%s) could not be activated: %v",
		ErrNoH264Encoder, openH264Cause(), label, backend.Name(), initErr)
}

func closeBackendLogged(b encoderBackend, what string) {
	if err := b.Close(); err != nil {
		slog.Warn("Encoder backend close failed", "what", what, "backend", b.Name(), "error", err.Error())
	}
}

// mftKind is one class of Media Foundation H264 encoder.
type mftKind int

const (
	mftKindHardware mftKind = iota
	mftKindSoftware
)

func (k mftKind) String() string {
	if k == mftKindSoftware {
		return "software"
	}
	return "hardware"
}

// mftSearchOrder is the order mftEncoder.findEncoder tries MFT kinds in. The
// regular hardware factory is hardware-only, so OpenH264 keeps precedence over
// Microsoft's software MFT (which stalls 20-60 frames on Server editions). The
// placeholder fallback (allowSoftware) also tries the software MFT, first when
// the caller did not prefer hardware — a secure-desktop start, a known-dead
// hardware verdict, or a mid-session demotion from a stalled hardware MFT.
// Lives outside mft_windows.go so the policy is testable on every platform.
func mftSearchOrder(allowSoftware, preferHardware bool) []mftKind {
	switch {
	case !allowSoftware:
		return []mftKind{mftKindHardware}
	case preferHardware:
		return []mftKind{mftKindHardware, mftKindSoftware}
	default:
		return []mftKind{mftKindSoftware, mftKindHardware}
	}
}
