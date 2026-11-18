package desktop

import (
	"context"
	"errors"
	"image"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// fakeBackendCapturer is a ScreenCapturer owned by a fake backend session.
type fakeBackendCapturer struct{ closed atomic.Int32 }

func (c *fakeBackendCapturer) Capture() (*image.RGBA, error) {
	return image.NewRGBA(image.Rect(0, 0, 4, 4)), nil
}
func (c *fakeBackendCapturer) CaptureRegion(_, _, w, h int) (*image.RGBA, error) {
	return image.NewRGBA(image.Rect(0, 0, w, h)), nil
}
func (c *fakeBackendCapturer) GetScreenBounds() (int, int, error) { return 4, 4, nil }
func (c *fakeBackendCapturer) Close() error                       { c.closed.Add(1); return nil }

// fakeBackendInput is an InputHandler owned by a fake backend session.
type fakeBackendInput struct{ InputHandler }

type fakeBackendSession struct {
	capturer *fakeBackendCapturer
	input    *fakeBackendInput
	done     chan struct{}
	doneOnce sync.Once
	mu       sync.Mutex
	err      error
	closed   atomic.Int32
}

func newFakeBackendSession() *fakeBackendSession {
	return &fakeBackendSession{
		capturer: &fakeBackendCapturer{},
		input:    &fakeBackendInput{},
		done:     make(chan struct{}),
	}
}

func (b *fakeBackendSession) Capturer() ScreenCapturer { return b.capturer }
func (b *fakeBackendSession) Input() InputHandler      { return b.input }
func (b *fakeBackendSession) Done() <-chan struct{}    { return b.done }
func (b *fakeBackendSession) Err() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.err
}
func (b *fakeBackendSession) Close() error { b.closed.Add(1); return nil }

// end ends the source on its own, as a portal revoke or a compositor exit
// would.
func (b *fakeBackendSession) end(err error) {
	b.mu.Lock()
	b.err = err
	b.mu.Unlock()
	b.doneOnce.Do(func() { close(b.done) })
}

type fakeSessionBackend struct {
	mu      sync.Mutex
	opened  []CaptureConfig
	session *fakeBackendSession
	openErr error
}

func (f *fakeSessionBackend) Open(_ context.Context, cfg CaptureConfig) (BackendSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.opened = append(f.opened, cfg)
	if f.openErr != nil {
		return nil, f.openErr
	}
	if f.session == nil {
		return nil, nil
	}
	return f.session, nil
}

func (f *fakeSessionBackend) Probe(context.Context) error { return nil }

// withRegisteredBackend registers b for one test and clears the registry
// afterwards.
func withRegisteredBackend(t *testing.T, b SessionBackend) {
	t.Helper()
	resetSessionBackendForTest()
	RegisterSessionBackend(b)
	t.Cleanup(resetSessionBackendForTest)
}

func TestSessionBackend_UsedWhenRegistered(t *testing.T) {
	bs := newFakeBackendSession()
	backend := &fakeSessionBackend{session: bs}
	withRegisteredBackend(t, backend)

	if !SessionBackendRegistered() {
		t.Fatal("SessionBackendRegistered = false after registration")
	}
	cfg := CaptureConfig{DisplayIndex: 1, DesktopContext: "user_session"}
	opened, err := openRegisteredBackendSession(cfg)
	if err != nil || opened != BackendSession(bs) {
		t.Fatalf("openRegisteredBackendSession = %v, %v; want the backend's session", opened, err)
	}
	if len(backend.opened) != 1 || backend.opened[0] != cfg {
		t.Fatalf("backend opened with %v, want exactly [%v]", backend.opened, cfg)
	}

	// Capture and input both come from the one backend session.
	if got := sessionInputHandler(opened, "user_session"); got != InputHandler(bs.input) {
		t.Fatalf("input handler = %T, want the backend session's", got)
	}
	openCalls := 0
	capturer, err := openSessionCaptureSource(opened, func() (ScreenCapturer, error) {
		openCalls++
		return nil, errors.New("the platform capturer must not be opened")
	})
	if err != nil || capturer != ScreenCapturer(bs.capturer) {
		t.Fatalf("capture source = %v, %v; want the backend session's capturer", capturer, err)
	}
	if openCalls != 0 {
		t.Fatalf("platform capturer opened %d times with a backend registered", openCalls)
	}
}

func TestSessionBackend_OpenFailureIsReported(t *testing.T) {
	withRegisteredBackend(t, &fakeSessionBackend{openErr: ErrShareStopped})
	if _, err := openRegisteredBackendSession(CaptureConfig{}); !errors.Is(err, ErrShareStopped) {
		t.Fatalf("openRegisteredBackendSession error = %v, want ErrShareStopped", err)
	}
	// A backend that returns neither a session nor an error is refused.
	withRegisteredBackend(t, &fakeSessionBackend{})
	if bs, err := openRegisteredBackendSession(CaptureConfig{}); err == nil || bs != nil {
		t.Fatalf("openRegisteredBackendSession = %v, %v; want an error for a nil session", bs, err)
	}
}

func TestSessionBackend_NotRegisteredUsesX11Path(t *testing.T) {
	resetSessionBackendForTest()
	t.Cleanup(resetSessionBackendForTest)

	if SessionBackendRegistered() {
		t.Fatal("SessionBackendRegistered = true with nothing registered")
	}
	bs, err := openRegisteredBackendSession(CaptureConfig{})
	if bs != nil || err != nil {
		t.Fatalf("openRegisteredBackendSession = %v, %v; want nil, nil", bs, err)
	}
	// Input is today's platform handler.
	if got, want := reflect.TypeOf(sessionInputHandler(nil, "user_session")), reflect.TypeOf(NewInputHandler("user_session")); got != want {
		t.Fatalf("input handler type = %v, want the platform handler %v", got, want)
	}
	// Capture is today's open.
	platform := &fakeBackendCapturer{}
	openCalls := 0
	capturer, err := openSessionCaptureSource(nil, func() (ScreenCapturer, error) {
		openCalls++
		return platform, nil
	})
	if err != nil || capturer != ScreenCapturer(platform) || openCalls != 1 {
		t.Fatalf("capture source = %v, %v after %d opens; want the platform capturer, opened once", capturer, err, openCalls)
	}
}

func TestSessionBackend_DoneEndsSession(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		reason string
	}{
		{"user revoked the share", ErrShareStopped, StopReasonShareStopped},
		{"wrapped revoke", errors.Join(errors.New("portal"), ErrShareStopped), StopReasonShareStopped},
		{"source ended", errors.New("compositor gone"), StopReasonCaptureEnded},
		{"no error", nil, StopReasonCaptureEnded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bs := newFakeBackendSession()
			s := newTestSession("desk-1")
			s.backend = bs
			s.capturer = bs.capturer
			m := &SessionManager{sessions: map[string]*Session{"desk-1": s}}
			stopped := make(chan string, 2)
			m.OnSessionStopped = func(id, reason string) { stopped <- id + "|" + reason }

			go m.watchSessionBackend("desk-1", s, bs)
			bs.end(tc.err)

			select {
			case got := <-stopped:
				if got != "desk-1|"+tc.reason {
					t.Fatalf("OnSessionStopped(%q), want desk-1|%s", got, tc.reason)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("the session did not end when its backend source ended")
			}
			if s.LastStopReason() != tc.reason {
				t.Fatalf("stop reason = %q, want %q", s.LastStopReason(), tc.reason)
			}
			m.mu.Lock()
			_, still := m.sessions["desk-1"]
			m.mu.Unlock()
			if still {
				t.Fatal("the ended session is still registered")
			}
			if bs.closed.Load() != 1 {
				t.Fatalf("backend session closed %d times, want 1", bs.closed.Load())
			}
		})
	}
}

// With a live peer connection the stop is reported once, by the peer's
// Closed state handler (as StartSession wires it), never also by the watcher.
func TestSessionBackend_DoneWithPeerReportsOnce(t *testing.T) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	bs := newFakeBackendSession()
	s := newTestSession("desk-pc")
	s.backend = bs
	s.peerConn = pc
	m := &SessionManager{sessions: map[string]*Session{"desk-pc": s}}
	reports := make(chan string, 4)
	m.OnSessionStopped = func(id, reason string) { reports <- reason }
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateClosed || state == webrtc.PeerConnectionStateFailed {
			m.StopSession("desk-pc")
			if m.OnSessionStopped != nil {
				go m.OnSessionStopped("desk-pc", s.LastStopReason())
			}
		}
	})

	go m.watchSessionBackend("desk-pc", s, bs)
	bs.end(ErrShareStopped)

	select {
	case r := <-reports:
		if r != StopReasonShareStopped {
			t.Fatalf("reported reason %q, want %q", r, StopReasonShareStopped)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the stop was never reported")
	}
	select {
	case r := <-reports:
		t.Fatalf("the stop was reported twice (second reason %q)", r)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestSessionBackend_StoppedSessionIgnoresLaterDone(t *testing.T) {
	bs := newFakeBackendSession()
	s := newTestSession("desk-2")
	s.backend = bs
	m := &SessionManager{sessions: map[string]*Session{}}
	stopped := make(chan string, 2)
	m.OnSessionStopped = func(id, reason string) { stopped <- reason }

	s.Stop() // an operator stop ends it first
	watched := make(chan struct{})
	go func() { m.watchSessionBackend("desk-2", s, bs); close(watched) }()
	select {
	case <-watched:
	case <-time.After(5 * time.Second):
		t.Fatal("the watcher did not exit when its session stopped")
	}
	bs.end(ErrShareStopped)
	select {
	case r := <-stopped:
		t.Fatalf("a stopped session must not be reported again, got %q", r)
	case <-time.After(50 * time.Millisecond):
	}
	if bs.closed.Load() != 1 {
		t.Fatalf("backend session closed %d times by the stop, want 1", bs.closed.Load())
	}
}

func TestSessionBackend_MonitorSwitchRefused(t *testing.T) {
	bs := newFakeBackendSession()
	s := newTestSession("desk-3")
	s.backend = bs
	if _, err := s.openMonitorCapturer(CaptureConfig{DisplayIndex: 1}); !errors.Is(err, ErrNotSupported) {
		t.Fatalf("monitor switch on a backend session: err = %v, want ErrNotSupported", err)
	}
}

func TestRegisterSessionBackend_Twice_Panics(t *testing.T) {
	withRegisteredBackend(t, &fakeSessionBackend{})
	defer func() {
		if recover() == nil {
			t.Fatal("a second RegisterSessionBackend must panic")
		}
	}()
	RegisterSessionBackend(&fakeSessionBackend{})
}

func TestRegisterSessionBackend_NilPanics(t *testing.T) {
	resetSessionBackendForTest()
	t.Cleanup(resetSessionBackendForTest)
	defer func() {
		if recover() == nil {
			t.Fatal("registering a nil backend must panic")
		}
	}()
	RegisterSessionBackend(nil)
}

func TestWaylandBackendNotCompiledInW3(t *testing.T) {
	if WaylandBackendCompiled {
		t.Fatal("WaylandBackendCompiled must stay false until the Wayland backend ships with it")
	}
}

// TestRootAgentNeverRegistersBackend pins that only the Linux desktop helper
// process may register a session backend: no file the root agent runs
// (heartbeat, broker, agent start-up) may call RegisterSessionBackend. The
// allowlist is the helper's own Linux entry point; in W3 nothing registers.
func TestRootAgentNeverRegistersBackend(t *testing.T) {
	root := agentModuleRoot(t)
	allowed := map[string]bool{
		// The Linux desktop helper process (W4 registers the Wayland
		// backend here, before the helper connects).
		filepath.Join("internal", "agentapp", "linux_desktop_helper.go"): true,
	}
	var callers []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "vendor", "testdata", ".git", "node_modules":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if !strings.Contains(string(src), "RegisterSessionBackend(") {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		if rel == filepath.Join("internal", "remote", "desktop", "session_backend.go") {
			// The definition; it must not call itself.
			if strings.Count(string(src), "RegisterSessionBackend(") != 1 {
				t.Errorf("%s: RegisterSessionBackend must only be defined there, not called", rel)
			}
			return nil
		}
		callers = append(callers, rel)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range callers {
		if !allowed[c] {
			t.Errorf("%s calls RegisterSessionBackend; only the Linux desktop helper process may", c)
		}
	}
}

// agentModuleRoot finds the agent module root (the directory with go.mod).
func agentModuleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod not found above the test directory")
		}
		dir = parent
	}
}

// resetSessionBackendForTest clears the process's session backend.
func resetSessionBackendForTest() {
	sessionBackendMu.Lock()
	sessionBackend = nil
	sessionBackendMu.Unlock()
}
