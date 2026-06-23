package heartbeat

import (
	"errors"
	"os"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

const (
	watchdogRepairDownloadFailed       = "download_failed"
	watchdogRepairSignatureFailed      = "signature_failed"
	watchdogRepairServiceInstallFailed = "service_install_failed"
	watchdogRepairIPCTrustFailed       = "ipc_trust_failed"
	watchdogRepairStartFailed          = "start_failed"
	watchdogRepairPermissionDenied     = "permission_denied"
	watchdogRepairAlreadyRunning       = "already_running"
)

func watchdogRepairReason(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, os.ErrPermission) {
		return watchdogRepairPermissionDenied
	}
	lower := strings.ToLower(err.Error())
	switch {
	case strings.Contains(lower, "signature"),
		strings.Contains(lower, "manifest"),
		strings.Contains(lower, "checksum"),
		strings.Contains(lower, "trusted"):
		return watchdogRepairSignatureFailed
	case strings.Contains(lower, "download"):
		return watchdogRepairDownloadFailed
	case strings.Contains(lower, "allowlist"),
		strings.Contains(lower, "ipc"),
		strings.Contains(lower, "hash"):
		return watchdogRepairIPCTrustFailed
	case strings.Contains(lower, "start"),
		strings.Contains(lower, "restart"),
		strings.Contains(lower, "launchctl"),
		strings.Contains(lower, "systemctl"):
		return watchdogRepairStartFailed
	case strings.Contains(lower, "service install"),
		strings.Contains(lower, "install service"):
		return watchdogRepairServiceInstallFailed
	default:
		return "repair_failed"
	}
}

func handleUpdateWatchdog(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	targetVersion := strings.TrimSpace(tools.GetPayloadString(cmd.Payload, "version", ""))
	if targetVersion == "" {
		return tools.CommandResult{Status: "failed", Error: "missing version in payload"}
	}
	if strings.HasPrefix(targetVersion, "dev-") {
		return tools.CommandResult{Status: "failed", Error: "refusing to install dev watchdog build"}
	}
	if _, _, _, ok := parseSemver(targetVersion); !ok {
		return tools.CommandResult{Status: "failed", Error: "refusing to install non-semver watchdog build"}
	}
	if h.manifestTrustRotationRejected.Load() {
		return tools.CommandResult{Status: "failed", Error: watchdogRepairSignatureFailed + ": manifest trust rotation rejection unresolved"}
	}
	if isDowngrade(targetVersion, h.agentVersion) {
		return tools.CommandResult{Status: "failed", Error: "refusing to downgrade watchdog"}
	}
	if !h.watchdogUpgradeInProgress.CompareAndSwap(false, true) {
		return tools.CommandResult{
			Status: "failed",
			Error:  watchdogRepairAlreadyRunning,
		}
	}
	defer h.watchdogUpgradeInProgress.Store(false)

	install := h.watchdogInstaller
	if install == nil {
		install = h.installAndRestartWatchdog
	}
	if err := install(targetVersion); err != nil {
		reason := watchdogRepairReason(err)
		return tools.CommandResult{
			Status:     "failed",
			Error:      reason + ": " + err.Error(),
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	h.watchdogUpgradeMu.Lock()
	h.watchdogInstalledVersion = targetVersion
	h.watchdogUpgradeMu.Unlock()

	return tools.NewSuccessResult(map[string]any{
		"updated_to": targetVersion,
		"component":  "watchdog",
	}, time.Since(start).Milliseconds())
}
