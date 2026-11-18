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

// errLinuxDesktopHelperCannotCapture: the helper connected but root does not
// let it capture (no capture backend in this build, or the flag is off).
var errLinuxDesktopHelperCannotCapture = errors.New(
	"the Linux desktop helper for this Wayland session cannot capture: this agent build has no Wayland capture backend")

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
		// Connected and reported, but not allowed to capture: waiting
		// cannot change root's answer.
		if s := ctrl.BoundSession(logindSessionID); s != nil && s.GetCapabilities() != nil {
			return nil, errLinuxDesktopHelperCannotCapture
		}
		if !time.Now().Before(deadline) {
			return nil, fmt.Errorf("the Linux desktop helper did not become ready within %s", linuxDesktopHelperReadyWait)
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
	h.noteLinuxHostedDesktop(sessionID, logindSessionID)
	result, _ := h.startDesktopOnSession(session, sessionID, req)
	if result.Status != "completed" {
		h.endLinuxHostedDesktop(sessionID)
	}
	return result
}

// noteLinuxHostedDesktop records that a desktop session is hosted by the
// helper of a logind session.
func (h *Heartbeat) noteLinuxHostedDesktop(desktopSessionID, logindSessionID string) {
	ctrl := h.linuxDesktopController()
	if ctrl == nil || desktopSessionID == "" || logindSessionID == "" {
		return
	}
	if prev, loaded := h.linuxHostedDesktops.Swap(desktopSessionID, logindSessionID); loaded {
		if id, ok := prev.(string); ok {
			ctrl.NoteDesktopEnded(id)
		}
	}
	ctrl.NoteDesktopStarted(logindSessionID)
}

// endLinuxHostedDesktop releases a desktop session's live mark on its
// helper, once.
func (h *Heartbeat) endLinuxHostedDesktop(desktopSessionID string) {
	v, ok := h.linuxHostedDesktops.LoadAndDelete(desktopSessionID)
	if !ok {
		return
	}
	id, ok := v.(string)
	if !ok {
		return
	}
	if ctrl := h.linuxDesktopController(); ctrl != nil {
		ctrl.NoteDesktopEnded(id)
	}
}
