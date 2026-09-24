// win_validate.go — the Windows engine's validate phase (Part 0 §2 row 7).
// The OS-state checks (close hives FIRST, ESP files, BCD default entry) live
// in validateOSState (win_validate_os.go).
package rebuild

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/layout"
)

// winValidateSkipPrefixes are restore keys (forward-slash, lower-case form)
// the checksum sample skips: the hives are edited offline by the state
// apply and identity phases, and Breeze's own config/marker/intent files by
// identity/encryption — a byte difference there is intended.
var winValidateSkipPrefixes = []string{"windows/system32/config/", "programdata/breeze/"}

// winValidate proves the rebuild before declaring success, in this order
// (Ruling B6):
//
//  1. the OS-state checks (validateOSState) and a checksum sample of
//     restored files, read through the root VOLUME path r.rootVolume — the
//     restore wrote there, and the <staging>\root folder mount is not an
//     alias of it on the fake (Ruling B1);
//  2. the disk: work dir under the root volume is removed;
//  3. every volume is flushed;
//  4. winTeardown closes hives, releases letters and removes the folder
//     mounts (the VHDX stays attached);
//  5. the no-drive-letter bit is cleared on root/data partitions — the LAST
//     layout write, once nothing on the host is using the volumes; ESP, MSR
//     and Recovery keep it;
//  6. the GPT is read back: every planned partition must still be there
//     with its planned GUID (Global Constraint "Partition GUIDs are
//     identity");
//  7. the VHDX is detached (teardown's r.detach).
func winValidate(ctx context.Context, r *run) error {
	if r.opts.ExpectSystemState && !r.result.StateApplied {
		return errors.New("system state not applied: snapshot advertises system state but the restore phase did not apply it")
	}
	if err := validateOSState(ctx, r); err != nil {
		return err
	}
	if r.rootVolume == "" {
		return errors.New("validate: no root volume recorded for this run")
	}

	// 1. Checksum sample through the root volume.
	var withSum []backup.SnapshotFile
	if r.manifest != nil {
		for _, f := range r.manifest.Files {
			// r.failedFiles holds RestoreResult.FailedFiles verbatim, i.e.
			// RestoreSourceKey (OriginalPath for a VSS entry) — never
			// f.SourcePath, the shadow-copy device path (Ruling B3).
			if !f.HasContent() || f.Checksum == "" || r.failedFiles[backup.RestoreSourceKey(f)] {
				continue
			}
			key := strings.ToLower(strings.ReplaceAll(backup.RestoreKey(f), `\`, "/"))
			skip := false
			for _, prefix := range winValidateSkipPrefixes {
				skip = skip || strings.HasPrefix(key, prefix)
			}
			if !skip {
				withSum = append(withSum, f)
			}
		}
	}
	step := 1
	if len(withSum) > validateSampleSize {
		step = len(withSum) / validateSampleSize
	}
	checked, mismatched := 0, []string{}
	for i := 0; i < len(withSum); i += step {
		f := withSum[i]
		sum, err := backup.SHA256File(filepath.Join(r.rootVolume, backup.RestoreKey(f)))
		if err != nil || sum != f.Checksum {
			mismatched = append(mismatched, backup.RestoreSourceKey(f))
		}
		checked++
	}
	if len(mismatched) > 0 {
		return fmt.Errorf("%d of %d sampled files differ from the snapshot: %s", len(mismatched), checked, strings.Join(mismatched, ", "))
	}

	// 2. The disk: target's default work dir (winRestoreTree) lives on the
	// rebuilt root volume; a vhdx: target's work dir is on the host and Run
	// removes it once the rebuild completes.
	if r.opts.Target.Kind == TargetDisk && r.opts.WorkRoot == "" {
		if err := os.RemoveAll(filepath.Join(r.rootVolume, "$breeze-rebuild-work")); err != nil {
			r.warn("restore work dir not removed: %v", err)
		}
	}

	// 3. Flush every volume while it is still mounted.
	for number, guidPath := range r.volumes {
		if err := r.opts.WinSystem.FlushVolume(guidPath); err != nil {
			return fmt.Errorf("flush volume for partition %d: %w", number, err)
		}
	}

	// 4. Release hives, letters and folder mounts — not the VHDX.
	r.winTeardown()
	if r.releaseErr != nil {
		return fmt.Errorf("rebuild target is still in use after validation (unmount failed): %w", r.releaseErr)
	}

	// 5. Clear the no-drive-letter bit on root/data (the last layout write).
	_, parts, err := r.opts.WinSystem.ReadGPT(r.diskNumber)
	if err != nil {
		return fmt.Errorf("read GPT for validation: %w", err)
	}
	if err := r.checkPartitionGUIDs(parts); err != nil {
		return err // never write attributes to a disk whose identity moved
	}
	for _, p := range parts {
		planned := r.plannedPartition(p.Number)
		if planned == nil || (planned.Role != layout.RoleRoot && planned.Role != layout.RoleData) {
			continue // ESP, MSR and Recovery keep the bit (Global Constraint "No automount surprises")
		}
		if cleared := p.Attributes &^ gptAttrNoDriveLetter; cleared != p.Attributes {
			if err := r.opts.WinSystem.SetPartitionAttributes(r.diskNumber, p.Number, cleared); err != nil {
				return fmt.Errorf("clear no-letter attribute on partition %d: %w", p.Number, err)
			}
		}
	}

	// 6. Read back: the partition GUIDs must survive every write above.
	if _, parts, err = r.opts.WinSystem.ReadGPT(r.diskNumber); err != nil {
		return fmt.Errorf("read GPT for validation: %w", err)
	}
	if err := r.checkPartitionGUIDs(parts); err != nil {
		return err
	}

	// 7. Detach.
	r.teardown()
	if r.releaseErr != nil {
		return fmt.Errorf("rebuild target is still in use after validation (unmount or detach failed): %w", r.releaseErr)
	}
	return nil
}

// checkPartitionGUIDs fails when a planned partition is missing from the
// disk, or its GUID on disk differs from the plan's recorded one.
func (r *run) checkPartitionGUIDs(parts []WinGPTPartition) error {
	onDisk := map[int]WinGPTPartition{}
	for _, p := range parts {
		onDisk[p.Number] = p
	}
	if r.result.Plan == nil {
		return errors.New("validate: no partition plan recorded for this run")
	}
	for _, planned := range r.result.Plan.Partitions {
		p, ok := onDisk[planned.Number]
		if !ok {
			return fmt.Errorf("planned partition %d is missing from the disk (%d of %d partitions present)", planned.Number, len(parts), len(r.result.Plan.Partitions))
		}
		if planned.PartUUID != "" && !strings.EqualFold(planned.PartUUID, p.PartGUID) {
			return fmt.Errorf("partition %d GUID changed during the run (%s → %s)", p.Number, planned.PartUUID, p.PartGUID)
		}
	}
	return nil
}
