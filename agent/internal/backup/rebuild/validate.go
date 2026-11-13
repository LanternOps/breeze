package rebuild

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup"
)

const validateSampleSize = 64

// identityMutatedPaths lists snapshot source paths the identity phase's
// IdentityNew branch (applyNewIdentity) intentionally rewrites or removes.
// validate's restored-file checksum sample must skip them for an IdentityNew
// run — a byte difference there is the whole point of that phase, not a
// sign of restore corruption.
// Keyed by backup.RestoreKey (volume and leading separators stripped), the
// same key validate's checksum-sample target path is joined under r.staging
// with — these entries are all plain Linux absolute paths with no
// OriginalPath (not VSS-rewritten), so RestoreKey here is just SourcePath
// with its leading "/" stripped. NOT the same key as r.failedFiles below,
// which is looked up by backup.RestoreSourceKey (unstripped) instead,
// because that is the format RestoreResult.FailedFiles is actually written
// in (see restore_tree.go).
var identityMutatedPaths = map[string]bool{
	"etc/machine-id":          true,
	"etc/hostname":            true,
	"etc/breeze/agent.yaml":   true,
	"etc/breeze/secrets.yaml": true,
}

// validate proves the rebuild before declaring success: a sample of
// restored files still hashes to what the snapshot recorded, the boot
// phase's expected artifacts exist, fstab references only UUIDs actually on
// the rebuilt disk, then flushes and releases the target.
func validate(ctx context.Context, r *run) error {
	// 0. System state (#5412): an expected apply that never happened is a
	// named validation failure, whatever the files look like.
	if r.opts.ExpectSystemState && !r.result.StateApplied {
		return errors.New("system state not applied: snapshot advertises system state but the restore phase did not apply it")
	}
	// 1. Sample checksums of restored files.
	var withSum []backup.SnapshotFile
	if r.manifest != nil {
		for _, f := range r.manifest.Files {
			if !f.HasContent() || f.Checksum == "" {
				continue
			}
			if r.opts.Identity == IdentityNew && identityMutatedPaths[backup.RestoreKey(f)] {
				continue
			}
			if r.failedFiles[backup.RestoreSourceKey(f)] {
				// r.failedFiles is populated unchanged from
				// RestoreResult.FailedFiles (restore_tree.go), whose entries
				// are displayPath = restoreSourcePath(file) — i.e. exactly
				// RestoreSourceKey, NOT RestoreKey (volume not stripped).
				continue // known partial-restore failure, already a warning
			}
			withSum = append(withSum, f)
		}
	}
	step := 1
	if len(withSum) > validateSampleSize {
		step = len(withSum) / validateSampleSize
	}
	checked, mismatched := 0, []string{}
	for i := 0; i < len(withSum); i += step {
		f := withSum[i]
		sum, err := hashTreeFile(r.staging, backup.RestoreKey(f))
		if err != nil || sum != f.Checksum {
			mismatched = append(mismatched, f.SourcePath)
		}
		checked++
	}
	if len(mismatched) > 0 {
		return fmt.Errorf("%d of %d sampled files differ from the snapshot: %s", len(mismatched), checked, strings.Join(mismatched, ", "))
	}
	// 2. Boot artefacts.
	if !r.opts.SkipBoot {
		_, efiFile := grubTarget(r.sys.Arch())
		esp, err := espEFIDir(r.result.Plan)
		if err != nil {
			return err
		}
		if !treeFileExists(r.staging, filepath.Join(esp, "BOOT", efiFile)) {
			return fmt.Errorf("EFI/BOOT/%s missing after boot phase", efiFile)
		}
		if !treeFileExists(r.staging, filepath.Join("boot", "grub", "grub.cfg")) && !treeFileExists(r.staging, filepath.Join("boot", "grub2", "grub.cfg")) && !treeFileExists(r.staging, filepath.Join(esp, bootloaderID(r.staging), "grub.cfg")) {
			return errors.New("no grub.cfg found in the restored tree")
		}
	}
	// 3. fstab UUIDs resolve to planned partitions.
	if fstab, err := readTreeFile(r.staging, filepath.Join("etc", "fstab")); err == nil {
		known := map[string]bool{}
		for _, p := range r.result.Plan.Partitions {
			known[strings.ToLower(p.FSUUID)] = true
		}
		for _, line := range strings.Split(string(fstab), "\n") {
			f := strings.Fields(line)
			if len(f) == 0 || strings.HasPrefix(f[0], "#") {
				continue
			}
			if u, ok := strings.CutPrefix(f[0], "UUID="); ok && !known[strings.ToLower(u)] {
				r.warn("fstab references UUID %s which is not on the rebuilt disk (%s)", u, line)
			}
		}
	}
	// 4. Flush and release.
	if err := r.sys.Sync(ctx); err != nil {
		return err
	}
	r.teardown()
	if r.releaseErr != nil {
		return fmt.Errorf("rebuild target is still in use after validation (unmount or detach failed): %w", r.releaseErr)
	}
	return nil
}

// hashTreeFile returns the hex SHA-256 of the regular file base/name, read
// through base's root: a link that stays inside base is followed, while a
// path that leads outside base, or to anything but a regular file, is an
// error (validate counts it as a mismatch).
func hashTreeFile(base, name string) (string, error) {
	file, err := openTreeFile(base, name)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// readTreeFile reads the regular file base/name through base's root.
func readTreeFile(base, name string) ([]byte, error) {
	file, err := openTreeFile(base, name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	return io.ReadAll(file)
}

// treeFileExists reports whether base/name resolves, inside base's root, to
// an existing file or directory.
func treeFileExists(base, name string) bool {
	tree, err := os.OpenRoot(base)
	if err != nil {
		return false
	}
	defer func() { _ = tree.Close() }()
	_, err = tree.Stat(name)
	return err == nil
}

// openTreeFile opens base/name through base's root once it has resolved to a
// regular file (checked before opening, so a device or FIFO is never opened).
func openTreeFile(base, name string) (*os.File, error) {
	tree, err := os.OpenRoot(base)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tree.Close() }()
	info, err := tree.Stat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", name)
	}
	file, err := tree.Open(name)
	if err != nil {
		return nil, err
	}
	if info, err := file.Stat(); err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		if err == nil {
			err = fmt.Errorf("%s is not a regular file", name)
		}
		return nil, err
	}
	return file, nil
}
