//go:build !windows

package heartbeat

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdMSSQLDiscover] = handleMSSQLDiscover
	handlerRegistry[tools.CmdMSSQLBackup] = handleMSSQLBackup
	handlerRegistry[tools.CmdMSSQLRestore] = handleMSSQLRestore
	handlerRegistry[tools.CmdMSSQLVerify] = handleMSSQLVerify
}

func handleMSSQLDiscover(_ *Heartbeat, _ Command) tools.CommandResult {
	return tools.NewErrorResult(fmt.Errorf("MSSQL is only supported on Windows"), time.Since(time.Now()).Milliseconds())
}

func handleMSSQLBackup(_ *Heartbeat, _ Command) tools.CommandResult {
	return tools.NewErrorResult(fmt.Errorf("MSSQL is only supported on Windows"), time.Since(time.Now()).Milliseconds())
}

func handleMSSQLRestore(_ *Heartbeat, _ Command) tools.CommandResult {
	return tools.NewErrorResult(fmt.Errorf("MSSQL is only supported on Windows"), time.Since(time.Now()).Milliseconds())
}

func handleMSSQLVerify(_ *Heartbeat, _ Command) tools.CommandResult {
	return tools.NewErrorResult(fmt.Errorf("MSSQL is only supported on Windows"), time.Since(time.Now()).Milliseconds())
}
