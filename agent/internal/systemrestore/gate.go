package systemrestore

import (
	"context"
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
// snapshot creation. Callers may pass a shorter context. Running out yields
// StatusBusy, which is a report, not a failure.
const gateWaitBudget = 90 * time.Second

// withSnapshotGate runs fn while holding the gate, or returns StatusBusy if the
// gate could not be acquired within min(ctx, gateWaitBudget).
func withSnapshotGate(ctx context.Context, fn func() Outcome) Outcome {
	gateCtx, cancel := context.WithTimeout(ctx, gateWaitBudget)
	defer cancel()
	release, err := acquireGate(gateCtx)
	if err != nil {
		return Outcome{Status: StatusBusy, Message: "another VSS snapshot creation is in progress"}
	}
	defer release()
	return fn()
}
