package heartbeat

import (
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// CmdRetractMessage withdraws an endpoint message (#8742 W02): the API queues
// it when an operator retracts a message that may already be on screen.
const CmdRetractMessage = "retract_message"

func init() {
	handlerRegistry[CmdRetractMessage] = handleRetractMessage
}

// handleRetractMessage makes a message terminal in the replay store (so it is
// never redrawn after a helper restart) and tells the console Assist helper to
// take the card down. It is idempotent: an unknown or already-terminal id is a
// success with retracted=false. Message text is never logged.
func handleRetractMessage(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	raw := tools.GetPayloadString(cmd.Payload, "messageId", "")
	id, err := uuid.Parse(raw)
	if raw == "" || err != nil || !strings.EqualFold(id.String(), raw) {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "messageId must be a UUID string",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	wasPending := h.endpointMessageStore().Retract(raw, time.Now())

	// Tell the helper even when the store had no entry: the store write may have
	// failed after the card was drawn, and the helper side is idempotent.
	// The store is already terminal (replay suppressed), so a failed take-down is
	// reported without undoing that. No Assist session at all is a success: the
	// native toast is transient.
	if s := h.messagingAssistSession(); s != nil {
		if err := s.SendNotify("msg-retract-"+cmd.ID, ipc.TypeMessageRetract, ipc.MessageRef{MessageID: raw}); err != nil {
			log.Warn("could not tell the assist helper to retract a message", "messageId", raw, "error", err.Error())
			return tools.CommandResult{
				Status:     "failed",
				Error:      "could not reach the assist helper to retract the message",
				DurationMs: time.Since(start).Milliseconds(),
			}
		}
	}

	if !wasPending {
		return tools.NewSuccessResult(map[string]any{
			"retracted": false,
			"reason":    "unknown_or_terminal",
		}, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"retracted":  true,
		"wasPending": true,
	}, time.Since(start).Milliseconds())
}
