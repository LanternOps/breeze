package desktop

// The session backend seam (#12117 W3). A Linux desktop helper process may
// register one capture backend; each WebRTC desktop session then opens one
// BackendSession and takes both its capture source and its input sink from
// it (a portal RemoteDesktop session owns both). Without a registered
// backend every session runs exactly today's capturer and input code.
//
// Only the Linux desktop-helper process registers a backend; the root agent
// never does (pinned by TestRootAgentNeverRegistersBackend). In W3 nothing
// registers one at all, so the helper reports CanCapture=false and Wayland
// devices keep reporting wayland_unsupported. W4 adds the Wayland backend.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// SessionBackend opens one capture source and its matching input sink as a
// pair (a portal RemoteDesktop session owns both). Registered only by the
// Linux desktop-helper process; the root agent never registers one.
type SessionBackend interface {
	// Open starts one backend session for a desktop session. It may wait on
	// the user (a portal consent dialog) until ctx ends.
	Open(ctx context.Context, cfg CaptureConfig) (BackendSession, error)
	// Probe reports whether this process can capture: nil = it can. It runs
	// unprivileged, in the helper, and must not show any UI.
	Probe(ctx context.Context) error
}

// BackendSession is one open capture source and its input sink.
//
// The desktop session closes the capturer from Capturer() through its own
// Close when it tears down, and then calls Close here; Close must release
// everything (capture and input) and both closes must be idempotent and
// safe in either order.
type BackendSession interface {
	Capturer() ScreenCapturer
	Input() InputHandler
	// Done is closed when the source ends on its own (portal revoked,
	// compositor gone); Err then reports why. ErrShareStopped for a user revoke.
	Done() <-chan struct{}
	Err() error
	Close() error
}

// WaylandBackendCompiled is root-side truth about this build (helper and
// root are the same binary): whether it contains the Wayland capture
// backend. false until W4 adds the wayland package; W4 flips it in the same
// PR. Root clamps a Linux desktop helper's CanCapture claim with it.
const WaylandBackendCompiled = false

// ErrShareStopped is a backend session's Err when the user stopped sharing.
var ErrShareStopped = errors.New("desktop share stopped by the user")

// Stop reasons a desktop session reports when its backend source ends.
const (
	StopReasonShareStopped = "share_stopped"
	StopReasonCaptureEnded = "capture_ended"
)

// sessionBackendOpenTimeout bounds opening a backend session. It stays under
// the root agent's 30 s desktop-start command budget, so a start that waits
// on the user ends here, with a reason, before root gives up on the helper.
const sessionBackendOpenTimeout = 25 * time.Second

var (
	sessionBackendMu sync.Mutex
	sessionBackend   SessionBackend
)

// RegisterSessionBackend installs the process's session backend. It panics
// on a nil backend or when called twice: a process has one capture source
// and registers it once, at start-up, before any desktop session.
func RegisterSessionBackend(b SessionBackend) {
	if b == nil {
		panic("desktop: nil session backend")
	}
	sessionBackendMu.Lock()
	defer sessionBackendMu.Unlock()
	if sessionBackend != nil {
		panic("desktop: session backend registered twice")
	}
	sessionBackend = b
}

// SessionBackendRegistered reports whether a session backend is installed.
func SessionBackendRegistered() bool {
	return registeredSessionBackend() != nil
}

func registeredSessionBackend() SessionBackend {
	sessionBackendMu.Lock()
	defer sessionBackendMu.Unlock()
	return sessionBackend
}

// openRegisteredBackendSession opens a backend session for a new desktop
// session when a backend is registered; (nil, nil) when none is.
func openRegisteredBackendSession(cfg CaptureConfig) (BackendSession, error) {
	b := registeredSessionBackend()
	if b == nil {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), sessionBackendOpenTimeout)
	defer cancel()
	bs, err := b.Open(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open capture session: %w", err)
	}
	if bs == nil {
		return nil, errors.New("open capture session: backend returned no session")
	}
	return bs, nil
}

// sessionInputHandler is a desktop session's input sink: the backend
// session's when there is one, else the platform handler, as before.
func sessionInputHandler(bs BackendSession, desktopContext string) InputHandler {
	if bs != nil {
		return bs.Input()
	}
	return NewInputHandler(desktopContext)
}

// openSessionCaptureSource is a desktop session's first capturer: the
// backend session's when there is one, else open() — today's path.
func openSessionCaptureSource(bs BackendSession, open func() (ScreenCapturer, error)) (ScreenCapturer, error) {
	if bs == nil {
		return open()
	}
	c := bs.Capturer()
	if c == nil {
		return nil, errors.New("capture session has no capture source")
	}
	return c, nil
}

// openMonitorCapturer opens a capturer for another display of a running
// session. A backend session's source is the one stream the user shared, so
// it cannot be re-targeted.
func (s *Session) openMonitorCapturer(cfg CaptureConfig) (ScreenCapturer, error) {
	if s.backend != nil {
		return nil, fmt.Errorf("%w: display switching is not available for this capture source", ErrNotSupported)
	}
	return openSessionCapturer(cfg)
}

// backendStopReason is the reason a session reports when its backend source
// ended on its own.
func backendStopReason(err error) string {
	if errors.Is(err, ErrShareStopped) {
		return StopReasonShareStopped
	}
	return StopReasonCaptureEnded
}

// watchSessionBackend ends a desktop session when its backend source ends
// on its own, and reports why (share_stopped or capture_ended), once. It
// returns when the session stops for any other reason; that stopper reports.
func (m *SessionManager) watchSessionBackend(sessionID string, s *Session, bs BackendSession) {
	select {
	case <-s.done:
		return
	case <-bs.Done():
	}
	select {
	case <-s.done:
		return // already stopping for another reason
	default:
	}
	reason := backendStopReason(bs.Err())
	errText := ""
	if err := bs.Err(); err != nil {
		errText = err.Error()
	}
	slog.Warn("Desktop capture source ended, stopping the session",
		"session", sessionID, "reason", reason, "error", errText)
	m.mu.Lock()
	if cur, ok := m.sessions[sessionID]; ok && cur == s {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()
	s.StopWithReason(reason)
	m.notifyActivity()
	if s.LastStopReason() != reason {
		return // another stop won the race and reports for itself
	}
	if m.OnSessionStopped != nil {
		go m.OnSessionStopped(sessionID, reason)
	}
}
