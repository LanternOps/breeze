package desktop

import (
	"errors"
	"image"
	"strings"
	"testing"
	"time"
)

// No build tag on purpose: the Test Agent CI job runs on ubuntu-latest, where
// the `darwin && cgo` SCStream shim compiles out. The stream policy lives in a
// platform-neutral controller so it is covered there (#5928).

// fakeSCKStream is an in-memory sckStreamBackend driven by a fake clock.
type fakeSCKStream struct {
	clock *fakeClock

	running    bool
	starts     []bool // refreshFilter argument of every start() call
	stops      int
	startErrs  []error // consumed one per start(); nil = success
	seq        uint64
	copies     int
	copyErr    error // returned once by the next copyLatest
	stopErr    error
	dispChange bool

	// firstFrameAfter delivers a frame this long after a successful start;
	// negative means the stream never produces one.
	firstFrameAfter time.Duration
	startedAt       time.Time
	pendingFrame    bool
}

func (f *fakeSCKStream) start(refreshFilter bool) error {
	f.starts = append(f.starts, refreshFilter)
	if len(f.startErrs) > 0 {
		err := f.startErrs[0]
		f.startErrs = f.startErrs[1:]
		if err != nil {
			return err
		}
	}
	f.running = true
	f.stopErr = nil
	f.dispChange = false
	f.startedAt = f.clock.t
	f.pendingFrame = true
	return nil
}

func (f *fakeSCKStream) stop() {
	if f.running {
		f.stops++
	}
	f.running = false
}

func (f *fakeSCKStream) frameSeq() uint64 {
	if f.running && f.pendingFrame && f.firstFrameAfter >= 0 &&
		!f.clock.t.Before(f.startedAt.Add(f.firstFrameAfter)) {
		f.seq++
		f.pendingFrame = false
	}
	return f.seq
}

func (f *fakeSCKStream) copyLatest() (*image.RGBA, uint64, error) {
	f.copies++
	if err := f.copyErr; err != nil {
		f.copyErr = nil
		return nil, 0, err
	}
	return image.NewRGBA(image.Rect(0, 0, 4, 2)), f.seq, nil
}

func (f *fakeSCKStream) stopError() error     { return f.stopErr }
func (f *fakeSCKStream) displayChanged() bool { return f.dispChange }

// newFrame simulates SCK delivering a new complete frame.
func (f *fakeSCKStream) newFrame() { f.seq++ }

type fakeClock struct {
	t      time.Time
	slept  time.Duration
	sleeps int
}

func (c *fakeClock) now() time.Time { return c.t }
func (c *fakeClock) sleep(d time.Duration) {
	c.sleeps++
	c.slept += d
	c.t = c.t.Add(d)
}
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newTestSCKController(t *testing.T) (*sckStreamController, *fakeSCKStream, *fakeClock) {
	t.Helper()
	clk := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	be := &fakeSCKStream{clock: clk}
	c := newSCKStreamController(be)
	c.now = clk.now
	c.sleep = clk.sleep
	c.slept = func(_, _ time.Time) bool { return false }
	return c, be, clk
}

func TestSCKStreamController_FirstCaptureStartsStreamAndWaitsForFirstFrame(t *testing.T) {
	c, be, clk := newTestSCKController(t)
	be.firstFrameAfter = 40 * time.Millisecond

	img, err := c.capture()
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if img == nil {
		t.Fatal("first capture returned no frame; the probe needs one")
	}
	if len(be.starts) != 1 || be.starts[0] {
		t.Fatalf("starts = %v, want one start reusing the init-time filter (refreshFilter=false)", be.starts)
	}
	if clk.slept < 40*time.Millisecond {
		t.Fatalf("slept %v, want the controller to have waited for the first frame", clk.slept)
	}
}

func TestSCKStreamController_FirstFrameTimeoutIsACaptureError(t *testing.T) {
	// The #6105 hosts: SCK initialises but never yields a frame. That must
	// surface as a capture-phase error so the probe's retry + CoreGraphics
	// fallback (#7046) still engages.
	c, be, _ := newTestSCKController(t)
	be.firstFrameAfter = -1

	img, err := c.capture()
	if err == nil || img != nil {
		t.Fatalf("capture = (%v, %v), want a first-frame timeout error", img, err)
	}
	if !strings.Contains(err.Error(), "first frame") {
		t.Fatalf("error %q should name the first-frame timeout", err)
	}
	if be.running {
		t.Fatal("stream left running after first-frame timeout")
	}
}

func TestSCKStreamController_UnchangedFrameIsNilUntilRedeliveryInterval(t *testing.T) {
	c, be, clk := newTestSCKController(t)
	if img, err := c.capture(); err != nil || img == nil {
		t.Fatalf("first capture = (%v, %v)", img, err)
	}
	copies := be.copies

	clk.advance(10 * time.Millisecond)
	img, err := c.capture()
	if err != nil || img != nil {
		t.Fatalf("unchanged capture = (%v, %v), want (nil, nil) — no copy for an unchanged screen", img, err)
	}
	if be.copies != copies {
		t.Fatal("unchanged frame was copied")
	}

	// A static screen still has its latest frame redelivered periodically, so
	// a session whose first encode comes after the probe frame is not left
	// black (the probe consumed the only frame SCK sent).
	clk.advance(sckRedeliverInterval)
	if img, err := c.capture(); err != nil || img == nil {
		t.Fatalf("capture after redeliver interval = (%v, %v), want the latest frame", img, err)
	}
}

func TestSCKStreamController_NewFrameIsDeliveredImmediately(t *testing.T) {
	c, be, clk := newTestSCKController(t)
	if _, err := c.capture(); err != nil {
		t.Fatal(err)
	}
	clk.advance(time.Millisecond)
	be.newFrame()
	img, err := c.capture()
	if err != nil || img == nil {
		t.Fatalf("capture after new frame = (%v, %v)", img, err)
	}
	if clk.sleeps != 0 {
		t.Fatalf("capture blocked (%d sleeps) with a frame ready; capture must not block encode", clk.sleeps)
	}
}

func TestSCKStreamController_StreamStopRestartsWithBackoffAndReportsErrors(t *testing.T) {
	c, be, clk := newTestSCKController(t)
	if _, err := c.capture(); err != nil {
		t.Fatal(err)
	}

	be.stopErr = errors.New("stream stopped: -3815")
	be.startErrs = []error{errors.New("start failed"), errors.New("start failed"), nil}

	// Stop observed: stream torn down, first restart attempt fails.
	if img, err := c.capture(); err == nil || img != nil {
		t.Fatalf("capture after stream stop = (%v, %v), want an error (a nil frame would mask the no-video watchdog)", img, err)
	}
	if be.stops != 1 {
		t.Fatalf("stops = %d, want the stopped stream released", be.stops)
	}

	// During backoff every call is an error, never (nil, nil), and blocks at
	// most sckMaxBackoffWait per call.
	before := clk.slept
	_, err := c.capture()
	if err == nil {
		t.Fatal("capture during backoff returned nil error")
	}
	if clk.slept-before > sckMaxBackoffWait {
		t.Fatalf("one capture slept %v, cap is %v", clk.slept-before, sckMaxBackoffWait)
	}

	// Keep calling until the stream is back; restarts must refresh the filter.
	var img *image.RGBA
	for i := 0; i < 200 && img == nil; i++ {
		img, _ = c.capture()
	}
	if img == nil {
		t.Fatal("stream never recovered")
	}
	for i, refresh := range be.starts[1:] {
		if !refresh {
			t.Fatalf("restart #%d reused the stale filter; restarts must re-query shareable content", i+1)
		}
	}
	if c.backoff != 0 {
		t.Fatalf("backoff = %v after a delivered frame, want reset", c.backoff)
	}
}

func TestSCKStreamController_BackoffDoublesAndCaps(t *testing.T) {
	c, be, _ := newTestSCKController(t)
	be.startErrs = make([]error, 20)
	for i := range be.startErrs {
		be.startErrs[i] = errors.New("nope")
	}
	// Record the backoff after every start attempt (len(be.starts) grows).
	var seen []time.Duration
	for i := 0; i < 400 && len(be.starts) < 8; i++ {
		n := len(be.starts)
		_, _ = c.capture()
		if len(be.starts) != n {
			seen = append(seen, c.backoff)
		}
	}
	want := []time.Duration{sckBackoffMin, 2 * sckBackoffMin, 4 * sckBackoffMin, 8 * sckBackoffMin, sckBackoffMax, sckBackoffMax, sckBackoffMax, sckBackoffMax}
	if len(seen) != len(want) {
		t.Fatalf("backoff after each failed start = %v, want %v", seen, want)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Fatalf("backoff after each failed start = %v, want %v", seen, want)
		}
	}
}

func TestSCKStreamController_DisplayChangeRestartsImmediately(t *testing.T) {
	c, be, clk := newTestSCKController(t)
	if _, err := c.capture(); err != nil {
		t.Fatal(err)
	}
	be.dispChange = true
	clk.advance(sckDisplayPollInterval)
	img, err := c.capture()
	if err != nil || img == nil {
		t.Fatalf("capture after display change = (%v, %v), want a frame from the rebuilt stream", img, err)
	}
	if be.stops != 1 || len(be.starts) != 2 || !be.starts[1] {
		t.Fatalf("stops=%d starts=%v, want one rebuild with a refreshed filter", be.stops, be.starts)
	}
}

func TestSCKStreamController_DisplayPollIsThrottled(t *testing.T) {
	c, be, clk := newTestSCKController(t)
	if _, err := c.capture(); err != nil {
		t.Fatal(err)
	}
	be.dispChange = true
	clk.advance(sckDisplayPollInterval / 4)
	_, _ = c.capture()
	if be.stops != 0 {
		t.Fatal("display state polled on every frame; it must be throttled")
	}
}

func TestSCKStreamController_WakeFromSleepRestartsImmediately(t *testing.T) {
	c, be, clk := newTestSCKController(t)
	if _, err := c.capture(); err != nil {
		t.Fatal(err)
	}
	c.slept = func(_, _ time.Time) bool { return true }
	clk.advance(time.Millisecond)
	img, err := c.capture()
	if err != nil || img == nil {
		t.Fatalf("capture after wake = (%v, %v)", img, err)
	}
	if be.stops != 1 || len(be.starts) != 2 {
		t.Fatalf("stops=%d starts=%d, want the stream rebuilt after wake", be.stops, len(be.starts))
	}
}

func TestSCKStreamController_ForceRestartSkipsBackoff(t *testing.T) {
	c, be, _ := newTestSCKController(t)
	be.startErrs = []error{nil, errors.New("fail"), nil}
	if _, err := c.capture(); err != nil {
		t.Fatal(err)
	}
	be.stopErr = errors.New("stopped")
	if _, err := c.capture(); err == nil {
		t.Fatal("want restart failure")
	}
	if c.backoff == 0 {
		t.Fatal("want backoff armed")
	}
	c.forceRestart()
	if c.backoff != 0 {
		t.Fatal("forceRestart must clear backoff (no-video watchdog path)")
	}
	if img, err := c.capture(); err != nil || img == nil {
		t.Fatalf("capture after forceRestart = (%v, %v)", img, err)
	}
}

func TestSCKStreamController_CloseStopsStream(t *testing.T) {
	c, be, _ := newTestSCKController(t)
	if _, err := c.capture(); err != nil {
		t.Fatal(err)
	}
	c.close()
	if be.running || be.stops != 1 {
		t.Fatalf("running=%v stops=%d after close", be.running, be.stops)
	}
}

func TestSystemSlept(t *testing.T) {
	cases := []struct {
		name       string
		wall, mono time.Duration
		want       bool
	}{
		{"normal tick", 16 * time.Millisecond, 16 * time.Millisecond, false},
		{"slow tick no sleep", 3 * time.Second, 3 * time.Second, false},
		{"small clock slew", 1 * time.Second, 200 * time.Millisecond, false},
		{"system slept", 10 * time.Minute, 20 * time.Millisecond, true},
		{"wall clock stepped back", -time.Hour, 16 * time.Millisecond, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := systemSlept(tc.wall, tc.mono); got != tc.want {
				t.Fatalf("systemSlept(%v, %v) = %v, want %v", tc.wall, tc.mono, got, tc.want)
			}
		})
	}
}

func TestSCKStreamController_LatestAlwaysReturnsAFrameWithoutConsumingIt(t *testing.T) {
	// Screenshots taken during a live session share the capturer with the
	// stream loop. latest() must always yield a frame (an unchanged screen is
	// not "no frame" to a screenshot) and must not mark it delivered, or the
	// loop would skip a changed frame the screenshot happened to copy first.
	c, be, clk := newTestSCKController(t)
	if _, err := c.capture(); err != nil {
		t.Fatal(err)
	}
	clk.advance(time.Millisecond)
	if img, err := c.latest(); err != nil || img == nil {
		t.Fatalf("latest on unchanged screen = (%v, %v), want a frame", img, err)
	}

	be.newFrame()
	if img, err := c.latest(); err != nil || img == nil {
		t.Fatalf("latest = (%v, %v)", img, err)
	}
	if img, err := c.capture(); err != nil || img == nil {
		t.Fatalf("capture after latest copied the new frame = (%v, %v), want the loop to still get it", img, err)
	}
}

func TestSCKStreamController_LatestStartsStreamOnFirstUse(t *testing.T) {
	c, be, _ := newTestSCKController(t)
	if img, err := c.latest(); err != nil || img == nil {
		t.Fatalf("latest on a fresh capturer = (%v, %v)", img, err)
	}
	if len(be.starts) != 1 {
		t.Fatalf("starts = %v", be.starts)
	}
}

func TestSCKStreamController_CopyFailureTearsDownAndArmsBackoff(t *testing.T) {
	c, be, clk := newTestSCKController(t)
	if _, err := c.capture(); err != nil {
		t.Fatal(err)
	}
	be.copyErr = errors.New("pixel buffer lock failed")
	be.newFrame()
	clk.advance(time.Millisecond)
	if img, err := c.capture(); err == nil || img != nil {
		t.Fatalf("capture with a failing copy = (%v, %v), want the copy error", img, err)
	}
	if be.running || be.stops != 1 {
		t.Fatalf("running=%v stops=%d, want the stream torn down", be.running, be.stops)
	}
	if c.backoff != sckBackoffMin {
		t.Fatalf("backoff = %v, want %v armed", c.backoff, sckBackoffMin)
	}
}

func TestSCKStreamController_LatestDuringOutageIsAnError(t *testing.T) {
	c, be, _ := newTestSCKController(t)
	if _, err := c.capture(); err != nil {
		t.Fatal(err)
	}
	be.stopErr = errors.New("stopped")
	be.startErrs = []error{errors.New("fail"), errors.New("fail")}
	if _, err := c.capture(); err == nil {
		t.Fatal("want restart failure")
	}
	if img, err := c.latest(); err == nil || img != nil {
		t.Fatalf("latest during outage = (%v, %v), want an error (a screenshot must not silently get nothing)", img, err)
	}
}

func TestSCKStreamController_DisplayPollRebaselinesAfterRestart(t *testing.T) {
	c, be, clk := newTestSCKController(t)
	if _, err := c.capture(); err != nil {
		t.Fatal(err)
	}
	// Rebuild via wake long after the last poll; the new stream must get a
	// full poll interval before its display state is checked.
	clk.advance(10 * sckDisplayPollInterval)
	c.slept = func(_, _ time.Time) bool { return true }
	if _, err := c.capture(); err != nil {
		t.Fatal(err)
	}
	c.slept = func(_, _ time.Time) bool { return false }
	stops := be.stops
	be.dispChange = true
	clk.advance(sckDisplayPollInterval / 2)
	_, _ = c.capture()
	if be.stops != stops {
		t.Fatal("display polled immediately after a restart; the poll clock must restart with the stream")
	}
	clk.advance(sckDisplayPollInterval)
	_, _ = c.capture()
	if be.stops != stops+1 {
		t.Fatalf("stops = %d, want the display change acted on once the interval elapsed", be.stops)
	}
}
