package systemrestore

import (
	"context"
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/vss"
)

// acquireGate is the process-wide VSS snapshot-creation gate shared with the
// Breeze backup subsystem, indirected through a var so tests can substitute a
// held or free gate. Never reassign it outside tests.
//
// A private mutex here would not see the backup's own snapshot creation, and
// two requesters inside the VSS creation interval is exactly what produces
// VSS_E_SNAPSHOT_SET_IN_PROGRESS.
var acquireGate = vss.AcquireSnapshotCreation

// gateWaitBudget caps how long a checkpoint waits for a concurrent backup's
// snapshot creation, even when the caller's context has no deadline. The gate
// is held only for the creation interval (normally seconds), not the whole
// backup. Running out yields StatusBusy, which is a report, not a failure. A
// var only so tests can shrink it.
var gateWaitBudget = 90 * time.Second

// withSnapshotGate runs fn while holding the gate, or returns StatusBusy if the
// gate could not be acquired within min(ctx, gateWaitBudget). A caller that
// cancelled is reported as such, not as a busy gate.
func withSnapshotGate(ctx context.Context, fn func() Outcome) Outcome {
	gateCtx, cancel := context.WithTimeout(ctx, gateWaitBudget)
	defer cancel()
	release, err := acquireGate(gateCtx)
	if err != nil {
		// A caller deadline is a legitimate, shorter wait budget (busy); an
		// explicit cancellation means nobody wants the checkpoint any more.
		if errors.Is(ctx.Err(), context.Canceled) {
			return Outcome{Status: StatusFailed, Message: "checkpoint abandoned by the caller: " + ctx.Err().Error()}
		}
		return Outcome{Status: StatusBusy, Message: "another VSS snapshot creation is in progress: " + err.Error()}
	}
	defer release()
	return fn()
}
