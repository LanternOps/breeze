package desktop

import (
	"errors"
	"strings"
	"testing"
)

// fallbackStub is a non-placeholder backend handed out by a test fallback factory.
type fallbackStub struct {
	stubEncoder
	name        string
	placeholder bool
}

func (f *fallbackStub) Name() string        { return f.name }
func (f *fallbackStub) IsPlaceholder() bool { return f.placeholder }

// swapPlaceholderFallbackFactory installs fn as the placeholder fallback for
// the duration of the test (nil simulates a platform with no fallback).
func swapPlaceholderFallbackFactory(t *testing.T, fn backendFactory) {
	t.Helper()
	placeholderFallbackMu.Lock()
	prev := placeholderFallbackFactory
	placeholderFallbackFactory = fn
	placeholderFallbackMu.Unlock()
	t.Cleanup(func() {
		placeholderFallbackMu.Lock()
		placeholderFallbackFactory = prev
		placeholderFallbackMu.Unlock()
	})
}

// swapOpenH264LoadErr sets the cached OpenH264 load failure for the test.
func swapOpenH264LoadErr(t *testing.T, err error) {
	t.Helper()
	openH264Mu.Lock()
	prev := openH264LoadErr
	openH264LoadErr = err
	openH264Mu.Unlock()
	t.Cleanup(func() {
		openH264Mu.Lock()
		openH264LoadErr = prev
		openH264Mu.Unlock()
	})
}

func newPlaceholderVideoEncoder() *VideoEncoder {
	cfg := applyDefaults(EncoderConfig{PreferHardware: false})
	return &VideoEncoder{cfg: cfg, backend: &softwareEncoder{cfg: cfg}}
}

func TestReplacePlaceholderBackend_UsesFallbackWhenOpenH264Missing(t *testing.T) {
	swapOpenH264LoadErr(t, errors.New("find OpenH264 library: auto-download OpenH264: dial tcp: i/o timeout"))
	var gotCfg EncoderConfig
	calls := 0
	swapPlaceholderFallbackFactory(t, func(cfg EncoderConfig) (encoderBackend, error) {
		calls++
		gotCfg = cfg
		return &fallbackStub{name: "mft-software"}, nil
	})

	enc := newPlaceholderVideoEncoder()
	if err := enc.ReplacePlaceholderBackend(); err != nil {
		t.Fatalf("ReplacePlaceholderBackend: %v", err)
	}
	if calls != 1 {
		t.Fatalf("fallback factory calls = %d, want 1", calls)
	}
	if enc.BackendIsPlaceholder() {
		t.Fatal("backend is still the placeholder after a successful fallback")
	}
	if got := enc.BackendName(); got != "mft-software" {
		t.Fatalf("BackendName = %q, want mft-software", got)
	}
	if gotCfg.Codec != CodecH264 || gotCfg.Bitrate != enc.cfg.Bitrate || gotCfg.FPS != enc.cfg.FPS {
		t.Fatalf("fallback got cfg %+v, want the encoder's own cfg %+v", gotCfg, enc.cfg)
	}
}

func TestReplacePlaceholderBackend_NoopForRealBackend(t *testing.T) {
	calls := 0
	swapPlaceholderFallbackFactory(t, func(cfg EncoderConfig) (encoderBackend, error) {
		calls++
		return &fallbackStub{name: "mft-software"}, nil
	})

	real := &fallbackStub{name: "openh264"}
	enc := &VideoEncoder{cfg: applyDefaults(EncoderConfig{}), backend: real}
	if err := enc.ReplacePlaceholderBackend(); err != nil {
		t.Fatalf("ReplacePlaceholderBackend on a real backend: %v", err)
	}
	if calls != 0 {
		t.Fatalf("fallback factory called %d times for a real backend, want 0", calls)
	}
	if enc.BackendName() != "openh264" {
		t.Fatalf("BackendName = %q, want openh264 (unchanged)", enc.BackendName())
	}
}

func TestReplacePlaceholderBackend_ErrorNamesOpenH264AndFallbackCauses(t *testing.T) {
	swapOpenH264LoadErr(t, errors.New("load OpenH264 library C:\\ProgramData\\Breeze\\openh264-2.4.1-win64.dll: Access is denied."))
	swapPlaceholderFallbackFactory(t, func(cfg EncoderConfig) (encoderBackend, error) {
		return nil, errors.New("no H264 Media Foundation encoder available")
	})

	enc := newPlaceholderVideoEncoder()
	err := enc.ReplacePlaceholderBackend()
	if err == nil {
		t.Fatal("ReplacePlaceholderBackend succeeded with a failing fallback, want error")
	}
	if !errors.Is(err, ErrNoH264Encoder) {
		t.Fatalf("error %v does not wrap ErrNoH264Encoder", err)
	}
	msg := err.Error()
	for _, want := range []string{"Access is denied", "openh264-2.4.1-win64.dll", "no H264 Media Foundation encoder available"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not name %q", msg, want)
		}
	}
	if !enc.BackendIsPlaceholder() {
		t.Fatal("backend changed after a failed fallback")
	}
}

func TestReplacePlaceholderBackend_NoFallbackRegistered(t *testing.T) {
	swapOpenH264LoadErr(t, errors.New("find OpenH264 library: checksum mismatch"))
	swapPlaceholderFallbackFactory(t, nil)

	enc := newPlaceholderVideoEncoder()
	err := enc.ReplacePlaceholderBackend()
	if err == nil {
		t.Fatal("ReplacePlaceholderBackend succeeded with no fallback registered, want error")
	}
	if !errors.Is(err, ErrNoH264Encoder) {
		t.Fatalf("error %v does not wrap ErrNoH264Encoder", err)
	}
	if !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("error %q does not name the OpenH264 load failure", err.Error())
	}
	if !enc.BackendIsPlaceholder() {
		t.Fatal("backend changed with no fallback registered")
	}
}

func TestReplacePlaceholderBackend_RejectsPlaceholderFromFallback(t *testing.T) {
	swapOpenH264LoadErr(t, errors.New("find OpenH264 library: not found"))
	swapPlaceholderFallbackFactory(t, func(cfg EncoderConfig) (encoderBackend, error) {
		return &fallbackStub{name: "bogus", placeholder: true}, nil
	})

	enc := newPlaceholderVideoEncoder()
	if err := enc.ReplacePlaceholderBackend(); err == nil {
		t.Fatal("accepted a placeholder from the fallback factory, want error")
	}
	if enc.BackendName() != "software" {
		t.Fatalf("BackendName = %q, want the original software placeholder", enc.BackendName())
	}
}

func TestReplacePlaceholderBackend_UnknownOpenH264Cause(t *testing.T) {
	swapOpenH264LoadErr(t, nil)
	swapPlaceholderFallbackFactory(t, nil)

	enc := newPlaceholderVideoEncoder()
	err := enc.ReplacePlaceholderBackend()
	if err == nil {
		t.Fatal("want error")
	}
	if !strings.Contains(err.Error(), "OpenH264") {
		t.Fatalf("error %q does not mention OpenH264", err.Error())
	}
}
