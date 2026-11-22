//go:build linux

package isolation

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// bootIsolator is the fake isolator plus the Linux boot-rule loader. A reboot
// empties nft, so the harness models it by clearing the fake's rules.
type bootIsolator struct {
	*fakeIsolator
	boot     []ResolvedSpec
	bootErr  error
	ownedErr error
}

func (b *bootIsolator) applyBootRules(_ context.Context, spec ResolvedSpec) error {
	if b.bootErr != nil {
		return b.bootErr
	}
	b.boot = append(b.boot, spec)
	return nil
}

func (b *bootIsolator) Owned(ctx context.Context) (bool, error) {
	if b.ownedErr != nil {
		return false, b.ownedErr
	}
	return b.fakeIsolator.Owned(ctx)
}

func bootHarness(t *testing.T) (*harness, *bootIsolator) {
	t.Helper()
	h := newHarness(t)
	boot := &bootIsolator{fakeIsolator: h.iso}
	h.m = NewManager(ManagerDeps{
		Isolator: boot, Scheduler: h.sched, DataDir: h.dir, Resolver: NewResolver(h.lookup.lookup),
		VerifyRoundTrip: h.verify.call, Clock: h.clock, Dialer: h.dialer,
	})
	h.m.negativeTimeout = 40 * time.Millisecond
	h.m.probeBudget = 3 * time.Second
	return h, boot
}

func rebootClearsRules(h *harness) {
	h.iso.set(func(f *fakeIsolator) {
		f.installed = false
	})
}

// nft rules do not survive a reboot, so a committed episode must be back in
// place before network-pre.target or the host boots unisolated until the agent
// starts (spec §3.5 Linux persistence row).
func TestBootApplyRestoresACommittedEpisode(t *testing.T) {
	h, boot := bootHarness(t)
	const id = "11111111-2222-4333-8444-000000000001"
	out := h.m.HandleIsolate(context.Background(), h.payload(id, 1, 72*time.Hour))
	if out.Failed() {
		t.Fatalf("isolate: %+v", out)
	}
	rebootClearsRules(h)
	if err := h.m.BootApplyAndRestore(context.Background()); err != nil {
		t.Fatalf("boot apply: %v", err)
	}
	if len(boot.boot) != 1 {
		t.Fatalf("boot rules loaded %d times", len(boot.boot))
	}
	if got := boot.boot[0]; got.IsolationID != id || got.Generation != 1 || len(got.Entries) == 0 {
		t.Fatalf("boot spec = %+v", got)
	}
	if j := h.journal(); j.Phase != journal.PhaseCommitted {
		t.Fatalf("restoring rules must not change the journal: phase %s", j.Phase)
	}
}

func TestBootApplyLeavesPresentRulesAlone(t *testing.T) {
	h, boot := bootHarness(t)
	out := h.m.HandleIsolate(context.Background(), h.payload("11111111-2222-4333-8444-000000000001", 1, 72*time.Hour))
	if out.Failed() {
		t.Fatalf("isolate: %+v", out)
	}
	// The unit re-run without a reboot: the full rule set is still in the kernel.
	if err := h.m.BootApplyAndRestore(context.Background()); err != nil {
		t.Fatalf("boot apply: %v", err)
	}
	if len(boot.boot) != 0 {
		t.Fatal("boot rules must not replace the running rule set")
	}
}

func TestBootApplyDoesNotRestoreAnExpiredEpisode(t *testing.T) {
	h, boot := bootHarness(t)
	out := h.m.HandleIsolate(context.Background(), h.payload("11111111-2222-4333-8444-000000000001", 1, time.Hour))
	if out.Failed() {
		t.Fatalf("isolate: %+v", out)
	}
	rebootClearsRules(h)
	h.clock.Advance(2 * time.Hour)
	if err := h.m.BootApplyAndRestore(context.Background()); err != nil {
		t.Fatalf("boot apply: %v", err)
	}
	if len(boot.boot) != 0 {
		t.Fatal("an expired episode must not be restored")
	}
	if j := h.journal(); j.Phase == journal.PhaseCommitted {
		t.Fatalf("phase = %s", j.Phase)
	}
}

func TestBootApplyDoesNotPromoteAnUncommittedEpisode(t *testing.T) {
	h, boot := bootHarness(t)
	seedRecovery(t, h, journal.PhaseProvisional)
	rebootClearsRules(h)
	if err := h.m.BootApplyAndRestore(context.Background()); err != nil {
		t.Fatalf("boot apply: %v", err)
	}
	if len(boot.boot) != 0 {
		t.Fatal("an unfinished provisional apply must be cleaned up, never restored")
	}
}

func TestBootApplyIsANoOpWithNoEpisode(t *testing.T) {
	h, boot := bootHarness(t)
	if err := h.m.BootApplyAndRestore(context.Background()); err != nil {
		t.Fatalf("boot apply: %v", err)
	}
	if len(boot.boot) != 0 {
		t.Fatal("nothing to restore")
	}
}

func TestBootApplySurfacesAFailedRestore(t *testing.T) {
	h, boot := bootHarness(t)
	out := h.m.HandleIsolate(context.Background(), h.payload("11111111-2222-4333-8444-000000000001", 1, 72*time.Hour))
	if out.Failed() {
		t.Fatalf("isolate: %+v", out)
	}
	rebootClearsRules(h)
	boot.bootErr = errors.New("nft: load failed")
	if err := h.m.BootApplyAndRestore(context.Background()); err == nil {
		t.Fatal("a failed restore must exit non-zero so the journal of the boot shows it")
	}
	boot.bootErr = nil
	boot.ownedErr = errors.New("engine unavailable")
	if err := h.m.BootApplyAndRestore(context.Background()); err == nil {
		t.Fatal("an unobservable engine must not read as a successful boot")
	}
}
