package main

import (
	"log/slog"

	"github.com/breeze-rmm/agent/internal/powerrequest"
)

// backupPowerRequestReason is what Windows lists for the request in
// `powercfg /requests` while a backup workload runs.
const backupPowerRequestReason = "Breeze backup in progress"

// holdSystemAwake is the power request seam; tests replace it.
var holdSystemAwake = powerrequest.HoldSystemAwake

// holdSystemAwakeForBackup keeps the device out of idle sleep while one backup
// workload executes (#12193): a Windows device that idle-sleeps mid-run stalls
// the helper and the agent with it, and the run is lost (#11044). It is held
// only once the workload leaves the execution queue, and the caller releases
// it when the workload returns, whichever way it ends. Each workload holds its
// own request, so concurrent workloads need no shared count.
//
// Best effort: a device that refuses the request still runs the backup, with
// a warning that it may sleep. Policy is "always, for the duration of the
// run", on AC and battery alike. The request blocks idle sleep only; a sleep
// the user asks for, a critical-battery action and a shutdown still happen.
func holdSystemAwakeForBackup(commandID, commandType string) (release func()) {
	release, err := holdSystemAwake(backupPowerRequestReason)
	if err != nil {
		slog.Warn("could not hold a system-required power request; the device may idle-sleep during this backup",
			"commandId", commandID, "commandType", commandType, "error", err.Error())
		return func() {}
	}
	return release
}
