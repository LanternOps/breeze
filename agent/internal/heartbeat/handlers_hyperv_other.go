//go:build !windows

package heartbeat

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdHypervDiscover] = handleHypervDiscover
	handlerRegistry[tools.CmdHypervBackup] = handleHypervBackup
	handlerRegistry[tools.CmdHypervRestore] = handleHypervRestore
	handlerRegistry[tools.CmdHypervCheckpoint] = handleHypervCheckpoint
	handlerRegistry[tools.CmdHypervVMState] = handleHypervVMState
}

func handleHypervDiscover(h *Heartbeat, cmd Command) tools.CommandResult {
	return tools.NewErrorResult(fmt.Errorf("Hyper-V is only supported on Windows"), time.Since(time.Now()).Milliseconds())
}

func handleHypervBackup(h *Heartbeat, cmd Command) tools.CommandResult {
	return tools.NewErrorResult(fmt.Errorf("Hyper-V is only supported on Windows"), time.Since(time.Now()).Milliseconds())
}

func handleHypervRestore(h *Heartbeat, cmd Command) tools.CommandResult {
	return tools.NewErrorResult(fmt.Errorf("Hyper-V is only supported on Windows"), time.Since(time.Now()).Milliseconds())
}

func handleHypervCheckpoint(h *Heartbeat, cmd Command) tools.CommandResult {
	return tools.NewErrorResult(fmt.Errorf("Hyper-V is only supported on Windows"), time.Since(time.Now()).Milliseconds())
}

func handleHypervVMState(h *Heartbeat, cmd Command) tools.CommandResult {
	return tools.NewErrorResult(fmt.Errorf("Hyper-V is only supported on Windows"), time.Since(time.Now()).Milliseconds())
}
