//go:build !windows

package heartbeat

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdVSSStatus] = handleVSSStatus
	handlerRegistry[tools.CmdVSSWriterList] = handleVSSWriterList
}

func handleVSSStatus(h *Heartbeat, cmd Command) tools.CommandResult {
	return tools.NewErrorResult(fmt.Errorf("VSS is only supported on Windows"), time.Since(time.Now()).Milliseconds())
}

func handleVSSWriterList(h *Heartbeat, cmd Command) tools.CommandResult {
	return tools.NewErrorResult(fmt.Errorf("VSS is only supported on Windows"), time.Since(time.Now()).Milliseconds())
}
