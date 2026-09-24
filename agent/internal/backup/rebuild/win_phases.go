// win_phases.go — Windows-engine startup housekeeping. The Windows phase
// functions live in win_preflight.go, win_provision.go,
// win_restore_tree.go, win_system_state.go, win_boot.go, win_identity.go,
// win_encryption.go, win_validate.go, win_validate_os.go, win_convert.go.
package rebuild

import (
	"encoding/json"
	"os"
)

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
