// win_system_state.go — the Windows restore phase's offline system-state
// step (W06c Part C Task 14) and the hive lifecycle helpers the identity
// (Task 15), boot (Task 16) and validate (Task 17) phases share.
//
// Every hive path here goes through r.rootVolume, the root partition's
// VOLUME path, never the r.rootDir folder mount (Part B as-built rule, ruling
// B1/C1): rootDir exists only for external tool arguments (bcdboot, DISM).
package rebuild

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// winStateHives are the hives the state apply leaves loaded for identity
// and validate, in load order.
var winStateHives = []string{"SYSTEM", "SOFTWARE"}

// hiveMountName is the run-scoped HKLM mount name (Global Constraint
// "Hives": HKLM\BRZ_<runid>_<HIVE>); cleanupLeftovers unloads BRZ_* at the
// next start if this process dies with one loaded.
func hiveMountName(r *run, hive string) string {
	return "BRZ_" + targetKey(r.opts.Target) + "_" + hive
}

// applyWindowsSystemState is winRestoreTree's offline system-state step.
// It reads the rebuilt disk's actual partition GUIDs (what the MountedDevices
// DMIO values must match), applies bmr.RestoreSystemStateOfflineWindows to
// the restored root volume, and keeps SYSTEM/SOFTWARE loaded in r.hives for
// identity and validate. Hive loads go through WinSystem.LoadHive, whose
// real implementation holds SeBackup/SeRestore (ruling B2).
func applyWindowsSystemState(ctx context.Context, r *run) error {
	if r.rootVolume == "" {
		return errors.New("apply system state: no root volume recorded for this run")
	}
	// bmr loads SYSTEM/SOFTWARE under the same mount names; anything still
	// loaded from earlier in this process must go first.
	if err := r.closeWinHives(); err != nil {
		return fmt.Errorf("apply system state: %w", err)
	}
	root, onDisk, err := r.diskPartitionGUIDs()
	if err != nil {
		return err
	}
	st, warnings, err := bmr.RestoreSystemStateOfflineWindows(ctx, r.rootVolume, r.stateStaging, root, onDisk,
		targetKey(r.opts.Target), r.opts.AllowDomainController, r.opts.WinSystem.LoadHive)
	r.warnings = append(r.warnings, warnings...)
	if err != nil {
		return fmt.Errorf("apply system state: %w", err)
	}
	r.hives = map[string]winhive.Handle{"SYSTEM": st.System, "SOFTWARE": st.Software}
	r.controlSets = st.ControlSets
	r.result.StateApplied, r.state.StateApplied = true, true
	return nil
}

// diskPartitionGUIDs returns the root partition's GUID and every partition
// GUID on the rebuilt disk, as the disk itself reports them.
func (r *run) diskPartitionGUIDs() (root string, all []string, err error) {
	_, parts, err := r.opts.WinSystem.ReadGPT(r.diskNumber)
	if err != nil {
		return "", nil, fmt.Errorf("read rebuilt partition table: %w", err)
	}
	for _, p := range parts {
		all = append(all, p.PartGUID)
		if pp := r.plannedPartition(p.Number); pp != nil && pp.Role == layout.RoleRoot {
			root = p.PartGUID
		}
	}
	if root == "" {
		return "", nil, errors.New("rebuilt disk has no root partition")
	}
	return root, all, nil
}

// ensureWinHives loads whichever of SYSTEM and SOFTWARE is not already
// loaded from the restored root volume — a resumed run skipped the restore
// phase that normally loads them, and winBoot closes them before DISM and
// bcdboot (which open the offline hives themselves). Safe to call
// repeatedly: loaded hives are left alone. On a load failure the hives
// this call loaded are unloaded again.
func (r *run) ensureWinHives() error {
	if r.rootVolume == "" {
		return errors.New("load hives: no root volume recorded for this run")
	}
	if r.hives == nil {
		r.hives = map[string]winhive.Handle{}
	}
	cfg := filepath.Join(r.rootVolume, "Windows", "System32", "config")
	var loadedNow []string
	for _, hive := range winStateHives {
		if r.hives[hive] != nil {
			continue
		}
		h, err := r.opts.WinSystem.LoadHive(filepath.Join(cfg, hive), hiveMountName(r, hive))
		if err != nil {
			for _, name := range loadedNow {
				if cerr := r.hives[name].Close(); cerr != nil {
					err = errors.Join(err, fmt.Errorf("unload %s hive: %w", name, cerr))
				}
				delete(r.hives, name)
			}
			return fmt.Errorf("load %s hive: %w", hive, err)
		}
		r.hives[hive] = h
		loadedNow = append(loadedNow, hive)
	}
	if r.controlSets == nil {
		sets, err := winhive.ControlSets(r.hives["SYSTEM"].Root())
		if err != nil {
			return err
		}
		r.controlSets = sets
	}
	return nil
}

// closeWinHives flushes and unloads every loaded hive (validate does this
// FIRST — Part 0 §2; winBoot before DISM/bcdboot). Every hive is attempted;
// the first unload failure (a leaked key handle) is returned, and r.hives
// is cleared either way so a later ensureWinHives starts clean.
func (r *run) closeWinHives() error {
	names := make([]string, 0, len(r.hives))
	for name := range r.hives {
		names = append(names, name)
	}
	sort.Strings(names)
	var first error
	for _, name := range names {
		if err := r.hives[name].Close(); err != nil && first == nil {
			first = fmt.Errorf("unload %s hive: %w", name, err)
		}
	}
	r.hives = nil
	return first
}
