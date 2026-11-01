package heartbeat

import (
	"context"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdCollectEvidence] = handleCollectEvidence
	handlerRegistry[tools.CmdExecuteContainment] = handleExecuteContainment
}

func handleCollectEvidence(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.CollectEvidence(cmd.Payload)
}

func handleExecuteContainment(h *Heartbeat, cmd Command) tools.CommandResult {
	if cmd.Payload["actionType"] == "network_isolation" {
		if h == nil || h.containment == nil {
			return unavailableContainmentResult()
		}
		if err := validateContainmentPayload(cmd.Payload, h.serverURL(), time.Now()); err != nil {
			// The rule name only: payload values may include the secret.
			log.Warn("refusing network isolation command", logging.KeyCommandID, cmd.ID, "error", err.Error())
			return invalidContainmentResult()
		}
		return containmentCommandResult(h.containment.manager.HandleIsolate(context.Background(), cmd.Payload))
	}
	return tools.ExecuteContainment(cmd.Payload)
}
