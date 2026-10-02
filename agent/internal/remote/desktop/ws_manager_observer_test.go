package desktop

import (
	"errors"
	"image"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The activity observer is what the Quick Support viewing indicator hangs
// off (#7684): it must fire on EVERY change to the set of running streams,
// whichever path made the change, so the indicator can never outlive the
// capture.

type observerCapturer struct{ boundsErr error }

func (observerCapturer) Capture() (*image.RGBA, error)                         { return nil, nil }
func (observerCapturer) CaptureRegion(int, int, int, int) (*image.RGBA, error) { return nil, nil }
func (c observerCapturer) GetScreenBounds() (int, int, error) {
	if c.boundsErr != nil {
		return 0, 0, c.boundsErr
	}
	return 1280, 720, nil
}
func (observerCapturer) Close() error { return nil }

func observerLease() *RevocationLease {
	now := time.Now()
	return &RevocationLease{
		ExpiresAt:    now.Add(time.Hour),
		HardDeadline: now.Add(2 * time.Hour),
		RenewEvery:   time.Minute,
	}
}

func noopSend(string, []byte) error { return nil }

// activityRecorder records how many observer calls arrived and what the
// manager's active count was at the time of the latest one.
type activityRecorder struct {
	mu    sync.Mutex
	calls int
}

func (r *activityRecorder) fn() func() {
	return func() {
		r.mu.Lock()
		r.calls++
		r.mu.Unlock()
	}
}

func (r *activityRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

func TestWsActivityObserverFiresOnStartAndEveryStopPath(t *testing.T) {
	stops := map[string]func(m *WsSessionManager, id string, s *WsStreamSession){
		"StopSession": func(m *WsSessionManager, id string, _ *WsStreamSession) { m.StopSession(id) },
		"StopExact":   func(m *WsSessionManager, id string, s *WsStreamSession) { m.StopExact(id, s) },
		"StopAll":     func(m *WsSessionManager, _ string, _ *WsStreamSession) { m.StopAll() },
	}
	for name, stop := range stops {
		t.Run(name, func(t *testing.T) {
			m := NewWsSessionManagerForTest(func() ScreenCapturer { return observerCapturer{} })
			rec := &activityRecorder{}
			m.SetActivityObserver(rec.fn())
			base := rec.count()

			_, _, stream, err := m.StartSession("s1", 0, DefaultStreamConfig(), observerLease(), noopSend)
			if err != nil {
				t.Fatalf("start: %v", err)
			}
			if rec.count() <= base {
				t.Fatal("a stream start must notify the activity observer")
			}
			if m.ActiveCount() != 1 {
				t.Fatalf("active=%d", m.ActiveCount())
			}
			afterStart := rec.count()

			stop(m, "s1", stream)
			if rec.count() <= afterStart {
				t.Fatalf("%s must notify the activity observer", name)
			}
			if m.ActiveCount() != 0 {
				t.Fatalf("active=%d after %s", m.ActiveCount(), name)
			}
		})
	}
}

// A replacement start whose new capturer fails has already stopped the old
// stream under the same id: the observer must hear about it, or an indicator
// would stay up over a session that is no longer capturing.
func TestWsActivityObserverFiresWhenAFailedReplacementStopsTheOldStream(t *testing.T) {
	var fail atomic.Bool
	m := NewWsSessionManagerForTest(func() ScreenCapturer {
		if fail.Load() {
			return observerCapturer{boundsErr: errors.New("no display")}
		}
		return observerCapturer{}
	})
	rec := &activityRecorder{}
	m.SetActivityObserver(rec.fn())

	if _, _, _, err := m.StartSession("s1", 0, DefaultStreamConfig(), observerLease(), noopSend); err != nil {
		t.Fatalf("start: %v", err)
	}
	before := rec.count()
	fail.Store(true)
	if _, _, _, err := m.StartSession("s1", 0, DefaultStreamConfig(), observerLease(), noopSend); err == nil {
		t.Fatal("the replacement start should fail")
	}
	if m.ActiveCount() != 0 {
		t.Fatalf("the old stream should be gone, active=%d", m.ActiveCount())
	}
	if rec.count() <= before {
		t.Fatal("the failed replacement removed a stream; the observer must be told")
	}
}

// The revocation-lease watchdog stopping a stream (revoked, lapsed, past the
// hard deadline) is a stop path like any other.
func TestWsActivityObserverFiresWhenTheLeaseWatchdogStopsAStream(t *testing.T) {
	m := NewWsSessionManagerForTest(func() ScreenCapturer { return observerCapturer{} })
	ticks := make(chan time.Time)
	m.clock = &watchdogClock{
		now:   time.Now,
		ticks: func(time.Duration) (<-chan time.Time, func()) { return ticks, func() {} },
	}
	rec := &activityRecorder{}
	m.SetActivityObserver(rec.fn())

	if _, _, _, err := m.StartSession("s1", 0, DefaultStreamConfig(), observerLease(), noopSend); err != nil {
		t.Fatalf("start: %v", err)
	}
	before := rec.count()
	m.RevokeSession("s1", "revoked")
	ticks <- time.Now()

	deadline := time.Now().Add(5 * time.Second)
	for m.ActiveCount() != 0 || rec.count() <= before {
		if time.Now().After(deadline) {
			t.Fatalf("watchdog stop not observed: active=%d calls=%d (before %d)", m.ActiveCount(), rec.count(), before)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// The observer is invoked with the manager's lock held, so it must be able to
// read nothing back from the manager — but registering one while streams are
// already running must still report the current state immediately, so a
// late-wired indicator does not miss a stream that started first.
func TestWsActivityObserverIsToldOnRegistration(t *testing.T) {
	m := NewWsSessionManagerForTest(func() ScreenCapturer { return observerCapturer{} })
	if _, _, _, err := m.StartSession("s1", 0, DefaultStreamConfig(), observerLease(), noopSend); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(m.StopAll)
	rec := &activityRecorder{}
	m.SetActivityObserver(rec.fn())
	if rec.count() != 1 {
		t.Fatalf("registration must notify once, got %d", rec.count())
	}
}
