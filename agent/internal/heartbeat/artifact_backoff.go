package heartbeat

import (
	"os"
	"time"

	"github.com/breeze-rmm/agent/internal/updater"
)

// Component keys for h.artifactBackoff. Each tracks one target version at a
// time, so a new offer for a component starts a fresh streak (#7516).
const (
	artifactComponentAgent      = "agent"
	artifactComponentBackup     = "backup"
	artifactComponentUserHelper = "user-helper"
	artifactComponentWatchdog   = "watchdog"
)

// upgradeDeferredByArtifactBackoff reports whether doUpgrade should skip this
// heartbeat's offer of targetVersion. It runs before any network or status work,
// because the server re-sends the same upgradeTo on every heartbeat (#7516).
// It returns true when:
//   - the agent artifact for targetVersion recently failed verification, or
//   - the backup companion for targetVersion recently failed verification while
//     a backup binary is installed and the companion failure cap is not yet
//     reached. In that case the cycle would only re-download the backup,
//     abort, and repeat.
func (h *Heartbeat) upgradeDeferredByArtifactBackoff(targetVersion string) bool {
	if left, active := h.artifactBackoff.Remaining(artifactComponentAgent, targetVersion); active {
		log.Debug("upgrade skipped: this version's agent artifact recently failed verification; backing off",
			"targetVersion", targetVersion, "retryIn", left.Round(time.Second).String())
		return true
	}
	if _, active := h.artifactBackoff.Remaining(artifactComponentBackup, targetVersion); active &&
		h.backupHelperPresent() && h.backupPrefetchFailuresFor(targetVersion) < backupPrefetchFailureCap {
		log.Debug("upgrade skipped: this version's breeze-backup artifact recently failed verification; backing off",
			"targetVersion", targetVersion)
		return true
	}
	return false
}

// noteAgentUpgradeArtifactFailure records err against targetVersion's agent
// backoff when it is a deterministic artifact failure, and logs it. Returns
// false (and records nothing) for any other error, which the caller handles as
// before.
func (h *Heartbeat) noteAgentUpgradeArtifactFailure(targetVersion string, err error) bool {
	if !updater.IsDeterministicArtifactFailure(err) {
		return false
	}
	n, delay := h.artifactBackoff.NoteFailure(artifactComponentAgent, targetVersion)
	key, value := updater.SafeDownloadErrorFields(err)
	log.Error("auto-update failed: the agent artifact the server serves for this version does not verify; backing off until the offer changes or the wait elapses",
		"targetVersion", targetVersion,
		"consecutiveFailures", n,
		"retryAfter", delay.String(),
		key, value)
	return true
}

// backupHelperPresent reports whether a non-empty breeze-backup binary is
// installed at the resolved path. A zero-length file counts as absent (see
// backupUpgradeCompanion).
func (h *Heartbeat) backupHelperPresent() bool {
	installPath, err := h.resolveBackupBinaryPath()
	if err != nil {
		return false
	}
	fi, statErr := os.Stat(installPath)
	return statErr == nil && fi.Size() > 0
}
