package heartbeat

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/systemrestore"
)

// checkpointRecorder replaces the package's createRestorePoint seam for one
// test and records every call. Tests using it must not run in parallel: the
// seam is a package-level var.
type checkpointRecorder struct {
	mu       sync.Mutex
	calls    int
	requests []systemrestore.Request
	// onCall, when set, runs inside each fake checkpoint (ordering probes).
	onCall func()
	// status is what each fake checkpoint reports (default created).
	status systemrestore.Status
}

func (r *checkpointRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

func installCheckpointRecorder(t *testing.T) *checkpointRecorder {
	t.Helper()
	rec := &checkpointRecorder{status: systemrestore.StatusCreated}
	prev := createRestorePoint
	createRestorePoint = func(_ context.Context, req systemrestore.Request) systemrestore.Outcome {
		rec.mu.Lock()
		rec.calls++
		rec.requests = append(rec.requests, req)
		onCall := rec.onCall
		status := rec.status
		rec.mu.Unlock()
		if onCall != nil {
			onCall()
		}
		return systemrestore.Outcome{Status: status, RequestID: req.RequestID, AttemptedAt: "t"}
	}
	t.Cleanup(func() { createRestorePoint = prev })
	return rec
}

func restorePointBlock(requestID string, enabled bool, label string) map[string]any {
	return map[string]any{
		"v":         float64(systemrestore.SupportedVersion),
		"requestId": requestID,
		"enabled":   enabled,
		"label":     label,
	}
}

func payloadWithBlock(requestID, label string) map[string]any {
	return map[string]any{systemrestore.PayloadKey: restorePointBlock(requestID, true, label)}
}

func TestTakeCheckpointReturnsNilWhenNotRequested(t *testing.T) {
	rec := installCheckpointRecorder(t)
	cp := newCommandCheckpoint(map[string]any{}, false, "run script")
	if got := takeCheckpoint(cp); got != nil {
		t.Fatalf("expected nil for a script command with no block, got %+v", got)
	}
	if got := cp.Report(); got != nil {
		t.Fatalf("Report = %+v, want nil", got)
	}
	if rec.count() != 0 {
		t.Fatalf("attempts = %d, want 0", rec.count())
	}
}

func TestTakeCheckpointAttemptsOnTheLegacyPatchDefault(t *testing.T) {
	// Global Constraint 7: a missing block on install_patches means legacy
	// best-effort ENABLED, so an old server keeps today's behaviour.
	rec := installCheckpointRecorder(t)
	got := takeCheckpoint(newCommandCheckpoint(map[string]any{}, true, "install 6 update(s)"))
	if got == nil {
		t.Fatal("expected an attempt on the legacy patch path")
	}
	if !got.Status.Terminal() {
		t.Fatalf("Status %q is not terminal", got.Status)
	}
	if rec.count() != 1 || rec.requests[0].Label != "install 6 update(s)" {
		t.Fatalf("attempts = %d, requests = %+v", rec.count(), rec.requests)
	}
}

func TestTakeCheckpointPrefersTheServerLabel(t *testing.T) {
	rec := installCheckpointRecorder(t)
	got := takeCheckpoint(newCommandCheckpoint(payloadWithBlock("r1", "Breeze: install 6 updates"), false, "fallback"))
	if got == nil || got.RequestID != "r1" {
		t.Fatalf("outcome = %+v", got)
	}
	if rec.requests[0].Label != "Breeze: install 6 updates" {
		t.Fatalf("label = %q, want the server label", rec.requests[0].Label)
	}
}

func TestTakeCheckpointAlwaysReportsATerminalStatus(t *testing.T) {
	// An enabled request must NEVER vanish without an outcome -- that is the
	// invisibility problem #4609 exists to fix. (Seamed: a real call on a
	// Windows CI runner could create an actual restore point.)
	rec := installCheckpointRecorder(t)
	rec.status = systemrestore.StatusUnsupported
	for _, legacy := range []bool{true, false} {
		cp := newCommandCheckpoint(payloadWithBlock("r1", "x"), legacy, "x")
		takeCheckpoint(cp)
		if got := cp.Report(); got == nil || !got.Status.Terminal() || got.RequestID != "r1" {
			t.Fatalf("legacy=%v produced %+v", legacy, got)
		}
	}
}

func TestTakeCheckpointGivesTheAttemptItsOwnDeadline(t *testing.T) {
	// The budget is a fresh context, not the action's: assert the attempt
	// sees a deadline roughly restorePointBudget out.
	var deadline time.Time
	var ok bool
	prev := createRestorePoint
	createRestorePoint = func(ctx context.Context, req systemrestore.Request) systemrestore.Outcome {
		deadline, ok = ctx.Deadline()
		return systemrestore.Outcome{Status: systemrestore.StatusCreated, RequestID: req.RequestID}
	}
	t.Cleanup(func() { createRestorePoint = prev })
	takeCheckpoint(newCommandCheckpoint(payloadWithBlock("r1", "x"), false, "x"))
	if !ok {
		t.Fatal("checkpoint ran without a deadline")
	}
	if remaining := time.Until(deadline); remaining < restorePointBudget-time.Minute || remaining > restorePointBudget {
		t.Fatalf("deadline in %v, want about %v", remaining, restorePointBudget)
	}
}
