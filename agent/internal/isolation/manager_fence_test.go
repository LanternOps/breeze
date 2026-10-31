package isolation

import (
	"context"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// While the worker probes (lock released), "recovery" takes the lock and
// rolls the attempt back. The worker must not commit when it returns.
func TestFenceRolledBackAttemptCannotCommit(t *testing.T) {
	h := newHarness(t)
	gate := make(chan struct{})
	entered := make(chan struct{}, 1)
	h.verify.set(func(v *fakeVerify) { v.gate, v.entered = gate, entered })
	done := make(chan CommandOutcome, 1)
	go func() { done <- h.isolate(idA, 1) }()
	<-entered

	// Recovery's rollback-if-uncommitted, under the machine-wide lock.
	unlock, err := journal.Lock(h.dir)
	if err != nil {
		t.Fatalf("the worker held the lock across the probes: %v", err)
	}
	j := h.journal()
	if j.Phase != journal.PhaseProvisional || j.AttemptID == "" {
		t.Fatalf("journal while probing: %s %q", j.Phase, j.AttemptID)
	}
	if err := h.iso.Release(context.Background()); err != nil {
		t.Fatal(err)
	}
	j.Phase = journal.PhaseRolledBack
	j.AttemptID = ""
	j.Episode.State, j.Episode.FailureCode = StateFailed, FailControlPlaneUnreachable
	j.Append(h.clock.Now(), "rolled_back", idA, 1, "recovery")
	if err := journal.Save(journal.Path(h.dir), j); err != nil {
		t.Fatal(err)
	}
	unlock()
	applies := h.iso.applies
	seqAfterRecovery := j.LastSeq()

	close(gate)
	out := <-done
	if !out.Failed() {
		t.Fatalf("a fenced worker reported success: %+v", out)
	}
	got := h.journal()
	if got.Phase != journal.PhaseRolledBack {
		t.Fatalf("fenced worker changed the journal to %s", got.Phase)
	}
	if got.LastSeq() != seqAfterRecovery {
		t.Fatalf("fenced worker wrote to the journal after recovery owned it: events %v", eventTypes(got))
	}
	if installed, _, _ := h.iso.state(); installed || h.iso.applies != applies {
		t.Fatal("fenced worker re-installed rules")
	}
	if h.log.count("journal:committed") != 0 {
		t.Fatal("fenced worker journalled committed")
	}
}

// A console release that lands while the worker probes wins.
func TestFenceReleaseDuringProbesWins(t *testing.T) {
	h := newHarness(t)
	gate := make(chan struct{})
	entered := make(chan struct{}, 1)
	h.verify.set(func(v *fakeVerify) { v.gate, v.entered = gate, entered })
	done := make(chan CommandOutcome, 1)
	go func() { done <- h.isolate(idA, 1) }()
	<-entered
	rel := h.m.HandleRelease(context.Background(), map[string]any{"isolationId": idA, "generation": float64(2)})
	if rel.Failed() || rel.Result.State != StateReleased {
		t.Fatalf("release during probes: %+v", rel)
	}
	close(gate)
	out := <-done
	if out.Result == nil || out.Result.State == StateVerified {
		t.Fatalf("worker reported verified after the release: %+v", out)
	}
	if installed, _, _ := h.iso.state(); installed {
		t.Fatal("rules reinstalled after the release")
	}
	if j := h.journal(); j.Phase != journal.PhaseReleased {
		t.Fatalf("phase %s", j.Phase)
	}
}

// The generation-1 expiry arm firing after an extend to generation 2 must not
// release generation 2: expiry is decided from the journal, not the arm.
func TestFenceOldExpiryArmDoesNotReleaseNewGeneration(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1) // expires in 72 h
	if out := h.m.HandleIsolate(context.Background(), h.payload(idA, 2, 200*time.Hour)); out.Failed() {
		t.Fatalf("extend %+v", out)
	}
	var gen1 *expiryArm
	h.sched.mu.Lock()
	for i := range h.sched.expiry {
		if h.sched.expiry[i].gen == 1 {
			gen1 = &h.sched.expiry[i]
		}
	}
	h.sched.mu.Unlock()
	if gen1 == nil {
		t.Fatal("no generation-1 expiry arm recorded")
	}
	h.clock.SetWall(gen1.at.Add(time.Minute))
	h.clock.Advance(0)
	h.m.Tick(context.Background()) // the old arm fires: recovery's expire-check
	if !h.m.Active() {
		t.Fatal("the generation-1 expiry arm released generation 2")
	}
	if j := h.journal(); j.Episode.Generation != 2 || j.Phase != journal.PhaseCommitted {
		t.Fatalf("journal %s gen %d", j.Phase, j.Episode.Generation)
	}
}

// A late isolate for an episode that ended locally does not re-isolate.
func TestFenceLocalTerminalWinsOverStaleCommand(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	if err := h.m.LocalRelease(context.Background(), "", true); err != nil {
		t.Fatal(err)
	}
	applies := h.iso.applies
	out := h.isolate(idA, 2)
	if !out.Failed() || h.iso.applies != applies {
		t.Fatalf("a stale command re-isolated after a local release: %+v", out)
	}
	h.m.Reconcile(context.Background(), h.desired(idA, 2, DesiredIsolated, time.Hour, false))
	if h.m.Active() || h.iso.applies != applies {
		t.Fatal("the heartbeat re-asserted an episode that ended locally")
	}
}
