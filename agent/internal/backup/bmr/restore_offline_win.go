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
// replaced from <stagingDir>\registry\<HIVE>: the tree's .LOG1/.LOG2 are
// deleted and replaced by the artifact's own logs when it carries them (a
// VSS-copied hive does, a reg-save hive does not) — never a mix of capture
// points (LSA secrets vs machine password). Every artifact is confirmed
// present before anything is overwritten.
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
	// Copy all four artifacts — and whichever .LOG1/.LOG2 each artifact
	// carries — to temp names first; the tree is touched only once every copy
	// succeeded, so a failed copy can never leave a mix of artifact and tree
	// hives (which a retry would then see as "complete"). An artifact taken
	// from a VSS shadow copy is the raw hive file, which on Windows 8.1+ can
	// lag its own transaction logs; RegLoadKey replays <hive>.LOG1/.LOG2 found
	// next to the file, so those logs travel with it (#5397). A reg-save
	// artifact has none, and the tree's logs are deleted either way.
	tmp := func(name string) string { return filepath.Join(cfg, name+".brz-fallback-tmp") }
	var staged []string
	removeTemps := func() {
		for _, name := range staged {
			_ = os.Remove(tmp(name))
		}
	}
	for _, h := range offlineRequiredHives {
		staged = append(staged, h)
		if err := copyHiveFile(filepath.Join(stagingDir, "registry", h), tmp(h)); err != nil {
			removeTemps()
			return "", fmt.Errorf("replace %s from the system-state artifact: %w", h, err)
		}
		for _, ext := range []string{".LOG1", ".LOG2"} {
			name := h + ext
			src := filepath.Join(stagingDir, "registry", name)
			present, err := hiveFilePresent(src)
			if err != nil {
				removeTemps()
				return "", fmt.Errorf("check system-state artifact %s: %w", name, err)
			}
			if !present {
				continue
			}
			staged = append(staged, name)
			if err := copyHiveFile(src, tmp(name)); err != nil {
				removeTemps()
				return "", fmt.Errorf("replace %s from the system-state artifact: %w", name, err)
			}
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
	// Every rename goes through the single renameHive seam, in renameOrder:
	// artifact logs, then tree-present primaries, then tree-missing primaries
	// strictly LAST. A rename failure partway through must never leave a
	// tree-missing hive's slot filled — that would read as "complete" to a
	// retry (selectOfflineHives treats the tree as authoritative) and stop it
	// re-entering the fallback, stranding the temp files this same failure
	// leaves behind.
	for _, name := range renameOrder(staged, treeMissing) {
		if err := renameHive(tmp(name), filepath.Join(cfg, name)); err != nil {
			removeTemps()
			return "", fmt.Errorf("replace %s from the system-state artifact: %w", name, err)
		}
	}
	return "registry hives restored from the system-state artifacts, not the file tree", nil
}

// renameHive is os.Rename, a seam so tests can inject a failure at any
// rename of the swap (18b row 3) and prove it never leaves a tree-missing
// hive's slot filled.
var renameHive = os.Rename

// renameOrder orders the fallback swap so an interrupted swap is always
// retried: every artifact log first, then the primaries of hives the tree
// still had, and the primaries the tree was MISSING strictly last. Until the
// last rename lands, at least one tree-missing hive is still absent, so a
// retry of selectOfflineHives sees an incomplete tree and redoes the whole
// fallback — it can never accept an artifact primary (from a VSS copy, lagging
// its logs) that was installed without them.
func renameOrder(staged, treeMissing []string) []string {
	missing := make(map[string]bool, len(treeMissing))
	for _, h := range treeMissing {
		missing[h] = true
	}
	isPrimary := make(map[string]bool, len(offlineRequiredHives))
	for _, h := range offlineRequiredHives {
		isPrimary[h] = true
	}
	var logs, present, absent []string
	for _, name := range staged {
		switch {
		case !isPrimary[name]:
			logs = append(logs, name)
		case missing[name]:
			absent = append(absent, name)
		default:
			present = append(present, name)
		}
	}
	return append(append(logs, present...), absent...)
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
		dc, err := winhive.IsDomainController(system.Root())
		if err != nil {
			return nil, warnings, fmt.Errorf("domain-controller check: %w", err)
		}
		warnings = append(warnings, dc.Warnings...)
		if dc.IsDC {
			return nil, warnings, fmt.Errorf("source is a domain controller (%s); pass --allow-domain-controller and read the DC recovery guidance", dc.Evidence)
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
