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
		h.denyConsent(session, outcome.RequestID, "policy_denied") // policy hard-deny, no dialog
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
		h.denyConsent(session, outcome.RequestID, "unexpected_status")
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
		h.denyConsent(session, outcome.RequestID, dialog.Reason)
	case sessionbroker.PamActionAwaitRemote:
		log.Info("pam: awaiting remote technician approval; server will issue actuate_elevation", "elevationRequestId", outcome.RequestID)
	}
}

// denyConsent cancels the live consent.exe prompt and logs the denial.
func (h *Heartbeat) denyConsent(session *sessionbroker.Session, requestID, reason string) {
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
		if errors.As(err, &uncertain) && uncertain.Quiesced != nil {
			h.pamDismissalUncertain = true
			go func(quiesced <-chan struct{}) {
				<-quiesced
				h.pamActuateMu.Lock()
				h.pamDismissalUncertain = false
				h.pamActuateMu.Unlock()
				log.Info("pam: uncertain dismissal quiesced; PAM actuation gate released",
					"elevationRequestId", requestID)
			}(uncertain.Quiesced)
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
