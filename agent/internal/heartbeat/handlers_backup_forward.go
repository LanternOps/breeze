package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdBackupRun] = handleBackupRun
	handlerRegistry[tools.CmdBackupList] = handleBackupList
	handlerRegistry[tools.CmdBackupStop] = handleBackupStop
	handlerRegistry[tools.CmdBackupRestore] = handleBackupRestore
}

// handleBackupRun keeps its 10-minute timeout unconditionally: it only
// bounds the legacy synchronous path (server lacks backup_run_async), where
// forwardToBackupHelper waits for the whole backup to finish. When the
// server advertises the capability, forwardToBackupHelper sends the command
// async — the helper's {"started":true} ack arrives within seconds, well
// under this bound, and the real result is delivered later as an unsolicited
// backup_result envelope (heartbeat.go, case backupipc.TypeBackupResult),
// never through this timeout at all.
func handleBackupRun(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 10*time.Minute)
}

func handleBackupList(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 30*time.Second)
}

func handleBackupStop(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 10*time.Second)
}

func handleBackupRestore(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 30*time.Minute)
}
