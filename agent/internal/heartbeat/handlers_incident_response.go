package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdCollectEvidence] = handleCollectEvidence
	handlerRegistry[tools.CmdExecuteContainment] = handleExecuteContainment
}

func handleCollectEvidence(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.CollectEvidence(cmd.Payload)
}

func handleExecuteContainment(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.ExecuteContainment(cmd.Payload)
}
