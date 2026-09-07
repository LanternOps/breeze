package heartbeat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/audit"
	"github.com/breeze-rmm/agent/internal/elevaccount"
	"github.com/breeze-rmm/agent/internal/eventlog"
	"github.com/breeze-rmm/agent/internal/pamactuator"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// PAM Track 5: wire the server-pushed `actuate_elevation` device_command
// into the pamactuator package. The server's approval-flow (Track 6) emits
// this command after a tech approves an elevation request. The command is a
// go signal only; the agent mints the dormant-admin credential locally and
// passes it to the actuator in-process.
//
// Payload shape (validated by apps/api/src/routes/devices/actuateElevation.ts):
//
//	{
//	  "elevationRequestId": "uuid",
//	  "timeoutMs":          8000,
//	  "targetPath":         "C:\\Windows\\System32\\mmc.exe",
//	  "commandLine":        "mmc.exe devmgmt.msc",
//	  "subjectUsername":    "CORP\\alice"
//	}
//
// Deprecated username/password payload fields are ignored. The secret never
// crosses the wire and is never included in CommandResult. The pamactuator's
// Reason field is mirrored into Stdout so the server can switch on it without
// parsing free-form text.
//
// targetPath/commandLine (Task 5) are the server's echo of the stored
// elevation_requests row's target — the remote path holds no cross-request
// state, unlike the local RunPamFlow path which already has ev's target from
// ETW discovery. Path A (sendinput) ignores these fields.

func init() {
	handlerRegistry[tools.CmdActuateElevation] = handleActuateElevation
	handlerRegistry[tools.CmdPamApplyV2] = handlePamApplyV2
	handlerRegistry[tools.CmdPamCleanupV2] = handlePamCleanupV2
}

const pamLifecycleOperationTimeout = 2 * time.Minute

type legacyPamActuationAdmission interface {
	AcquireLegacyActuation(context.Context) (func(), error)
}

type pamReceivedObservationManager interface {
	ApplyWithReceivedObservation(
		context.Context,
		pamlifetime.ApplyCommand,
		func(pamlifetime.Result) error,
	) pamlifetime.Result
}

func handlePamApplyV2(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	var payload pamlifetime.ApplyCommand
	if err := decodePamLifetimePayload(cmd.Payload, &payload); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if err := validatePamLifetimeLocalIdentity(h, payload.DeviceID, payload.OrgID); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if h == nil || h.pamLifetimeManager == nil {
		return tools.NewErrorResult(errors.New("PAM lifetime manager unavailable"), time.Since(start).Milliseconds())
	}
	if !h.pamReconciled.Load() {
		return tools.NewErrorResult(errors.New("PAM lifetime reconciliation in progress"), time.Since(start).Milliseconds())
	}
	if !h.pamReceivedObservationReady.Load() {
		return tools.NewErrorResult(errors.New("PAM received observation transport unavailable"), time.Since(start).Milliseconds())
	}
	if !h.pamVerificationAvailable.Load() {
		return tools.NewErrorResult(errors.New("PAM lifetime verification unavailable"), time.Since(start).Milliseconds())
	}
	if !h.IsUACInterceptionEnabled() {
		return tools.NewErrorResult(errors.New("PAM lifetime apply is disabled by policy"), time.Since(start).Milliseconds())
	}
	manager, ok := h.pamLifetimeManager.(pamReceivedObservationManager)
	if !ok {
		return tools.NewErrorResult(errors.New("PAM received observation transport unavailable"), time.Since(start).Milliseconds())
	}
	ctx, cancel := context.WithTimeout(context.Background(), pamLifecycleOperationTimeout)
	defer cancel()
	result := manager.ApplyWithReceivedObservation(ctx, payload, func(received pamlifetime.Result) error {
		return h.handOffPamReceivedObservation(ctx, cmd.ID, received)
	})
	h.refreshPamLifetimeAvailability()
	commandResult := tools.NewSuccessResult(result, time.Since(start).Milliseconds())
	commandResult.Result = result
	return commandResult
}

func handlePamCleanupV2(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	var payload pamlifetime.CleanupCommand
	if err := decodePamLifetimePayload(cmd.Payload, &payload); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if err := validatePamLifetimeLocalIdentity(h, payload.DeviceID, payload.OrgID); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	if h == nil || h.pamLifetimeManager == nil {
		return tools.NewErrorResult(errors.New("PAM lifetime manager unavailable"), time.Since(start).Milliseconds())
	}
	if !h.pamReconciled.Load() {
		return tools.NewErrorResult(errors.New("PAM lifetime reconciliation in progress"), time.Since(start).Milliseconds())
	}
	ctx, cancel := context.WithTimeout(context.Background(), pamLifecycleOperationTimeout)
	defer cancel()
	result := h.pamLifetimeManager.Cleanup(ctx, payload)
	h.refreshPamLifetimeAvailability()
	commandResult := tools.NewSuccessResult(result, time.Since(start).Milliseconds())
	commandResult.Result = result
	return commandResult
}

func validatePamLifetimeLocalIdentity(h *Heartbeat, deviceID, orgID string) error {
	if h == nil || h.config == nil || h.config.DeviceID == "" || h.config.OrgID == "" {
		return errors.New("PAM lifetime local identity unavailable")
	}
	if deviceID != h.config.DeviceID || orgID != h.config.OrgID {
		return errors.New("PAM lifetime command identity does not match enrolled device")
	}
	return nil
}

func decodePamLifetimePayload(payload map[string]any, destination any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal PAM lifetime v2 payload: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode PAM lifetime v2 payload: %w", err)
	}
	return nil
}

// actuatePayload is the typed view of cmd.Payload. Kept local — no
// caller outside this file needs the shape.
type actuatePayload struct {
	ElevationRequestID string `json:"elevationRequestId"`
	Username           string `json:"username,omitempty"`
	Password           string `json:"password,omitempty"`
	TimeoutMs          int    `json:"timeoutMs"`
	TargetPath         string `json:"targetPath"`
	// TargetHash is the server's echo of elevation_requests.target_executable_hash
	// (SHA-256, when known) — display-only, for the endpoint event log (#4913).
	TargetHash  string `json:"targetHash,omitempty"`
	CommandLine string `json:"commandLine"`
	// SubjectUsername is the server's echo of the stored
	// elevation_requests.subject_username — the account that requested this
	// elevation. Path B resolves it to that user's live session so the elevated
	// process lands in front of the requester on RDP/multi-session hosts rather
	// than the physical console. Empty/absent → console fallback. Path A ignores it.
	SubjectUsername string `json:"subjectUsername,omitempty"`

	// Display-only identity/context fields for the endpoint's local audit
	// trail — Windows Event Log (Breeze-PAM source) + audit.jsonl (#4913).
	// Resolved server-side, inside the same tenant-scoped transaction that
	// queued this command, from elevation_requests + users. Never a user id,
	// token, or credential — see apps/api/src/routes/devices/actuateElevation.ts.
	RequestedByName string `json:"requestedByName,omitempty"`
	ApprovedByName  string `json:"approvedByName,omitempty"`
	ApprovedByEmail string `json:"approvedByEmail,omitempty"`
	ApprovedAt      string `json:"approvedAt,omitempty"`
	RiskTier        *int   `json:"riskTier,omitempty"`
	MatchedRuleName string `json:"matchedRuleName,omitempty"`
	WindowEndsAt    string `json:"windowEndsAt,omitempty"`
}

// pamTarget carries the target executable path + command line into
// actuateElevation so the Path B token-launch actuator knows what to launch.
// Path A (sendinput) ignores both fields. The local flow (RunPamFlow) already
// holds these from ETW discovery (etwlua.Event); the remote flow
// (handleActuateElevation) gets them echoed back from the server's stored
// elevation_requests row, so the agent holds no cross-request state.
type pamTarget struct {
	Path string
	// TargetHash is the target executable's SHA-256, when known — display-only,
	// for the endpoint event log (#4913). Not used for verification here; the
	// actuator's own target re-validation is a separate concern.
	TargetHash  string
	CommandLine string
	// SubjectUsername is the account that requested the elevation, used by Path
	// B to place the launched process in that user's live session. Local flow:
	// from etwlua.Event.SubjectUsername. Remote flow: server-echoed
	// elevation_requests.subject_username. Empty → console fallback.
	SubjectUsername string

	// Display-only identity/context fields for the endpoint's local Windows
	// Event Log + audit.jsonl entries (#4913). Populated by the remote
	// actuate_elevation path from the server-resolved approver identity
	// (actuatePayload); zero-valued on the local ETW-driven flow (RunPamFlow),
	// which has no Breeze approver to name for an auto-approved local decision.
	// Never a user id, token, or credential — see eventLogFields below.
	RequestedByName string
	ApprovedByName  string
	ApprovedByEmail string
	ApprovedAt      string
	RiskTier        string
	MatchedRuleName string
	WindowEndsAt    string
}

// auditPamElevation appends the same display-only identity/context fields
// written to the Windows Event Log (#4913) to the agent's local audit.jsonl,
// via the existing tamper-evident audit.Logger — so the trail exists even on
// platforms/configs where the Windows Event Log write is unavailable or
// disabled. Safe to call on a nil h or nil h.auditLog (Logger.Log no-ops).
func (h *Heartbeat) auditPamElevation(requestID string, target pamTarget, outcome string) {
	if h == nil {
		return
	}
	h.auditLog.Log(audit.EventPrivilegedOp, requestID, map[string]any{
		"pamStage":        "elevation_actuation",
		"outcome":         outcome,
		"targetPath":      target.Path,
		"targetHash":      target.TargetHash,
		"subjectUser":     target.SubjectUsername,
		"requestedByName": target.RequestedByName,
		"approvedByName":  target.ApprovedByName,
		"approvedByEmail": target.ApprovedByEmail,
		"approvedAt":      target.ApprovedAt,
		"riskTier":        target.RiskTier,
		"matchedRuleName": target.MatchedRuleName,
		"windowEndsAt":    target.WindowEndsAt,
	})
}

// eventLogFields projects a pamTarget into the display-only field set
// written to the endpoint's local Windows Event Log / audit.jsonl trail
// (#4913). requestID and detail are threaded in by the caller since they
// vary per lifecycle stage rather than per target.
func (t pamTarget) eventLogFields(requestID, detail string) eventlog.PAMFields {
	return eventlog.PAMFields{
		ElevationRequestID: requestID,
		TargetPath:         t.Path,
		TargetSHA256:       t.TargetHash,
		SubjectUser:        t.SubjectUsername,
		RequestedByName:    t.RequestedByName,
		ApprovedByName:     t.ApprovedByName,
		ApprovedByEmail:    t.ApprovedByEmail,
		ApprovedAt:         t.ApprovedAt,
		WindowEndsAt:       t.WindowEndsAt,
		RiskTier:           t.RiskTier,
		MatchedRuleName:    t.MatchedRuleName,
		Detail:             detail,
	}
}

// riskTierString renders the optional server-supplied risk tier for display
// in the event log body. nil (absent/null) renders as "" (shown as "-" by
// PAMFields.message).
func riskTierString(tier *int) string {
	if tier == nil {
		return ""
	}
	return strconv.Itoa(*tier)
}

// actuateResult is the public CommandResult Stdout payload. Mirrors
// pamactuator.Result minus the DetailMessage rename to `message` for
// JSON cleanliness on the server side.
type actuateResult struct {
	ElevationRequestID string `json:"elevationRequestId"`
	Success            bool   `json:"success"`
	Reason             string `json:"reason"`
	Message            string `json:"message"`
}

// newActuator is an indirection so tests can install a fake. Now strategy-aware
// so Path A (sendinput) and Path B (token_launch) share one selection point.
var newActuator = pamactuator.NewWithStrategy

// newElevationAccountManager is test-swappable for handler safety tests.
var newElevationAccountManager = elevaccount.New

// PAM lifecycle event-log writers (#4913), indirected so call-site tests can
// install a fake and assert exactly which stage fired with which fields —
// eventlog.Event itself is a no-op on non-Windows, so without this seam
// these call sites would be untestable outside a Windows CI runner.
var (
	writePAMElevationActuated = eventlog.WritePAMElevationActuated
	writePAMSessionEnded      = eventlog.WritePAMSessionEnded
	writePAMAccountDemoted    = eventlog.WritePAMAccountDemoted
	writePAMActuationRefused  = eventlog.WritePAMActuationRefused
)

func handleActuateElevation(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	payload, err := parseActuatePayload(cmd.Payload)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	// Bound the overall handler at twice the consent-window timeout so a
	// stuck Windows desktop can't pin a worker forever. The actuator
	// itself enforces its own deadline; this ctx is the belt-and-braces.
	timeout := time.Duration(payload.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = defaultActuateTimeoutMs * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*timeout)
	defer cancel()
	if h == nil || h.pamLifetimeManager == nil {
		return tools.NewErrorResult(errors.New("PAM lifetime manager unavailable"), time.Since(start).Milliseconds())
	}
	if !h.pamReconciled.Load() {
		return tools.NewErrorResult(errors.New("PAM lifetime reconciliation in progress"), time.Since(start).Milliseconds())
	}
	if !h.pamVerificationAvailable.Load() {
		return tools.NewErrorResult(errors.New("PAM lifetime verification unavailable"), time.Since(start).Milliseconds())
	}
	if !h.IsUACInterceptionEnabled() {
		return tools.NewErrorResult(errors.New("PAM lifetime actuation is disabled by policy"), time.Since(start).Milliseconds())
	}
	admission, ok := h.pamLifetimeManager.(legacyPamActuationAdmission)
	if !ok {
		return tools.NewErrorResult(errors.New("PAM lifetime legacy admission unavailable"), time.Since(start).Milliseconds())
	}
	release, err := admission.AcquireLegacyActuation(ctx)
	if err != nil || release == nil {
		if err == nil {
			err = errors.New("PAM lifetime legacy admission unavailable")
		}
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	defer release()

	res := h.actuateElevation(ctx, payload.ElevationRequestID, payload.TimeoutMs,
		pamTarget{
			Path:            payload.TargetPath,
			TargetHash:      payload.TargetHash,
			CommandLine:     payload.CommandLine,
			SubjectUsername: payload.SubjectUsername,
			RequestedByName: payload.RequestedByName,
			ApprovedByName:  payload.ApprovedByName,
			ApprovedByEmail: payload.ApprovedByEmail,
			ApprovedAt:      payload.ApprovedAt,
			RiskTier:        riskTierString(payload.RiskTier),
			MatchedRuleName: payload.MatchedRuleName,
			WindowEndsAt:    payload.WindowEndsAt,
		})

	out := actuateResult{
		ElevationRequestID: payload.ElevationRequestID,
		Success:            res.Success,
		Reason:             res.Reason,
		Message:            res.DetailMessage,
	}

	// Success and failure both surface as a "completed" CommandResult so
	// the server's command-result handler always sees a JSON body — Q4
	// of the firmup: the server is the one deciding retry/escalate based
	// on the Reason code, not the agent.
	return tools.NewSuccessResult(out, time.Since(start).Milliseconds())
}

// refusePamActuation builds the fail-closed refusal and logs it at the block
// site. The remote actuate path folds this into a success-shaped CommandResult
// and logs nothing agent-side, so without this a PAM-disabled device would
// leave no local trace of the refusals it is issuing (#2610). Also writes a
// Windows Event Log entry (#4913) so an auditor reading the endpoint's local
// log — not just the agent's own logs — can see that Breeze refused to act.
func refusePamActuation(requestID, why string, target pamTarget) pamactuator.Result {
	log.Warn("pam: actuation REFUSED — PAM is fail-closed",
		"elevationRequestId", requestID, "why", why)
	writePAMActuationRefused(target.eventLogFields(requestID, why))
	return pamactuator.Result{
		Success:       false,
		Reason:        "dismissal_uncertain",
		DetailMessage: "previous PAM consent dismissal has not reported completion",
	}
}

// actuateElevation runs the dormant-admin promote → consent.exe type →
// guaranteed-demote pipeline and returns the actuator result. Called by the
// remote actuate_elevation command handler, and (Task 5) by the local
// etwlua-driven flow — the receiver is on *Heartbeat so RunPamFlow can share it.
func (h *Heartbeat) actuateElevation(ctx context.Context, requestID string, timeoutMs int, target pamTarget) pamactuator.Result {
	// Serialize the whole promote→Trigger→demote critical section against any
	// concurrent denyConsent (or a second actuateElevation): two goroutines
	// driving SendInput/SetThreadDesktop against the same live consent.exe
	// would corrupt input injection. See Heartbeat.pamActuateMu.
	// Fast path: check the gate under a short lock first. A recovery probe can
	// hold pamActuateMu across a full pamDismissTimeout (10s) IPC round-trip,
	// and sync.Mutex.Lock is not ctx-aware, so without this a worker could be
	// pinned for that long only to be told "dismissal_uncertain" anyway.
	h.pamActuateMu.Lock()
	gated := h.pamDismissalUncertain
	h.pamActuateMu.Unlock()
	if gated {
		result := refusePamActuation(requestID, "dismissal of a denied consent prompt was never proven", target)
		h.auditPamElevation(requestID, target, result.Reason)
		return result
	}

	h.pamActuateMu.Lock()
	defer h.pamActuateMu.Unlock()
	// Re-check under the real critical section: the gate may have been engaged
	// between the fast path and here.
	if h.pamDismissalUncertain {
		result := refusePamActuation(requestID, "dismissal gate engaged concurrently", target)
		h.auditPamElevation(requestID, target, result.Reason)
		return result
	}

	// #4913: mark the start of the actuation on the endpoint's local Windows
	// Event Log, with the requester/approver identity the server resolved,
	// before any promote/type/demote work begins.
	writePAMElevationActuated(target.eventLogFields(requestID, ""))

	manager := newElevationAccountManager()
	cred, err := manager.Promote(ctx)
	if err != nil {
		result := pamactuator.Result{
			Success:       false,
			Reason:        promoteFailureReason(err),
			DetailMessage: err.Error(),
		}
		writePAMSessionEnded(target.eventLogFields(requestID, result.Reason))
		h.auditPamElevation(requestID, target, result.Reason)
		return result
	}
	defer func() {
		demoteCtx, demoteCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer demoteCancel()
		if err := manager.Demote(demoteCtx); err != nil {
			log.Warn("actuate_elevation: demote failed",
				"elevationRequestId", requestID,
				"error", err.Error(),
			)
			return
		}
		writePAMAccountDemoted(target.eventLogFields(requestID, ""))
	}()
	defer zeroCredential(&cred)

	act := newActuator(h.pamActuatorStrategy())
	result := act.Trigger(ctx, pamactuator.Request{
		ElevationRequestID: requestID,
		Username:           cred.Username,
		Password:           cred.Password,
		TimeoutMs:          timeoutMs,
		TargetPath:         target.Path,
		CommandLine:        target.CommandLine,
		SubjectUsername:    target.SubjectUsername,
	})
	writePAMSessionEnded(target.eventLogFields(requestID, result.Reason))
	h.auditPamElevation(requestID, target, result.Reason)
	return result
}

// parseActuatePayload validates the incoming payload. Required fields:
// elevationRequestId. timeoutMs is optional. Deprecated username/password
// fields may be present but are ignored by the handler.
func parseActuatePayload(p map[string]any) (actuatePayload, error) {
	raw, err := json.Marshal(p)
	if err != nil {
		return actuatePayload{}, err
	}
	var out actuatePayload
	if err := json.Unmarshal(raw, &out); err != nil {
		return actuatePayload{}, err
	}
	if out.ElevationRequestID == "" {
		return actuatePayload{}, errors.New("actuate_elevation: elevationRequestId is required")
	}
	return out, nil
}

// pamActuatorStrategy resolves the configured Windows actuator strategy,
// defaulting to sendinput when unset, unknown, or config is unavailable (a
// handful of existing unit tests exercise actuateElevation/denyConsent
// against a zero-value *Heartbeat with a nil config).
func (h *Heartbeat) pamActuatorStrategy() pamactuator.Strategy {
	if h == nil || h.config == nil {
		return pamactuator.StrategySendInput
	}
	switch pamactuator.Strategy(h.config.PAMActuatorStrategy) {
	case pamactuator.StrategyTokenLaunch:
		return pamactuator.StrategyTokenLaunch
	default:
		return pamactuator.StrategySendInput
	}
}

func promoteFailureReason(err error) string {
	if errors.Is(err, elevaccount.ErrUnsupportedPlatform) {
		return elevaccount.ErrUnsupportedPlatform.Error()
	}
	if err == nil {
		return "credential_promote_failed"
	}
	return "credential_promote_failed"
}

func zeroCredential(cred *elevaccount.Credential) {
	if cred == nil {
		return
	}
	if cred.Password != "" {
		cred.Password = strings.Repeat("\x00", len(cred.Password))
		cred.Password = ""
	}
}
