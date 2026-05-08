package heartbeat

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/updater"
)

const (
	devUpdateComponentAgent         = "agent"
	devUpdateComponentDesktopHelper = "desktop-helper"
)

// darwinDesktopHelperInstallPath is the installed location of the desktop
// helper binary on macOS. Must match service_cmd_darwin.go.
const darwinDesktopHelperInstallPath = "/usr/local/bin/breeze-desktop-helper"

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
	component := tools.GetPayloadString(cmd.Payload, "component", devUpdateComponentAgent)
	// preserveAutoUpdate=true tells handleDevUpdateAgent NOT to disable
	// auto_update after the swap. Used by server-orchestrated recovery
	// flows (see apps/api/scripts/recover-stuck-agents.ts) where the
	// goal is to get back onto the auto-update path, not to pin a dev
	// binary. Default false preserves the original dev-push behaviour.
	preserveAutoUpdate := tools.GetPayloadBool(cmd.Payload, "preserveAutoUpdate", false)
	// reason is informational — surfaces in logs so a future operator
	// grepping for "agent_update_trust_root_recovery" can find every
	// affected device's update timeline without parsing payloads.
	reason := tools.GetPayloadString(cmd.Payload, "reason", "")

	log.Info("dev_update received",
		"version", version,
		"component", component,
		"downloadUrl", downloadURL,
		"preserveAutoUpdate", preserveAutoUpdate,
		"reason", reason,
	)

	switch component {
	case devUpdateComponentAgent, "":
		return handleDevUpdateAgent(h, start, downloadURL, checksum, version, preserveAutoUpdate)
	case devUpdateComponentDesktopHelper:
		return handleDevUpdateDesktopHelper(h, start, downloadURL, checksum, version)
	default:
		return tools.NewErrorResult(fmt.Errorf("unsupported dev_update component: %q", component), time.Since(start).Milliseconds())
	}
}

// applyDevUpdateAutoUpdatePolicy decides whether a dev_update should leave
// auto_update on or pin the agent to the pushed binary.
//
//   - preserveAutoUpdate=false (default, classic dev push): set
//     h.config.AutoUpdate=false and persist to disk so the next heartbeat
//     doesn't immediately re-upgrade off the dev binary.
//   - preserveAutoUpdate=true (server-orchestrated recovery push): leave
//     auto_update untouched so the recovered agent rejoins the normal
//     update path on its next heartbeat.
//
// The persist-fail path logs a warning rather than returning an error —
// the binary swap proceeds and the agent restarts; if persist failed the
// only consequence is auto_update reverts to its on-disk value at restart.
// Extracted so handlers_devupdate_test.go can exercise both branches
// without standing up the full updater pipeline.
func applyDevUpdateAutoUpdatePolicy(h *Heartbeat, preserveAutoUpdate bool) {
	if preserveAutoUpdate {
		log.Info("dev_update preserving auto_update — likely a server-orchestrated recovery push")
		return
	}
	h.config.AutoUpdate = false
	if err := config.SetAndPersist("auto_update", false); err != nil {
		log.Warn("failed to persist auto_update=false — dev build may revert after restart", "error", err.Error())
	}
	log.Info("auto_update disabled and persisted for dev push")
}

func handleDevUpdateAgent(h *Heartbeat, start time.Time, downloadURL, checksum, version string, preserveAutoUpdate bool) tools.CommandResult {
	applyDevUpdateAutoUpdatePolicy(h, preserveAutoUpdate)

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
		h.sendUpdateStatus(version)
		if err := u.UpdateFromURL(downloadURL, checksum); err != nil {
			log.Error("dev_update failed", "version", version, "error", err.Error())
		}
	}()

	return tools.NewSuccessResult(map[string]any{
		"message":   "dev_update initiated asynchronously — check agent logs for outcome",
		"component": devUpdateComponentAgent,
		"version":   version,
		"note":      "result reported before update completes; failures will only appear in agent logs",
	}, time.Since(start).Milliseconds())
}

// handleDevUpdateDesktopHelper replaces the desktop helper binary on disk,
// refreshes the broker's helper binary hash allowlist so the newly spawned
// helper is accepted, and kickstarts the helper LaunchAgents so they pick up
// the new binary immediately. The main agent is NOT restarted.
func handleDevUpdateDesktopHelper(h *Heartbeat, start time.Time, downloadURL, checksum, version string) tools.CommandResult {
	if runtime.GOOS != "darwin" {
		return tools.NewErrorResult(fmt.Errorf("desktop-helper dev push is only implemented on darwin"), time.Since(start).Milliseconds())
	}

	updaterCfg := &updater.Config{
		ServerURL:      h.config.ServerURL,
		AuthToken:      h.secureToken,
		CurrentVersion: h.agentVersion,
	}
	u := updater.New(updaterCfg)

	// Download + verify into a temp file. The caller is responsible for
	// moving it into place and cleaning up.
	tempPath, err := u.DownloadAndVerify(downloadURL, checksum)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to download desktop helper: %w", err), time.Since(start).Milliseconds())
	}
	defer os.Remove(tempPath)

	installPath := darwinDesktopHelperInstallPath

	// Backup the existing helper binary (best effort — first install may not
	// have one yet).
	backupDir := config.GetDataDir()
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to create backup directory %s: %w", backupDir, err), time.Since(start).Milliseconds())
	}
	backupPath := filepath.Join(backupDir, "breeze-desktop-helper.backup")
	if _, statErr := os.Stat(installPath); statErr == nil {
		if err := copyFile(installPath, backupPath); err != nil {
			log.Warn("failed to back up existing desktop helper binary — proceeding anyway",
				"installPath", installPath,
				"backupPath", backupPath,
				"error", err.Error())
		}
	}

	// Install new binary. os.Rename across filesystems can fail, so copy
	// then chmod to ensure the file is in place atomically from the helper's
	// point of view.
	if err := copyFile(tempPath, installPath); err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to install desktop helper at %s: %w", installPath, err), time.Since(start).Milliseconds())
	}
	if err := os.Chmod(installPath, 0755); err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to chmod desktop helper at %s: %w", installPath, err), time.Since(start).Milliseconds())
	}
	log.Info("installed new desktop helper binary", "path", installPath, "version", version)

	// Refresh the broker's binary hash allowlist so the newly spawned helper
	// is accepted when it reconnects.
	if h.sessionBroker != nil {
		h.sessionBroker.RefreshAllowedHashes()
	} else {
		log.Warn("session broker unavailable — helper reconnection may be rejected until agent restart")
	}

	// Kickstart the helper LaunchAgents so running helpers restart with the
	// new binary. Reuses the existing helper-restart logic from the user-
	// session switch path.
	kickstartDarwinDesktopHelpers()

	// Also kickstart any other helpers that may be loaded but weren't hit by
	// the post-update kickstart routine above (e.g. a helper running in a
	// disconnected user session).
	_ = exec.Command("launchctl", "kickstart", "-k", "loginwindow/com.breeze.desktop-helper-loginwindow").Run()

	return tools.NewSuccessResult(map[string]any{
		"message":   "desktop helper replaced and kickstarted",
		"component": devUpdateComponentDesktopHelper,
		"version":   version,
		"path":      installPath,
	}, time.Since(start).Milliseconds())
}

// copyFile copies src to dst, overwriting dst if it exists.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open src: %w", err)
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0755)
	if err != nil {
		return fmt.Errorf("open dst: %w", err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return fmt.Errorf("copy: %w", err)
	}
	return out.Close()
}
