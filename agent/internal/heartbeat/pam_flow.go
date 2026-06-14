package heartbeat

import (
	"context"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

const (
	// pamDialogTimeout bounds the broker round-trip to comfortably under
	// consent.exe's idle lifetime (~120s default). Timeout → deny+dismiss
	// (RequestPamApproval already returns that on timeout).
	pamDialogTimeout = 90 * time.Second
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
	switch outcome.Status {
	case "denied":
		h.denyConsent(ctx, outcome.RequestID, "policy_denied") // policy hard-deny, no dialog
		return
	case "auto_approved", "pending":
		// fall through to the dialog gate
	default:
		log.Debug("pam: no local flow for status", "status", outcome.Status, "elevationRequestId", outcome.RequestID)
		return
	}

	find := h.pamFindSession
	if find == nil {
		find = h.sessionBroker.FindCapableSession
	}
	session := find(ipc.ScopePam, "")
	if session == nil {
		log.Warn("pam: no capable user-helper session; cannot show dialog, consent.exe will time out",
			"elevationRequestId", outcome.RequestID)
		return
	}

	ask := h.pamRequestDialog
	if ask == nil {
		ask = h.sessionBroker.RequestPamApproval
	}
	dialog, err := ask(session, outcome.RequestID, buildPamRequestDialog(ev), pamDialogTimeout)
	if err != nil {
		log.Warn("pam: dialog round-trip error; treating as deny", "elevationRequestId", outcome.RequestID, "error", err.Error())
		dialog = ipc.PamDialogResult{Approved: false, DismissedByUser: true}
	}

	verdict := sessionbroker.PamPolicyEndUserAllowed
	if outcome.Status == "pending" {
		verdict = sessionbroker.PamPolicyRequireApproval
	}

	switch sessionbroker.ComposePamDecision(verdict, dialog, nil) {
	case sessionbroker.PamActionActuate:
		res := h.actuateElevation(ctx, outcome.RequestID, defaultActuateTimeoutMs)
		log.Info("pam: local actuation complete", "elevationRequestId", outcome.RequestID, "success", res.Success, "reason", res.Reason)
	case sessionbroker.PamActionDeny:
		h.denyConsent(ctx, outcome.RequestID, dialog.Reason)
	case sessionbroker.PamActionAwaitRemote:
		log.Info("pam: awaiting remote technician approval; server will issue actuate_elevation", "elevationRequestId", outcome.RequestID)
	}
}

// denyConsent cancels the live consent.exe prompt and logs the denial.
func (h *Heartbeat) denyConsent(ctx context.Context, requestID, reason string) {
	res := newActuator().Dismiss(ctx)
	log.Info("pam: denied elevation, dismissed consent prompt",
		"elevationRequestId", requestID, "reason", reason,
		"dismiss_success", res.Success, "dismiss_reason", res.Reason)
}

// buildPamRequestDialog maps a detected ETW event onto the dialog payload.
// Reason/IntentSummary are left empty (AI intent summary is Phase 2).
func buildPamRequestDialog(ev etwlua.Event) ipc.PamRequestDialog {
	return ipc.PamRequestDialog{
		ExePath:        ev.TargetExecutablePath,
		Signer:         ev.TargetExecutableSigner,
		Hash:           ev.TargetExecutableHash,
		SubjectUser:    ev.SubjectUsername,
		CommandLine:    ev.CommandLine,
		TimeoutSeconds: int(pamDialogTimeout.Seconds()),
	}
}
