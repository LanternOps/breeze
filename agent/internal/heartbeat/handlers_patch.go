package heartbeat

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdPatchScan] = handlePatchScan
	handlerRegistry[tools.CmdInstallPatches] = handleInstallPatches
	handlerRegistry[tools.CmdRollbackPatches] = handleRollbackPatches
	handlerRegistry[tools.CmdDownloadPatches] = handleDownloadPatches
	handlerRegistry[tools.CmdScheduleReboot] = handleScheduleReboot
	handlerRegistry[tools.CmdCancelReboot] = handleCancelReboot
	handlerRegistry[tools.CmdGetRebootStatus] = handleGetRebootStatus
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
	start := time.Now()

	// Run pre-flight checks before install
	opts := patching.PreflightOptionsFromConfig(h.config)
	pfResult := patching.RunPreflight(opts)
	for _, check := range pfResult.Checks {
		if check.Passed {
			log.Debug("preflight passed", "check", check.Name, "message", check.Message)
		} else {
			log.Warn("preflight failed", "check", check.Name, "message", check.Message)
		}
	}
	if !pfResult.OK {
		return tools.NewErrorResult(pfResult.FirstError(), time.Since(start).Milliseconds())
	}

	return h.executePatchInstallCommand(cmd.Payload, false)
}

func handleRollbackPatches(h *Heartbeat, cmd Command) tools.CommandResult {
	return h.executePatchInstallCommand(cmd.Payload, true)
}

func handleDownloadPatches(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	// Run pre-flight for downloads (disk + service health only, skip battery/maintenance)
	opts := patching.PreflightOptionsFromConfig(h.config)
	opts.CheckACPower = false
	opts.CheckMaintWindow = false
	pfResult := patching.RunPreflight(opts)
	for _, check := range pfResult.Checks {
		if !check.Passed {
			log.Warn("download preflight failed", "check", check.Name, "message", check.Message)
		}
	}
	if !pfResult.OK {
		return tools.NewErrorResult(pfResult.FirstError(), time.Since(start).Milliseconds())
	}

	if h.patchMgr == nil || len(h.patchMgr.ProviderIDs()) == 0 {
		return tools.NewErrorResult(fmt.Errorf("no patch providers available"), time.Since(start).Milliseconds())
	}

	patchIDs := tools.GetPayloadStringSlice(cmd.Payload, "patchIds")
	if len(patchIDs) == 0 {
		return tools.NewErrorResult(fmt.Errorf("no patchIds provided"), time.Since(start).Milliseconds())
	}

	// Progress callback sends events via WebSocket
	var progressFn patching.ProgressCallback
	if h.wsClient != nil {
		progressFn = func(event patching.ProgressEvent) {
			_ = h.wsClient.SendPatchProgress(cmd.ID, event)
		}
	}

	results, err := h.patchMgr.DownloadPatches(patchIDs, progressFn)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	successCount := 0
	failedCount := 0
	downloadResults := make([]map[string]any, len(results))
	for i, r := range results {
		downloadResults[i] = map[string]any{
			"patchId": r.PatchID,
			"success": r.Success,
			"message": r.Message,
		}
		if r.Success {
			successCount++
		} else {
			failedCount++
		}
	}

	return tools.NewSuccessResult(map[string]any{
		"downloadedCount": successCount,
		"failedCount":     failedCount,
		"results":         downloadResults,
	}, time.Since(start).Milliseconds())
}

func handleScheduleReboot(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	if h.rebootMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("reboot manager not available"), time.Since(start).Milliseconds())
	}

	delayMinutes := tools.GetPayloadInt(cmd.Payload, "delayMinutes", 60)
	reason := tools.GetPayloadString(cmd.Payload, "reason", "Scheduled by administrator")
	source := tools.GetPayloadString(cmd.Payload, "source", "manual")

	delay := time.Duration(delayMinutes) * time.Minute
	deadline := time.Now().Add(delay)

	// Allow overriding deadline via payload
	if deadlineStr := tools.GetPayloadString(cmd.Payload, "deadline", ""); deadlineStr != "" {
		if parsed, err := time.Parse(time.RFC3339, deadlineStr); err == nil {
			deadline = parsed
		}
	}

	if err := h.rebootMgr.Schedule(delay, deadline, reason, source); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	state := h.rebootMgr.State()
	stateJSON, _ := json.Marshal(state)
	var stateMap map[string]any
	json.Unmarshal(stateJSON, &stateMap)

	return tools.NewSuccessResult(stateMap, time.Since(start).Milliseconds())
}

func handleCancelReboot(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	if h.rebootMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("reboot manager not available"), time.Since(start).Milliseconds())
	}

	if err := h.rebootMgr.Cancel(); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	return tools.NewSuccessResult(map[string]any{"cancelled": true}, time.Since(start).Milliseconds())
}

func handleGetRebootStatus(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	if h.rebootMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("reboot manager not available"), time.Since(start).Milliseconds())
	}

	state := h.rebootMgr.State()
	stateJSON, _ := json.Marshal(state)
	var stateMap map[string]any
	json.Unmarshal(stateJSON, &stateMap)

	return tools.NewSuccessResult(stateMap, time.Since(start).Milliseconds())
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
