package heartbeat

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

const (
	desktopLeaseTTL = 5 * time.Minute
	// helperReadyBudget is the lifecycle startup timeout (90s) plus margin —
	// long enough for a cold spawn into an RDS session, short enough that the
	// API's command round-trip does not time out first.
	helperReadyBudget = 95 * time.Second
	// consentHelperWait bounds the head start given to the target session's
	// user helper before the consent prompt is sent. Missing it is not fatal:
	// the prompt then reports helper-absent and consentUnavailableBehavior
	// decides.
	consentHelperWait = 30 * time.Second
)

// desktopLeaseRenewEvery paces the renewal ticker. A var, not a const, so
// tests can shrink it; production never writes it after init.
var desktopLeaseRenewEvery = time.Minute

type desktopLeaseHold struct {
	winID  uint32
	roles  []ipc.HelperRole
	cancel context.CancelFunc // stops the renewal goroutine; nil until renewal starts
}

func desktopLeaseOpID(sessionID string) string { return "desk-" + sessionID }

// lifecycleController returns the helper lifecycle manager, or nil when none
// runs. Read under h.mu because it is installed after construction.
func (h *Heartbeat) lifecycleController() helperLifecycleController {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.helperLifecycle
}

// helperWaitFailureMessage maps a typed wait result to the operator-facing
// error. Never a bare timeout string without a reason.
func helperWaitFailureMessage(res sessionbroker.HelperWaitResult) string {
	switch res.Status {
	case sessionbroker.HelperWaitFatalCooldown:
		return fmt.Sprintf("helper is in crash cooldown; retry in %s", res.RetryAfter.Round(time.Second))
	case sessionbroker.HelperWaitRetriesExhausted:
		return "helper failed to start after repeated attempts"
	case sessionbroker.HelperWaitSessionGone:
		return "target session has ended"
	case sessionbroker.HelperWaitSpawnerUnavailable:
		return "helper spawning is unavailable on this host"
	case sessionbroker.HelperWaitTimeout:
		return "helper did not become ready in time"
	}
	return "helper unavailable"
}

// acquireDesktopLeases takes the on-demand leases for a desktop connect:
// always the system role (capture); additionally the user role when a
// prompt/banner is configured, since consent UI renders through the target
// session's user helper. Returns nil on success or a ready-to-return failure
// CommandResult.
func (h *Heartbeat) acquireDesktopLeases(sessionID string, winID uint32, wantConsentUI bool) *tools.CommandResult {
	h.mu.Lock()
	lc := h.helperLifecycle
	h.mu.Unlock()
	if lc == nil {
		r := tools.NewErrorResult(errors.New("helper lifecycle manager is not running"), 0)
		return &r
	}

	roles := []ipc.HelperRole{ipc.HelperRoleSystem}
	if wantConsentUI {
		roles = append(roles, ipc.HelperRoleUser)
	}
	opID := desktopLeaseOpID(sessionID)
	for i, role := range roles {
		if err := lc.AcquireLease(winID, role, opID, desktopLeaseTTL); err != nil {
			// Roll back any lease taken before the failure so a half-acquired
			// connect can't keep a helper alive for a session that never streams.
			for _, taken := range roles[:i] {
				lc.ReleaseLease(winID, taken, opID)
			}
			msg := fmt.Sprintf("failed to reserve helper for session %d: %v", winID, err)
			if errors.Is(err, sessionbroker.ErrLeaseSessionNotFound) {
				msg = fmt.Sprintf("target session %d no longer exists", winID)
			}
			log.Warn("desktop lease acquisition failed",
				"sessionId", sessionID, "winSession", winID, "role", string(role), "error", err.Error())
			r := tools.NewErrorResult(errors.New(msg), 0)
			return &r
		}
	}
	h.mu.Lock()
	if h.desktopLeases == nil {
		h.desktopLeases = make(map[string]*desktopLeaseHold)
	}
	h.desktopLeases[sessionID] = &desktopLeaseHold{winID: winID, roles: roles}
	h.mu.Unlock()
	return nil
}

// releaseDesktopLeases stops renewal and releases every role held for the
// remote session. Safe to call when nothing is held.
func (h *Heartbeat) releaseDesktopLeases(sessionID string) {
	h.mu.Lock()
	hold := h.desktopLeases[sessionID]
	delete(h.desktopLeases, sessionID)
	lc := h.helperLifecycle
	var cancel context.CancelFunc
	var winID uint32
	var roles []ipc.HelperRole
	if hold != nil {
		// Copy under the lock: startDesktopLeaseRenewal writes hold.cancel while
		// holding h.mu, so reading it outside would race.
		cancel, winID, roles = hold.cancel, hold.winID, hold.roles
	}
	h.mu.Unlock()
	if hold == nil || lc == nil {
		return
	}
	if cancel != nil {
		cancel()
	}
	for _, role := range roles {
		lc.ReleaseLease(winID, role, desktopLeaseOpID(sessionID))
	}
}

// helperSessionPresent reports whether a helper for key is connected to the
// broker. The desktopHelperPresent seam overrides it in tests.
func (h *Heartbeat) helperSessionPresent(key sessionbroker.HelperKey) bool {
	h.mu.Lock()
	fn := h.desktopHelperPresent
	broker := h.sessionBroker
	h.mu.Unlock()
	if fn != nil {
		return fn(key)
	}
	if broker == nil {
		// No broker to ask — never claim the helper vanished, or renewal would
		// stop itself on a live stream.
		return true
	}
	return broker.HelperSessionByKey(key) != nil
}

// startDesktopLeaseRenewal keeps the desktop leases alive for the stream's
// lifetime. It stops itself when the system-role helper session has vanished
// on two consecutive ticks (stream died without a stop_desktop); the lease TTL
// + linger then reap the helper. Self-stopping deliberately does NOT release
// the leases — only an explicit stop/failure does, so a momentary broker blip
// can't tear down a live connect.
func (h *Heartbeat) startDesktopLeaseRenewal(sessionID string) {
	h.mu.Lock()
	hold := h.desktopLeases[sessionID]
	lc := h.helperLifecycle
	if hold == nil || lc == nil {
		h.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	if hold.cancel != nil {
		// A previous renewal for the same remote session id — never expected,
		// but stopping the old goroutine beats leaking it.
		hold.cancel()
	}
	hold.cancel = cancel
	winID, roles := hold.winID, append([]ipc.HelperRole(nil), hold.roles...)
	h.mu.Unlock()

	go func() {
		ticker := time.NewTicker(desktopLeaseRenewEvery)
		defer ticker.Stop()
		gone := 0
		sysKey := sessionbroker.HelperKey{WindowsSessionID: winID, Role: ipc.HelperRoleSystem}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !h.helperSessionPresent(sysKey) {
					gone++
					if gone >= 2 {
						log.Warn("stopping desktop lease renewal: helper session vanished",
							"sessionId", sessionID, "winSession", winID)
						return
					}
					continue
				}
				gone = 0
				for _, role := range roles {
					if err := lc.RenewLease(winID, role, desktopLeaseOpID(sessionID), desktopLeaseTTL); err != nil {
						log.Warn("desktop lease renewal failed, stopping renewal",
							"sessionId", sessionID, "winSession", winID, "role", string(role), "error", err.Error())
						return
					}
				}
			}
		}
	}()
}

// resolveDesktopTargetWinID parses the target session string ("" already
// defaulted to console by the caller) into the lease key form.
//
// Session 0 is rejected explicitly. It parses fine and a lease on it can even
// be acquired, but leaseRoleEligible refuses to spawn a helper for session 0
// (Session 0 isolation — it is the services session, never interactive), and
// WaitForHelperReady cannot report session-gone while the lease exists. The
// connect would therefore burn the full 95s helper budget and end with the
// misleading "helper did not become ready in time" instead of a typed reason.
// Broker.ConsoleSessionID() normalizes 0 to "" for the same reason; a stale
// picker, an older API, or a hand-built command can still put it in the
// payload.
func resolveDesktopTargetWinID(targetSession string) (uint32, error) {
	winID, err := sessionbroker.ParseWindowsSessionIDForHeartbeat(targetSession)
	if err != nil {
		return 0, fmt.Errorf("invalid targetSessionId %q: %w", targetSession, err)
	}
	if winID == 0 {
		return 0, errors.New("invalid targetSessionId 0: session 0 is never an interactive session")
	}
	return winID, nil
}
