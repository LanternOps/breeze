package heartbeat

import (
	"context"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

const pamHelperLeaseTTL = 5 * time.Minute

// pamHelperSpawnWait bounds how long RunPamFlow waits for an on-demand SYSTEM
// helper to come up. It eats into the dialog's share of consent.exe's ~120 s
// lifetime, so it is far below the lifecycle's 90 s startup timeout: a helper
// that is not up by then is unlikely to finish in time to matter. A var so
// tests can shrink it; production never writes it after init.
var pamHelperSpawnWait = 30 * time.Second

// syncPAMHelperHold points the lifecycle's PAM hold (#8996) at the effective
// interception state. Called whenever the PAM policy is applied and when the
// lifecycle manager is installed, so neither ordering can leave them apart.
// Idempotent and cheap: the manager only kicks a reconcile on a change.
func (h *Heartbeat) syncPAMHelperHold() {
	lc := h.lifecycleController()
	if lc == nil {
		return
	}
	lc.SetPAMHelperHold(h.IsUACInterceptionEnabled())
}

// installHelperLifecycle publishes the lifecycle manager (Start) and carries
// the current PAM hold over: the PAM policy may already have been applied
// before the manager existed.
func (h *Heartbeat) installHelperLifecycle(lc helperLifecycleController, cancel context.CancelFunc) {
	h.mu.Lock()
	h.helperLifecycle = lc
	h.lifecycleCancel = cancel
	h.mu.Unlock()
	h.syncPAMHelperHold()
}

// spawnPamHelperOnDemand is RunPamFlow's fallback when no capable SYSTEM
// helper is connected for the requester (#8996): the PAM hold has not
// reconciled yet (fresh logon, interception enabled moments ago) or a helper
// crashed. It leases a SYSTEM helper on the target session, waits a bounded
// time for it, and re-locates the capable session.
//
// The returned release func MUST be called when the flow ends — the lease has
// to outlive the dialog round-trip, or the reconciler could reap the helper
// that is showing it. release is non-nil even when session is nil.
func (h *Heartbeat) spawnPamHelperOnDemand(
	ctx context.Context,
	find func(capability, targetWinSession string) *sessionbroker.Session,
	requestID, targetWinSession string,
) (session *sessionbroker.Session, release func()) {
	release = func() {}
	lc := h.lifecycleController()
	if lc == nil {
		logPamHelperUnavailable(requestID, targetWinSession, "no helper lifecycle manager to spawn one")
		return nil, release
	}

	leaseTarget := targetWinSession
	if leaseTarget == "" {
		console := h.pamConsoleSessionID
		if console == nil {
			console = sessionbroker.GetConsoleSessionID
		}
		leaseTarget = console()
	}
	winID, err := sessionbroker.ParseWindowsSessionIDForHeartbeat(leaseTarget)
	if err != nil || winID == 0 {
		reason := fmt.Sprintf("target Windows session %q could not be resolved", leaseTarget)
		if err != nil {
			reason += ": " + err.Error()
		}
		logPamHelperUnavailable(requestID, targetWinSession, reason)
		return nil, release
	}

	// Fail fast on a session the reconciler will never give a SYSTEM helper
	// (disconnected, gone): the flow runs synchronously on the etwlua loop, so
	// waiting out pamHelperSpawnWait would stall every queued elevation.
	key := sessionbroker.HelperKey{WindowsSessionID: winID, Role: ipc.HelperRoleSystem}
	available, err := lc.HelperRoleAvailable(key)
	if err != nil {
		logPamHelperUnavailable(requestID, targetWinSession, fmt.Sprintf("session %d availability check failed: %v", winID, err))
		return nil, release
	}
	if !available {
		logPamHelperUnavailable(requestID, targetWinSession, fmt.Sprintf("session %d cannot host a SYSTEM helper (not active or connected)", winID))
		return nil, release
	}

	opID := "pam-" + requestID
	if err := lc.AcquireLease(winID, ipc.HelperRoleSystem, opID, pamHelperLeaseTTL); err != nil {
		logPamHelperUnavailable(requestID, targetWinSession, "helper lease refused: "+err.Error())
		return nil, release
	}
	release = func() { lc.ReleaseLease(winID, ipc.HelperRoleSystem, opID) }

	log.Info("pam: no SYSTEM helper in the requester session; spawning one on demand",
		"elevationRequestId", requestID, "targetWinSession", targetWinSession, "leaseWinSession", winID)
	waitCtx, cancel := context.WithTimeout(ctx, pamHelperSpawnWait)
	res := lc.WaitForHelperReady(waitCtx, key)
	cancel()
	if res.Status != sessionbroker.HelperWaitReady {
		if ctx.Err() != nil {
			// The flow itself was cancelled (agent shutdown), not the helper.
			log.Warn("pam: elevation flow cancelled while waiting for an on-demand SYSTEM helper",
				"elevationRequestId", requestID, "targetWinSession", targetWinSession, "error", ctx.Err().Error())
			return nil, release
		}
		logPamHelperUnavailable(requestID, targetWinSession, helperWaitFailureMessage(res))
		return nil, release
	}

	// Ready means authenticated with capabilities; PAM additionally needs the
	// pam scope, which FindCapableSession checks.
	session = find(ipc.ScopePam, targetWinSession)
	if session == nil {
		logPamHelperUnavailable(requestID, targetWinSession, "spawned helper does not hold the PAM scope")
	}
	return session, release
}

// logPamHelperUnavailable is the terminal "this elevation cannot be handled"
// log. Error, not Warn: the server still lists the request as pending and a
// technician can approve it, but the device will never act on it — the
// elevation protocol has no agent-reported "unable" status to say so (#8996).
func logPamHelperUnavailable(requestID, targetWinSession, reason string) {
	log.Error("pam: no capable SYSTEM helper session; cannot complete elevation flow, consent.exe will time out — the server still shows this request as pending",
		"elevationRequestId", requestID, "targetWinSession", targetWinSession, "reason", reason)
}
