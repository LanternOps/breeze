package heartbeat

import (
	"errors"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/websocket"
)

func init() {
	handlerRegistry[tools.CmdSoftwareInstall] = handleSoftwareInstall
}

func handleSoftwareInstall(h *Heartbeat, cmd Command) tools.CommandResult {
	return tools.InstallSoftwareWithProgress(cmd.Payload, h.commandProgressReporter(cmd.ID))
}

// commandProgressReporter returns a reporter that forwards in-flight stages for
// commandID to the server over the WebSocket (#3578), or nil when there is no
// WebSocket client (a nil reporter reports nothing). Whether the connected
// server understands the frame is decided per send by the client's capability
// check, so a reconnect to a different server version is handled.
func (h *Heartbeat) commandProgressReporter(commandID string) tools.ProgressReporter {
	if h == nil || h.wsClient == nil || commandID == "" {
		return nil
	}
	return newCommandProgressReporter(commandID, h.wsClient.SendCommandProgress)
}

func newCommandProgressReporter(commandID string, send func(commandID, stage string) error) tools.ProgressReporter {
	return func(stage string) {
		// Advisory: a lost stage costs the UI a label, never the install.
		if err := send(commandID, stage); err != nil && !errors.Is(err, websocket.ErrServerLacksCapability) {
			log.Debug("command progress not sent",
				logging.KeyCommandID, commandID,
				"stage", stage,
				"error", err.Error())
		}
	}
}
