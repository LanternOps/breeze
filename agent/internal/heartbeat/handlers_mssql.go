//go:build windows

package heartbeat

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/mssql"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdMSSQLDiscover] = handleMSSQLDiscover
	handlerRegistry[tools.CmdMSSQLBackup] = handleMSSQLBackup
	handlerRegistry[tools.CmdMSSQLRestore] = handleMSSQLRestore
	handlerRegistry[tools.CmdMSSQLVerify] = handleMSSQLVerify
}

func handleMSSQLDiscover(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	instances, err := mssql.DiscoverInstances()
	if err != nil {
		slog.Warn("mssql discover failed", "error", err.Error())
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	result := map[string]any{
		"instances": instances,
		"count":     len(instances),
	}

	data, _ := json.Marshal(result)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}

func handleMSSQLBackup(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	payload := cmd.Payload
	instance := tools.GetPayloadString(payload, "instance", "")
	database := tools.GetPayloadString(payload, "database", "")
	backupType := tools.GetPayloadString(payload, "backupType", "full")
	outputPath := tools.GetPayloadString(payload, "outputPath", "")

	if instance == "" {
		return tools.NewErrorResult(fmt.Errorf("instance is required"), time.Since(start).Milliseconds())
	}
	if database == "" {
		return tools.NewErrorResult(fmt.Errorf("database is required"), time.Since(start).Milliseconds())
	}
	if outputPath == "" {
		return tools.NewErrorResult(fmt.Errorf("outputPath is required"), time.Since(start).Milliseconds())
	}

	backupResult, err := mssql.RunBackup(instance, database, backupType, outputPath)
	if err != nil {
		slog.Warn("mssql backup failed",
			"instance", instance,
			"database", database,
			"type", backupType,
			"error", err.Error(),
		)
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	data, _ := json.Marshal(backupResult)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}

func handleMSSQLRestore(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	payload := cmd.Payload
	instance := tools.GetPayloadString(payload, "instance", "")
	backupFile := tools.GetPayloadString(payload, "backupFile", "")
	targetDB := tools.GetPayloadString(payload, "targetDatabase", "")
	noRecovery := tools.GetPayloadBool(payload, "noRecovery", false)

	if instance == "" {
		return tools.NewErrorResult(fmt.Errorf("instance is required"), time.Since(start).Milliseconds())
	}
	if backupFile == "" {
		return tools.NewErrorResult(fmt.Errorf("backupFile is required"), time.Since(start).Milliseconds())
	}
	if targetDB == "" {
		return tools.NewErrorResult(fmt.Errorf("targetDatabase is required"), time.Since(start).Milliseconds())
	}

	restoreResult, err := mssql.RunRestore(instance, backupFile, targetDB, noRecovery)
	if err != nil {
		slog.Warn("mssql restore failed",
			"instance", instance,
			"backupFile", backupFile,
			"targetDB", targetDB,
			"error", err.Error(),
		)
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	data, _ := json.Marshal(restoreResult)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}

func handleMSSQLVerify(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	payload := cmd.Payload
	instance := tools.GetPayloadString(payload, "instance", "")
	backupFile := tools.GetPayloadString(payload, "backupFile", "")

	if instance == "" {
		return tools.NewErrorResult(fmt.Errorf("instance is required"), time.Since(start).Milliseconds())
	}
	if backupFile == "" {
		return tools.NewErrorResult(fmt.Errorf("backupFile is required"), time.Since(start).Milliseconds())
	}

	verifyResult, err := mssql.VerifyBackup(instance, backupFile)
	if err != nil {
		slog.Warn("mssql verify failed",
			"instance", instance,
			"backupFile", backupFile,
			"error", err.Error(),
		)
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	data, _ := json.Marshal(verifyResult)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}
