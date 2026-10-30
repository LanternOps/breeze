package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// pam_request_notify (#8928) is the server's fire-and-forget notice that an
// elevation request the user handed to IT was denied or expired. Payload:
//
//	{ "requestId": "<uuid>", "outcome": "denied" | "expired", "reason"?: "<text>" }
//
// It carries no program name: the notice names the program from the agent's
// own tracker, so the server cannot make the agent claim a request is about a
// program it never saw. A request the agent is not tracking (agent restarted,
// auto-approved, declined locally, older than the TTL) succeeds silently, so
// the server never retries it. The result's "shown" is true only when the
// notice reached a helper; otherwise "notShownReason" says why.

func init() {
	handlerRegistry[tools.CmdPamRequestNotify] = handlePamRequestNotify
}

const (
	pamNotifyOutcomeDenied  = "denied"
	pamNotifyOutcomeExpired = "expired"
)

type pamRequestNotifyPayload struct {
	RequestID string  `json:"requestId"`
	Outcome   string  `json:"outcome"`
	Reason    *string `json:"reason"`
	// DecidedBy (#10190 W07) is who decided, as the server's identity level
	// allows; display-only.
	DecidedBy *pamlifetime.DecidedBy `json:"decidedBy"`
}

func handlePamRequestNotify(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	payload, err := parsePamRequestNotifyPayload(cmd.Payload)
	if err != nil {
		log.Warn("pam: refusing pam_request_notify", "commandId", cmd.ID, "error", err.Error())
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	// #10190 W07: the elevation prompt shows the outcome first (it also ends
	// a first question still on screen). When Assist holds it, the notice is
	// not shown too.
	state := ipc.PromptStateExpired
	reason := ""
	if payload.Outcome == pamNotifyOutcomeDenied {
		state = ipc.PromptStateDenied
		if payload.Reason != nil {
			reason = *payload.Reason
		}
	}
	onAssist := h.elevationOutcome(payload.RequestID, state, payload.DecidedBy.Technician(), reason)

	tracker := h.pamTracker()
	entry, claimed := tracker.ClaimNotify(payload.RequestID)
	// The server's outcome is final: forget the request either way.
	tracker.Remove(payload.RequestID)
	if onAssist {
		log.Info("pam: outcome shown on the elevation prompt", "elevationRequestId", payload.RequestID, "outcome", payload.Outcome)
		return tools.NewSuccessResult(map[string]any{"shown": true, "renderer": elevationRendererAssist}, time.Since(start).Milliseconds())
	}
	if !claimed {
		log.Info("pam: outcome notice for a request this agent is not tracking (or already notified); not shown",
			"elevationRequestId", payload.RequestID, "outcome", payload.Outcome)
		return tools.NewSuccessResult(map[string]any{"shown": false, "notShownReason": "not_tracked"}, time.Since(start).Milliseconds())
	}

	var title, body string
	switch payload.Outcome {
	case pamNotifyOutcomeDenied:
		reason := ""
		if payload.Reason != nil {
			reason = *payload.Reason
		}
		title, body = pamCopyDenied(entry.Program, entry.SupportName, reason)
	default: // pamNotifyOutcomeExpired; validated above
		title, body = pamCopyExpired(entry.Program, entry.SupportName)
	}
	if err := h.notifyPamUser(title, body, entry.WinSession); err != nil {
		// The command still succeeds: the server never retries it, and the
		// outcome is final, so the entry stays removed. The result says what
		// actually happened.
		reason := pamNoticeNotShownReason(err)
		log.Warn("pam: outcome notice not shown", "elevationRequestId", payload.RequestID,
			"outcome", payload.Outcome, "targetWinSession", entry.WinSession,
			"notShownReason", reason, "error", err.Error())
		return tools.NewSuccessResult(map[string]any{"shown": false, "notShownReason": reason}, time.Since(start).Milliseconds())
	}
	log.Info("pam: showed outcome notice", "elevationRequestId", payload.RequestID,
		"outcome", payload.Outcome, "targetWinSession", entry.WinSession)
	return tools.NewSuccessResult(map[string]any{"shown": true}, time.Since(start).Milliseconds())
}

func parsePamRequestNotifyPayload(raw map[string]any) (pamRequestNotifyPayload, error) {
	var payload pamRequestNotifyPayload
	encoded, err := json.Marshal(raw)
	if err != nil {
		return payload, fmt.Errorf("marshal pam_request_notify payload: %w", err)
	}
	// Unknown fields are ignored (forward compatible); wrong types are not.
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return payload, fmt.Errorf("decode pam_request_notify payload: %w", err)
	}
	if _, err := canonicalPamUUID(payload.RequestID); err != nil {
		return payload, errors.New("pam_request_notify requestId must be a canonical UUID")
	}
	switch payload.Outcome {
	case pamNotifyOutcomeDenied, pamNotifyOutcomeExpired:
	default:
		return payload, fmt.Errorf("pam_request_notify outcome %q is not denied or expired", payload.Outcome)
	}
	if payload.Reason != nil && utf8.RuneCountInString(*payload.Reason) > pamNotifyReasonMaxRunes {
		return payload, fmt.Errorf("pam_request_notify reason exceeds %d characters", pamNotifyReasonMaxRunes)
	}
	return payload, nil
}
