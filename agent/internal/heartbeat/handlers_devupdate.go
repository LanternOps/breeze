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

	// Disable auto-update to prevent heartbeat from overwriting the dev binary
	h.config.AutoUpdate = false
	if err := config.Save(h.config); err != nil {
		log.Warn("failed to persist auto_update=false to config", "error", err)
		// Continue anyway — the in-memory flag is already set
	}
	log.Info("auto_update disabled for dev push, set auto_update: true in config to re-enable")

	// Resolve current binary path
	binaryPath, err := os.Executable()
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to get executable path: %w", err), time.Since(start).Milliseconds())
	}
	binaryPath, err = filepath.EvalSymlinks(binaryPath)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to resolve symlinks: %w", err), time.Since(start).Milliseconds())
	}

	backupPath := binaryPath + ".backup"
	authToken := h.authTokenPlaintext()

	updaterCfg := &updater.Config{
		ServerURL:      h.config.ServerURL,
		AuthToken:      authToken,
		CurrentVersion: h.agentVersion,
		BinaryPath:     binaryPath,
		BackupPath:     backupPath,
	}

	u := updater.New(updaterCfg)

	// Run the update in a goroutine since UpdateFromURL triggers a restart
	go func() {
		if err := u.UpdateFromURL(downloadURL, checksum); err != nil {
			log.Error("dev_update failed", "version", version, "error", err)
		}
	}()

	return tools.NewSuccessResult(map[string]any{
		"message": "dev_update initiated asynchronously — check agent logs for outcome",
		"version": version,
		"note":    "result reported before update completes; failures will only appear in agent logs",
	}, time.Since(start).Milliseconds())
}
