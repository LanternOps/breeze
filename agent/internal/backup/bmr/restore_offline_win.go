package bmr

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/winhive"
	"github.com/breeze-rmm/agent/internal/securefs"
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
	tree, openErr := os.OpenRoot(root)
	if openErr != nil {
		return "", openErr
	}
	defer func() { _ = tree.Close() }()
	var treeMissing []string
	for _, h := range offlineRequiredHives {
		_, statErr := securefs.StatFile(root, filepath.Join("Windows", "System32", "config", h))
		present, err := statErr == nil, statErr
		if errors.Is(err, fs.ErrNotExist) {
			err = nil
		}
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
			if present, err = stagedFilePresent(stagingDir, filepath.Join("registry", h)); err != nil {
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
	if err := securefs.InstallDir(root, filepath.Join("Windows", "System32", "config"), 0o755, false, nil, time.Time{}); err != nil {
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
	var staged []string
	removeTemps := func() {
		for _, name := range staged {
			_ = tree.Remove(filepath.Join("Windows", "System32", "config", name+".brz-fallback-tmp"))
		}
	}
	for _, h := range offlineRequiredHives {
		staged = append(staged, h)
		if err := copyHiveFileInRoot(root, filepath.Join("Windows", "System32", "config", h+".brz-fallback-tmp"), stagingDir, filepath.Join("registry", h)); err != nil {
			removeTemps()
			return "", fmt.Errorf("replace %s from the system-state artifact: %w", h, err)
		}
		for _, ext := range []string{".LOG1", ".LOG2"} {
			name := h + ext
			present, err := stagedFilePresent(stagingDir, filepath.Join("registry", name))
			if err != nil {
				removeTemps()
				return "", fmt.Errorf("check system-state artifact %s: %w", name, err)
			}
			if !present {
				continue
			}
			staged = append(staged, name)
			if err := copyHiveFileInRoot(root, filepath.Join("Windows", "System32", "config", name+".brz-fallback-tmp"), stagingDir, filepath.Join("registry", name)); err != nil {
				removeTemps()
				return "", fmt.Errorf("replace %s from the system-state artifact: %w", name, err)
			}
		}
	}
	// Stale transaction logs go before the swap: a tree log left next to an
	// artifact hive would be replayed against the wrong hive.
	for _, h := range offlineRequiredHives {
		for _, ext := range []string{".LOG1", ".LOG2"} {
			if err := tree.Remove(filepath.Join("Windows", "System32", "config", h+ext)); err != nil && !errors.Is(err, fs.ErrNotExist) {
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
		if err := renameHive(tree, filepath.Join("Windows", "System32", "config", name+".brz-fallback-tmp"), filepath.Join("Windows", "System32", "config", name)); err != nil {
			removeTemps()
			return "", fmt.Errorf("replace %s from the system-state artifact: %w", name, err)
		}
	}
	return "registry hives restored from the system-state artifacts, not the file tree", nil
}

// renameHive keeps the swap rooted, with a seam so tests can inject a failure at any
// rename of the swap (18b row 3) and prove it never leaves a tree-missing
// hive's slot filled.
var renameHive = func(tree *os.Root, from, to string) error { return tree.Rename(from, to) }

func copyHiveFileInRoot(root, relative, stagingDir, sourceRelative string) error {
	_, err := securefs.CopyFileFromRoot(root, relative, stagingDir, sourceRelative, 0o600, time.Time{}, nil)
	return err
}

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

// TreeHivePath returns base joined with relative once the walk from base to
// the hive has found only plain directories and a regular file, opening each
// component without following a link or reparse point. Registry hive loads
// open their file by path, and the registry also opens files next to it (the
// hive's .LOG, .LOG1 and .LOG2 logs, its .blf and .regtrans-ms transaction
// files) and the transaction files under TxR. Rather than predict those
// names, every entry in the hive's directory and in its TxR directory must be
// a plain directory or a regular file reached without a link or reparse
// point. Every load of a hive from a restored tree, the ESP or a staging
// directory checks the path this way first.
//
// The loads edit the hive in place (computer name, MountedDevices, boot-start
// drivers), so loading a private copy is not an option; the check is a
// preflight on the tree the restore just wrote.
func TreeHivePath(base, relative string) (string, error) {
	if base == "" {
		return "", errors.New("hive file has no base directory")
	}
	if err := checkRegularTreeFile(base, relative); err != nil {
		return "", fmt.Errorf("hive file %s: %w", relative, err)
	}
	dir := filepath.Dir(relative)
	if err := checkHiveDirectory(base, dir); err != nil {
		return "", fmt.Errorf("hive file %s: %w", relative, err)
	}
	if err := checkHiveDirectory(base, filepath.Join(dir, "TxR")); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("hive file %s: %w", relative, err)
	}
	return filepath.Join(base, relative), nil
}

func checkRegularTreeFile(base, relative string) error {
	file, err := securefs.OpenFile(base, relative)
	if err != nil {
		return err
	}
	return file.Close()
}

// checkHiveDirectory requires base/dir to be reached through plain
// directories and every entry in it to be either a plain directory (checked
// by a walk that refuses a link or reparse point at every component) or a
// regular file whose attributes are read without following one. Any other entry, including a
// link or reparse point of any name, is refused. A missing dir is reported as
// fs.ErrNotExist.
func checkHiveDirectory(base, dir string) error {
	if dir != "." {
		if err := checkPlainTreeDir(base, dir); err != nil {
			return err
		}
	}
	entries, err := os.ReadDir(filepath.Join(base, dir))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := filepath.Join(dir, entry.Name())
		switch entry.Type() {
		case fs.ModeDir:
			if err := checkPlainTreeDir(base, name); err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		case 0:
			// Attributes only: a hive loaded earlier in this run (and its
			// logs) is held by the registry without read sharing, so the
			// entries next to the next hive are inspected, not opened for
			// reading. StatFile still refuses a link or reparse point.
			info, err := securefs.StatFile(base, name)
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			if !info.Mode().IsRegular() {
				return fmt.Errorf("%s is not a regular file", name)
			}
		default:
			return fmt.Errorf("%s is a link or special file", name)
		}
	}
	return nil
}

// checkPlainTreeDir confirms that every directory from base down to base/dir
// is a plain directory, by opening an absent name beneath it: securefs
// refuses a link or reparse point at every directory component before it can
// report the name as absent. A missing dir is reported by the listing that
// follows.
func checkPlainTreeDir(base, dir string) error {
	file, err := securefs.OpenFile(base, filepath.Join(dir, ".brz-absent-probe"))
	if err == nil {
		return file.Close()
	}
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
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
	cfg := filepath.Join("Windows", "System32", "config")
	systemPath, err := TreeHivePath(root, filepath.Join(cfg, "SYSTEM"))
	if err != nil {
		return nil, warnings, fmt.Errorf("load SYSTEM hive: %w", err)
	}
	system, err := load(systemPath, "BRZ_"+runID+"_SYSTEM")
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
	softwarePath, err := TreeHivePath(root, filepath.Join(cfg, "SOFTWARE"))
	if err != nil {
		return nil, warnings, fmt.Errorf("load SOFTWARE hive: %w", err)
	}
	software, err := load(softwarePath, "BRZ_"+runID+"_SOFTWARE")
	if err != nil {
		return nil, warnings, fmt.Errorf("load SOFTWARE hive: %w", err)
	}
	ok = true
	return &WindowsOfflineState{System: system, Software: software, ControlSets: sets}, warnings, nil
}
