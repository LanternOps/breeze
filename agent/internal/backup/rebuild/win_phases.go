// win_phases.go — Windows-engine startup housekeeping. The Windows phase
// functions live in win_preflight.go, win_provision.go,
// win_restore_tree.go, win_system_state.go, win_boot.go, win_identity.go,
// win_encryption.go, win_validate.go, win_validate_os.go, win_convert.go.
package rebuild

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// cleanupLeftovers runs before loadState (Run's very first step after
// computing r.statePath), releasing Windows-host resources a previous
// crashed run may have left live: hive mounts under HKLM\BRZ_* (Global
// Constraint "Hives"), system-state staging dirs in TEMP (a copy of the
// backup's registry hives — sweepStaleStateStaging) and, for a vhdx:
// target, an attached-but-undetached VHDX. It never fails the run — every problem here is a warning: the run
// that follows either doesn't need the leftover (a fresh WipeDisk/WriteGPT
// clobbers it regardless) or fails loudly on its own if the leftover
// genuinely blocks it. A nil r.winSys (any Linux/darwin host, or a Windows
// test that never sets Options.WinSystem) makes this a no-op.
func cleanupLeftovers(r *run) {
	if r.winSys == nil || hostPlatform() != "windows" {
		return
	}
	if n, err := r.winSys.UnloadStaleHives("BRZ_"); err != nil {
		r.warn("stale hive cleanup: %v", err)
	} else if n > 0 {
		r.warn("unloaded %d stale registry hive mount(s) from a previous run", n)
	}
	sweepStaleStateStaging(r)
	if r.opts.Target.Kind != TargetVHDX {
		return
	}
	data, err := os.ReadFile(r.statePath)
	if err != nil {
		return // no state file for this exact target yet — nothing to detach
	}
	var s runState
	if json.Unmarshal(data, &s) != nil || s.SnapshotID != r.opts.SnapshotID || s.TargetKey != targetKey(r.opts.Target) || len(s.Volumes) == 0 {
		return
	}
	detached, err := r.winSys.DetachVHDXByPath(r.opts.Target.Path)
	switch {
	case err != nil:
		r.warn("detach stale VHDX %s: %v", r.opts.Target.Path, err)
	case detached:
		r.warn("detached a VHDX left attached by a previous, interrupted run (%s)", r.opts.Target.Path)
	}
}

// stateStagingPrefix names the system-state staging dir preflightVerify
// creates in TEMP; newStateStagingDir appends "<pid>-<random>".
const stateStagingPrefix = "breeze-rebuild-state-"

// legacyStateStagingMaxAge: a staging dir named before the owner pid was
// part of the name ("breeze-rebuild-state-<random>") cannot say whether its
// run is still going, so the sweep waits until it is this old.
const legacyStateStagingMaxAge = 24 * time.Hour

// stateStagingParent is where newStateStagingDir creates the staging dir
// and where the startup sweep looks: the process's TEMP (for SYSTEM,
// C:\Windows\SystemTemp). A seam for tests.
var stateStagingParent = os.TempDir

// processState reports whether pid is a running process and, when the OS
// can say, when that process started (zero = unknown). Anything short of a
// definite "no such process" answers running, so the sweep never removes a
// live run's dir. Set per OS (winsystem_windows.go, winsystem_other.go).
var processState func(pid int) (running bool, started time.Time)

// stagingOwnerGone reports whether the process that created a staging dir
// last written at dirModified is gone: no process holds its pid any more,
// or the one that does started after the dir was last written — the
// original owner exited and the id was reused. An unknown start time
// counts as the owner (kept).
func stagingOwnerGone(pid int, dirModified time.Time) bool {
	if processState == nil {
		return false
	}
	running, started := processState(pid)
	if !running {
		return true
	}
	return !started.IsZero() && started.After(dirModified)
}

// newStateStagingDir creates this run's system-state staging dir,
// "<TEMP>\breeze-rebuild-state-<pid>-<random>", so a later run can tell
// whether the process that made it is still alive.
func newStateStagingDir() (string, error) {
	return os.MkdirTemp(stateStagingParent(), fmt.Sprintf("%s%d-*", stateStagingPrefix, os.Getpid()))
}

// stateStagingOwner parses the owner pid out of a staging dir name made by
// newStateStagingDir. ok is false for any other name.
func stateStagingOwner(name string) (pid int, ok bool) {
	rest, found := strings.CutPrefix(name, stateStagingPrefix)
	if !found {
		return 0, false
	}
	pidPart, random, found := strings.Cut(rest, "-")
	if !found || !allDigits(pidPart) || !allDigits(random) {
		return 0, false
	}
	pid, err := strconv.Atoi(pidPart)
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// sweepStaleStateStaging removes system-state staging dirs a hard-killed
// earlier run left in TEMP: teardown removes the run's own dir on every
// normal exit, but a killed process never reaches it, and the dir holds a
// copy of the backup's registry hives. Only dirs this engine names are
// considered, and of those only
//   - "<prefix><pid>-<random>" whose pid is not this process and whose
//     owner is gone (stagingOwnerGone — covers pid reuse), and
//   - legacy "<prefix><random>" (no pid) dirs older than
//     legacyStateStagingMaxAge;
//
// never a symlink or junction. Best-effort: failures are warnings.
func sweepStaleStateStaging(r *run) {
	parent := stateStagingParent()
	entries, err := os.ReadDir(parent)
	if err != nil {
		r.warn("stale system-state staging cleanup: %v", err)
		return
	}
	self := os.Getpid()
	removed := 0
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, stateStagingPrefix) {
			continue
		}
		path := filepath.Join(parent, name)
		fi, err := os.Lstat(path)
		if err != nil || fi.Mode().Type() != fs.ModeDir {
			continue
		}
		if pid, ok := stateStagingOwner(name); ok {
			if pid == self || !stagingOwnerGone(pid, fi.ModTime()) {
				continue
			}
		} else if !allDigits(strings.TrimPrefix(name, stateStagingPrefix)) || time.Since(fi.ModTime()) < legacyStateStagingMaxAge {
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			r.warn("remove stale system-state staging %s: %v", path, err)
			continue
		}
		removed++
	}
	if removed > 0 {
		r.warn("removed %d stale system-state staging dir(s) left by an interrupted run", removed)
	}
}
