package heartbeat

import (
	"errors"
	"fmt"
	"testing"

	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/systemrestore"
)

const patchTestRequestID = "0b8a3c1e-1d2f-4e5a-9b6c-7d8e9f0a1b2c"

// patchCheckpointHarness is a heartbeat with one mock apt provider, a stubbed
// preflight and a recording checkpoint seam.
type patchCheckpointHarness struct {
	h        *Heartbeat
	provider *heartbeatMockProvider
	rec      *checkpointRecorder
	// installsBeforeCheckpoint is how many patches had already been installed
	// when the (first) checkpoint ran. Must be 0.
	installsBeforeCheckpoint int
}

func newPatchCheckpointHarness(t *testing.T) *patchCheckpointHarness {
	t.Helper()
	ph := &patchCheckpointHarness{provider: &heartbeatMockProvider{id: "apt"}, installsBeforeCheckpoint: -1}
	ph.h = &Heartbeat{patchMgr: patching.NewPatchManager(ph.provider)}
	ph.rec = installCheckpointRecorder(t)
	ph.rec.onCall = func() {
		if ph.installsBeforeCheckpoint < 0 {
			ph.installsBeforeCheckpoint = len(ph.provider.installIDs)
		}
	}
	stubPatchPreflight(t, nil)
	return ph
}

func stubPatchPreflight(t *testing.T, err error) {
	t.Helper()
	prev := patchInstallPreflight
	patchInstallPreflight = func(*Heartbeat) error { return err }
	t.Cleanup(func() { patchInstallPreflight = prev })
}

// patchPayload builds an install_patches payload with one patch per category.
// withBlock stamps an enabled restore-point block, as W05 does.
func patchPayload(withBlock bool, categories ...string) map[string]any {
	patches := make([]any, 0, len(categories))
	for i, c := range categories {
		patches = append(patches, map[string]any{
			"id":       fmt.Sprintf("apt:pkg%d", i),
			"source":   "linux",
			"title":    fmt.Sprintf("pkg %d", i),
			"category": c,
		})
	}
	p := map[string]any{"patches": patches}
	if withBlock {
		p[systemrestore.PayloadKey] = restorePointBlock(patchTestRequestID, true, "Breeze: install updates")
	}
	return p
}

func nCategories(n int, c string) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = c
	}
	return out
}

func (ph *patchCheckpointHarness) install(payload map[string]any) tools.CommandResult {
	return handleInstallPatches(ph.h, Command{ID: "cmd-patch", Type: tools.CmdInstallPatches, Payload: payload})
}

func TestInstallPatchesTakesExactlyOneCheckpointForNPatches(t *testing.T) {
	// The shipped code called CreateRestorePoint once per non-definitions
	// update: a 12-patch job "created" 12 checkpoints and, under the Windows
	// throttle, actually got at most one. One per COMMAND is the honest shape.
	ph := newPatchCheckpointHarness(t)
	res := ph.install(patchPayload(true, nCategories(12, "security")...))
	if got := ph.rec.count(); got != 1 {
		t.Fatalf("checkpoint attempts = %d, want 1", got)
	}
	if len(ph.provider.installIDs) != 12 {
		t.Fatalf("installs = %d, want 12", len(ph.provider.installIDs))
	}
	if ph.installsBeforeCheckpoint != 0 {
		t.Fatalf("%d patch(es) installed before the checkpoint; it must precede the first install", ph.installsBeforeCheckpoint)
	}
	if res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusCreated || res.RestorePoint.RequestID != patchTestRequestID {
		t.Fatalf("RestorePoint = %+v, want created for the stamped requestId", res.RestorePoint)
	}
	if ph.rec.requests[0].Label != "Breeze: install updates" {
		t.Fatalf("label = %q, want the server label", ph.rec.requests[0].Label)
	}
}

func TestInstallPatchesSkipsADefinitionsOnlyCommand(t *testing.T) {
	ph := newPatchCheckpointHarness(t)
	res := ph.install(patchPayload(true, "definitions", "Definitions", "definitions"))
	if got := ph.rec.count(); got != 0 {
		t.Fatalf("checkpoint attempts = %d, want 0 for a definitions-only command", got)
	}
	// An enabled request must never vanish without an outcome.
	if res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusSkippedDefinitions || res.RestorePoint.RequestID != patchTestRequestID {
		t.Fatalf("RestorePoint = %+v, want skipped_definition_only", res.RestorePoint)
	}
	if len(ph.provider.installIDs) != 3 {
		t.Fatalf("installs = %d, want 3 -- skipping the checkpoint must not skip the install", len(ph.provider.installIDs))
	}
}

func TestInstallPatchesCheckpointsAMixedCommand(t *testing.T) {
	ph := newPatchCheckpointHarness(t)
	ph.install(patchPayload(true, "definitions", "security"))
	if got := ph.rec.count(); got != 1 {
		t.Fatalf("checkpoint attempts = %d, want 1 for a mixed command", got)
	}
}

func TestInstallPatchesTreatsAnUnknownCategoryAsRisky(t *testing.T) {
	// Fail toward protection: an unlabelled patch might be anything.
	for _, cats := range [][]string{{""}, {"definitions", ""}, {"definitions", "driver"}} {
		ph := newPatchCheckpointHarness(t)
		ph.install(patchPayload(true, cats...))
		if got := ph.rec.count(); got != 1 {
			t.Fatalf("categories %q: checkpoint attempts = %d, want 1", cats, got)
		}
	}
}

func TestInstallPatchesTreatsPatchIDsWithoutRecordsAsRisky(t *testing.T) {
	// A bare patchIds entry carries no category at all.
	ph := newPatchCheckpointHarness(t)
	payload := patchPayload(true, "definitions")
	payload["patchIds"] = []any{"apt:extra"}
	ph.install(payload)
	if got := ph.rec.count(); got != 1 {
		t.Fatalf("checkpoint attempts = %d, want 1 when any patch has no category", got)
	}
}

func TestInstallPatchesCheckpointsAfterPreflightAndBeforeInstall(t *testing.T) {
	// A command rejected by preflight must not consume the day's one point.
	ph := newPatchCheckpointHarness(t)
	stubPatchPreflight(t, errors.New("not in maintenance window"))
	res := ph.install(patchPayload(true, nCategories(2, "security")...))
	if got := ph.rec.count(); got != 0 {
		t.Fatalf("checkpoint attempts = %d, want 0 when preflight rejects the command", got)
	}
	if res.Status != "failed" || res.Error != "not in maintenance window" {
		t.Fatalf("result = %+v, want the preflight failure", res)
	}
	if res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusSkippedNoMutation {
		t.Fatalf("RestorePoint = %+v, want skipped_no_mutation", res.RestorePoint)
	}
}

func TestInstallPatchesDoesNotCheckpointWhenNothingCanBeInstalled(t *testing.T) {
	t.Run("no providers", func(t *testing.T) {
		ph := newPatchCheckpointHarness(t)
		ph.h.patchMgr = nil
		res := ph.install(patchPayload(true, "security"))
		if ph.rec.count() != 0 || res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusSkippedNoMutation {
			t.Fatalf("attempts = %d, RestorePoint = %+v", ph.rec.count(), res.RestorePoint)
		}
	})
	t.Run("no patches", func(t *testing.T) {
		ph := newPatchCheckpointHarness(t)
		res := ph.install(patchPayload(true))
		if ph.rec.count() != 0 || res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusSkippedNoMutation {
			t.Fatalf("attempts = %d, RestorePoint = %+v", ph.rec.count(), res.RestorePoint)
		}
	})
}

func TestInstallPatchesWithNoBlockStillAttempts(t *testing.T) {
	ph := newPatchCheckpointHarness(t)
	res := ph.install(patchPayload(false, nCategories(2, "security")...))
	if got := ph.rec.count(); got != 1 {
		t.Fatalf("attempts = %d, want 1 -- a missing block on install_patches means legacy best-effort enabled", got)
	}
	// No block means no requestId: the server could not correlate the outcome
	// (its ingest and stored-result parser require a UUID requestId), so it is
	// logged rather than sent.
	if res.RestorePoint != nil {
		t.Fatalf("RestorePoint = %+v, want nil for an unstamped legacy attempt", res.RestorePoint)
	}
	if ph.rec.requests[0].Label != "install 2 update(s)" {
		t.Fatalf("label = %q, want the agent fallback label", ph.rec.requests[0].Label)
	}
}

func TestInstallPatchesWithNoBlockDefinitionsOnlyStillSkips(t *testing.T) {
	// Today's server sends `category` only with a stamped block, but a
	// category that IS present is honoured either way.
	ph := newPatchCheckpointHarness(t)
	res := ph.install(patchPayload(false, "definitions"))
	if ph.rec.count() != 0 || res.RestorePoint != nil {
		t.Fatalf("attempts = %d, RestorePoint = %+v", ph.rec.count(), res.RestorePoint)
	}
}

func TestInstallPatchesHonoursAnExplicitDisable(t *testing.T) {
	ph := newPatchCheckpointHarness(t)
	payload := patchPayload(false, "security")
	payload[systemrestore.PayloadKey] = restorePointBlock(patchTestRequestID, false, "x")
	res := ph.install(payload)
	if ph.rec.count() != 0 || res.RestorePoint != nil {
		t.Fatalf("attempts = %d, RestorePoint = %+v; enabled:false must win over the legacy default", ph.rec.count(), res.RestorePoint)
	}
}

func TestRollbackPatchesNeverCheckpoints(t *testing.T) {
	ph := newPatchCheckpointHarness(t)
	res := handleRollbackPatches(ph.h, Command{ID: "cmd-rb", Type: tools.CmdRollbackPatches, Payload: patchPayload(true, "security")})
	if ph.rec.count() != 0 || res.RestorePoint != nil {
		t.Fatalf("attempts = %d, RestorePoint = %+v", ph.rec.count(), res.RestorePoint)
	}
}

func TestPatchRefsFromPayloadReadsCategory(t *testing.T) {
	refs := (&Heartbeat{}).patchRefsFromPayload(patchPayload(false, "definitions", ""))
	if len(refs) != 2 || refs[0].Category != "definitions" || refs[1].Category != "" {
		t.Fatalf("refs = %+v", refs)
	}
}
