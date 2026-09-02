package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// swapCompanionBinary atomically installs pair.Temp at pair.Target using a
// same-directory staging file + rename, mirroring
// heartbeat.replaceWatchdogBinaryUnix. It is currently only used for the
// breeze-backup companion binary on the Linux and macOS-fallback raw-binary
// upgrade paths (updateTo); Windows swaps its companions via the restart-helper
// PowerShell script instead (see restart_windows.go).
//
// pair.Temp is produced by DownloadBinary in the OS temp directory, which may
// be a different filesystem than pair.Target's directory — a direct
// os.Rename(pair.Temp, pair.Target) would then fail with EXDEV, so the bytes
// are copied into a sibling of pair.Target first (making the final rename
// same-filesystem and therefore atomic) rather than renamed directly. POSIX
// makes replacing a running process's file safe: the old inode stays open for
// whatever currently has it mapped/executing until that process exits, so
// this can run while the backup helper it's replacing is executing (though
// callers are expected to avoid that — see sessionbroker.StopBackupHelperIfIdle).
//
// On success pair.Temp is removed (its bytes now live at pair.Target). On
// failure pair.Temp is left in place for the caller to clean up and
// pair.Target is untouched.
func swapCompanionBinary(pair *BinaryPair) error {
	src, err := os.Open(pair.Temp)
	if err != nil {
		return fmt.Errorf("open downloaded binary: %w", err)
	}
	// Read-only handle: a close error carries nothing the caller can act on,
	// and the bytes have already been copied out by then. Explicitly discarded
	// so errcheck can tell "ignored on purpose" from "forgotten".
	defer func() { _ = src.Close() }()

	destDir := filepath.Dir(pair.Target)
	staging, err := os.CreateTemp(destDir, ".breeze-backup-*.new")
	if err != nil {
		return fmt.Errorf("create staging file in %s: %w", destDir, err)
	}
	stagingPath := staging.Name()
	// Best-effort cleanup if we bail before the rename.
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(stagingPath)
		}
	}()

	// On these two bail-outs the copy has already failed, so the staging file is
	// garbage that the deferred cleanup above is about to remove — a close error
	// would only mask the real error being returned. Discarded explicitly.
	if _, err := io.Copy(staging, src); err != nil {
		_ = staging.Close()
		return fmt.Errorf("copy binary bytes: %w", err)
	}
	if err := staging.Sync(); err != nil {
		_ = staging.Close()
		return fmt.Errorf("sync staging file: %w", err)
	}
	if err := staging.Close(); err != nil {
		return fmt.Errorf("close staging file: %w", err)
	}
	if err := os.Chmod(stagingPath, 0o755); err != nil {
		return fmt.Errorf("chmod staging file: %w", err)
	}
	if err := os.Rename(stagingPath, pair.Target); err != nil {
		return fmt.Errorf("rename into place: %w", err)
	}
	cleanup = false
	removeCleanup(pair.Temp)
	return nil
}

type rollbackSwapJournal struct {
	SchemaVersion int                        `json:"schemaVersion"`
	DirectiveID   string                     `json:"directiveId"`
	State         string                     `json:"state"`
	Next          int                        `json:"next"`
	Artifacts     []rollbackSwapJournalEntry `json:"artifacts"`
}

type rollbackSwapJournalEntry struct {
	Component  RollbackComponent `json:"component"`
	LivePath   string            `json:"livePath"`
	BackupPath string            `json:"backupPath"`
	NewPath    string            `json:"newPath"`
}

func rollbackPathToken(directiveID string) string {
	sum := sha256.Sum256([]byte(directiveID))
	return hex.EncodeToString(sum[:8])
}

func copyRollbackFile(source, target string, mode os.FileMode) error {
	src, err := os.Open(source)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	dst, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode.Perm())
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		_ = dst.Close()
		if !ok {
			_ = os.Remove(target)
		}
	}()
	if _, err := io.Copy(dst, src); err != nil {
		return err
	}
	if err := dst.Sync(); err != nil {
		return err
	}
	if err := dst.Close(); err != nil {
		return err
	}
	ok = true
	return nil
}

func writeRollbackJournal(path string, journal rollbackSwapJournal) error {
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("rollback journal path is a symlink")
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	payload, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".breeze-rollback-journal-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	ok := false
	defer func() {
		_ = tmp.Close()
		if !ok {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(payload); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := replaceRollbackFile(tmpPath, path); err != nil {
		return err
	}
	if err := syncRollbackDir(path); err != nil {
		return err
	}
	ok = true
	return nil
}

// SwapRollbackArtifacts crosses the complete-set boundary using a durable
// journal. An interrupted non-committed journal always recovers the old set.
func SwapRollbackArtifacts(set RollbackSwapSet) error {
	return swapRollbackArtifactsMode(set, nil, true)
}

func swapRollbackArtifacts(set RollbackSwapSet, afterRename func(int) error) error {
	return swapRollbackArtifactsMode(set, afterRename, true)
}

// SwapRollbackArtifactsRetainingJournal installs the target set on Unix and
// prepares its durable detached swap on Windows, retaining the old set and
// journal until post-restart health calls CommitRollbackSwap.
func SwapRollbackArtifactsRetainingJournal(set RollbackSwapSet) error {
	if deferRollbackSwapToRestart() {
		_, err := prepareRollbackArtifacts(set)
		return err
	}
	return swapRollbackArtifactsMode(set, nil, false)
}

func swapRollbackArtifactsMode(set RollbackSwapSet, afterRename func(int) error, finalize bool) error {
	journal, err := prepareRollbackArtifacts(set)
	if err != nil {
		return err
	}
	return applyPreparedRollbackArtifacts(set.JournalPath, journal, afterRename, finalize)
}

func prepareRollbackArtifacts(set RollbackSwapSet) (rollbackSwapJournal, error) {
	if strings.TrimSpace(set.DirectiveID) == "" || set.JournalPath == "" || len(set.Artifacts) == 0 {
		return rollbackSwapJournal{}, fmt.Errorf("rollback swap set is incomplete")
	}
	journal := rollbackSwapJournal{SchemaVersion: 1, DirectiveID: set.DirectiveID, State: "prepared"}
	token := rollbackPathToken(set.DirectiveID)
	seen := make(map[string]struct{}, len(set.Artifacts))
	cleanupPrepared := true
	defer func() {
		if cleanupPrepared {
			for _, entry := range journal.Artifacts {
				_ = os.Remove(entry.BackupPath)
				_ = os.Remove(entry.NewPath)
			}
		}
	}()
	for index, artifact := range set.Artifacts {
		if artifact.Component == "" || artifact.StagedPath == "" || artifact.LivePath == "" {
			return rollbackSwapJournal{}, fmt.Errorf("rollback swap artifact %d is incomplete", index)
		}
		livePath, err := filepath.Abs(artifact.LivePath)
		if err != nil {
			return rollbackSwapJournal{}, err
		}
		stagedPath, err := filepath.Abs(artifact.StagedPath)
		if err != nil {
			return rollbackSwapJournal{}, err
		}
		if _, duplicate := seen[livePath]; duplicate {
			return rollbackSwapJournal{}, fmt.Errorf("duplicate rollback live path")
		}
		seen[livePath] = struct{}{}
		liveInfo, err := os.Lstat(livePath)
		if err != nil {
			return rollbackSwapJournal{}, fmt.Errorf("inspect live rollback component %s: %w", artifact.Component, err)
		}
		if !liveInfo.Mode().IsRegular() {
			return rollbackSwapJournal{}, fmt.Errorf("live rollback component %s is not a regular file", artifact.Component)
		}
		stagedInfo, err := os.Lstat(stagedPath)
		if err != nil {
			return rollbackSwapJournal{}, fmt.Errorf("inspect staged rollback component %s: %w", artifact.Component, err)
		}
		if !stagedInfo.Mode().IsRegular() {
			return rollbackSwapJournal{}, fmt.Errorf("staged rollback component %s is not a regular file", artifact.Component)
		}
		base := filepath.Join(filepath.Dir(livePath), ".breeze-rollback-"+token+"-"+fmt.Sprint(index))
		entry := rollbackSwapJournalEntry{Component: artifact.Component, LivePath: livePath, BackupPath: base + ".old", NewPath: base + ".new"}
		if err := copyRollbackFile(livePath, entry.BackupPath, liveInfo.Mode()); err != nil {
			return rollbackSwapJournal{}, fmt.Errorf("backup %s: %w", artifact.Component, err)
		}
		if err := copyRollbackFile(stagedPath, entry.NewPath, stagedInfo.Mode()); err != nil {
			return rollbackSwapJournal{}, fmt.Errorf("stage %s beside live file: %w", artifact.Component, err)
		}
		journal.Artifacts = append(journal.Artifacts, entry)
	}
	if err := writeRollbackJournal(set.JournalPath, journal); err != nil {
		return rollbackSwapJournal{}, fmt.Errorf("write prepared rollback journal: %w", err)
	}
	cleanupPrepared = false
	return journal, nil
}

func applyPreparedRollbackArtifacts(journalPath string, journal rollbackSwapJournal, afterRename func(int) error, finalize bool) error {
	for index, entry := range journal.Artifacts {
		journal.State = "swapping"
		journal.Next = index
		if err := writeRollbackJournal(journalPath, journal); err != nil {
			return fmt.Errorf("write rollback boundary journal: %w", err)
		}
		if err := replaceRollbackFile(entry.NewPath, entry.LivePath); err != nil {
			return fmt.Errorf("swap rollback component %s: %w", entry.Component, err)
		}
		if err := syncRollbackDir(entry.LivePath); err != nil {
			return fmt.Errorf("sync rollback component %s: %w", entry.Component, err)
		}
		if afterRename != nil {
			if err := afterRename(index); err != nil {
				return err
			}
		}
	}
	journal.State = "swapped"
	journal.Next = len(journal.Artifacts)
	if err := writeRollbackJournal(journalPath, journal); err != nil {
		return fmt.Errorf("write swapped rollback journal: %w", err)
	}
	if !finalize {
		return nil
	}
	journal.State = "committed"
	journal.Next = len(journal.Artifacts)
	if err := writeRollbackJournal(journalPath, journal); err != nil {
		return fmt.Errorf("commit rollback journal: %w", err)
	}
	for _, entry := range journal.Artifacts {
		_ = os.Remove(entry.BackupPath)
		_ = os.Remove(entry.NewPath)
	}
	if err := os.Remove(journalPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncRollbackDir(journalPath)
}

// CommitRollbackSwap makes a health-verified target set permanent and removes
// the retained old-set recovery material.
func CommitRollbackSwap(journalPath string) error {
	payload, err := os.ReadFile(journalPath)
	if err != nil {
		return err
	}
	var journal rollbackSwapJournal
	if err := json.Unmarshal(payload, &journal); err != nil {
		return err
	}
	if journal.SchemaVersion != 1 || journal.State != "swapped" {
		return fmt.Errorf("rollback journal is not ready to commit")
	}
	journal.State = "committed"
	if err := writeRollbackJournal(journalPath, journal); err != nil {
		return err
	}
	for _, entry := range journal.Artifacts {
		_ = os.Remove(entry.BackupPath)
		_ = os.Remove(entry.NewPath)
	}
	if err := os.Remove(journalPath); err != nil {
		return err
	}
	return syncRollbackDir(journalPath)
}

// RecoverRollbackSwap deterministically resolves an interrupted journal to a
// complete set: committed journals retain the target set; all earlier states
// restore every old component before removing recovery material.
func RecoverRollbackSwap(journalPath string) error {
	return recoverRollbackSwapPlatform(journalPath)
}

func readRollbackJournal(journalPath string) (rollbackSwapJournal, error) {
	info, err := os.Lstat(journalPath)
	if err != nil {
		return rollbackSwapJournal{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return rollbackSwapJournal{}, fmt.Errorf("rollback journal is not a regular file")
	}
	payload, err := os.ReadFile(journalPath)
	if err != nil {
		return rollbackSwapJournal{}, err
	}
	var journal rollbackSwapJournal
	if err := json.Unmarshal(payload, &journal); err != nil {
		return rollbackSwapJournal{}, fmt.Errorf("decode rollback journal: %w", err)
	}
	if journal.SchemaVersion != 1 || strings.TrimSpace(journal.DirectiveID) == "" || len(journal.Artifacts) == 0 {
		return rollbackSwapJournal{}, fmt.Errorf("invalid rollback journal")
	}
	return journal, nil
}

func recoverRollbackSwapInline(journalPath string) error {
	journal, err := readRollbackJournal(journalPath)
	if err != nil {
		return err
	}
	if journal.State != "committed" {
		for index, entry := range journal.Artifacts {
			backupInfo, err := os.Lstat(entry.BackupPath)
			if err != nil || !backupInfo.Mode().IsRegular() {
				return fmt.Errorf("rollback backup %d unavailable", index)
			}
			recoveryPath := entry.LivePath + ".breeze-recover-" + rollbackPathToken(journal.DirectiveID)
			_ = os.Remove(recoveryPath)
			if err := copyRollbackFile(entry.BackupPath, recoveryPath, backupInfo.Mode()); err != nil {
				return err
			}
			if err := replaceRollbackFile(recoveryPath, entry.LivePath); err != nil {
				return err
			}
			if err := syncRollbackDir(entry.LivePath); err != nil {
				return err
			}
		}
	}
	for _, entry := range journal.Artifacts {
		_ = os.Remove(entry.BackupPath)
		_ = os.Remove(entry.NewPath)
	}
	if err := os.Remove(journalPath); err != nil {
		return err
	}
	return syncRollbackDir(journalPath)
}
