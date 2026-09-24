package bmr

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// WindowsOfflineState is what RestoreSystemStateOfflineWindows leaves open
// for the rebuild engine: the loaded SYSTEM and SOFTWARE hives (identity
// edits the same mounts; validate closes them) and the control sets to edit.
type WindowsOfflineState struct {
	System, Software winhive.Handle
	ControlSets      []string
}

// offlineRequiredHives are governed by the all-or-nothing rule (Global
// Constraint "Hives").
var offlineRequiredHives = []string{"SYSTEM", "SOFTWARE", "SAM", "SECURITY"}

// selectOfflineHives: the VSS file tree is authoritative. If ANY required
// hive is missing from <root>\Windows\System32\config, all four are
// replaced from <stagingDir>\registry\<HIVE> and their .LOG1/.LOG2 deleted
// — never a mix of capture points (LSA secrets vs machine password). Every
// artifact is confirmed present before anything is overwritten.
func selectOfflineHives(root, stagingDir string) (warning string, err error) {
	cfg := filepath.Join(root, "Windows", "System32", "config")
	var treeMissing []string
	for _, h := range offlineRequiredHives {
		present, err := hiveFilePresent(filepath.Join(cfg, h))
		if err != nil {
			return "", fmt.Errorf("check hive %s in the file tree: %w", h, err)
		}
		if !present {
			treeMissing = append(treeMissing, h)
		}
	}
	if len(treeMissing) == 0 {
		return "", nil
	}
	artifactMissing := map[string]bool{}
	for _, h := range offlineRequiredHives {
		present := false
		if stagingDir != "" {
			if present, err = hiveFilePresent(filepath.Join(stagingDir, "registry", h)); err != nil {
				return "", fmt.Errorf("check system-state artifact %s: %w", h, err)
			}
		}
		artifactMissing[h] = !present
	}
	for _, h := range treeMissing {
		if artifactMissing[h] {
			return "", fmt.Errorf("hive %s missing from both the file tree and the system-state artifacts", h)
		}
	}
	for _, h := range offlineRequiredHives {
		if artifactMissing[h] {
			return "", fmt.Errorf("hive %s missing from the file tree, and the all-or-nothing artifact fallback cannot replace all four hives: system-state artifact %s is missing", treeMissing[0], h)
		}
	}
	if err := os.MkdirAll(cfg, 0o755); err != nil {
		return "", err
	}
	// Copy all four artifacts to temp names first; the tree is touched only
	// once every copy succeeded, so a failed copy can never leave a mix of
	// artifact and tree hives (which a retry would then see as "complete").
	tmp := func(h string) string { return filepath.Join(cfg, h+".brz-fallback-tmp") }
	removeTemps := func() {
		for _, h := range offlineRequiredHives {
			_ = os.Remove(tmp(h))
		}
	}
	for _, h := range offlineRequiredHives {
		if err := copyHiveFile(filepath.Join(stagingDir, "registry", h), tmp(h)); err != nil {
			removeTemps()
			return "", fmt.Errorf("replace %s from the system-state artifact: %w", h, err)
		}
	}
	// Stale transaction logs go before the swap: a tree log left next to an
	// artifact hive would be replayed against the wrong hive.
	for _, h := range offlineRequiredHives {
		for _, ext := range []string{".LOG1", ".LOG2"} {
			if err := os.Remove(filepath.Join(cfg, h+ext)); err != nil && !errors.Is(err, fs.ErrNotExist) {
				removeTemps()
				return "", fmt.Errorf("delete %s%s before the artifact fallback: %w", h, ext, err)
			}
		}
	}
	for _, h := range offlineRequiredHives {
		if err := os.Rename(tmp(h), filepath.Join(cfg, h)); err != nil {
			removeTemps()
			return "", fmt.Errorf("replace %s from the system-state artifact: %w", h, err)
		}
	}
	return "registry hives restored from the system-state artifacts, not the file tree", nil
}

// hiveFilePresent fails closed: only a confirmed-absent file
// (fs.ErrNotExist) reads as missing; any other Stat error is returned.
func hiveFilePresent(path string) (bool, error) {
	_, err := os.Stat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return false, err
}

func copyHiveFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// RestoreSystemStateOfflineWindows applies a Windows snapshot's system
// state OFFLINE to the restored tree at root, never the live registry:
//  1. hive source (tree first, all-or-nothing artifact fallback);
//  2. load SYSTEM at HKLM\BRZ_<runID>_SYSTEM; refuse a domain controller
//     unless allowDC — before any hive edit (R15's restore-phase leg);
//  3. control sets; MountedDevices rewrite; boot-start storage per set;
//  4. load SOFTWARE at HKLM\BRZ_<runID>_SOFTWARE.
//
// Both hives are returned OPEN; the caller owns closing them. On error
// nothing stays loaded. load is winhive.Load in production (through
// WinSystem.LoadHive), a Fake-backed loader in tests.
func RestoreSystemStateOfflineWindows(ctx context.Context, root, stagingDir, rootPartGUID string, onDiskGUIDs []string,
	runID string, allowDC bool, load func(hiveFile, mountName string) (winhive.Handle, error)) (*WindowsOfflineState, []string, error) {
	var warnings []string
	w, err := selectOfflineHives(root, stagingDir)
	if err != nil {
		return nil, warnings, err
	}
	if w != "" {
		warnings = append(warnings, w)
	}
	if err := ctx.Err(); err != nil {
		return nil, warnings, err
	}
	cfg := filepath.Join(root, "Windows", "System32", "config")
	system, err := load(filepath.Join(cfg, "SYSTEM"), "BRZ_"+runID+"_SYSTEM")
	if err != nil {
		return nil, warnings, fmt.Errorf("load SYSTEM hive: %w", err)
	}
	ok := false
	defer func() {
		if !ok {
			_ = system.Close()
		}
	}()
	if !allowDC {
		isDC, err := winhive.HasNTDS(system.Root())
		if err != nil {
			return nil, warnings, fmt.Errorf(`check Services\NTDS: %w`, err)
		}
		if isDC {
			return nil, warnings, errors.New(`source is a domain controller (Services\NTDS present); pass --allow-domain-controller and read the DC recovery guidance`)
		}
	}
	sets, err := winhive.ControlSets(system.Root())
	if err != nil {
		return nil, warnings, err
	}
	changed, removed, err := winhive.RewriteMountedDevices(system.Root(), rootPartGUID, onDiskGUIDs)
	if err != nil {
		return nil, warnings, err
	}
	if changed {
		noun := "letters"
		if removed == 1 {
			noun = "letter"
		}
		warnings = append(warnings, fmt.Sprintf("MountedDevices: C: remapped to the restored partition; %d stale drive %s removed", removed, noun))
	}
	for _, cs := range sets {
		if _, err := winhive.ForceBootStartStorage(system.Root(), cs); err != nil {
			return nil, warnings, fmt.Errorf("boot-start storage drivers in %s: %w", cs, err)
		}
	}
	software, err := load(filepath.Join(cfg, "SOFTWARE"), "BRZ_"+runID+"_SOFTWARE")
	if err != nil {
		return nil, warnings, fmt.Errorf("load SOFTWARE hive: %w", err)
	}
	ok = true
	return &WindowsOfflineState{System: system, Software: software, ControlSets: sets}, warnings, nil
}
