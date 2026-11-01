package heartbeat

import (
	"context"
	"time"

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
		if h == nil || h.containment == nil || validateContainmentPayload(cmd.Payload, h.serverURL(), time.Now()) != nil {
			return invalidContainmentResult()
		}
		return containmentCommandResult(h.containment.manager.HandleIsolate(context.Background(), cmd.Payload))
	}
	return tools.ExecuteContainment(cmd.Payload)
}
