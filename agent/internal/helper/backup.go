package helper

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// Pre-update backup of the helper binary (#7113).
//
// The rollback after a failed update renames the backup over the helper
// binary, so the backup has to be a complete copy of the build that ran before
// the update. A copy written straight to the final name and interrupted part
// way (disk full, AV, a crash) left a truncated file there that a later
// rollback restored as if it were good. The copy is now written to a scratch
// name, synced, and renamed into place, and its size and SHA-256 are recorded
// so the rollback can refuse a file that does not match.

// errBackupMismatch reports a backup whose bytes differ from the copy that was
// recorded: it is damaged or was replaced, and must not be restored.
var errBackupMismatch = errors.New("helper backup does not match the recorded copy")

// backupCopyFunc is a seam for the backup tests.
var backupCopyFunc = io.Copy

// helperBackup is a verified copy of the helper binary taken before an update.
// The zero value means no backup was taken, and verify refuses it.
type helperBackup struct {
	path   string
	size   int64
	sha256 [sha256.Size]byte
	// version is the build the backup holds, read before the update; "" when
	// unknown.
	version string
}

// backupPartialPath is where the copy is written before it is renamed into
// place. A fixed name, so an interrupted copy leaves at most one stray file and
// the next attempt overwrites it.
func backupPartialPath(backupPath string) string {
	return backupPath + ".partial"
}

// writeHelperBackup copies src to backupPath through a scratch file and returns
// the record the rollback verifies against. On failure the scratch file is
// removed and backupPath is left exactly as it was: a previous rollback that
// could not restore keeps the only good copy there.
func writeHelperBackup(src, backupPath string) (helperBackup, error) {
	in, err := os.Open(src)
	if err != nil {
		return helperBackup{}, err
	}
	defer func() { _ = in.Close() }() // read-only handle
	info, err := in.Stat()
	if err != nil {
		return helperBackup{}, err
	}

	partial := backupPartialPath(backupPath)
	out, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0755)
	if err != nil {
		return helperBackup{}, err
	}
	hash := sha256.New()
	n, err := backupCopyFunc(io.MultiWriter(out, hash), in)
	if err == nil && n != info.Size() {
		err = fmt.Errorf("copied %d of %d bytes", n, info.Size())
	}
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(partial, backupPath)
	}
	if err != nil {
		if rmErr := os.Remove(partial); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
			log.Warn("failed to remove partial helper backup", "path", partial, "error", rmErr.Error())
		}
		return helperBackup{}, err
	}

	b := helperBackup{path: backupPath, size: n}
	copy(b.sha256[:], hash.Sum(nil))
	return b, nil
}

// verify checks the backup on disk against the recorded copy. It returns an
// error wrapping os.ErrNotExist when the file is gone, errBackupMismatch when
// its size or bytes differ, and any other error when it cannot be read.
func (b helperBackup) verify() error {
	if b.path == "" {
		return fmt.Errorf("no helper backup was recorded for this update: %w", os.ErrNotExist)
	}
	f, err := os.Open(b.path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }() // read-only handle
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() != b.size {
		return fmt.Errorf("%w: size %d, recorded %d", errBackupMismatch, info.Size(), b.size)
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return err
	}
	if !bytes.Equal(hash.Sum(nil), b.sha256[:]) {
		return fmt.Errorf("%w: SHA-256 differs", errBackupMismatch)
	}
	return nil
}

// Kept backup (#7357).
//
// When a rollback cannot restore the backup and the exe has changed, the
// backup is the only good copy of the helper and is kept. The next update
// attempt must not overwrite it with a copy of the exe it starts from, which
// is the broken build: a second failure would then "restore" that. So the
// rollback records the kept backup, in memory and in a small file next to it
// (it has to outlive an agent restart), and the next attempt reuses it as its
// rollback target instead of taking a new backup. The record is dropped when
// a restore consumes the backup, when the backup is gone or damaged, or when
// an update installs and starts a new build.

// keptBackupRecordPath is where the record of a kept backup is written.
func keptBackupRecordPath(backupPath string) string {
	return backupPath + ".kept"
}

// keptBackupRecord is the on-disk form of a kept helperBackup. The path is not
// stored: the record always sits next to the backup it describes.
type keptBackupRecord struct {
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
	Version string `json:"version,omitempty"`
}

// saveKeptBackupRecord writes the record of b through a scratch file, so a
// crash never leaves a half-written record behind.
func saveKeptBackupRecord(b helperBackup) error {
	data, err := json.Marshal(keptBackupRecord{
		Size:    b.size,
		SHA256:  hex.EncodeToString(b.sha256[:]),
		Version: b.version,
	})
	if err != nil {
		return err
	}
	path := keptBackupRecordPath(b.path)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp) // best effort; the next save overwrites it
		return err
	}
	return nil
}

// loadKeptBackupRecord reads the record of the backup at backupPath. It
// returns an error wrapping os.ErrNotExist when there is none.
func loadKeptBackupRecord(backupPath string) (helperBackup, error) {
	data, err := os.ReadFile(keptBackupRecordPath(backupPath))
	if err != nil {
		return helperBackup{}, err
	}
	var rec keptBackupRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		return helperBackup{}, fmt.Errorf("parse kept helper backup record: %w", err)
	}
	sum, err := hex.DecodeString(rec.SHA256)
	if err != nil || len(sum) != sha256.Size || rec.Size < 0 {
		return helperBackup{}, errors.New("parse kept helper backup record: invalid size or SHA-256")
	}
	b := helperBackup{path: backupPath, size: rec.Size, version: rec.Version}
	copy(b.sha256[:], sum)
	return b, nil
}

// keepBackupLocked records b as the only good copy of the helper. A record
// that cannot be written is logged: the in-memory copy still protects the
// backup until the agent restarts. Must be called with m.mu held.
func (m *Manager) keepBackupLocked(b helperBackup) {
	m.keptBackup = b
	if err := saveKeptBackupRecord(b); err != nil {
		log.Warn("failed to record kept helper backup, it is protected only until the agent restarts",
			"backup", b.path, "error", err.Error())
	}
}

// releaseKeptBackupLocked drops the kept-backup record. It does not touch the
// backup itself. Must be called with m.mu held.
func (m *Manager) releaseKeptBackupLocked() {
	m.keptBackup = helperBackup{}
	path := keptBackupRecordPath(m.backupPath())
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Warn("failed to remove kept helper backup record", "path", path, "error", err.Error())
	}
}

// keptBackupLocked returns the kept backup, reading its record from disk when
// the agent restarted since it was kept. An unreadable record is discarded:
// without it the backup cannot be verified, and the update falls back to
// taking a new one. Must be called with m.mu held.
func (m *Manager) keptBackupLocked() (helperBackup, bool) {
	if m.keptBackup.path != "" {
		return m.keptBackup, true
	}
	b, err := loadKeptBackupRecord(m.backupPath())
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Warn("discarding unreadable kept helper backup record", "backup", m.backupPath(), "error", err.Error())
			m.releaseKeptBackupLocked()
		}
		return helperBackup{}, false
	}
	m.keptBackup = b
	return b, true
}

// backupPath is where the pre-update copy of the helper binary is kept.
func (m *Manager) backupPath() string {
	return m.binaryPath + ".backup"
}

// backupForUpdateLocked returns the backup the rollback of this update attempt
// restores. A kept backup that still verifies is reused as is, never
// overwritten (#7357); one that is gone or damaged is dropped and a new backup
// of the current binary is taken. One that cannot be read is reused too: it
// may still be the good copy, and the rollback verifies it again before use.
// A failed backup does not stop the update, as before; the rollback then finds
// no recorded copy and leaves the binary alone (#7113). Must be called with
// m.mu held.
func (m *Manager) backupForUpdateLocked() helperBackup {
	if kept, ok := m.keptBackupLocked(); ok {
		err := kept.verify()
		switch {
		case err == nil:
			log.Warn("helper backup from a failed rollback is the only good copy, reusing it for this update",
				"backup", kept.path, "backupVersion", kept.version, "path", m.binaryPath)
			return kept
		case errors.Is(err, os.ErrNotExist), errors.Is(err, errBackupMismatch):
			log.Warn("kept helper backup is gone or damaged, taking a new backup",
				"backup", kept.path, "error", err.Error())
			m.releaseKeptBackupLocked()
		default:
			log.Warn("cannot verify kept helper backup, reusing it for this update",
				"backup", kept.path, "error", err.Error())
			return kept
		}
	}

	backup, err := writeHelperBackup(m.binaryPath, m.backupPath())
	if err != nil {
		log.Warn("failed to backup helper binary, a failed update cannot be rolled back", "error", err.Error())
		return helperBackup{}
	}
	// The version lets a rollback that cannot replace the exe tell "nothing
	// to restore" (msiexec rolled its own change back) from "the good copy is
	// only in the backup" (#6869). "" when unknown.
	version, err := m.readBinaryVersion()
	if err != nil {
		if !errors.Is(err, errBinaryVersionUnsupported) {
			log.Warn("failed to read pre-update helper version", "path", m.binaryPath, "error", err.Error())
		}
		version = ""
	}
	backup.version = version
	return backup
}
