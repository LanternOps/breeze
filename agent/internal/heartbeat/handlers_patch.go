package heartbeat

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdPatchScan] = handlePatchScan
	handlerRegistry[tools.CmdInstallPatches] = handleInstallPatches
	handlerRegistry[tools.CmdRollbackPatches] = handleRollbackPatches
	handlerRegistry[tools.CmdBackupRun] = handleBackupRun
	handlerRegistry[tools.CmdBackupList] = handleBackupList
	handlerRegistry[tools.CmdBackupStop] = handleBackupStop
}

func handlePatchScan(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	pendingItems, installedItems, err := h.collectPatchInventory()
	if err != nil && len(pendingItems) == 0 && len(installedItems) == 0 {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	h.sendInventoryData("patches", map[string]any{
		"patches":   pendingItems,
		"installed": installedItems,
	}, fmt.Sprintf("patches (%d pending, %d installed)", len(pendingItems), len(installedItems)))

	return tools.NewSuccessResult(map[string]any{
		"pendingCount":   len(pendingItems),
		"installedCount": len(installedItems),
		"warning":        errorString(err),
	}, time.Since(start).Milliseconds())
}

func handleInstallPatches(h *Heartbeat, cmd Command) tools.CommandResult {
	return h.executePatchInstallCommand(cmd.Payload, false)
}

func handleRollbackPatches(h *Heartbeat, cmd Command) tools.CommandResult {
	return h.executePatchInstallCommand(cmd.Payload, true)
}

func handleBackupRun(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	if h.backupMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("backup not configured"), time.Since(start).Milliseconds())
	}
	job, err := h.backupMgr.RunBackup()
	if err != nil && job == nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	jobResult := map[string]any{
		"jobId":  job.ID,
		"status": job.Status,
	}
	if job.Snapshot != nil {
		jobResult["snapshotId"] = job.Snapshot.ID
		jobResult["filesBackedUp"] = job.FilesBackedUp
		jobResult["bytesBackedUp"] = job.BytesBackedUp
	}
	if job.Error != nil {
		jobResult["warning"] = job.Error.Error()
	}
	return tools.NewSuccessResult(jobResult, time.Since(start).Milliseconds())
}

func handleBackupList(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	if h.backupMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("backup not configured"), time.Since(start).Milliseconds())
	}
	snapshots, err := backup.ListSnapshots(h.backupMgr.GetProvider())
	if err != nil && len(snapshots) == 0 {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"snapshots": snapshots,
		"count":     len(snapshots),
	}, time.Since(start).Milliseconds())
}

func handleBackupStop(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	if h.backupMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("backup not configured"), time.Since(start).Milliseconds())
	}
	h.backupMgr.Stop()
	return tools.NewSuccessResult(map[string]any{"stopped": true}, time.Since(start).Milliseconds())
}
