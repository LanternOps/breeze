package heartbeat

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// Compile-time check that *Heartbeat satisfies the etwlua PamRunner contract.
var _ etwlua.PamRunner = (*Heartbeat)(nil)

const (
	// pamDialogTimeout bounds the broker round-trip to comfortably under
	// consent.exe's idle lifetime (~120s default). Timeout → deny+dismiss
	// (RequestPamApproval already returns that on timeout).
	pamDialogTimeout = 90 * time.Second
	// pamDismissTimeout gives the helper's eight-second dismissal attempt time
	// to complete and return its correlated IPC result.
	pamDismissTimeout = 10 * time.Second
	// defaultPamRecoveryDelay spaces out gate-recovery re-dismissals. It is
	// deliberately longer than pamDismissTimeout so a reconnecting helper has
	// time to come back before the next probe.
	defaultPamRecoveryDelay = 15 * time.Second
	// defaultPamRecoveryMaxAttempts bounds recovery so a permanently broken
	// helper doesn't spin forever. On exhaustion the gate stays CLOSED — the
	// bound limits probing, never the fail-closed guarantee.
	defaultPamRecoveryMaxAttempts = 8
	// defaultActuateTimeoutMs is the per-actuation consent.exe wait, matching
	// the remote handler's fallback.
	defaultActuateTimeoutMs = 8000
)

// RunPamFlow implements etwlua.PamRunner. Given the server's ingest decision
// for a detected UAC prompt, it shows the user-desktop PAM dialog (when the
// status warrants it), composes the decision, and either actuates locally
// (end-user-allowed) or dismisses consent.exe (deny). The require-approval
// path resolves remotely: the server issues an actuate_elevation command once
// a technician approves.
func (h *Heartbeat) RunPamFlow(ctx context.Context, ev etwlua.Event, outcome etwlua.ElevationOutcome) {
	// RunPamFlow runs on the etwlua loop goroutine and reaches raw SendInput
	// syscalls via the actuator — unlike the remote actuate path, there is no
	// worker-pool recover() above it. A syscall panic here would crash the
	// whole agent. Contain it: the credential-zeroing/demote defers inside
	// actuateElevation still run during unwinding, so this is purely
	// availability hardening, not a correctness shortcut.
	defer func() {
		if r := recover(); r != nil {
			log.Error("pam: panic in RunPamFlow; elevation flow aborted",
				"elevationRequestId", outcome.RequestID, "panic", r)
		}
	}()

	switch outcome.Status {
	case etwlua.ElevationDenied, etwlua.ElevationAutoApproved, etwlua.ElevationPending:
		// All supported statuses need the SYSTEM+PAM helper in the requester's
		// Windows session when known. Hard deny skips the dialog only after
		// resolving that target session.
	default:
		log.Debug("pam: no local flow for status", "status", string(outcome.Status), "elevationRequestId", outcome.RequestID)
		return
	}

	targetWinSession := ""
	sessionTarget := "physical_console_fallback"
	// Zero and Windows' 0xFFFFFFFF invalid-session sentinel both mean the
	// requester session is unresolved, so retain the existing console fallback.
	if ev.SubjectSessionID != 0 && ev.SubjectSessionID != 0xFFFFFFFF {
		targetWinSession = strconv.FormatUint(uint64(ev.SubjectSessionID), 10)
		sessionTarget = "requester_session"
	}

	// Defensive: the PamRunner contract (see etwlua.PamRunner) says the caller
	// passes a nil runner when the broker is absent. Guard anyway so a wiring
	// slip can't panic the ETW hot path — every supported flow needs a helper.
	if h.pamFindSession == nil && h.sessionBroker == nil {
		log.Warn("pam: no session broker available; skipping elevation flow",
			"elevationRequestId", outcome.RequestID, "sessionTarget", sessionTarget,
			"targetWinSession", targetWinSession)
		return
	}

	find := h.pamFindSession
	if find == nil {
		find = h.sessionBroker.FindCapableSession
	}
	session := find(ipc.ScopePam, targetWinSession)
	if session == nil {
		log.Warn("pam: no capable SYSTEM helper session; cannot complete elevation flow, consent.exe will time out",
			"elevationRequestId", outcome.RequestID, "sessionTarget", sessionTarget,
			"targetWinSession", targetWinSession)
		return
	}
	if outcome.Status == etwlua.ElevationDenied {
		h.denyConsent(session, outcome.RequestID, "policy_denied", targetWinSession) // policy hard-deny, no dialog
		return
	}

	ask := h.pamRequestDialog
	if ask == nil {
		ask = h.sessionBroker.RequestPamApproval
	}
	dialog, err := ask(session, outcome.RequestID, buildPamRequestDialog(ev), pamDialogTimeout)
	if err != nil {
		log.Warn("pam: dialog round-trip error; treating as deny", "elevationRequestId", outcome.RequestID, "error", err.Error())
		dialog = ipc.PamDialogResult{Approved: false, DismissedByUser: true, Reason: "dialog_roundtrip_error"}
	}

	var verdict string
	switch outcome.Status {
	case etwlua.ElevationAutoApproved:
		verdict = sessionbroker.PamPolicyEndUserAllowed
	case etwlua.ElevationPending:
		verdict = sessionbroker.PamPolicyRequireApproval
	default:
		// Unreachable today (the switch above only lets these two through),
		// but fail closed if a new fall-through status is ever added upstream:
		// never actuate on a status we don't recognize.
		log.Warn("pam: unexpected status at verdict mapping; denying", "status", string(outcome.Status), "elevationRequestId", outcome.RequestID)
		h.denyConsent(session, outcome.RequestID, "unexpected_status", targetWinSession)
		return
	}

	switch sessionbroker.ComposePamDecision(verdict, dialog, nil) {
	case sessionbroker.PamActionActuate:
		// Bound the local actuation with a per-flow ceiling, mirroring the
		// remote handler (handlers_actuate.go). Deriving from ctx (not
		// context.Background) preserves agent-shutdown cancellation while
		// adding a flow-scoped timeout so a stuck desktop can't pin the
		// etwlua loop goroutine forever. Wrapped in a closure so defer cancel
		// releases the timer even if actuateElevation panics (recovered above).
		func() {
			actCtx, cancel := context.WithTimeout(ctx, 2*defaultActuateTimeoutMs*time.Millisecond)
			defer cancel()
			res := h.actuateElevation(actCtx, outcome.RequestID, defaultActuateTimeoutMs,
				pamTarget{Path: ev.TargetExecutablePath, CommandLine: ev.CommandLine, SubjectUsername: ev.SubjectUsername})
			if res.Success {
				log.Info("pam: local actuation complete", "elevationRequestId", outcome.RequestID, "success", true, "reason", res.Reason)
			} else {
				log.Warn("pam: local actuation failed", "elevationRequestId", outcome.RequestID, "reason", res.Reason, "message", res.DetailMessage)
			}
		}()
	case sessionbroker.PamActionDeny:
		h.denyConsent(session, outcome.RequestID, dialog.Reason, targetWinSession)
	case sessionbroker.PamActionAwaitRemote:
		log.Info("pam: awaiting remote technician approval; server will issue actuate_elevation", "elevationRequestId", outcome.RequestID)
	}
}

// denyConsent cancels the live consent.exe prompt and logs the denial.
// targetWinSession is retained so gate recovery can re-locate a capable helper
// after the original session dies mid-dismiss.
func (h *Heartbeat) denyConsent(session *sessionbroker.Session, requestID, reason, targetWinSession string) {
	if session == nil {
		log.Warn("pam: deny enforcement FAILED — no SYSTEM helper session; consent.exe may still be live",
			"elevationRequestId", requestID, "reason", reason)
		return
	}

	dismiss := h.pamDismissConsent
	if dismiss == nil {
		if h.sessionBroker == nil {
			log.Warn("pam: deny enforcement FAILED — dismissal IPC unavailable; consent.exe may still be live",
				"elevationRequestId", requestID, "reason", reason)
			return
		}
		dismiss = h.sessionBroker.DismissPamConsent
	}

	var (
		res              ipc.PamDismissConsentResult
		err              error
		alreadyUncertain bool
	)
	// Serialize the helper command against any concurrent actuateElevation. If
	// the broker cannot prove completion, mark PAM input fail-closed until the
	// helper's correlated response proves its work is quiescent. New actuation
	// attempts return immediately without promoting credentials or sending input.
	func() {
		h.pamActuateMu.Lock()
		defer h.pamActuateMu.Unlock()
		if h.pamDismissalUncertain {
			alreadyUncertain = true
			return
		}
		res, err = dismiss(session, requestID, pamDismissTimeout)
		var uncertain *sessionbroker.PamDismissUncertainError
		if errors.As(err, &uncertain) {
			// Invariant: the broker always builds this error with a non-nil
			// Quiesced (see Broker.DismissPamConsent). A nil channel would mean
			// we can never learn the dismissal's fate, so engage the gate and
			// go straight to recovery rather than falling through to a plain
			// Warn that silently leaves actuation open (issue #2610).
			h.pamDismissalUncertain = true
			log.Error("pam: dismissal completion unproven — PAM actuation gate ENGAGED (fail-closed)",
				"elevationRequestId", requestID, "reason", reason,
				"error", err.Error())
			go h.awaitPamDismissalQuiescence(requestID, targetWinSession, uncertain.Quiesced)
		}
	}()
	if alreadyUncertain {
		log.Warn("pam: deny enforcement skipped — previous dismissal completion remains uncertain",
			"elevationRequestId", requestID, "reason", reason)
		return
	}
	if err != nil {
		log.Warn("pam: deny enforcement FAILED — dismissal IPC error; consent.exe may still be live",
			"elevationRequestId", requestID, "reason", reason, "error", err.Error())
		return
	}

	switch {
	case res.Success:
		log.Info("pam: denied elevation, dismissed consent prompt",
			"elevationRequestId", requestID, "reason", reason, "dismiss_reason", res.Reason)
	case res.Reason == "no_consent_window":
		// Prompt already gone (user closed it, self-timeout, or a prior dismiss) —
		// the deny is satisfied, not a failure.
		log.Info("pam: deny — consent prompt already closed",
			"elevationRequestId", requestID, "reason", reason)
	default:
		log.Warn("pam: deny enforcement FAILED — consent.exe may still be live",
			"elevationRequestId", requestID, "reason", reason,
			"dismiss_reason", res.Reason, "dismiss_message", res.DetailMessage)
	}
}

// awaitPamDismissalQuiescence resolves the fail-closed PAM gate opened by
// denyConsent. It releases the gate ONLY on proof that no denied consent prompt
// can still be on screen; every other ending routes to bounded recovery.
//
// Why proof and not mere completion (issue #2610): pamactuator.Trigger locates
// the live prompt generically, with no correlation to elevationRequestId. If a
// previously DENIED consent.exe is still up when the gate reopens, the next
// approved actuation types freshly-promoted admin credentials into that stale
// window — silently reversing the deny.
func (h *Heartbeat) awaitPamDismissalQuiescence(requestID, targetWinSession string, quiesced <-chan sessionbroker.PamDismissOutcome) {
	defer func() {
		if r := recover(); r != nil {
			// Never let a panic here leave the gate in an unattended state; the
			// gate stays closed, which is the safe direction.
			log.Error("pam: panic while resolving dismissal gate; PAM actuation remains fail-closed",
				"elevationRequestId", requestID, "panic", r)
		}
	}()

	outcome, ok := <-quiesced
	switch {
	case ok && outcome.Cleared():
		h.releasePamDismissalGate(requestID, "helper proved dismissal", 0)
		return
	case !ok:
		// Channel closed without an outcome. Treat exactly like an unproven
		// helper death — never as an all-clear.
		log.Error("pam: dismissal quiescence closed without an outcome; PAM stays fail-closed, attempting recovery",
			"elevationRequestId", requestID)
	case !outcome.Proven:
		log.Error("pam: helper session died mid-dismiss — dismissal UNPROVEN, consent.exe may still be live; PAM stays fail-closed, attempting recovery",
			"elevationRequestId", requestID)
	default:
		// Proven finished, but not proven clear: the helper reported a failure
		// (consent_did_not_close / send_input_failed / desktop_open_failed) or
		// its response could not be interpreted.
		detail := ""
		if outcome.Err != nil {
			detail = outcome.Err.Error()
		}
		log.Error("pam: dismissal CONFIRMED FAILED — consent.exe likely still live; PAM stays fail-closed, attempting recovery",
			"elevationRequestId", requestID, "dismiss_reason", outcome.Result.Reason,
			"dismiss_message", outcome.Result.DetailMessage, "error", detail)
	}

	h.recoverPamDismissalGate(requestID, targetWinSession)
}

// recoverPamDismissalGate re-establishes proof after an unproven or failed
// dismissal, so a dead helper cannot disable PAM for the agent's whole lifetime.
//
// Recovery does NOT time out into an open state — that would reintroduce the
// stale-denied-window bug this gate exists to prevent. Instead it re-issues the
// dismiss against a freshly located helper: a "no_consent_window" (or a clean
// success) is real evidence that nothing is on screen for a later actuation to
// type into. Anything short of that evidence leaves the gate closed.
func (h *Heartbeat) recoverPamDismissalGate(requestID, targetWinSession string) {
	delay := h.pamRecoveryDelay
	if delay <= 0 {
		delay = defaultPamRecoveryDelay
	}
	maxAttempts := h.pamRecoveryMaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = defaultPamRecoveryMaxAttempts
	}

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		select {
		case <-h.stopChan:
			log.Warn("pam: dismissal gate recovery abandoned — agent shutting down",
				"elevationRequestId", requestID, "attempt", attempt)
			return
		case <-time.After(delay):
		}

		outcome, probed := h.probePamDismissalRecovery(requestID, targetWinSession, attempt, delay)
		if !probed {
			continue
		}
		if outcome.Cleared() {
			h.releasePamDismissalGate(requestID, "recovery re-verified no live consent window", attempt)
			return
		}
		log.Warn("pam: dismissal gate recovery attempt did not prove a clear desktop; PAM remains fail-closed",
			"elevationRequestId", requestID, "attempt", attempt, "maxAttempts", maxAttempts,
			"dismiss_reason", outcome.Result.Reason)
	}

	// Deliberate terminal state: fail-closed wins over availability. Logged at
	// Error so a dead-PAM device is visible in the field instead of surfacing
	// only as routine per-actuation "dismissal_uncertain" warnings.
	log.Error("pam: PAM ACTUATION DISABLED until agent restart — recovery exhausted without proving the consent desktop is clear",
		"elevationRequestId", requestID, "attempts", maxAttempts)
}

// probePamDismissalRecovery runs one re-dismissal against a freshly located
// helper. It reports (outcome, true) only when it learned something definite;
// (zero, false) means "retry" (no helper yet, transport error, or still silent).
//
// Each probe uses its own IPC correlation ID. Reusing the original
// elevationRequestId would collide with a pending registration that an earlier
// uncertain probe left behind on a still-live session, and every later probe
// would fail with ErrDuplicateCommand — leaving the gate stuck closed for the
// wrong reason. The ID is pure IPC correlation (PamDismissConsentRequest
// carries only a deadline), so a derived ID is safe.
func (h *Heartbeat) probePamDismissalRecovery(requestID, targetWinSession string, attempt int, wait time.Duration) (sessionbroker.PamDismissOutcome, bool) {
	find := h.pamFindSession
	if find == nil {
		if h.sessionBroker == nil {
			return sessionbroker.PamDismissOutcome{}, false
		}
		find = h.sessionBroker.FindCapableSession
	}
	dismiss := h.pamDismissConsent
	if dismiss == nil {
		if h.sessionBroker == nil {
			return sessionbroker.PamDismissOutcome{}, false
		}
		dismiss = h.sessionBroker.DismissPamConsent
	}

	session := find(ipc.ScopePam, targetWinSession)
	if session == nil {
		// Helper hasn't reconnected yet — nothing can be proven, and nothing
		// can actuate either. Wait for the next attempt.
		return sessionbroker.PamDismissOutcome{}, false
	}

	// Hold the same mutex as denyConsent/actuateElevation: a recovery probe
	// drives the consent desktop exactly like a first-line dismissal does.
	probeID := requestID + "-gate-recovery-" + strconv.Itoa(attempt)
	h.pamActuateMu.Lock()
	res, err := dismiss(session, probeID, pamDismissTimeout)
	h.pamActuateMu.Unlock()

	if err == nil {
		return sessionbroker.PamDismissOutcome{Proven: true, Result: res}, true
	}

	var uncertain *sessionbroker.PamDismissUncertainError
	if !errors.As(err, &uncertain) || uncertain.Quiesced == nil {
		log.Warn("pam: dismissal gate recovery probe failed", "elevationRequestId", requestID, "error", err.Error())
		return sessionbroker.PamDismissOutcome{}, false
	}

	// The probe itself came back uncertain. Give its quiescence a bounded read
	// so one silent helper can't stall the recovery loop.
	select {
	case outcome, ok := <-uncertain.Quiesced:
		if !ok {
			return sessionbroker.PamDismissOutcome{}, false
		}
		return outcome, true
	case <-time.After(wait):
		return sessionbroker.PamDismissOutcome{}, false
	case <-h.stopChan:
		return sessionbroker.PamDismissOutcome{}, false
	}
}

// releasePamDismissalGate reopens PAM actuation. Only ever called with proof
// that no denied consent prompt remains on screen.
func (h *Heartbeat) releasePamDismissalGate(requestID, why string, attempt int) {
	h.pamActuateMu.Lock()
	h.pamDismissalUncertain = false
	h.pamActuateMu.Unlock()
	log.Info("pam: dismissal proven clear; PAM actuation gate released",
		"elevationRequestId", requestID, "why", why, "attempt", attempt)
}

// buildPamRequestDialog maps a detected ETW event onto the dialog payload.
// Reason/IntentSummary are left empty (AI intent summary is Phase 2).
func buildPamRequestDialog(ev etwlua.Event) ipc.PamRequestDialog {
	return ipc.PamRequestDialog{
		ExePath:     ev.TargetExecutablePath,
		Signer:      ev.TargetExecutableSigner,
		Hash:        ev.TargetExecutableHash,
		SubjectUser: ev.SubjectUsername,
		CommandLine: ev.CommandLine,
		// TimeoutSeconds is informational only today: the authoritative
		// round-trip timeout is enforced broker-side via the pamDialogTimeout
		// arg to RequestPamApproval, and the user-helper MessageBox does not
		// currently self-dismiss on this value. Populated for a future helper
		// self-timeout — do not rely on it for enforcement.
		TimeoutSeconds: int(pamDialogTimeout.Seconds()),
	}
}
