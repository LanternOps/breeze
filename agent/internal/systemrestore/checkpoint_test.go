package systemrestore

import (
	"context"
	"sync"
	"testing"
)

func stampedPayload(requestID string, enabled bool, label string) map[string]any {
	return map[string]any{
		PayloadKey: map[string]any{
			"v":         float64(SupportedVersion),
			"requestId": requestID,
			"enabled":   enabled,
			"label":     label,
		},
	}
}

// countingCreate records every call and returns a created outcome stamped with
// the request it was handed.
func countingCreate(calls *int, got *Request) CreateFunc {
	return func(_ context.Context, req Request) Outcome {
		*calls++
		if got != nil {
			*got = req
		}
		return Outcome{Status: StatusCreated, RequestID: req.RequestID, AttemptedAt: "t"}
	}
}

func TestCheckpointNotRequestedNeverCallsCreateAndReportsNothing(t *testing.T) {
	calls := 0
	cp := NewCheckpoint(map[string]any{}, false, "run script", countingCreate(&calls, nil))
	if cp.Requested() {
		t.Fatal("a script command with no block must not request a checkpoint")
	}
	if got := cp.Take(context.Background()); got != nil {
		t.Fatalf("Take = %+v, want nil", got)
	}
	if got := cp.Report(); got != nil {
		t.Fatalf("Report = %+v, want nil", got)
	}
	if calls != 0 {
		t.Fatalf("create calls = %d, want 0", calls)
	}
}

func TestCheckpointExplicitlyDisabledBlockNeverCallsCreate(t *testing.T) {
	calls := 0
	cp := NewCheckpoint(stampedPayload("req-1", false, "x"), true, "x", countingCreate(&calls, nil))
	cp.Take(context.Background())
	if calls != 0 || cp.Report() != nil {
		t.Fatalf("calls = %d, report = %+v; an explicit enabled:false must win over the legacy default", calls, cp.Report())
	}
}

func TestCheckpointTakesAtMostOncePerCommand(t *testing.T) {
	calls := 0
	cp := NewCheckpoint(stampedPayload("req-1", true, "Breeze: install"), false, "fallback", countingCreate(&calls, nil))
	first := cp.Take(context.Background())
	second := cp.Take(context.Background())
	if calls != 1 {
		t.Fatalf("create calls = %d, want exactly 1 across repeated Take", calls)
	}
	if first == nil || second == nil || first.RequestID != "req-1" || second.RequestID != "req-1" {
		t.Fatalf("Take outcomes = %+v / %+v", first, second)
	}
	if got := cp.Report(); got == nil || got.Status != StatusCreated || got.RequestID != "req-1" {
		t.Fatalf("Report = %+v, want the created outcome", got)
	}
}

func TestCheckpointConcurrentTakeStillCallsCreateOnce(t *testing.T) {
	calls := 0
	var mu sync.Mutex
	create := func(_ context.Context, req Request) Outcome {
		mu.Lock()
		calls++
		mu.Unlock()
		return Outcome{Status: StatusCreated, RequestID: req.RequestID}
	}
	cp := NewCheckpoint(stampedPayload("req-1", true, "x"), false, "x", create)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); cp.Take(context.Background()) }()
	}
	wg.Wait()
	if calls != 1 {
		t.Fatalf("create calls = %d, want 1", calls)
	}
}

func TestCheckpointPrefersServerLabelAndFallsBackWhenEmpty(t *testing.T) {
	calls := 0
	var got Request
	NewCheckpoint(stampedPayload("req-1", true, "Breeze: run script"), false, "fallback", countingCreate(&calls, &got)).Take(context.Background())
	if got.Label != "Breeze: run script" {
		t.Fatalf("label = %q, want the server label", got.Label)
	}
	NewCheckpoint(stampedPayload("req-2", true, ""), false, "fallback", countingCreate(&calls, &got)).Take(context.Background())
	if got.Label != "fallback" {
		t.Fatalf("label = %q, want the fallback for an empty server label", got.Label)
	}
}

func TestCheckpointEnabledButNeverTakenReportsSkippedNoMutation(t *testing.T) {
	// The boundary is "immediately before the first mutation". A command that
	// stops before it (validation, preflight, already installed) must still
	// answer the request -- an enabled request never vanishes without an
	// outcome -- and must say WHY honestly, not as skipped_disabled.
	calls := 0
	cp := NewCheckpoint(stampedPayload("req-9", true, "x"), false, "x", countingCreate(&calls, nil))
	got := cp.Report()
	if calls != 0 {
		t.Fatalf("create calls = %d, want 0", calls)
	}
	if got == nil || got.Status != StatusSkippedNoMutation || got.RequestID != "req-9" {
		t.Fatalf("Report = %+v, want skipped_no_mutation for req-9", got)
	}
	if got.AttemptedAt == "" || got.Message == "" {
		t.Fatalf("synthesized outcome must carry attemptedAt and a message: %+v", got)
	}
	if !got.Status.Terminal() {
		t.Fatal("skipped_no_mutation must be terminal")
	}
}

func TestCheckpointSkipRecordsTheReasonAndBlocksALaterTake(t *testing.T) {
	calls := 0
	cp := NewCheckpoint(stampedPayload("req-3", true, "x"), true, "x", countingCreate(&calls, nil))
	cp.Skip(StatusSkippedDefinitions, "every patch in this command is a definitions update")
	cp.Take(context.Background())
	if calls != 0 {
		t.Fatalf("create calls = %d, want 0 after Skip", calls)
	}
	got := cp.Report()
	if got == nil || got.Status != StatusSkippedDefinitions || got.RequestID != "req-3" {
		t.Fatalf("Report = %+v, want skipped_definition_only for req-3", got)
	}
}

func TestCheckpointSkipDoesNotOverwriteATakenOutcome(t *testing.T) {
	cp := NewCheckpoint(stampedPayload("req-4", true, "x"), false, "x", countingCreate(new(int), nil))
	cp.Take(context.Background())
	cp.Skip(StatusSkippedDefinitions, "late")
	if got := cp.Report(); got == nil || got.Status != StatusCreated {
		t.Fatalf("Report = %+v, want the created outcome to stand", got)
	}
}

func TestCheckpointSkipIsANoOpWhenNotRequested(t *testing.T) {
	cp := NewCheckpoint(map[string]any{}, false, "x", countingCreate(new(int), nil))
	cp.Skip(StatusSkippedDefinitions, "x")
	if got := cp.Report(); got != nil {
		t.Fatalf("Report = %+v, want nil when nothing was requested", got)
	}
}

func TestCheckpointLegacyDefaultAttemptsButIsNotReported(t *testing.T) {
	// Global Constraint 7: a MISSING block on install_patches means legacy
	// best-effort enabled, so the attempt still happens. But with no block
	// there is no requestId: the server's ingest and stored-result parser both
	// require a UUID requestId and would drop the outcome (logging a warning
	// for every such command). So the attempt is made and logged, not sent.
	calls := 0
	cp := NewCheckpoint(map[string]any{}, true, "install 2 update(s)", countingCreate(&calls, nil))
	if !cp.Requested() {
		t.Fatal("legacy install_patches default must request an attempt")
	}
	if got := cp.Take(context.Background()); got == nil {
		t.Fatal("Take must return the attempt's outcome")
	}
	if calls != 1 {
		t.Fatalf("create calls = %d, want 1", calls)
	}
	if got := cp.Report(); got != nil {
		t.Fatalf("Report = %+v, want nil for an unstamped legacy attempt", got)
	}
}

func TestCheckpointUnknownBlockVersionFallsBackToTheLegacyDefault(t *testing.T) {
	payload := map[string]any{PayloadKey: map[string]any{"v": float64(2), "requestId": "r", "enabled": true}}
	calls := 0
	cp := NewCheckpoint(payload, false, "x", countingCreate(&calls, nil))
	cp.Take(context.Background())
	if calls != 0 || cp.Report() != nil {
		t.Fatalf("a v2 block on a script must read as disabled; calls=%d", calls)
	}
}

func TestCheckpointAbandonedReportsNothing(t *testing.T) {
	// A redelivered command refused as a duplicate of one still running must
	// not answer the request: the original execution owns the outcome, and a
	// skipped_no_mutation from the duplicate would win the ledger CAS.
	calls := 0
	cp := NewCheckpoint(stampedPayload("req-5", true, "x"), false, "x", countingCreate(&calls, nil))
	cp.Abandon()
	if got := cp.Report(); got != nil {
		t.Fatalf("Report = %+v, want nil after Abandon", got)
	}
	if got := cp.Take(context.Background()); got != nil || calls != 0 {
		t.Fatalf("Take after Abandon = %+v (calls %d), want inert", got, calls)
	}
}

func TestCheckpointNilReceiverIsSafe(t *testing.T) {
	var cp *Checkpoint
	if cp.Requested() || cp.Take(context.Background()) != nil || cp.Report() != nil {
		t.Fatal("nil checkpoint must be inert")
	}
	cp.Skip(StatusSkippedDefinitions, "x")
	cp.Abandon()
}

func TestCheckpointReportReturnsACopy(t *testing.T) {
	cp := NewCheckpoint(stampedPayload("req-1", true, "x"), false, "x", countingCreate(new(int), nil))
	cp.Take(context.Background())
	cp.Report().Status = StatusFailed
	if cp.Report().Status != StatusCreated {
		t.Fatal("Report must not hand out the checkpoint's own outcome to mutate")
	}
}
