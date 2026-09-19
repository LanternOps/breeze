package rebuild

import (
	"context"
	"errors"
	"fmt"
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
var identityMutatedPaths = map[string]bool{
	"/etc/machine-id":          true,
	"/etc/hostname":            true,
	"/etc/breeze/agent.yaml":   true,
	"/etc/breeze/secrets.yaml": true,
}

// validate proves the rebuild before declaring success: a sample of
// restored files still hashes to what the snapshot recorded, the boot
// phase's expected artifacts exist, fstab references only UUIDs actually on
// the rebuilt disk, then flushes and releases the target.
func validate(ctx context.Context, r *run) error {
	// 1. Sample checksums of restored files.
	var withSum []backup.SnapshotFile
	if r.manifest != nil {
		for _, f := range r.manifest.Files {
			if !f.HasContent() || f.Checksum == "" {
				continue
			}
			if r.opts.Identity == IdentityNew && identityMutatedPaths[f.SourcePath] {
				continue
			}
			if r.failedFiles[f.SourcePath] {
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
		target := filepath.Join(r.staging, filepath.FromSlash(strings.TrimPrefix(f.SourcePath, "/")))
		sum, err := backup.SHA256File(target)
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
		if !fileExists(filepath.Join(r.staging, "boot", "efi", "EFI", "BOOT", efiFile)) {
			return fmt.Errorf("EFI/BOOT/%s missing after boot phase", efiFile)
		}
		if !fileExists(filepath.Join(r.staging, "boot", "grub", "grub.cfg")) && !fileExists(filepath.Join(r.staging, "boot", "grub2", "grub.cfg")) && !fileExists(filepath.Join(r.staging, "boot", "efi", "EFI", bootloaderID(r.staging), "grub.cfg")) {
			return errors.New("no grub.cfg found in the restored tree")
		}
	}
	// 3. fstab UUIDs resolve to planned partitions.
	if fstab, err := os.ReadFile(filepath.Join(r.staging, "etc", "fstab")); err == nil {
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
	return nil
}
