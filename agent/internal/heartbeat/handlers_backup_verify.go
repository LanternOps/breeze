package heartbeat

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdBackupVerify] = handleBackupVerify
	handlerRegistry[tools.CmdBackupTestRestore] = handleBackupTestRestore
	handlerRegistry[tools.CmdBackupCleanup] = handleBackupCleanup
}

func handleBackupVerify(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	if h.backupMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("backup not configured"), time.Since(start).Milliseconds())
	}

	snapshotID := tools.GetPayloadString(cmd.Payload, "snapshotId", "")
	if snapshotID == "" {
		// Default to latest snapshot
		snapshots, err := backup.ListSnapshots(h.backupMgr.GetProvider())
		if err != nil || len(snapshots) == 0 {
			return tools.NewErrorResult(fmt.Errorf("no snapshots available"), time.Since(start).Milliseconds())
		}
		snapshotID = snapshots[len(snapshots)-1].ID
	}

	result, err := backup.VerifyIntegrity(h.backupMgr.GetProvider(), snapshotID)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(result, time.Since(start).Milliseconds())
}

func handleBackupTestRestore(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	if h.backupMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("backup not configured"), time.Since(start).Milliseconds())
	}

	snapshotID := tools.GetPayloadString(cmd.Payload, "snapshotId", "")
	if snapshotID == "" {
		snapshots, err := backup.ListSnapshots(h.backupMgr.GetProvider())
		if err != nil || len(snapshots) == 0 {
			return tools.NewErrorResult(fmt.Errorf("no snapshots available"), time.Since(start).Milliseconds())
		}
		snapshotID = snapshots[len(snapshots)-1].ID
	}

	// Set up WebSocket progress callback if available
	var progressFn func(current, total int)
	if h.wsClient != nil {
		progressFn = func(current, total int) {
			_ = h.wsClient.SendVerificationProgress(cmd.ID, map[string]any{
				"current": current,
				"total":   total,
			})
		}
	}

	result, err := backup.TestRestore(h.backupMgr.GetProvider(), snapshotID, progressFn)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(result, time.Since(start).Milliseconds())
}

func handleBackupCleanup(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	restorePath := tools.GetPayloadString(cmd.Payload, "restorePath", "")
	if restorePath == "" {
		return tools.NewErrorResult(fmt.Errorf("restorePath is required"), time.Since(start).Milliseconds())
	}

	if err := backup.CleanupRestoreDir(restorePath); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{"cleaned": true, "path": restorePath}, time.Since(start).Milliseconds())
}
