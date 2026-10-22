package heartbeat

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

const pamHelperLeaseTTL = 5 * time.Minute

// pamHelperSpawnWait bounds how long RunPamFlow waits for an on-demand SYSTEM
// helper to come up, and is the point at which the agent gives up on the
// request and reports it unable (helper_start_failed). Why 30 s:
//   - the user is sitting at a UAC prompt PAM is not handling while the agent
//     waits, so the wait stays well below the lifecycle's 90 s helper startup
//     timeout rather than matching it;
//   - once it expires RunPamFlow returns and the user never sees the PAM
//     dialog for this prompt, so a request left pending could only be approved
//     for something the user never confirmed;
//   - a helper that comes up later serves the next UAC prompt, which creates a
//     fresh request.
const pamHelperSpawnWait = 30 * time.Second

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
		// Not proof either: hb.Start installs the lifecycle manager on its own
		// goroutine, so an early UAC event can arrive before it. Leave the
		// request pending for the server's stale-request expiry.
		log.Error("pam: no helper lifecycle manager to spawn a SYSTEM helper; elevation flow stopped, request left pending",
			"elevationRequestId", requestID, "targetWinSession", targetWinSession)
		return nil, release, nil
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
		// Not proof either: GetConsoleSessionID answers "0" when the console
		// lookup fails, which can happen during a session switch. Stop, leave
		// the request pending (#9517).
		reason := fmt.Sprintf("target Windows session %q could not be resolved", leaseTarget)
		if err != nil {
			reason += ": " + err.Error()
		}
		log.Error("pam: could not resolve the Windows session for a SYSTEM helper; elevation flow stopped, request left pending",
			"elevationRequestId", requestID, "targetWinSession", targetWinSession, "detail", reason)
		return nil, release, nil
	}

	// Fail fast on a session the reconciler will never give a SYSTEM helper
	// (disconnected, gone): the flow runs synchronously on the etwlua loop, so
	// waiting out pamHelperSpawnWait would stall every queued elevation.
	key := sessionbroker.HelperKey{WindowsSessionID: winID, Role: ipc.HelperRoleSystem}
	available, err := lc.HelperRoleAvailable(key)
	if err != nil {
		// Not proof the session cannot host a helper: the check failed
		// (transient WTS enumeration error), or the session was not in the
		// snapshot, which the detector can also produce by skipping a row it
		// could not read or truncating a very long list (ListSessions, not
		// ListSessionsComplete). Stop this flow but do not report the request
		// unable, which would close it for good; the server's stale-request
		// expiry still closes it if nothing else happens (#9517).
		log.Error("pam: could not confirm the requester session can host a SYSTEM helper; elevation flow stopped, request left pending",
			"elevationRequestId", requestID, "targetWinSession", targetWinSession, "session", winID, "error", err.Error())
		return nil, release, nil
	}
	if !available {
		return nil, release, pamHelperUnavailable(requestID, targetWinSession, pamUnableSessionUnavailable,
			fmt.Sprintf("session %d cannot host a SYSTEM helper (not active or connected)", winID))
	}

	opID := "pam-" + requestID
	if err := lc.AcquireLease(winID, ipc.HelperRoleSystem, opID, pamHelperLeaseTTL); err != nil {
		// AcquireLease re-enumerates sessions and returns those errors
		// unchanged, so a refusal here is not known to be permanent either:
		// stop the flow, leave the request pending.
		log.Error("pam: helper lease refused; elevation flow stopped, request left pending",
			"elevationRequestId", requestID, "targetWinSession", targetWinSession, "session", winID, "error", err.Error())
		return nil, release, nil
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
		if res.Status == sessionbroker.HelperWaitSessionGone {
			// The lifecycle drops a lease when its session is missing from a
			// plain ListSessions snapshot, which a skipped row or a truncated
			// list can also produce, so this is not proof the session ended.
			// Same rule as the availability check above: stop, leave pending.
			log.Error("pam: requester session dropped out of the session list while waiting for a SYSTEM helper; elevation flow stopped, request left pending",
				"elevationRequestId", requestID, "targetWinSession", targetWinSession, "session", winID, "detail", helperWaitFailureMessage(res))
			return nil, release, nil
		}
		return nil, release, pamHelperUnavailable(requestID, targetWinSession, pamUnableHelperStartFailed, helperWaitFailureMessage(res))
	}

	// Ready means authenticated with capabilities; PAM additionally needs the
	// pam scope, which FindCapableSession checks. Look up the session the
	// helper was spawned in, not targetWinSession: an empty target re-reads
	// the console session, which may have moved since the lease (#9517).
	session = find(ipc.ScopePam, strconv.FormatUint(uint64(winID), 10))
	if session == nil {
		if res.Session != nil && (res.Session.HelperRole != ipc.HelperRoleSystem || !res.Session.HasScope(ipc.ScopePam)) {
			return nil, release, pamHelperUnavailable(requestID, targetWinSession, pamUnableHelperUnavailable, "spawned helper does not hold the PAM scope")
		}
		// The ready helper holds the scope (or the wait did not say which
		// helper came up), yet the lookup missed it: a race with the session
		// list, not proof. Stop, leave the request pending.
		log.Error("pam: on-demand SYSTEM helper was ready but not found for the PAM flow; elevation flow stopped, request left pending",
			"elevationRequestId", requestID, "targetWinSession", targetWinSession, "session", winID)
		return nil, release, nil
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
