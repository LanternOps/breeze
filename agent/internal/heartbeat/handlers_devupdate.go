package heartbeat

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

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

	// Disable auto-update in memory to prevent heartbeat from overwriting
	// the dev binary during this run. We intentionally do NOT call
	// config.Save here — SaveTo would need the auth token which is cleared
	// from the config struct at startup, and writing the file risks wiping it.
	h.config.AutoUpdate = false
	log.Info("auto_update disabled in memory for dev push")

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
