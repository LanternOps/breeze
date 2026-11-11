package desktop

import (
	"errors"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fallbackStub is a backend handed out by a test fallback factory. It records
// Close calls and can report an activation failure like mftEncoder.InitError.
type fallbackStub struct {
	stubEncoder
	name        string
	placeholder bool
	initErr     error
	closes      atomic.Int32
}

func (f *fallbackStub) Name() string        { return f.name }
func (f *fallbackStub) IsPlaceholder() bool { return f.placeholder }
func (f *fallbackStub) Close() error        { f.closes.Add(1); return nil }
func (f *fallbackStub) InitError() error    { return f.initErr }

// closeTrackingPlaceholder is the software placeholder with a Close counter.
type closeTrackingPlaceholder struct {
	softwareEncoder
	closes atomic.Int32
}

func (p *closeTrackingPlaceholder) Close() error { p.closes.Add(1); return nil }

// swapPlaceholderFallbackFactory installs fn as the placeholder fallback for
// the duration of the test (nil simulates a platform with no fallback). These
// helpers mutate package globals: tests using them must not call t.Parallel.
func swapPlaceholderFallbackFactory(t *testing.T, fn backendFactory) {
	t.Helper()
	prevLabel, prevFn := placeholderFallback()
	registerPlaceholderFallbackFactory("Test", fn)
	t.Cleanup(func() { registerPlaceholderFallbackFactory(prevLabel, prevFn) })
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

func newPlaceholderVideoEncoder() (*VideoEncoder, *closeTrackingPlaceholder) {
	cfg := applyDefaults(EncoderConfig{Bitrate: 1234, FPS: 17, PreferHardware: false})
	p := &closeTrackingPlaceholder{softwareEncoder: softwareEncoder{cfg: cfg}}
	return &VideoEncoder{cfg: cfg, backend: p}, p
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

	enc, placeholder := newPlaceholderVideoEncoder()
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
	if gotCfg.Codec != CodecH264 || gotCfg.Bitrate != 1234 || gotCfg.FPS != 17 || gotCfg.PreferHardware {
		t.Fatalf("fallback got cfg %+v, want the encoder's own cfg (bitrate 1234, fps 17, PreferHardware false)", gotCfg)
	}
	if n := placeholder.closes.Load(); n != 1 {
		t.Fatalf("replaced placeholder closed %d times, want 1", n)
	}
}

func TestReplacePlaceholderBackend_NilBackendIsTreatedAsPlaceholder(t *testing.T) {
	swapOpenH264LoadErr(t, errors.New("find OpenH264 library: not found"))
	swapPlaceholderFallbackFactory(t, func(cfg EncoderConfig) (encoderBackend, error) {
		return &fallbackStub{name: "mft-software"}, nil
	})
	enc := &VideoEncoder{cfg: applyDefaults(EncoderConfig{})}
	if err := enc.ReplacePlaceholderBackend(); err != nil {
		t.Fatalf("ReplacePlaceholderBackend: %v", err)
	}
	if enc.BackendName() != "mft-software" {
		t.Fatalf("BackendName = %q, want mft-software", enc.BackendName())
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
	if enc.BackendName() != "openh264" || real.closes.Load() != 0 {
		t.Fatalf("real backend touched: name %q, closes %d", enc.BackendName(), real.closes.Load())
	}
}

func TestReplacePlaceholderBackend_ErrorNamesOpenH264AndFallbackCauses(t *testing.T) {
	swapOpenH264LoadErr(t, errors.New("load OpenH264 library C:\\ProgramData\\Breeze\\openh264-2.4.1-win64.dll: Access is denied."))
	swapPlaceholderFallbackFactory(t, func(cfg EncoderConfig) (encoderBackend, error) {
		return nil, errors.New("no hardware or software H264 Media Foundation encoder is registered")
	})

	enc, placeholder := newPlaceholderVideoEncoder()
	err := enc.ReplacePlaceholderBackend()
	if err == nil {
		t.Fatal("ReplacePlaceholderBackend succeeded with a failing fallback, want error")
	}
	if !errors.Is(err, ErrNoH264Encoder) {
		t.Fatalf("error %v does not wrap ErrNoH264Encoder", err)
	}
	msg := err.Error()
	for _, want := range []string{"no H264 encoder available", "Access is denied", "openh264-2.4.1-win64.dll", "Test fallback", "Media Foundation encoder is registered"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not name %q", msg, want)
		}
	}
	if !enc.BackendIsPlaceholder() || placeholder.closes.Load() != 0 {
		t.Fatal("backend changed or closed after a failed fallback")
	}
}

func TestReplacePlaceholderBackend_NoFallbackRegistered(t *testing.T) {
	swapOpenH264LoadErr(t, errors.New("find OpenH264 library: checksum mismatch"))
	swapPlaceholderFallbackFactory(t, nil)

	enc, _ := newPlaceholderVideoEncoder()
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

func TestReplacePlaceholderBackend_RejectsUnusableFallbackResult(t *testing.T) {
	swapOpenH264LoadErr(t, errors.New("find OpenH264 library: not found"))
	for _, tc := range []struct {
		name    string
		backend *fallbackStub
	}{
		{"placeholder", &fallbackStub{name: "bogus", placeholder: true}},
		{"nil", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			swapPlaceholderFallbackFactory(t, func(cfg EncoderConfig) (encoderBackend, error) {
				if tc.backend == nil {
					return nil, nil
				}
				return tc.backend, nil
			})
			enc, _ := newPlaceholderVideoEncoder()
			err := enc.ReplacePlaceholderBackend()
			if !errors.Is(err, ErrNoH264Encoder) {
				t.Fatalf("err = %v, want ErrNoH264Encoder", err)
			}
			if !strings.Contains(err.Error(), "returned no usable encoder") {
				t.Fatalf("error %q does not say the fallback was unusable", err.Error())
			}
			if enc.BackendName() != "software" {
				t.Fatalf("BackendName = %q, want the original software placeholder", enc.BackendName())
			}
			if tc.backend != nil && tc.backend.closes.Load() != 1 {
				t.Fatalf("rejected fallback closed %d times, want 1", tc.backend.closes.Load())
			}
		})
	}
}

func TestReplacePlaceholderBackend_UnknownOpenH264Cause(t *testing.T) {
	swapOpenH264LoadErr(t, nil)
	swapPlaceholderFallbackFactory(t, nil)

	enc, _ := newPlaceholderVideoEncoder()
	err := enc.ReplacePlaceholderBackend()
	if err == nil {
		t.Fatal("want error")
	}
	if !strings.Contains(err.Error(), "no load failure recorded") {
		t.Fatalf("error %q does not say no OpenH264 load failure was recorded", err.Error())
	}
}

func TestFallbackActivationError(t *testing.T) {
	swapOpenH264LoadErr(t, errors.New("find OpenH264 library: not found"))
	swapPlaceholderFallbackFactory(t, nil)

	failed := &VideoEncoder{backend: &fallbackStub{name: "mft-software", initErr: errors.New("no hardware H264 MFT (x) and no software H264 MFT (y)")}}
	err := failed.FallbackActivationError()
	if !errors.Is(err, ErrNoH264Encoder) {
		t.Fatalf("err = %v, want ErrNoH264Encoder", err)
	}
	for _, want := range []string{"find OpenH264 library: not found", "no software H264 MFT (y)", "could not be activated"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not name %q", err.Error(), want)
		}
	}

	if err := (&VideoEncoder{backend: &fallbackStub{name: "mft-software"}}).FallbackActivationError(); err != nil {
		t.Fatalf("activated fallback reported %v, want nil", err)
	}
	// A backend without InitError (OpenH264, VideoToolbox) is activated by
	// construction.
	if err := (&VideoEncoder{backend: &stubEncoder{}}).FallbackActivationError(); err != nil {
		t.Fatalf("backend without InitError reported %v, want nil", err)
	}
}

func TestMFTSearchOrder(t *testing.T) {
	for _, tc := range []struct {
		allowSoftware, preferHardware bool
		want                          []mftKind
	}{
		// The regular hardware factory: hardware only, so OpenH264 keeps
		// precedence over Microsoft's software MFT.
		{false, true, []mftKind{mftKindHardware}},
		{false, false, []mftKind{mftKindHardware}},
		// Placeholder fallback on the Default desktop: hardware first.
		{true, true, []mftKind{mftKindHardware, mftKindSoftware}},
		// Placeholder fallback when the caller asked for software (secure
		// desktop, known-dead hardware, mid-session demotion): software first.
		{true, false, []mftKind{mftKindSoftware, mftKindHardware}},
	} {
		got := mftSearchOrder(tc.allowSoftware, tc.preferHardware)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("mftSearchOrder(allowSoftware=%v, preferHardware=%v) = %v, want %v",
				tc.allowSoftware, tc.preferHardware, got, tc.want)
		}
	}
}

// --- swapToSoftwareEncoder with the placeholder fallback -------------------

// withSoftwareSwapCandidate makes swapToSoftwareEncoder's NewVideoEncoder
// return a placeholder encoder (OpenH264 missing) and counts the calls.
func withSoftwareSwapCandidate(t *testing.T) *atomic.Int32 {
	t.Helper()
	var calls atomic.Int32
	prev := newSoftwareSwapCandidate
	newSoftwareSwapCandidate = func(cfg EncoderConfig) (*VideoEncoder, error) {
		calls.Add(1)
		cfg = applyDefaults(cfg)
		return &VideoEncoder{cfg: cfg, backend: &softwareEncoder{cfg: cfg}}, nil
	}
	t.Cleanup(func() { newSoftwareSwapCandidate = prev })
	return &calls
}

func newStalledSession(current *fallbackStub) *Session {
	s := &Session{id: "swap-test", done: make(chan struct{})}
	s.capturer = &boundsCapturer{w: 1280, h: 720}
	s.encoder.Store(&VideoEncoder{backend: current})
	return s
}

func TestSwapToSoftwareEncoder_UsesSoftwareFallbackWhenOpenH264Missing(t *testing.T) {
	swapOpenH264LoadErr(t, errors.New("find OpenH264 library: not found"))
	withSoftwareSwapCandidate(t)
	var gotCfg EncoderConfig
	swapPlaceholderFallbackFactory(t, func(cfg EncoderConfig) (encoderBackend, error) {
		gotCfg = cfg
		return &fallbackStub{name: "mft-software"}, nil
	})
	stalled := &fallbackStub{name: "mft-hardware"}
	stalled.hardware = true
	s := newStalledSession(stalled)

	s.swapToSoftwareEncoder()

	if got := s.encoder.Load().BackendName(); got != "mft-software" {
		t.Fatalf("encoder after swap = %q, want mft-software", got)
	}
	if gotCfg.PreferHardware {
		t.Fatal("mid-session fallback asked for hardware first; it must prefer software")
	}
	if stalled.closes.Load() != 1 {
		t.Fatalf("stalled encoder closed %d times, want 1", stalled.closes.Load())
	}
}

func TestSwapToSoftwareEncoder_RejectsFallbackThatGainsNothing(t *testing.T) {
	stalledHW := func() *fallbackStub { f := &fallbackStub{name: "mft-hardware"}; f.hardware = true; return f }
	for _, tc := range []struct {
		name     string
		current  *fallbackStub
		fallback func() *fallbackStub
	}{
		// No software MFT: the fallback's last resort is a hardware MFT, which
		// may be the encoder that just stalled.
		{"hardware result", stalledHW(), func() *fallbackStub { f := &fallbackStub{name: "mft-hardware"}; f.hardware = true; return f }},
		// A stalled software MFT swapped for another software MFT.
		{"same backend", &fallbackStub{name: "mft-software"}, func() *fallbackStub { return &fallbackStub{name: "mft-software"} }},
		// Activation failed (SetDimensions only logs it).
		{"activation failed", stalledHW(), func() *fallbackStub {
			return &fallbackStub{name: "mft-software", initErr: errors.New("no software H264 MFT")}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			swapOpenH264LoadErr(t, errors.New("find OpenH264 library: not found"))
			calls := withSoftwareSwapCandidate(t)
			var made []*fallbackStub
			swapPlaceholderFallbackFactory(t, func(cfg EncoderConfig) (encoderBackend, error) {
				f := tc.fallback()
				made = append(made, f)
				return f, nil
			})
			s := newStalledSession(tc.current)

			s.swapToSoftwareEncoder()
			if got := s.encoder.Load().BackendName(); got != tc.current.name || tc.current.closes.Load() != 0 {
				t.Fatalf("encoder swapped to %q (current closed %d times), want the current %q kept", got, tc.current.closes.Load(), tc.current.name)
			}
			if len(made) != 1 || made[0].closes.Load() != 1 {
				t.Fatalf("rejected fallback not closed exactly once (made %d)", len(made))
			}

			// The stall check calls swapToSoftwareEncoder on every frame; within
			// the backoff it must not rebuild an encoder.
			s.swapToSoftwareEncoder()
			s.swapToSoftwareEncoder()
			if n := calls.Load(); n != 1 {
				t.Fatalf("encoder built %d times within the backoff, want 1", n)
			}

			// After the backoff it tries again.
			s.softwareSwapRetryAt.Store(time.Now().Add(-time.Second).UnixNano())
			s.swapToSoftwareEncoder()
			if n := calls.Load(); n != 2 {
				t.Fatalf("encoder built %d times after the backoff, want 2", n)
			}
		})
	}
}

func TestSwapToSoftwareEncoder_BacksOffWhenNoFallback(t *testing.T) {
	swapOpenH264LoadErr(t, errors.New("find OpenH264 library: not found"))
	calls := withSoftwareSwapCandidate(t)
	swapPlaceholderFallbackFactory(t, nil)
	stalled := &fallbackStub{name: "videotoolbox"}
	stalled.hardware = true
	s := newStalledSession(stalled)

	for i := 0; i < 5; i++ {
		s.swapToSoftwareEncoder()
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("encoder built %d times for 5 stall checks within the backoff, want 1", n)
	}
	if s.encoder.Load().BackendName() != "videotoolbox" {
		t.Fatal("current encoder replaced with no usable software encoder")
	}
}

// StartSession can't run here (it needs a real capturer and peer connection),
// so pin its wiring by source: the placeholder check must try the fallback and
// verify activation after SetDimensions, and the old bare refusal must be gone.
func TestStartSession_TriesPlaceholderFallback(t *testing.T) {
	b, err := os.ReadFile("session_webrtc.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	start := src[strings.Index(src, "func (m *SessionManager) StartSession("):]
	from := 0
	for _, n := range []string{
		"enc.BackendIsPlaceholder()",
		"enc.ReplacePlaceholderBackend()",
		"enc.SetDimensions(w, h)",
		"enc.FallbackActivationError()",
	} {
		i := strings.Index(start[from:], n)
		if i < 0 {
			t.Fatalf("StartSession: %q missing or out of order", n)
		}
		from += i + len(n)
	}
	if strings.Contains(start, `"no H264 encoder available (backend=%s)"`) {
		t.Fatal("StartSession still refuses a placeholder encoder without trying the fallback")
	}
}
