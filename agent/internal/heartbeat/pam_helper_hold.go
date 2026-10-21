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
//
// When session is nil, unable says why the device cannot act on the request
// (#9517) so the caller can report it; unable is nil when the flow itself was
// cancelled (agent shutdown), which is not the device's verdict on the request.
func (h *Heartbeat) spawnPamHelperOnDemand(
	ctx context.Context,
	find func(capability, targetWinSession string) *sessionbroker.Session,
	requestID, targetWinSession string,
) (session *sessionbroker.Session, release func(), unable *pamUnable) {
	release = func() {}
	lc := h.lifecycleController()
	if lc == nil {
		return nil, release, pamHelperUnavailable(requestID, targetWinSession, pamUnableHelperUnavailable, "no helper lifecycle manager to spawn one")
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
		return nil, release, pamHelperUnavailable(requestID, targetWinSession, pamUnableSessionUnavailable, reason)
	}

	// Fail fast on a session the reconciler will never give a SYSTEM helper
	// (disconnected, gone): the flow runs synchronously on the etwlua loop, so
	// waiting out pamHelperSpawnWait would stall every queued elevation.
	key := sessionbroker.HelperKey{WindowsSessionID: winID, Role: ipc.HelperRoleSystem}
	available, err := lc.HelperRoleAvailable(key)
	if err != nil {
		return nil, release, pamHelperUnavailable(requestID, targetWinSession, pamUnableSessionUnavailable,
			fmt.Sprintf("session %d availability check failed: %v", winID, err))
	}
	if !available {
		return nil, release, pamHelperUnavailable(requestID, targetWinSession, pamUnableSessionUnavailable,
			fmt.Sprintf("session %d cannot host a SYSTEM helper (not active or connected)", winID))
	}

	opID := "pam-" + requestID
	if err := lc.AcquireLease(winID, ipc.HelperRoleSystem, opID, pamHelperLeaseTTL); err != nil {
		return nil, release, pamHelperUnavailable(requestID, targetWinSession, pamUnableHelperUnavailable, "helper lease refused: "+err.Error())
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
			return nil, release, nil
		}
		return nil, release, pamHelperUnavailable(requestID, targetWinSession, pamUnableReasonForWait(res), helperWaitFailureMessage(res))
	}

	// Ready means authenticated with capabilities; PAM additionally needs the
	// pam scope, which FindCapableSession checks.
	session = find(ipc.ScopePam, targetWinSession)
	if session == nil {
		return nil, release, pamHelperUnavailable(requestID, targetWinSession, pamUnableHelperUnavailable, "spawned helper does not hold the PAM scope")
	}
	return session, release, nil
}

// pamHelperUnavailable logs the terminal "this elevation cannot be handled"
// line and returns the report for the server (#9517). Error, not Warn: the
// device will never act on this request; the report is what tells the server
// to close it instead of offering it to a technician (#8996).
func pamHelperUnavailable(requestID, targetWinSession, reason, detail string) *pamUnable {
	log.Error("pam: no capable SYSTEM helper session; cannot complete elevation flow, consent.exe will time out — reporting the request as unable to the server",
		"elevationRequestId", requestID, "targetWinSession", targetWinSession, "reason", reason, "detail", detail)
	return &pamUnable{Reason: reason, Detail: detail}
}

// pamUnableReasonForWait maps a failed helper wait to its report category.
func pamUnableReasonForWait(res sessionbroker.HelperWaitResult) string {
	if res.Status == sessionbroker.HelperWaitSessionGone {
		return pamUnableSessionUnavailable
	}
	return pamUnableHelperStartFailed
}
