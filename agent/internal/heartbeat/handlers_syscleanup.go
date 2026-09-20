package heartbeat

import (
	"context"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/syscleanup"
)

// handleSystemCleanupList returns the device's native-cleanup catalogue
// (Disk Cleanup v2 §7.3). Read-only: it probes binary presence, sandbox write
// access and — for the actions that have a non-mutating simulation mode — an
// estimate. It never removes anything.
func handleSystemCleanupList(_ *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	// The package's own 3-minute estimate budget is the binding limit; this
	// outer context is the backstop for a probe that ignores it.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	return tools.NewSuccessResult(syscleanup.List(ctx), time.Since(start).Milliseconds())
}

// handleSystemCleanupRun executes the selected catalogue actions.
//
// Both payload fields are REQUIRED and validated here rather than defaulted:
// a missing runId would produce a result the server cannot attribute to a
// cleanup run row, and an empty actionIds must never be read as "run
// everything" on a customer's machine.
func handleSystemCleanupRun(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	runID := tools.GetPayloadString(cmd.Payload, "runId", "")
	if runID == "" {
		return tools.NewErrorResult(fmt.Errorf("system_cleanup_run requires a runId"), time.Since(start).Milliseconds())
	}
	actionIDs := tools.GetPayloadStringSlice(cmd.Payload, "actionIds")
	if len(actionIDs) == 0 {
		return tools.NewErrorResult(fmt.Errorf("system_cleanup_run requires a non-empty actionIds"), time.Since(start).Milliseconds())
	}

	params := syscleanup.Params{}
	if raw, ok := cmd.Payload["params"].(map[string]any); ok {
		params.JournalVacuumBytes = int64(tools.GetPayloadInt(raw, "journalVacuumBytes", 0))
	}

	// No outer deadline here: syscleanup.Run derives the AGGREGATE budget from
	// the selection itself (RunBudget, spec §13 #14) and the server stores the
	// same figure on the run row. A second, flat ceiling at this level could
	// only disagree with it — and would cut a legitimate 160-minute
	// cleanmgr+DISM selection short at whatever number was hard-coded here.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	return tools.NewSuccessResult(
		syscleanup.Run(ctx, runID, actionIDs, params),
		time.Since(start).Milliseconds(),
	)
}
