package heartbeat

import (
	"context"

	"github.com/breeze-rmm/agent/internal/systemrestore"
)

// createRestorePoint is the checkpoint attempt itself. A var solely so tests
// can count attempts and probe ordering without touching System Restore.
var createRestorePoint systemrestore.CreateFunc = systemrestore.Create

// restorePointBudget bounds one checkpoint's gate wait and WMI verification,
// derived from a fresh context rather than the action's own deadline so it
// never eats a script's timeoutSeconds. It does NOT bound the native
// SRSetRestorePointW calls (see systemrestore.Create's TIMEOUT CAVEAT).
const restorePointBudget = systemrestore.CommandBudget

// newCommandCheckpoint builds the at-most-one checkpoint for a command
// (#4609 W07). legacyDefaultEnabled: true for install_patches (a missing block
// means legacy best-effort enabled), false for script / software_install (a
// missing block means disabled).
func newCommandCheckpoint(payload map[string]any, legacyDefaultEnabled bool, fallbackLabel string) *systemrestore.Checkpoint {
	return systemrestore.NewCheckpoint(payload, legacyDefaultEnabled, fallbackLabel, createRestorePoint)
}

// takeCheckpoint takes cp (if requested and not yet taken) under its own
// restorePointBudget and returns the recorded outcome (nil when not
// requested). Call it immediately before the command's first mutation.
//
// The handler then attaches cp.Report() — never this return value — to the
// result on every exit path: Report is what turns "requested but never reached
// the boundary" into skipped_no_mutation, so an enabled request never vanishes
// without an outcome.
func takeCheckpoint(cp *systemrestore.Checkpoint) *systemrestore.Outcome {
	if !cp.Requested() {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), restorePointBudget)
	defer cancel()
	return cp.Take(ctx)
}
