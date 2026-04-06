package heartbeat

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/updater"
)

func init() {
	handlerRegistry[tools.CmdDevUpdate] = handleDevUpdate
}

func handleDevUpdate(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	downloadURL := tools.GetPayloadString(cmd.Payload, "downloadUrl", "")
	if downloadURL == "" {
		return tools.NewErrorResult(fmt.Errorf("missing required field: downloadUrl"), 0)
	}

	checksum := tools.GetPayloadString(cmd.Payload, "checksum", "")
	if checksum == "" {
		return tools.NewErrorResult(fmt.Errorf("missing required field: checksum"), 0)
	}

	version := tools.GetPayloadString(cmd.Payload, "version", "dev")

	log.Info("dev_update received",
		"version", version,
		"downloadUrl", downloadURL,
	)

	// Disable auto-update so the heartbeat doesn't overwrite the dev binary
	// after the agent restarts. Persisted to disk via viper so it survives
	// the restart triggered by the update.
	h.config.AutoUpdate = false
	if err := config.SetAndPersist("auto_update", false); err != nil {
		log.Warn("failed to persist auto_update=false — dev build may revert after restart", "error", err.Error())
	}
	log.Info("auto_update disabled and persisted for dev push")

	// Resolve current binary path
	binaryPath, err := os.Executable()
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to get executable path: %w", err), time.Since(start).Milliseconds())
	}
	binaryPath, err = filepath.EvalSymlinks(binaryPath)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to resolve symlinks: %w", err), time.Since(start).Milliseconds())
	}

	backupDir := config.GetDataDir()
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to create backup directory %s: %w", backupDir, err), time.Since(start).Milliseconds())
	}
	backupPath := filepath.Join(backupDir, "breeze-agent.backup")

	updaterCfg := &updater.Config{
		ServerURL:      h.config.ServerURL,
		AuthToken:      h.secureToken,
		CurrentVersion: h.agentVersion,
		BinaryPath:     binaryPath,
		BackupPath:     backupPath,
	}

	u := updater.New(updaterCfg)

	// Run the update in a goroutine since UpdateFromURL triggers a restart
	go func() {
		if err := u.UpdateFromURL(downloadURL, checksum); err != nil {
			log.Error("dev_update failed", "version", version, "error", err.Error())
		}
	}()

	return tools.NewSuccessResult(map[string]any{
		"message": "dev_update initiated asynchronously — check agent logs for outcome",
		"version": version,
		"note":    "result reported before update completes; failures will only appear in agent logs",
	}, time.Since(start).Milliseconds())
}
