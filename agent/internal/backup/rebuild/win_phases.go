// win_phases.go holds the Windows platform table's entry points.
//
// The real validate/convert phases live in win_validate.go and
// win_convert.go.
//
// Staged for W06c (Part C deletes each one from here and adds the real
// one; applyWindowsSystemState (Task 14, win_system_state.go), winIdentity
// and winEncryption (Task 15, win_identity.go / win_encryption.go) and
// winBoot (Task 16, win_boot.go) are already real): validateOSState
// (Task 17, win_validate_os.go).
package rebuild

import (
	"context"
	"encoding/json"
	"errors"
	"os"
)

// errWindowsOSStateStaged is what the W06c-staged functions return outside
// SkipBoot in this PR.
var errWindowsOSStateStaged = errors.New("windows offline system-state, boot, identity and encryption phases arrive in W06c")

// A Windows run in this PR therefore reaches "completed" only with
// SkipBoot set — exactly what the Task 13 tests and CI VHDX gate use.

// validateOSState is winValidate's OS-state hook (close hives, ESP + BCD
// checks). Nothing is loaded or written by the staged phases above, so the
// staged hook has nothing to check; Part C replaces it.
func validateOSState(_ context.Context, _ *run) error { return nil }

// cleanupLeftovers runs before loadState (Run's very first step after
// computing r.statePath), releasing Windows-host resources a previous
// crashed run may have left live: hive mounts under HKLM\BRZ_* (Global
// Constraint "Hives") and, for a vhdx: target, an attached-but-undetached
// VHDX. It never fails the run — every problem here is a warning: the run
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
