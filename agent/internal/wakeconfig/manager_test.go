package wakeconfig

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type harness struct {
	m        *Manager
	clock    *fakeClock
	collects atomic.Int32
	uploads  atomic.Int32
	failUp   atomic.Bool
	fast     atomic.Value // string
	path     string
}

func newHarness(t *testing.T, interval time.Duration) *harness {
	t.Helper()
	h := &harness{clock: &fakeClock{t: t0}, path: filepath.Join(t.TempDir(), "wake_status_state.json")}
	t.Cleanup(func() { stopAndWait(t, h.m) })
	h.fast.Store("disabled")
	h.m = New(Options{
		Collect: func(ctx context.Context) (Inputs, error) {
			h.collects.Add(1)
			return winInputs(h.fast.Load().(string), goodNIC("aa:bb:cc:dd:ee:01")), nil
		},
		Upload: func(ctx context.Context, s Snapshot) error {
			if h.failUp.Load() {
				return errors.New("503")
			}
			h.uploads.Add(1)
			return nil
		},
		Now:       h.clock.Now,
		StatePath: h.path,
		Interval:  interval,
	})
	return h
}

// stopAndWait stops a manager and waits for its loop to exit, so it is not
// still writing state into a TempDir that is being removed. A manager that
// was never started has nothing to wait for.
func stopAndWait(t *testing.T, m *Manager) {
	if m == nil {
		return
	}
	m.mu.Lock()
	started := m.started
	m.mu.Unlock()
	if !started {
		return
	}
	m.Stop()
	select {
	case <-m.Done():
	case <-time.After(5 * time.Second):
		t.Error("wake manager did not stop")
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestDisabledPolicyStopsCollection(t *testing.T) {
	h := newHarness(t, 20*time.Millisecond)
	h.m.Start(context.Background())
	defer h.m.Stop()
	h.m.ApplySettings(Settings{Enabled: false})
	time.Sleep(150 * time.Millisecond)
	if h.collects.Load() != 0 || h.uploads.Load() != 0 {
		t.Fatalf("disabled manager collected %d / uploaded %d", h.collects.Load(), h.uploads.Load())
	}
	h.m.ApplySettings(Settings{Enabled: true})
	waitFor(t, "first collection", func() bool { return h.collects.Load() >= 1 })
	h.m.ApplySettings(Settings{Enabled: false})
	time.Sleep(60 * time.Millisecond) // let an in-flight cycle finish
	n := h.collects.Load()
	time.Sleep(150 * time.Millisecond)
	if h.collects.Load() != n {
		t.Fatalf("collection continued after disable: %d -> %d", n, h.collects.Load())
	}
}

func TestCollectsOnEnableAndEvery24h(t *testing.T) {
	h := newHarness(t, 30*time.Millisecond) // stands in for 24 h
	h.m.Start(context.Background())
	defer h.m.Stop()
	h.m.ApplySettings(Settings{Enabled: true})
	waitFor(t, "enable collection", func() bool { return h.collects.Load() >= 1 })
	waitFor(t, "periodic collections", func() bool { return h.collects.Load() >= 3 })
	// disable -> enable is a transition and collects again right away
	h.m.ApplySettings(Settings{Enabled: false})
	time.Sleep(80 * time.Millisecond)
	n := h.collects.Load()
	h.m.ApplySettings(Settings{Enabled: true})
	waitFor(t, "re-enable collection", func() bool { return h.collects.Load() > n })
}

func TestUploadOnlyOnFingerprintChangeOr24h(t *testing.T) {
	h := newHarness(t, 20*time.Millisecond)
	h.m.Start(context.Background())
	defer h.m.Stop()
	h.m.ApplySettings(Settings{Enabled: true})
	waitFor(t, "first upload", func() bool { return h.uploads.Load() == 1 })
	waitFor(t, "more collections", func() bool { return h.collects.Load() >= 4 })
	if h.uploads.Load() != 1 {
		t.Fatalf("unchanged fingerprint re-uploaded: %d", h.uploads.Load())
	}
	h.fast.Store("enabled") // fingerprint changes
	waitFor(t, "change upload", func() bool { return h.uploads.Load() == 2 })
	waitFor(t, "more collections", func() bool { return h.collects.Load() >= 8 })
	if h.uploads.Load() != 2 {
		t.Fatalf("uploads = %d", h.uploads.Load())
	}
	h.clock.Advance(25 * time.Hour) // 24 h keepalive
	waitFor(t, "keepalive upload", func() bool { return h.uploads.Load() == 3 })
}

func TestFailedUploadIsNotPersistedAndRetries(t *testing.T) {
	h := newHarness(t, 20*time.Millisecond)
	h.failUp.Store(true)
	h.m.Start(context.Background())
	defer h.m.Stop()
	h.m.ApplySettings(Settings{Enabled: true})
	waitFor(t, "collections while failing", func() bool { return h.collects.Load() >= 3 })
	st := loadState(h.path)
	if st.LastUploadFingerprint != "" || !st.LastUploadAt.IsZero() {
		t.Fatalf("state advanced after failed upload: %+v", st)
	}
	h.failUp.Store(false)
	waitFor(t, "upload after recovery", func() bool { return h.uploads.Load() == 1 })
	waitFor(t, "state persisted", func() bool { return loadState(h.path).LastUploadFingerprint != "" })
}

func TestCorruptStateFileStartsEmpty(t *testing.T) {
	p := filepath.Join(t.TempDir(), "wake_status_state.json")
	if err := os.WriteFile(p, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	st := loadState(p)
	if len(st.Adapters) != 0 || st.LastUploadFingerprint != "" {
		t.Fatalf("corrupt file must start empty: %+v", st)
	}
	st.LastUploadFingerprint = "abc"
	if err := saveState(p, st); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode().Perm())
	}
	if loadState(p).LastUploadFingerprint != "abc" {
		t.Fatal("round trip failed")
	}
}

func TestApplySettingsNeverBlocks(t *testing.T) {
	h := newHarness(t, time.Hour) // loop not started: nothing drains the channel
	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			h.m.ApplySettings(Settings{Enabled: i%2 == 0})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ApplySettings blocked")
	}
}

// A failed upload retries after RetryInterval, not after the full interval.
func TestFailedUploadRetriesSoonerThanInterval(t *testing.T) {
	h := newHarness(t, time.Hour) // the full interval never elapses in this test
	h.m.opts.RetryInterval = 20 * time.Millisecond
	h.failUp.Store(true)
	h.m.Start(context.Background())
	defer h.m.Stop()
	h.m.ApplySettings(Settings{Enabled: true})
	waitFor(t, "retries while failing", func() bool { return h.collects.Load() >= 3 })
	h.failUp.Store(false)
	waitFor(t, "upload after recovery", func() bool { return h.uploads.Load() == 1 })
}
