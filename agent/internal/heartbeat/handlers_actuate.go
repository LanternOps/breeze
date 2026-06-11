package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/elevaccount"
	"github.com/breeze-rmm/agent/internal/pamactuator"
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
//	  "timeoutMs":          8000
//	}
//
// Deprecated username/password payload fields are ignored. The secret never
// crosses the wire and is never included in CommandResult. The pamactuator's
// Reason field is mirrored into Stdout so the server can switch on it without
// parsing free-form text.

func init() {
	handlerRegistry[tools.CmdActuateElevation] = handleActuateElevation
}

// actuatePayload is the typed view of cmd.Payload. Kept local — no
// caller outside this file needs the shape.
type actuatePayload struct {
	ElevationRequestID string `json:"elevationRequestId"`
	Username           string `json:"username,omitempty"`
	Password           string `json:"password,omitempty"`
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

// newElevationAccountManager is test-swappable for handler safety tests.
var newElevationAccountManager = elevaccount.New

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

	manager := newElevationAccountManager()
	cred, err := manager.Promote(ctx)
	if err != nil {
		out := actuateResult{
			ElevationRequestID: payload.ElevationRequestID,
			Success:            false,
			Reason:             promoteFailureReason(err),
			Message:            err.Error(),
		}
		return tools.NewSuccessResult(out, time.Since(start).Milliseconds())
	}
	defer func() {
		demoteCtx, demoteCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer demoteCancel()
		if err := manager.Demote(demoteCtx); err != nil {
			log.Warn("actuate_elevation: demote failed",
				"elevationRequestId", payload.ElevationRequestID,
				"error", err.Error(),
			)
		}
	}()
	defer zeroCredential(&cred)

	act := newActuator()
	res := act.Trigger(ctx, pamactuator.Request{
		ElevationRequestID: payload.ElevationRequestID,
		Username:           cred.Username,
		Password:           cred.Password,
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
