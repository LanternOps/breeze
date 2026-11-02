package desktop

import (
	"errors"
	"image"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// warmupStubEncoder is a hardware-reporting backend whose Encode behaviour is
// scripted per call, so the warm-up and restore paths can be driven without
// cgo/VideoToolbox. Encode runs on the warm-up goroutine while the test
// goroutine inspects it, hence the atomics.
type warmupStubEncoder struct {
	stubEncoder
	encode  func(call int) ([]byte, error)
	dimErr  error
	calls   atomic.Int32
	closed  atomic.Bool
	frameSz atomic.Int64
	keyed   atomic.Bool
	dims    atomic.Value // [2]int
}

func newWarmupStub(encode func(call int) ([]byte, error)) *warmupStubEncoder {
	s := &warmupStubEncoder{encode: encode}
	s.hardware = true
	return s
}

func (s *warmupStubEncoder) Encode(frame []byte) ([]byte, error) {
	n := int(s.calls.Add(1))
	s.frameSz.Store(int64(len(frame)))
	return s.encode(n)
}
func (s *warmupStubEncoder) SetDimensions(w, h int) error {
	s.dims.Store([2]int{w, h})
	return s.dimErr
}
func (s *warmupStubEncoder) Close() error         { s.closed.Store(true); return nil }
func (s *warmupStubEncoder) Name() string         { return "warmup-stub" }
func (s *warmupStubEncoder) ForceKeyframe() error { s.keyed.Store(true); return nil }

// trackingSoftwareEncoder stands in for the live OpenH264 encoder; the tests
// assert it is never touched (closed or swapped out) by a failed warm-up.
type trackingSoftwareEncoder struct {
	stubEncoder
	closed atomic.Bool
}

func (s *trackingSoftwareEncoder) Close() error { s.closed.Store(true); return nil }
func (s *trackingSoftwareEncoder) Name() string { return "openh264" }

// boundsCapturer reports configurable screen bounds; only the capture loop
// (the test goroutine here) reads it.
type boundsCapturer struct{ w, h int }

func (c *boundsCapturer) Capture() (*image.RGBA, error) { return nil, nil }
func (c *boundsCapturer) CaptureRegion(int, int, int, int) (*image.RGBA, error) {
	return nil, nil
}
func (c *boundsCapturer) GetScreenBounds() (int, int, error) { return c.w, c.h, nil }
func (c *boundsCapturer) Close() error                       { return nil }

func encodeOK(int) ([]byte, error) { return []byte{0, 0, 0, 1, 0x65}, nil }
func encodeTimeout(int) ([]byte, error) {
	return nil, errors.New("videotoolbox encode timed out")
}

// withWarmupTestHooks shortens the warm-up budget, swaps the restore-candidate
// factory for one returning the given backend, and clears the process-lifetime
// verdict store, restoring all three afterwards.
func withWarmupTestHooks(t *testing.T, budget time.Duration, backend func() encoderBackend) {
	t.Helper()
	prevBudget, prevGap, prevFactory := hardwareWarmupBudget, hardwareWarmupRetryGap, newHardwareRestoreCandidate
	hardwareWarmupBudget = budget
	hardwareWarmupRetryGap = time.Millisecond
	if backend != nil {
		newHardwareRestoreCandidate = func(cfg EncoderConfig) (*VideoEncoder, error) {
			return &VideoEncoder{cfg: cfg, backend: backend()}, nil
		}
	}
	resetHardwareEncoderVerdicts()
	t.Cleanup(func() {
		hardwareWarmupBudget, hardwareWarmupRetryGap, newHardwareRestoreCandidate = prevBudget, prevGap, prevFactory
		resetHardwareEncoderVerdicts()
	})
}

// newDemotedSession returns a session running on a (tracked) software encoder
// whose restore policy is armed and due at the returned time.
func newDemotedSession(w, h int) (*Session, *trackingSoftwareEncoder, time.Time) {
	s := &Session{id: "warmup-test", done: make(chan struct{})}
	s.capturer = &boundsCapturer{w: w, h: h}
	sw := &trackingSoftwareEncoder{}
	s.encoder.Store(&VideoEncoder{backend: sw})
	t0 := time.Unix(0, 0)
	s.hwRestore.onDemotedFromHardware(t0)
	return s, sw, t0.Add(time.Hour)
}

// pumpRestore keeps ticking the capture-loop entry point until the in-flight
// warm-up (if any) has been collected, like the ticker loop does.
func pumpRestore(t *testing.T, s *Session, now time.Time) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for s.hwWarmupCh != nil {
		if time.Now().After(deadline) {
			t.Fatalf("warm-up result never arrived")
		}
		s.maybeRestoreHardwareEncoder(now)
		time.Sleep(time.Millisecond)
	}
}

func TestWarmUpHardwareEncoder(t *testing.T) {
	cases := []struct {
		name       string
		encode     func(int) ([]byte, error)
		dimErr     error
		cancel     bool
		wantOK     bool
		wantClosed bool
		minCalls   int32
	}{
		{name: "first frame proves the encoder", encode: encodeOK, wantOK: true, minCalls: 1},
		{
			name: "cold-start stall that recovers within the budget still succeeds",
			encode: func(n int) ([]byte, error) {
				if n < 3 {
					return nil, errors.New("videotoolbox encode timed out")
				}
				return []byte{0, 0, 0, 1, 0x65}, nil
			},
			wantOK: true, minCalls: 3,
		},
		{
			name:   "buffering (nil output, nil error) is not success",
			encode: func(int) ([]byte, error) { return nil, nil },
			wantOK: false, wantClosed: true, minCalls: 1,
		},
		{name: "encoder that never emits is discarded", encode: encodeTimeout, wantOK: false, wantClosed: true, minCalls: 1},
		{name: "session creation failure is a warm-up failure", encode: encodeOK, dimErr: errors.New("videotoolbox create session failed: OSStatus=-12902"), wantOK: false, wantClosed: true},
		{name: "session end cancels and discards", encode: encodeTimeout, cancel: true, wantOK: false, wantClosed: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := newWarmupStub(tc.encode)
			stub.dimErr = tc.dimErr
			enc := &VideoEncoder{backend: stub}
			done := make(chan struct{})
			if tc.cancel {
				close(done)
			}

			res := warmUpHardwareEncoder(enc, 64, 48, PixelFormatBGRA, 200*time.Millisecond, time.Millisecond, done)

			if ok := res.err == nil; ok != tc.wantOK {
				t.Fatalf("ok = %v (err=%v), want %v", ok, res.err, tc.wantOK)
			}
			if tc.wantOK {
				if res.enc != enc {
					t.Fatalf("a proven encoder must be handed back")
				}
				if !stub.keyed.Load() {
					t.Fatalf("a proven encoder must have a keyframe queued for its first live frame")
				}
				if got := stub.frameSz.Load(); got != 64*48*4 {
					t.Fatalf("warm-up frame size = %d, want %d", got, 64*48*4)
				}
			} else if res.enc != nil {
				t.Fatalf("a failed warm-up must not hand back an encoder")
			}
			if stub.closed.Load() != tc.wantClosed {
				t.Fatalf("closed = %v, want %v", stub.closed.Load(), tc.wantClosed)
			}
			if stub.calls.Load() < tc.minCalls {
				t.Fatalf("Encode calls = %d, want >= %d", stub.calls.Load(), tc.minCalls)
			}
			if res.width != 64 || res.height != 48 {
				t.Fatalf("result dims = %dx%d, want 64x48", res.width, res.height)
			}
		})
	}
}

// The live encoder must keep serving frames while the candidate warms up, and
// only be replaced once the candidate has proven itself.
func TestMaybeRestoreHardwareEncoder_SwapsOnlyAfterWarmupSucceeds(t *testing.T) {
	release := make(chan struct{})
	hw := newWarmupStub(func(int) ([]byte, error) {
		<-release
		return []byte{0, 0, 0, 1, 0x65}, nil
	})
	withWarmupTestHooks(t, 2*time.Second, func() encoderBackend { return hw })
	s, sw, now := newDemotedSession(1920, 1080)

	s.maybeRestoreHardwareEncoder(now)
	if s.hwWarmupCh == nil || !s.hwRestore.warming {
		t.Fatalf("a due restore must start a warm-up")
	}
	// Several capture-loop ticks while the candidate is still warming.
	for i := 0; i < 5; i++ {
		s.maybeRestoreHardwareEncoder(now)
	}
	if s.encoder.Load().backend != sw || sw.closed.Load() {
		t.Fatalf("the live software encoder must stay in place during warm-up")
	}
	if s.hwRestore.attempts != 1 {
		t.Fatalf("ticks during warm-up must not start further attempts, attempts=%d", s.hwRestore.attempts)
	}

	close(release)
	pumpRestore(t, s, now)

	if s.encoder.Load().backend != hw {
		t.Fatalf("a proven candidate must become the live encoder")
	}
	if !sw.closed.Load() {
		t.Fatalf("the replaced software encoder must be closed")
	}
	if s.hwRestore.demoted || s.hwRestore.warming {
		t.Fatalf("policy must be disarmed after a successful restore")
	}
	if d, _ := hw.dims.Load().([2]int); d != [2]int{1920, 1080} {
		t.Fatalf("candidate dimensions = %v, want 1920x1080", d)
	}
}

// The #10880 machine: hardware never produced a frame at session start and the
// first warm-up fails. The live software encoder is untouched, the session
// gives up, and the verdict is remembered so the next session starts on
// software.
func TestMaybeRestoreHardwareEncoder_DeadEncoderGivesUpAndRemembers(t *testing.T) {
	var built atomic.Int32
	withWarmupTestHooks(t, 20*time.Millisecond, func() encoderBackend {
		built.Add(1)
		return newWarmupStub(encodeTimeout)
	})
	s, sw, now := newDemotedSession(1920, 1080)

	s.maybeRestoreHardwareEncoder(now)
	pumpRestore(t, s, now)

	if s.encoder.Load().backend != sw || sw.closed.Load() {
		t.Fatalf("a failed warm-up must never touch the live software encoder")
	}
	if s.hwRestore.shouldAttempt(now.Add(24 * time.Hour)) {
		t.Fatalf("a never-producing encoder must stop restore attempts for the session")
	}
	if !hardwareEncoderKnownDead(1920, 1080) {
		t.Fatalf("the verdict must be remembered for these dimensions")
	}
	if hardwareEncoderKnownDead(2560, 1440) {
		t.Fatalf("the verdict is per resolution, not global")
	}
	if built.Load() != 1 {
		t.Fatalf("exactly one hardware attempt expected, got %d", built.Load())
	}
}

// When hardware did produce frames earlier in the session, a failed warm-up
// only backs off; it neither gives up nor records a process-wide verdict.
func TestMaybeRestoreHardwareEncoder_FailureAfterOutputBacksOff(t *testing.T) {
	withWarmupTestHooks(t, 20*time.Millisecond, func() encoderBackend { return newWarmupStub(encodeTimeout) })
	s, sw, now := newDemotedSession(1920, 1080)
	s.hwRestore.noteHardwareOutput()

	s.maybeRestoreHardwareEncoder(now)
	pumpRestore(t, s, now)

	if s.encoder.Load().backend != sw || sw.closed.Load() {
		t.Fatalf("a failed warm-up must never touch the live software encoder")
	}
	if hardwareEncoderKnownDead(1920, 1080) {
		t.Fatalf("no verdict when hardware has produced frames this session")
	}
	if !s.hwRestore.shouldAttempt(now.Add(time.Hour)) {
		t.Fatalf("a later attempt must still be scheduled")
	}
}

// A verdict learned by an earlier (or concurrent) session short-circuits the
// restore without building a candidate.
func TestMaybeRestoreHardwareEncoder_KnownDeadSkipsCandidate(t *testing.T) {
	var built atomic.Int32
	withWarmupTestHooks(t, time.Second, func() encoderBackend {
		built.Add(1)
		return newWarmupStub(encodeOK)
	})
	rememberHardwareEncoderDead(1920, 1080)
	s, sw, now := newDemotedSession(1920, 1080)

	s.maybeRestoreHardwareEncoder(now)

	if built.Load() != 0 || s.hwWarmupCh != nil {
		t.Fatalf("a known-dead resolution must not build or warm a candidate")
	}
	if s.encoder.Load().backend != sw {
		t.Fatalf("live encoder must be unchanged")
	}
	if s.hwRestore.shouldAttempt(now.Add(24 * time.Hour)) {
		t.Fatalf("known-dead resolution must stop further attempts")
	}
}

// If the display resolution changed while the candidate warmed up, it was
// proven at the wrong size: discard it, keep software, record no verdict.
func TestMaybeRestoreHardwareEncoder_ResolutionChangeDuringWarmupDiscards(t *testing.T) {
	release := make(chan struct{})
	hw := newWarmupStub(func(int) ([]byte, error) {
		<-release
		return []byte{0, 0, 0, 1, 0x65}, nil
	})
	withWarmupTestHooks(t, 2*time.Second, func() encoderBackend { return hw })
	s, sw, now := newDemotedSession(1920, 1080)

	s.maybeRestoreHardwareEncoder(now)
	s.capturer.(*boundsCapturer).w, s.capturer.(*boundsCapturer).h = 2560, 1440
	close(release)
	pumpRestore(t, s, now)

	if s.encoder.Load().backend != sw || sw.closed.Load() {
		t.Fatalf("a stale-resolution candidate must not replace the live encoder")
	}
	if !hw.closed.Load() {
		t.Fatalf("the discarded candidate must be closed")
	}
	if hardwareEncoderKnownDead(1920, 1080) || hardwareEncoderKnownDead(2560, 1440) {
		t.Fatalf("an inconclusive warm-up must not record a verdict")
	}
	if !s.hwRestore.demoted || s.hwRestore.warming {
		t.Fatalf("policy must stay armed for a later attempt")
	}
}

// When the session ends mid warm-up, the goroutine discards its candidate
// instead of blocking forever on the handoff.
func TestRunHardwareWarmup_SessionEndDiscardsUnclaimedCandidate(t *testing.T) {
	stub := newWarmupStub(encodeOK)
	done := make(chan struct{})
	out := make(chan hardwareWarmupResult) // never received from
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		runHardwareWarmup(&VideoEncoder{backend: stub}, 64, 48, PixelFormatRGBA, time.Second, time.Millisecond, done, out)
	}()
	// Let it prove the encoder and park on the handoff, then end the session.
	deadline := time.Now().Add(2 * time.Second)
	for stub.calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	close(done)
	wg.Wait()
	if !stub.closed.Load() {
		t.Fatalf("an unclaimed proven candidate must be closed when the session ends")
	}
}

func TestHardwareEncoderVerdicts(t *testing.T) {
	resetHardwareEncoderVerdicts()
	t.Cleanup(resetHardwareEncoderVerdicts)

	if hardwareEncoderKnownDead(1920, 1080) {
		t.Fatalf("fresh process must have no verdicts")
	}
	rememberHardwareEncoderDead(1921, 1081) // odd capture size, encoder rounds to even
	if !hardwareEncoderKnownDead(1920, 1080) {
		t.Fatalf("verdict must be keyed by the encoder's even-rounded dimensions")
	}
	if hardwareEncoderKnownDead(3840, 2160) {
		t.Fatalf("other resolutions must be unaffected")
	}
	if hardwareEncoderKnownDead(0, 0) {
		t.Fatalf("zero dimensions are never known-dead")
	}
	for i := 0; i < maxHardwareEncoderVerdicts*2; i++ {
		rememberHardwareEncoderDead(100+2*i, 100)
	}
	if n := hardwareEncoderVerdictCount(); n > maxHardwareEncoderVerdicts {
		t.Fatalf("verdict store must stay bounded, has %d entries", n)
	}
}
