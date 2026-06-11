package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/pamactuator"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// PAM Track 5: wire the server-pushed `actuate_elevation` device_command
// into the pamactuator package. The server's approval-flow (Track 6) emits
// this command after a tech approves an elevation request and the
// dormant-admin credential has been minted. The agent types those creds
// into the consent.exe prompt that's already up on the user's screen.
//
// Payload shape (validated by apps/api/src/routes/agents/actuateElevation.ts):
//
//	{
//	  "elevationRequestId": "uuid",
//	  "username":           "DOMAIN\\svc-pam",
//	  "password":           "<one-time>",
//	  "timeoutMs":          8000
//	}
//
// We do NOT log the password or include it in the CommandResult. The
// pamactuator's Reason field is mirrored into the result Stdout so the
// server-side handler can switch on it for retry/escalate decisions
// without parsing free-form text.

func init() {
	handlerRegistry[tools.CmdActuateElevation] = handleActuateElevation
}

// actuatePayload is the typed view of cmd.Payload. Kept local — no
// caller outside this file needs the shape.
type actuatePayload struct {
	ElevationRequestID string `json:"elevationRequestId"`
	Username           string `json:"username"`
	Password           string `json:"password"`
	TimeoutMs          int    `json:"timeoutMs"`
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

// newActuator is an indirection so tests can install a fake without
// touching package state in other tests. Set via swapActuatorForTest.
var newActuator = pamactuator.New

func handleActuateElevation(_ *Heartbeat, cmd Command) tools.CommandResult {
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
		timeout = 8 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*timeout)
	defer cancel()

	act := newActuator()
	res := act.Trigger(ctx, pamactuator.Request{
		ElevationRequestID: payload.ElevationRequestID,
		Username:           payload.Username,
		Password:           payload.Password,
		TimeoutMs:          payload.TimeoutMs,
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

// parseActuatePayload validates the incoming payload. Required fields:
// elevationRequestId, username, password. timeoutMs is optional.
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
	if out.Username == "" {
		return actuatePayload{}, errors.New("actuate_elevation: username is required")
	}
	if out.Password == "" {
		return actuatePayload{}, errors.New("actuate_elevation: password is required")
	}
	return out, nil
}
