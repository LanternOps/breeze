package heartbeat

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/updater"
)

// breeze-backup's version is SLAVED to the agent version: there is no
// independent backup directive or server-driven promotion. Delivery happens
// two ways — (A) prefetch + swap during an agent upgrade (this file's
// prefetchBackupHelper / backupUpgradeCompanion, called from doUpgrade) and
// (B) a 30-minute heartbeat reconcile (reconcileBackupHelper) that self-heals
// a missing or version-mismatched binary independently of any upgrade being
// in progress. Both paths always fetch h.agentVersion, never "latest".
//
// Both paths, and the version probe in backup_version.go, resolve the
// on-disk breeze-backup path through the single h.resolveBackupBinaryPath()
// helper — see its doc for why a single resolution matters.

// prefetchBackupHelper pre-downloads breeze-backup so the upgrade-restart path
// can drop it alongside the new agent binary. Unlike prefetchUserHelper this
// runs on EVERY platform — breeze-backup ships on Linux/macOS/Windows alike
// (see agent/Makefile), not just Windows — and unlike prefetchUserHelper it
// returns the download error to the caller instead of swallowing it: doUpgrade
// needs to distinguish failure to decide whether to abort the whole agent
// upgrade or proceed agent-only (see backupUpgradeCompanion).
func (h *Heartbeat) prefetchBackupHelper(targetVersion string) (*updater.BinaryPair, error) {
	target, resolveErr := h.resolveBackupBinaryPath()
	if resolveErr != nil {
		return nil, fmt.Errorf("cannot resolve backup helper install path: %w", resolveErr)
	}

	download := h.backupHelperDownloader
	if download == nil {
		backupCfg := &updater.Config{
			ServerURL:                   h.serverURL,
			BackupServerURL:             h.backupServerURL(),
			AuthToken:                   h.secureToken,
			CurrentVersion:              h.agentVersion,
			Component:                   "backup",
			PinnedManifestPubKeys:       h.pinnedManifestPubKeys(),
			RequireManifestSigningKeyID: h.requireManifestSigningKeyID(),
		}
		download = updater.New(backupCfg).DownloadBinary
	}

	tempPath, dlErr := download(targetVersion)
	if dlErr != nil {
		return nil, dlErr
	}

	pair := &updater.BinaryPair{
		Temp:   tempPath,
		Target: target,
	}
	log.Info(
		"pre-downloaded backup helper for upgrade swap",
		"temp", pair.Temp,
		"target", pair.Target,
	)
	return pair, nil
}

// backupPrefetchFailureCap is the number of consecutive backupUpgradeCompanion
// prefetch failures — for the SAME target version, with a backup binary
// already present — tolerated before giving up on aborting and proceeding
// agent-only instead. Without this cap, a target version whose breeze-backup
// artifact is permanently missing (a self-hosted server that never registered
// backup binaries, or a release tag that shipped without the asset) would
// wedge agent upgrades forever: every cycle re-aborts, the agent never
// upgrades, and the retry never has anything new to succeed at. Three cycles
// gives real transient failures (network blip, momentary server hiccup) two
// full retries to self-heal before conceding.
const backupPrefetchFailureCap = 3

// backupUpgradeCompanion resolves the *updater.BinaryPair doUpgrade should
// thread into UpdateOptions.Backup for this upgrade cycle, or reports that the
// whole agent upgrade must be aborted this cycle instead.
//
// Failure policy deliberately differs from the user-helper prefetch (which is
// always non-fatal):
//   - a breeze-backup binary is currently present at the target path: ABORT
//     the whole agent upgrade with a loud error, UNLESS this is the
//     backupPrefetchFailureCap'th consecutive failure for this exact target
//     version — see backupPrefetchFailureCap. The heartbeat loop naturally
//     retries upgrades on the next tick, so a transient prefetch failure
//     (network blip, momentary server hiccup) self-heals without ever leaving
//     a stale/mismatched backup helper installed next to a newer agent — but
//     a PERMANENTLY missing artifact must not wedge agent upgrades forever.
//   - no breeze-backup binary is present on disk: proceed agent-only. A
//     backup-less fleet (or a device where the artifact was never installed)
//     must not be permanently wedged off agent updates by a component it
//     doesn't have.
//
// A present-but-zero-length binary is treated as absent (proceed): it's
// already broken, so declining to upgrade around it doesn't preserve anything
// — reconcileBackupHelper will re-fetch it on its own schedule regardless.
func (h *Heartbeat) backupUpgradeCompanion(targetVersion string) (pair *updater.BinaryPair, abort bool) {
	installPath, resolveErr := h.resolveBackupBinaryPath()
	present := false
	if resolveErr == nil {
		if fi, statErr := os.Stat(installPath); statErr == nil && fi.Size() > 0 {
			present = true
		}
	}

	pair, err := h.prefetchBackupHelper(targetVersion)
	if err == nil {
		h.resetBackupPrefetchFailures()
		return pair, false
	}

	key, value := updater.SafeDownloadErrorFields(err)
	if !present {
		log.Warn("breeze-backup prefetch failed and no backup helper is installed; proceeding with agent-only upgrade",
			"targetVersion", targetVersion, key, value)
		return nil, false
	}

	failures := h.noteBackupPrefetchFailure(targetVersion)
	if failures >= backupPrefetchFailureCap {
		log.Error("proceeding with agent upgrade after failed breeze-backup prefetch attempts — backup binary will drift until reconcile succeeds",
			"targetVersion", targetVersion, "consecutiveFailures", failures, key, value)
		return nil, false
	}
	log.Error("agent upgrade blocked: matching breeze-backup artifact unavailable — retrying next cycle",
		"targetVersion", targetVersion, "consecutiveFailures", failures, key, value)
	return nil, true
}

// noteBackupPrefetchFailure records a consecutive backupUpgradeCompanion
// prefetch failure for targetVersion, resetting the streak first if
// targetVersion differs from the one the streak was counted against (a new
// release must get its own full budget of retries, not inherit a stale
// failure count from the release before it). Returns the new count.
func (h *Heartbeat) noteBackupPrefetchFailure(targetVersion string) int {
	h.backupPrefetchFailureMu.Lock()
	defer h.backupPrefetchFailureMu.Unlock()
	if h.backupPrefetchFailureVersion != targetVersion {
		h.backupPrefetchFailureVersion = targetVersion
		h.backupPrefetchFailureCount = 0
	}
	h.backupPrefetchFailureCount++
	return h.backupPrefetchFailureCount
}

// resetBackupPrefetchFailures clears the consecutive-failure streak after a
// successful prefetch, so a later failure (for this or a future target
// version) starts counting from zero again.
func (h *Heartbeat) resetBackupPrefetchFailures() {
	h.backupPrefetchFailureMu.Lock()
	defer h.backupPrefetchFailureMu.Unlock()
	h.backupPrefetchFailureVersion = ""
	h.backupPrefetchFailureCount = 0
}

// removeStagedUpgradeTemps removes the temp file staged by each non-nil
// BinaryPair, ignoring nil pairs and already-gone files. Used by doUpgrade's
// early-return paths that run AFTER a prefetch has already downloaded a
// companion binary to a temp file but BEFORE updater.UpdateToWithOptions is
// ever invoked (an abort from backupUpgradeCompanion, or a busy-defer from
// backupHelperIdle): UpdateToWithOptions' error-path cleanup is the only other
// owner of these temps, and it never runs on a path that doesn't reach it —
// so without this, the temp files are orphaned on disk until an operator or a
// future cleanup sweep notices.
func removeStagedUpgradeTemps(pairs ...*updater.BinaryPair) {
	for _, p := range pairs {
		if p == nil || p.Temp == "" {
			continue
		}
		if err := os.Remove(p.Temp); err != nil && !os.IsNotExist(err) {
			log.Warn("failed to remove staged upgrade temp file", "path", p.Temp, "error", err.Error())
		}
	}
}

// backupHelperIdle reports whether it is currently safe to replace the
// on-disk breeze-backup binary: no backup job may be in flight, since
// swapping (or an installer's taskkill backstop) killing the file out from
// under a job that's mid-upload would corrupt or kill it. Consults the same
// idle-check both callers need: h.backupHelperStopIfIdle (test seam) when
// set, otherwise h.sessionBroker.StopBackupHelperIfIdle. A nil sessionBroker
// (and no test seam) means "nothing to stop" — proceed. Shared by doUpgrade's
// pre-swap gate and reconcileBackupHelper's pre-download AND pre-install
// re-check so the nil-handling and seam resolution live in exactly one place.
func (h *Heartbeat) backupHelperIdle() bool {
	stopIfIdle := h.backupHelperStopIfIdle
	if stopIfIdle == nil && h.sessionBroker != nil {
		stopIfIdle = h.sessionBroker.StopBackupHelperIfIdle
	}
	if stopIfIdle == nil {
		return true
	}
	return stopIfIdle()
}

// reconcileBackupHelper self-heals a stale or missing breeze-backup binary,
// decoupled from any in-progress agent upgrade. Runs on ALL platforms —
// unlike reconcileUserHelper's Windows-only gate, breeze-backup ships
// everywhere.
//
// Unlike reconcileUserHelper's stat-only check (present vs. absent), this
// detection is VERSION-AWARE: breeze-backup's version is slaved to the
// agent's, so a present-but-stale (or present-but-broken, see
// backupProbeOutcome) binary is just as much a defect as a missing one — a
// stat-only check would never notice an agent that upgraded while a backup
// prefetch failed and proceeded agent-only (see backupUpgradeCompanion), nor
// a legacy binary that predates the --version flag entirely. All failure
// modes are non-fatal.
func (h *Heartbeat) reconcileBackupHelper() {
	installPath, resolveErr := h.resolveBackupBinaryPath()
	if resolveErr != nil {
		log.Warn("backup helper reconciliation: cannot resolve backup helper path", "error", resolveErr.Error())
		return
	}

	needsInstall := false
	switch fi, statErr := os.Stat(installPath); {
	case statErr == nil && fi.Size() == 0:
		// A previous install was interrupted mid-write (or an external
		// truncation). Treat as absent and re-fetch — otherwise the corpse
		// blocks self-heal forever. (installBackupBinary's atomic replace
		// makes us-produced truncation impossible, so this is defense in
		// depth against external causes, mirroring reconcileUserHelper.)
		log.Warn("backup helper reconciliation: binary present but zero-length, re-fetching", "path", installPath)
		needsInstall = true
	case statErr == nil:
		// Present and non-empty. A dev-prefixed agent version skips the
		// version-mismatch check entirely: dev pushes run off the release
		// train on purpose (mirrors bootstrapWatchdog's dev- handling), and
		// there is no published breeze-backup artifact for a dev version to
		// reconcile toward — attempting one would just fail every tick.
		if !strings.HasPrefix(h.agentVersion, "dev-") {
			installed, outcome := h.installedBackupVersionOutcome()
			switch {
			case outcome == backupProbeFailed:
				// Present, but the --version probe itself failed or produced
				// unparseable output — a legacy (pre-#1802) or otherwise
				// broken binary. This is exactly what reconcile exists to
				// replace; treating an unknown/failed probe as "healthy" (the
				// previous `installed != ""` guard) stranded every such
				// binary in the fleet unpatched forever.
				log.Info("backup helper reconciliation: installed binary failed its version probe (legacy or broken build), re-fetching",
					"want", h.agentVersion)
				needsInstall = true
			case outcome == backupProbeOK && installed != h.agentVersion:
				log.Info("backup helper reconciliation: version mismatch, re-fetching",
					"installed", installed, "want", h.agentVersion)
				needsInstall = true
			}
			// backupProbeNotInstalled / backupProbeUnresolved here would mean
			// the stat above and the probe's own stat disagreed (a narrow
			// external race) — not a confirmed defect, so skip rather than
			// risk fetching over a binary we can't currently characterize;
			// the next tick (or the version probe's own immediate retry for
			// an unresolved path) picks it back up.
		}
	case os.IsNotExist(statErr):
		needsInstall = true
	default:
		// An unexpected stat error (permissions, transient IO) is not a
		// confirmed absence — don't risk fetching/clobbering over a binary we
		// merely couldn't read.
		log.Warn("backup helper reconciliation: cannot stat helper, skipping this tick",
			"path", installPath, "error", statErr.Error())
		return
	}

	if !needsInstall {
		if prev := h.backupHelperReconcileFailures.Swap(0); prev >= backupHelperReconcilePersistentThreshold {
			log.Info("backup helper healthy again after persistent reconcile failures", "previousFailures", prev)
		}
		return
	}

	// Never replace a binary while a backup job is running: swapping the file
	// out from under a job that's mid-upload would corrupt or kill it. This is
	// checked FIRST — before spending time on a download — and is a routine,
	// expected outcome (not a failure), so it does not touch the
	// failure/escalation counter below.
	if !h.backupHelperIdle() {
		log.Debug("backup helper reconciliation deferred: a backup job is currently running")
		return
	}

	download := h.backupHelperDownloader
	if download == nil {
		backupCfg := &updater.Config{
			ServerURL:                   h.serverURL,
			BackupServerURL:             h.backupServerURL(),
			AuthToken:                   h.secureToken,
			CurrentVersion:              h.agentVersion,
			Component:                   "backup",
			PinnedManifestPubKeys:       h.pinnedManifestPubKeys(),
			RequireManifestSigningKeyID: h.requireManifestSigningKeyID(),
		}
		download = updater.New(backupCfg).DownloadBinary
	}

	// Always fetch the CURRENTLY-installed agent version, never "latest" —
	// breeze-backup is slaved to the agent, not independently promoted.
	tempPath, dlErr := download(h.agentVersion)
	if dlErr != nil {
		// A version whose backup artifact genuinely doesn't exist would 404
		// every tick; noteBackupReconcileFailure escalates that from WARN to a
		// distinct ERROR so it doesn't loop silently forever.
		h.noteBackupReconcileFailure("download_failed", dlErr)
		return
	}
	defer func() { _ = os.Remove(tempPath) }()

	// Re-check idle immediately before the install step: the check above ran
	// BEFORE the download, so a job that started during the download window
	// would otherwise reach installBackupBinary's unconditional taskkill
	// backstop while genuinely mid-upload. This narrows, but does not fully
	// eliminate, the race between this re-check and the replace a few lines
	// below — closing it completely would mean holding a spawn-lease lock
	// through the broker across the whole download+install, which risks a
	// broker deadlock to guard a window that's only seconds wide. Not worth
	// it: the reconcile retries on the next tick regardless, and
	// installBackupBinary's atomic replace is idempotent. Also routine, not a
	// failure — same as the pre-download check above.
	if !h.backupHelperIdle() {
		log.Debug("backup helper reconciliation deferred: a backup job started during the download")
		return
	}

	install := h.backupHelperInstaller
	if install == nil {
		install = h.installBackupBinary
	}
	if err := install(tempPath, installPath, h.agentVersion); err != nil {
		h.noteBackupReconcileFailure("install_failed", err)
		return
	}
	if prev := h.backupHelperReconcileFailures.Swap(0); prev >= backupHelperReconcilePersistentThreshold {
		log.Info("backup helper reconciliation recovered after persistent failures", "previousFailures", prev)
	}
	log.Info("backup helper reconciliation: installed", "path", installPath, "version", h.agentVersion)
}

// backupHelperReconcilePersistentThreshold is the consecutive-failure count at
// which reconcileBackupHelper escalates from a routine WARN to a distinct
// ERROR (~2h at the 30-min reconcile cadence). backupHelperReconcileReLogEvery
// re-emits the ERROR periodically thereafter (~daily) so a stuck device stays
// visible without logging every tick. Mirrors the user-helper constants.
const (
	backupHelperReconcilePersistentThreshold = 4
	backupHelperReconcileReLogEvery          = 48
)

// noteBackupReconcileFailure records a consecutive reconcile failure and logs
// it at a level that escalates with persistence, mirroring
// noteUserHelperReconcileFailure: WARN on the first, ERROR once the failure
// count crosses the threshold (and periodically after), DEBUG in between.
func (h *Heartbeat) noteBackupReconcileFailure(reason string, err error) {
	key, value := updater.SafeDownloadErrorFields(err)
	n := h.backupHelperReconcileFailures.Add(1)
	switch {
	case n >= backupHelperReconcilePersistentThreshold &&
		(n == backupHelperReconcilePersistentThreshold || n%backupHelperReconcileReLogEvery == 0):
		log.Error("backup helper reconciliation persistently failing — device cannot self-heal its backup binary",
			"reason", reason, "consecutiveFailures", n,
			"currentVersion", h.agentVersion, key, value)
	case n == 1:
		log.Warn("backup helper reconciliation failed; will retry on a later tick",
			"reason", reason, "consecutiveFailures", n,
			"currentVersion", h.agentVersion, key, value)
	default:
		log.Debug("backup helper reconciliation still failing",
			"reason", reason, "consecutiveFailures", n, key, value)
	}
}

// reconcileBackupHelperFromExecutable is the production entry point for
// reconcileBackupHelper, wired to the periodic reconcile ticker. Split out —
// even though reconcileBackupHelper now resolves its own path via
// resolveBackupBinaryPath — so the ticker call site stays a stable,
// self-describing name and reconcileBackupHelper's tests keep constructing a
// Heartbeat directly rather than going through a real ticker.
func (h *Heartbeat) reconcileBackupHelperFromExecutable() {
	h.reconcileBackupHelper()
}

// installBackupBinary places a freshly-downloaded breeze-backup at installPath
// and makes it usable, mirroring installUserHelperBinary: best-effort backup
// of the existing binary, an atomic replace, and a broker hash-allowlist
// refresh so the next spawn is admitted over IPC. Unlike the Windows-only
// user-helper this ships on every platform, so only the process-kill step is
// Windows-gated — on Unix, replacing a running process's file is safe without
// killing it first (the old inode persists for whatever's still
// executing/holding it; see watchdog_install_unix.go's
// replaceWatchdogBinaryUnix for the same fact). Does not remove tempPath — the
// caller owns that.
//
// Serialized by backupHelperInstallMu so a future manual dev-push for this
// component and the periodic reconcile can't race on the shared install path.
func (h *Heartbeat) installBackupBinary(tempPath, installPath, version string) error {
	lease, acquired := updater.TryBeginProcessMutation("backup-update")
	if !acquired {
		return updater.ErrProcessMutationInProgress
	}
	defer lease.Release()
	h.backupHelperInstallMu.Lock()
	defer h.backupHelperInstallMu.Unlock()

	backupDir := config.GetDataDir()
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return fmt.Errorf("failed to create backup directory %s: %w", backupDir, err)
	}
	backupOfOld := filepath.Join(backupDir, "breeze-backup.backup"+filepath.Ext(installPath))
	if _, statErr := os.Stat(installPath); statErr == nil {
		if err := copyFile(installPath, backupOfOld); err != nil {
			log.Warn("failed to back up existing breeze-backup binary — proceeding anyway (rollback unavailable if the install fails)",
				"installPath", installPath, "backupPath", backupOfOld, "error", err.Error())
		}
	}

	if runtime.GOOS == "windows" {
		// StopBackupHelperIfIdle (called by the reconcile caller before this
		// runs) only stops the process the broker itself spawned and tracks.
		// This best-effort taskkill catches anything else holding the exe
		// lock (e.g. a helper started out of band) — without it the
		// subsequent replace can fail with a sharing violation. Exit 128
		// ("process not found") is the benign no-process-running case.
		killCmd := exec.Command("taskkill", "/F", "/IM", "breeze-backup.exe")
		killOut, killErr := killCmd.CombinedOutput()
		switch {
		case killErr == nil:
			log.Info("stopped running breeze-backup.exe before install", "output", string(killOut))
		case taskkillProcessNotFound(killOut, killErr):
			log.Debug("no running breeze-backup.exe to stop", "output", string(killOut))
		default:
			log.Warn("taskkill breeze-backup.exe failed unexpectedly; the install copy may hit a sharing violation",
				"output", string(killOut), "error", killErr.Error())
		}
	}

	// Atomic replace: copy to a staging sibling then rename into place, so a
	// mid-write failure can never leave a truncated/zero-length binary that
	// reconcileBackupHelper's existence check would mistake for "present" and
	// never re-heal.
	if err := atomicReplaceFile(tempPath, installPath); err != nil {
		return fmt.Errorf("failed to install backup binary at %s: %w", installPath, err)
	}
	log.Info("installed backup binary", "path", installPath, "version", version)

	// The version cache is now stale relative to disk — clear it so the next
	// heartbeat reports the version we just installed instead of the old
	// cached one.
	h.invalidateBackupVersionCache()

	// Refresh the broker's binary hash allowlist so the newly spawned helper
	// is accepted when it reconnects. Without this, the helper's hash
	// mismatches the old allowlist entry and the broker rejects it at the IPC
	// handshake (see broker.go's selfHashes check) — surfaced here as an
	// explicit failure rather than a silent rejection discovered hours later.
	if h.sessionBroker == nil {
		log.Warn("session broker unavailable — backup binary installed but allowlist not refreshed; restart the agent to guarantee it is accepted")
		return nil
	}
	if _, refreshErr := h.sessionBroker.RefreshAllowedHashes(); refreshErr != nil {
		return fmt.Errorf("backup binary installed but broker allowlist refresh failed: %w", refreshErr)
	}
	installedHash, allowed, hashErr := h.sessionBroker.HashAndVerifyAllowed(installPath)
	if hashErr != nil {
		return fmt.Errorf("backup binary installed but hash verification failed: %w", hashErr)
	}
	if !allowed {
		return fmt.Errorf("backup binary installed but its hash %s is not in the refreshed allowlist; next spawn will be rejected", installedHash)
	}
	log.Info("backup binary hash verified in refreshed allowlist", "hash", installedHash)
	return nil
}
