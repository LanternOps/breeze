//go:build darwin

package isolation

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// enforcingIsolator is the fake isolator plus the pf view boot recovery asks
// for: are the installed rules actually acting? A reboot leaves the journal
// committed while pf holds nothing.
type enforcingIsolator struct {
	*fakeIsolator
	enforcingErr error
}

func (e *enforcingIsolator) enforcing(context.Context) (bool, error) {
	if e.enforcingErr != nil {
		return false, e.enforcingErr
	}
	installed, _, _ := e.state()
	return installed, nil
}

func darwinRecoveryHarness(t *testing.T) (*harness, *enforcingIsolator) {
	t.Helper()
	h := newHarness(t)
	iso := &enforcingIsolator{fakeIsolator: h.iso}
	h.m = h.newManager()
	h.m.deps.Isolator = iso
	return h, iso
}

func (h *harness) recoveryManager(iso Isolator) *Manager {
	m := h.newManager()
	m.deps.Isolator = iso
	return m
}

func TestDarwinBootApplyReinstallsAStillValidEpisode(t *testing.T) {
	h, iso := darwinRecoveryHarness(t)
	h.mustIsolate(idA, 1)
	h.clock.Reboot("boot-2", h.clock.Now().Add(10*time.Minute))
	iso.set(func(f *fakeIsolator) { f.installed = false }) // pf keeps nothing across a reboot
	applies := iso.applies

	if err := h.recoveryManager(iso).DarwinBootApply(context.Background()); err != nil {
		t.Fatal(err)
	}
	if installed, _, _ := iso.state(); !installed || iso.applies != applies+1 {
		t.Fatalf("installed=%v applies=%d->%d", installed, applies, iso.applies)
	}
	j := h.journal()
	if j.Phase != journal.PhaseCommitted || !containsStr(eventTypes(j), "drift_reapplied") {
		t.Fatalf("phase %s events %v", j.Phase, eventTypes(j))
	}
	// Recovery re-installs; it does not repoint tasks or probe.
	if h.log.count("verify ") != 1 || h.log.count("dial ") != 1 {
		t.Fatalf("recovery probed: %v", h.log.all())
	}
}

func TestDarwinBootApplyLeavesEnforcingRulesAlone(t *testing.T) {
	h, iso := darwinRecoveryHarness(t)
	h.mustIsolate(idA, 1)
	applies := iso.applies
	if err := h.recoveryManager(iso).DarwinBootApply(context.Background()); err != nil {
		t.Fatal(err)
	}
	if iso.applies != applies {
		t.Fatal("re-applied rules that were already enforcing")
	}
}

// Expiry first: an episode that ended while the Mac was off is released, never
// re-installed for the moment until the next check.
func TestDarwinBootApplyReleasesAnExpiredEpisodeInsteadOfReinstalling(t *testing.T) {
	h, iso := darwinRecoveryHarness(t)
	h.mustIsolate(idA, 1)
	h.clock.Reboot("boot-2", h.clock.Now().Add(73*time.Hour))
	iso.set(func(f *fakeIsolator) { f.installed = false })
	applies := iso.applies
	if err := h.recoveryManager(iso).DarwinBootApply(context.Background()); err != nil {
		t.Fatal(err)
	}
	if iso.applies != applies {
		t.Fatal("re-installed an expired episode")
	}
	if j := h.journal(); j.Phase != journal.PhaseReleased || j.Episode.State != StateExpired {
		t.Fatalf("phase %s episode %+v", j.Phase, j.Episode)
	}
}

func TestDarwinBootApplyReportsAFailedReinstall(t *testing.T) {
	h, iso := darwinRecoveryHarness(t)
	h.mustIsolate(idA, 1)
	h.clock.Reboot("boot-2", h.clock.Now().Add(time.Minute))
	iso.set(func(f *fakeIsolator) {
		f.installed = false
		f.applyErr = ErrIncompatible{Reason: "set skip covers en0"}
	})
	if err := h.recoveryManager(iso).DarwinBootApply(context.Background()); err == nil {
		t.Fatal("a failed re-install must exit non-zero so launchd logs it and the next poll retries")
	}
	j := h.journal()
	if j.Phase != journal.PhaseCommitted || j.Episode.LastError == "" {
		t.Fatalf("phase %s lastError %q", j.Phase, j.Episode.LastError)
	}
	t.Run("an unreadable engine is not enforcing", func(t *testing.T) {
		iso.set(func(f *fakeIsolator) { f.applyErr = nil })
		iso.enforcingErr = errors.New("pf unreachable")
		if err := h.recoveryManager(iso).DarwinBootApply(context.Background()); err == nil {
			t.Fatal("got nil")
		}
	})
}

func writeProvisionalJournal(t *testing.T, h *harness, bootID string, deadline time.Time) {
	t.Helper()
	j := journal.New()
	j.Phase = journal.PhaseProvisional
	j.AttemptID = "attempt1"
	j.ProvisionalDeadline = deadline
	j.AttemptBootID = bootID
	j.AttemptMono = int64(h.clock.Mono())
	j.Episode = &journal.EpisodeRecord{IsolationID: idA, Generation: 1, ExpiresAt: h.clock.Now().Add(72 * time.Hour), State: StateApplying}
	if err := journal.Save(journal.Path(h.dir), j); err != nil {
		t.Fatal(err)
	}
	h.iso.set(func(f *fakeIsolator) { f.installed = true })
}

// launchd cannot tell RunAtLoad from a StartInterval tick, and the agent's
// apply loads the poll job itself, so boot-apply runs in the middle of applies.
// An attempt of this boot that is still inside its window must be left alone.
func TestDarwinBootApplyDoesNotRollBackAnAttemptOfThisBoot(t *testing.T) {
	h, iso := darwinRecoveryHarness(t)
	writeProvisionalJournal(t, h, h.clock.BootID(), h.clock.Now().Add(80*time.Second))
	if err := h.recoveryManager(iso).DarwinBootApply(context.Background()); err != nil {
		t.Fatal(err)
	}
	if j := h.journal(); j.Phase != journal.PhaseProvisional {
		t.Fatalf("an in-flight apply was rolled back: %s", j.Phase)
	}
	if h.log.count("iso:Release") != 0 {
		t.Fatal("released an in-flight apply")
	}
}

func TestDarwinBootApplyRollsBackAnAttemptOfAnEarlierBoot(t *testing.T) {
	h, iso := darwinRecoveryHarness(t)
	writeProvisionalJournal(t, h, "boot-0", h.clock.Now().Add(80*time.Second))
	if err := h.recoveryManager(iso).DarwinBootApply(context.Background()); err != nil {
		t.Fatal(err)
	}
	if j := h.journal(); j.Phase != journal.PhaseRolledBack {
		t.Fatalf("phase %s", j.Phase)
	}
}

func TestDarwinRollbackIfOverdue(t *testing.T) {
	t.Run("inside the window: nothing", func(t *testing.T) {
		h, iso := darwinRecoveryHarness(t)
		writeProvisionalJournal(t, h, h.clock.BootID(), h.clock.Now().Add(80*time.Second))
		if err := h.recoveryManager(iso).DarwinRollbackIfOverdue(context.Background(), "attempt1"); err != nil {
			t.Fatal(err)
		}
		if j := h.journal(); j.Phase != journal.PhaseProvisional || h.log.count("iso:Release") != 0 {
			t.Fatalf("phase %s calls %v", j.Phase, h.log.all())
		}
	})
	t.Run("past the deadline: roll back", func(t *testing.T) {
		h, iso := darwinRecoveryHarness(t)
		writeProvisionalJournal(t, h, h.clock.BootID(), h.clock.Now().Add(80*time.Second))
		h.clock.Advance(81 * time.Second)
		if err := h.recoveryManager(iso).DarwinRollbackIfOverdue(context.Background(), "attempt1"); err != nil {
			t.Fatal(err)
		}
		j := h.journal()
		if j.Phase != journal.PhaseRolledBack || j.Episode.FailureCode != FailControlPlaneUnreachable {
			t.Fatalf("phase %s episode %+v", j.Phase, j.Episode)
		}
		if installed, _, _ := iso.state(); installed {
			t.Fatal("rules left installed")
		}
	})
	t.Run("another attempt: unload only this attempt's job", func(t *testing.T) {
		h, iso := darwinRecoveryHarness(t)
		writeProvisionalJournal(t, h, h.clock.BootID(), h.clock.Now().Add(-time.Second))
		if err := h.recoveryManager(iso).DarwinRollbackIfOverdue(context.Background(), "attempt0"); err != nil {
			t.Fatal(err)
		}
		if j := h.journal(); j.Phase != journal.PhaseProvisional {
			t.Fatalf("an old job rolled back a newer attempt: %s", j.Phase)
		}
		if h.log.count("sched:DisarmProvisional attempt0") != 1 || h.log.count("sched:DisarmProvisional attempt1") != 0 {
			t.Fatalf("calls %v", h.log.all())
		}
	})
	t.Run("committed: the left-over job unloads itself", func(t *testing.T) {
		h, iso := darwinRecoveryHarness(t)
		h.mustIsolate(idA, 1)
		h.log.reset()
		if err := h.recoveryManager(iso).DarwinRollbackIfOverdue(context.Background(), "attempt9"); err != nil {
			t.Fatal(err)
		}
		if j := h.journal(); j.Phase != journal.PhaseCommitted || h.log.count("sched:DisarmProvisional attempt9") != 1 {
			t.Fatalf("phase %s calls %v", j.Phase, h.log.all())
		}
	})
	t.Run("a failed rollback is retried, and its job stays armed", func(t *testing.T) {
		h, iso := darwinRecoveryHarness(t)
		writeProvisionalJournal(t, h, h.clock.BootID(), h.clock.Now().Add(80*time.Second))
		h.clock.Advance(81 * time.Second)
		iso.set(func(f *fakeIsolator) { f.releaseErr = errors.New("pf busy") })
		m := h.recoveryManager(iso)
		if err := m.DarwinRollbackIfOverdue(context.Background(), "attempt1"); err == nil {
			t.Fatal("a failed rollback must exit non-zero")
		}
		if h.log.count("sched:DisarmProvisional") != 0 || h.log.count("sched:RemoveAll") != 0 {
			t.Fatalf("disarmed with rules still installed: %v", h.log.all())
		}
		iso.set(func(f *fakeIsolator) { f.releaseErr = nil })
		if err := m.DarwinRollbackIfOverdue(context.Background(), "attempt1"); err != nil {
			t.Fatal(err)
		}
		if j := h.journal(); j.Phase != journal.PhaseRolledBack {
			t.Fatalf("phase %s", j.Phase)
		}
	})
	t.Run("invalid attempt", func(t *testing.T) {
		h, iso := darwinRecoveryHarness(t)
		if err := h.recoveryManager(iso).DarwinRollbackIfOverdue(context.Background(), ""); err == nil {
			t.Fatal("accepted an empty attempt")
		}
	})
}
