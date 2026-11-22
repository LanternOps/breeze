package heartbeat

// Routing of Linux desktop starts (#12117 W3). An X11 session, and every
// start with desktop_wayland_helper off, keeps today's direct in-root path
// byte for byte. A Wayland session with the flag on goes to the per-session
// desktop helper the Linux manager spawns. Until a capture backend ships
// (W4) that helper cannot capture, so such a start fails with a clear reason
// and the device keeps reporting wayland_unsupported.

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// linuxDesktopRouteKind is where a Linux desktop start goes.
type linuxDesktopRouteKind int

const (
	// routeDirectX11 is today's in-root path, including today's Wayland
	// error.
	routeDirectX11 linuxDesktopRouteKind = iota
	// routeHelper hands the start to the session's desktop helper.
	routeHelper
)

func (k linuxDesktopRouteKind) String() string {
	if k == routeHelper {
		return "helper"
	}
	return "direct"
}

// linuxDesktopRouteHostOS is the OS the routing applies to. A variable only
// so tests exercise the Linux branch on every host.
var linuxDesktopRouteHostOS = runtime.GOOS

const (
	// linuxDesktopSeatLookupTimeout bounds the logind read a routing
	// decision makes.
	linuxDesktopSeatLookupTimeout = 2 * time.Second
	// linuxDesktopEnsureTimeout bounds one spawn request to the manager.
	linuxDesktopEnsureTimeout = 15 * time.Second
	// linuxDesktopHelperReadyWait is how long a start waits for a spawned
	// helper to connect and report its capabilities.
	linuxDesktopHelperReadyWait = 10 * time.Second
	linuxDesktopHelperReadyPoll = 100 * time.Millisecond
)

// linuxDesktopRoute is the routing table. Pure.
//
//	flag off                       → direct (today's path)
//	active seat session is x11     → direct, unchanged
//	wayland and a manager exists   → helper
//	anything else                  → direct (today's path)
//
// An incomplete logind answer is "anything else".
func linuxDesktopRoute(flag bool, active *sessionbroker.DetectedSession, hasManager bool) linuxDesktopRouteKind {
	if !flag || active == nil || active.PropertiesUnknown || active.Session == "" {
		return routeDirectX11
	}
	if active.LogindType == "wayland" && hasManager {
		return routeHelper
	}
	return routeDirectX11
}

// linuxDesktopHelperController is what the heartbeat needs from the Linux
// desktop helper manager.
type linuxDesktopHelperController interface {
	Ensure(ctx context.Context, logindSessionID string) error
	BoundSession(logindSessionID string) *sessionbroker.Session
	NoteDesktopStarted(logindSessionID string)
	NoteDesktopEnded(logindSessionID string)
}

// linuxDesktopController returns the running manager, or nil when there is
// none (flag off, not Linux, or it failed to start).
func (h *Heartbeat) linuxDesktopController() linuxDesktopHelperController {
	if h.linuxDesktopHelperOverride != nil {
		return h.linuxDesktopHelperOverride
	}
	if m := h.linuxDesktopHelpers.Load(); m != nil {
		return m
	}
	return nil
}

// linuxDesktopWaylandHelperOn reports whether Wayland desktop work may go to
// a helper at all: Linux, the flag on, and a manager running. Nothing else
// is consulted, so a false answer costs no logind call.
func (h *Heartbeat) linuxDesktopWaylandHelperOn() (linuxDesktopHelperController, bool) {
	if !linuxDesktopHelperEnabled(linuxDesktopRouteHostOS, h.config) {
		return nil, false
	}
	ctrl := h.linuxDesktopController()
	return ctrl, ctrl != nil
}

// linuxActiveSeat asks logind for the active session on the local seat.
func (h *Heartbeat) linuxActiveSeat() (*sessionbroker.DetectedSession, error) {
	lookup := h.linuxActiveSeatSession
	if lookup == nil {
		lookup = sessionbroker.LinuxActiveSeatSession
	}
	ctx, cancel := context.WithTimeout(context.Background(), linuxDesktopSeatLookupTimeout)
	defer cancel()
	return lookup(ctx)
}

// linuxDesktopRouteDecision is a routing decision and, for routeHelper, the
// logind session the helper must serve.
type linuxDesktopRouteDecision struct {
	kind            linuxDesktopRouteKind
	logindSessionID string
}

// linuxDesktopRouteForStart decides where a desktop start goes on Linux.
// With the flag off, or no manager, it returns direct without asking logind,
// so those agents run exactly the code they ran before.
func (h *Heartbeat) linuxDesktopRouteForStart() linuxDesktopRouteDecision {
	direct := linuxDesktopRouteDecision{kind: routeDirectX11}
	if _, on := h.linuxDesktopWaylandHelperOn(); !on {
		return direct
	}
	active, err := h.linuxActiveSeat()
	if err != nil {
		log.Warn("could not read the active seat session; keeping the direct desktop path", "error", err.Error())
		return direct
	}
	kind := linuxDesktopRoute(true, active, true)
	if kind != routeHelper {
		// With the flag on, say why a start did not go to the helper. An
		// X11 session is the ordinary case; anything else is worth a warning.
		switch {
		case active == nil:
			log.Warn("no active session on the local seat; keeping the direct desktop path")
		case active.PropertiesUnknown || active.Session == "":
			log.Warn("logind's answer about the active seat session is incomplete; keeping the direct desktop path",
				"logindSession", active.Session)
		default:
			log.Info("active seat session is not Wayland; keeping the direct desktop path",
				"logindSession", active.Session, "type", active.LogindType)
		}
		return direct
	}
	log.Info("routing the desktop start to the Linux desktop helper", "logindSession", active.Session)
	return linuxDesktopRouteDecision{kind: routeHelper, logindSessionID: active.Session}
}

// linuxCapableBoundHelper returns the helper bound to a logind session if it
// holds the desktop scope and root lets it capture; otherwise nil.
func linuxCapableBoundHelper(ctrl linuxDesktopHelperController, logindSessionID string) *sessionbroker.Session {
	if ctrl == nil || logindSessionID == "" {
		return nil
	}
	s := ctrl.BoundSession(logindSessionID)
	if s == nil || s.LinuxDesktop == nil || s.LinuxDesktop.LogindSessionID != logindSessionID || !s.HasScope("desktop") {
		return nil
	}
	if caps := s.GetCapabilities(); caps == nil || !caps.CanCapture {
		return nil
	}
	return s
}

// spawnLinuxDesktopHelper asks the manager for the helper of a logind
// session. The manager re-reads logind and refuses anything but an active,
// local, Wayland user session that is its uid's only graphical one, so a
// stale routing decision cannot spawn into the wrong session.
func (h *Heartbeat) spawnLinuxDesktopHelper(logindSessionID string) error {
	ctrl, on := h.linuxDesktopWaylandHelperOn()
	if !on || logindSessionID == "" {
		return ErrLinuxDesktopHelperUnsupported
	}
	ctx, cancel := context.WithTimeout(context.Background(), linuxDesktopEnsureTimeout)
	defer cancel()
	return ctrl.Ensure(ctx, logindSessionID)
}

// errLinuxDesktopHelperCannotCapture: the helper connected and reported,
// but cannot serve this start. Wrapped with the specific cause.
var errLinuxDesktopHelperCannotCapture = errors.New("the Linux desktop helper for this Wayland session cannot capture")

// linuxHelperIncapableCause says why a bound, reported helper cannot serve
// a start for logindSessionID, or "" when it can (or has not reported yet).
func linuxHelperIncapableCause(s *sessionbroker.Session, logindSessionID string) string {
	switch {
	case s == nil:
		return ""
	case s.LinuxDesktop == nil || s.LinuxDesktop.LogindSessionID != logindSessionID:
		return "it is not bound to this logind session"
	case !s.HasScope("desktop"):
		return "it does not hold the desktop scope"
	}
	caps := s.GetCapabilities()
	switch {
	case caps == nil, caps.CanCapture:
		return ""
	case !desktop.WaylandBackendCompiled:
		return "this agent build has no Wayland capture backend"
	default:
		return "the helper reported that it cannot capture this session, or the agent does not allow it to"
	}
}

// findOrSpawnLinuxHelper returns the capable helper for a logind session,
// asking the manager to start one first if needed. Every failure is final
// for this start: the manager owns retries and backoff, so polling past its
// answer would only delay the technician's error.
func (h *Heartbeat) findOrSpawnLinuxHelper(logindSessionID string) (*sessionbroker.Session, error) {
	ctrl, on := h.linuxDesktopWaylandHelperOn()
	if !on {
		return nil, ErrLinuxDesktopHelperUnsupported
	}
	if s := linuxCapableBoundHelper(ctrl, logindSessionID); s != nil {
		return s, nil
	}
	if err := h.spawnDesktopHelper(logindSessionID); err != nil {
		return nil, fmt.Errorf("could not start the Linux desktop helper: %w", err)
	}
	deadline := time.Now().Add(linuxDesktopHelperReadyWait)
	for {
		if s := linuxCapableBoundHelper(ctrl, logindSessionID); s != nil {
			return s, nil
		}
		// Connected and reported, but unable to serve this start: waiting
		// cannot change the answer.
		bound := ctrl.BoundSession(logindSessionID)
		if cause := linuxHelperIncapableCause(bound, logindSessionID); cause != "" {
			return nil, fmt.Errorf("%w: %s", errLinuxDesktopHelperCannotCapture, cause)
		}
		if !time.Now().Before(deadline) {
			stage := "it never connected to the agent (the agent log has the spawn or admission failure)"
			if bound != nil {
				stage = "it connected but never reported its capabilities"
			}
			return nil, fmt.Errorf("the Linux desktop helper did not become ready within %s: %s", linuxDesktopHelperReadyWait, stage)
		}
		select {
		case <-time.After(linuxDesktopHelperReadyPoll):
		case <-h.stopChan:
			return nil, errors.New("agent is shutting down")
		}
	}
}

// startDesktopViaLinuxHelper runs one desktop start on the helper of a
// logind session. There is no retry against another helper: a helper that
// dies mid-start is respawned by the manager under its own budget, and the
// viewer's reconnect is the retry.
func (h *Heartbeat) startDesktopViaLinuxHelper(sessionID, logindSessionID string, req ipc.DesktopStartRequest) tools.CommandResult {
	var session *sessionbroker.Session
	var err error
	if h.helperFinder != nil {
		session = h.helperFinder(logindSessionID)
		if session == nil {
			err = errors.New("no capable helper available after spawn attempt")
		}
	} else {
		session, err = h.findOrSpawnLinuxHelper(logindSessionID)
	}
	if err != nil {
		log.Warn("Linux desktop helper start refused", "sessionId", sessionID, "logindSession", logindSessionID, "error", err.Error())
		return tools.NewErrorResult(err, 0)
	}
	// Marked live before the start is sent, so a helper hosting it is
	// neither idle-expired nor left unrespawned while it streams. Released
	// when the owner is forgotten, or below when the start fails.
	token := h.noteLinuxHostedDesktop(sessionID, logindSessionID)
	result, _ := h.startDesktopOnSession(session, sessionID, req)
	if result.Status != "completed" {
		h.endLinuxHostedDesktopStart(sessionID, token)
		return result
	}
	// A teardown report for an earlier start of the same desktop session
	// (a viewer reconnect reuses the id) may have released this start's
	// mark while it was in flight. Re-assert it while this helper still
	// owns the session.
	h.reassertLinuxHostedDesktop(sessionID, logindSessionID, session.SessionID)
	return result
}

// linuxHostedMark is one desktop session's live mark on the helper of a
// logind session. token identifies the start that placed it.
type linuxHostedMark struct {
	logindSessionID string
	token           uint64
}

// noteLinuxHostedDesktop marks a desktop session live on the helper of a
// logind session and returns the mark's token. Map and manager change
// together under linuxHostedMu, so a concurrent forget sees both or neither.
func (h *Heartbeat) noteLinuxHostedDesktop(desktopSessionID, logindSessionID string) uint64 {
	ctrl := h.linuxDesktopController()
	if ctrl == nil || desktopSessionID == "" || logindSessionID == "" {
		return 0
	}
	h.linuxHostedMu.Lock()
	defer h.linuxHostedMu.Unlock()
	return h.placeLinuxHostedLocked(ctrl, desktopSessionID, logindSessionID)
}

func (h *Heartbeat) placeLinuxHostedLocked(ctrl linuxDesktopHelperController, desktopSessionID, logindSessionID string) uint64 {
	if h.linuxHosted == nil {
		h.linuxHosted = make(map[string]linuxHostedMark)
	}
	if prev, ok := h.linuxHosted[desktopSessionID]; ok {
		ctrl.NoteDesktopEnded(prev.logindSessionID)
	}
	h.linuxHostedSeq++
	h.linuxHosted[desktopSessionID] = linuxHostedMark{logindSessionID: logindSessionID, token: h.linuxHostedSeq}
	ctrl.NoteDesktopStarted(logindSessionID)
	return h.linuxHostedSeq
}

// endLinuxHostedDesktopStart releases the mark a failed start placed, and
// only that one.
func (h *Heartbeat) endLinuxHostedDesktopStart(desktopSessionID string, token uint64) {
	h.linuxHostedMu.Lock()
	defer h.linuxHostedMu.Unlock()
	if m, ok := h.linuxHosted[desktopSessionID]; ok && m.token == token {
		h.releaseLinuxHostedLocked(desktopSessionID)
	}
}

// reassertLinuxHostedDesktop restores the mark of a completed start if it
// was released meanwhile, but only while helperSessionID still owns the
// desktop session: once its owner is forgotten the session is over.
func (h *Heartbeat) reassertLinuxHostedDesktop(desktopSessionID, logindSessionID, helperSessionID string) {
	ctrl := h.linuxDesktopController()
	if ctrl == nil {
		return
	}
	h.linuxHostedMu.Lock()
	defer h.linuxHostedMu.Unlock()
	if _, ok := h.linuxHosted[desktopSessionID]; ok {
		return
	}
	if owner, ok := h.desktopOwners.Load(desktopSessionID); !ok || owner != helperSessionID {
		return
	}
	h.placeLinuxHostedLocked(ctrl, desktopSessionID, logindSessionID)
}

// releaseLinuxHostedLocked releases a desktop session's mark, once. Called
// with linuxHostedMu held.
func (h *Heartbeat) releaseLinuxHostedLocked(desktopSessionID string) {
	m, ok := h.linuxHosted[desktopSessionID]
	if !ok {
		return
	}
	delete(h.linuxHosted, desktopSessionID)
	if ctrl := h.linuxDesktopController(); ctrl != nil {
		ctrl.NoteDesktopEnded(m.logindSessionID)
	}
}

// linuxHostedLogindSession is the logind session whose helper a desktop
// session is marked live on, if any.
func (h *Heartbeat) linuxHostedLogindSession(desktopSessionID string) (string, bool) {
	h.linuxHostedMu.Lock()
	defer h.linuxHostedMu.Unlock()
	m, ok := h.linuxHosted[desktopSessionID]
	return m.logindSessionID, ok
}
