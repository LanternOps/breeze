package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// Caller verification (#6354 W02).
//
// caller_verify shows a confirmation card to the explicitly named console
// user through their Assist helper and reports which button they pressed,
// together with the OS principal the AGENT verified for that login. The
// result travels back through the ordinary command-result path (HTTP and/or
// WebSocket); there is no bespoke transport.
//
// Fail-closed rules: a timeout, a dropped helper, a closed window, an error
// envelope, a malformed or unoffered answer all report choice "timeout" —
// never a number. The helper never supplies identity.

const cmdCallerVerify = "caller_verify"

// callerVerifyIPCGrace covers the helper's own countdown round-trip: the
// helper answers "timeout" at TimeoutMs, the agent stops waiting slightly
// after that.
const callerVerifyIPCGrace = 2 * time.Second

func init() {
	handlerRegistry[cmdCallerVerify] = handleCallerVerify
}

// callerPrincipal is the frozen `principal` object of the result: exactly one
// of SID (Windows) or UID (Unix). UID is a pointer so uid 0 survives.
type callerPrincipal struct {
	SID      string  `json:"sid,omitempty"`
	UID      *uint32 `json:"uid,omitempty"`
	Username string  `json:"username"`
	UPN      string  `json:"upn,omitempty"`
}

// callerVerifyResult is the frozen stdout JSON of a caller_verify command.
type callerVerifyResult struct {
	Delivered     bool             `json:"delivered"`
	Choice        string           `json:"choice,omitempty"`
	Principal     *callerPrincipal `json:"principal,omitempty"`
	HelperVersion string           `json:"helperVersion,omitempty"`
	Error         string           `json:"error,omitempty"`

	// duplicate: the same verification is already waiting on this helper
	// (a re-delivered command). Never serialized: the caller reports a
	// "duplicate" marker so the first execution's answer is the only one.
	duplicate bool
}

type callerVerifyResolver func(username string) (*sessionbroker.Session, sessionbroker.DetectedSession, string)
type callerVerifySender func(s *sessionbroker.Session, id, cmdType string, payload any, timeout time.Duration) (*ipc.Envelope, error)
type callerPrincipalReader func(s *sessionbroker.Session, loginUsername string) *callerPrincipal

func handleCallerVerify(h *Heartbeat, cmd Command) tools.CommandResult {
	started := time.Now()
	var req ipc.CallerVerifyRequest
	raw, err := json.Marshal(cmd.Payload)
	if err == nil {
		err = json.Unmarshal(raw, &req)
	}
	if err == nil {
		err = req.Validate()
	}
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("invalid caller_verify payload: %w", err), time.Since(started).Milliseconds())
	}

	// An agent without a session broker cannot reach any Assist helper.
	out := callerVerifyResult{Error: sessionbroker.CallerVerifyHelperOutdated}
	if h.sessionBroker != nil {
		detector := sessionbroker.NewSessionDetector()
		broker := h.sessionBroker
		out = runCallerVerify(req,
			func(username string) (*sessionbroker.Session, sessionbroker.DetectedSession, string) {
				return broker.CallerVerifySession(username, detector)
			},
			broker.SendCommandAndWait,
			principalForCaller,
		)
	}
	if out.duplicate {
		return tools.CommandResult{Status: "duplicate"}
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("encode caller_verify result: %w", err), time.Since(started).Milliseconds())
	}
	log.Info("caller verification finished",
		"commandId", cmd.ID,
		"delivered", out.Delivered,
		"answered", out.Delivered && out.Choice != ipc.CallerVerifyChoiceTimeout,
		"error", out.Error,
	)
	return tools.CommandResult{Status: "completed", Stdout: string(encoded), DurationMs: time.Since(started).Milliseconds()}
}

func runCallerVerify(req ipc.CallerVerifyRequest, resolve callerVerifyResolver, send callerVerifySender, principal callerPrincipalReader) callerVerifyResult {
	helper, login, reason := resolve(req.Username)
	if reason != "" || helper == nil {
		if reason == "" {
			reason = sessionbroker.CallerVerifyHelperOutdated
		}
		return callerVerifyResult{Error: reason}
	}

	timedOut := callerVerifyResult{Delivered: true, Choice: ipc.CallerVerifyChoiceTimeout}
	timeout := time.Duration(req.TimeoutMs)*time.Millisecond + callerVerifyIPCGrace
	resp, err := send(helper, ipc.CallerVerifyEnvelopeID(req.VerificationID), ipc.TypeCallerVerifyRequest, req, timeout)
	if errors.Is(err, sessionbroker.ErrDuplicateCommand) {
		return callerVerifyResult{duplicate: true}
	}
	if err != nil || resp == nil || resp.Error != "" {
		return timedOut
	}
	var answer ipc.CallerVerifyResponse
	if json.Unmarshal(resp.Payload, &answer) != nil || !req.AnswerAllowed(answer.Choice) {
		return timedOut
	}
	if answer.Choice == ipc.CallerVerifyChoiceTimeout {
		return callerVerifyResult{Delivered: true, Choice: answer.Choice, HelperVersion: answer.HelperVersion}
	}
	p := principal(helper, login.Username)
	if p == nil && answer.Choice != ipc.CallerVerifyChoiceNotMe {
		// The helper answered a number but the agent cannot vouch for who
		// did: never report a number without verified identity. A rejection
		// needs no identity and is always passed through.
		return callerVerifyResult{Error: sessionbroker.CallerVerifyNoSession}
	}
	return callerVerifyResult{Delivered: true, Choice: answer.Choice, Principal: p, HelperVersion: answer.HelperVersion}
}

// callerHelperCapabilities is the heartbeat readiness telemetry: which console
// logins could receive a card right now. Always sent (never omitted) so a
// false report replaces an earlier true one.
type callerHelperCapabilities struct {
	CallerVerify bool     `json:"callerVerify"`
	Usernames    []string `json:"usernames"`
}

func (h *Heartbeat) callerHelperCapabilities() callerHelperCapabilities {
	users := []string{}
	if h.sessionBroker != nil && h.sessionBroker.HasCallerVerifyHelper() {
		users = h.sessionBroker.CallerVerifyUsers(sessionbroker.NewSessionDetector())
	}
	return callerHelperCapabilities{CallerVerify: len(users) > 0, Usernames: users}
}
