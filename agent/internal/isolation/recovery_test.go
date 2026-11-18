package isolation

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

func seedRecovery(t *testing.T, h *harness, phase journal.Phase) *journal.Journal {
	t.Helper()
	j := committedJournal(h.clock, time.Hour)
	j.Phase = phase
	j.Episode.State = StateVerified
	j.RecoveryPath = "recovery.exe"
	if phase == journal.PhaseProvisional {
		j.AttemptID = "attempt-current"
		j.ProvisionalDeadline = h.clock.Now().Add(ProvisionalWindow)
		j.AttemptBootID = h.clock.BootID()
		j.AttemptMono = int64(h.clock.Mono())
	}
	if phase == journal.PhaseReleasing {
		j.Episode.ReleaseKind = ReleaseSystem
	}
	if err := journal.Save(h.m.path(), j); err != nil {
		t.Fatal(err)
	}
	h.iso.set(func(f *fakeIsolator) {
		f.installed = true
		f.cap = Capability{Version: 0, Mechanism: "wfp", UnsupportedReason: "not_activated"}
	})
	h.sched.polling = true
	return j
}

func TestRecoveryExpireCheck(t *testing.T) {
	for _, mode := range []string{"future", "expired", "releasing", "clock rollback"} {
		t.Run(mode, func(t *testing.T) {
			h := newHarness(t)
			phase := journal.PhaseCommitted
			if mode == "releasing" {
				phase = journal.PhaseReleasing
			}
			j := seedRecovery(t, h, phase)
			switch mode {
			case "expired":
				h.clock.Advance(time.Hour)
			case "clock rollback":
				h.clock.Reboot("new-boot", h.clock.Now().Add(-10*time.Minute))
			default:
				h.clock.Advance(time.Minute)
			}
			if err := h.m.RecoveryExpireCheck(context.Background()); err != nil {
				t.Fatal(err)
			}
			got := h.journal()
			installed, _, _ := h.iso.state()
			if mode == "future" {
				if !installed || got.Phase != journal.PhaseCommitted || !got.HighWaterWall.Equal(h.clock.Now()) {
					t.Fatalf("future: %+v installed=%v", got, installed)
				}
			} else if installed || got.PendingReport == nil {
				t.Fatalf("cleanup not durable: %+v installed=%v", got, installed)
			}
			if got.HighWaterWall.Before(j.HighWaterWall) {
				t.Fatal("high-water regressed")
			}
			if h.log.count("iso:Capability") != 0 || h.log.count("iso:Apply") != 0 || h.log.count("verify ") != 0 {
				t.Fatal("recovery gated on activation or applied/probed")
			}
		})
	}
}

func TestRecoveryRollbackFenced(t *testing.T) {
	for _, tc := range []struct {
		phase    journal.Phase
		attempt  string
		released bool
	}{
		{journal.PhaseProvisional, "attempt-current", true},
		{journal.PhaseProvisional, "stale-attempt", false},
		{journal.PhaseCommitted, "attempt-current", false},
	} {
		t.Run(string(tc.phase)+tc.attempt, func(t *testing.T) {
			h := newHarness(t)
			seedRecovery(t, h, tc.phase)
			if err := h.m.RollbackIfUncommitted(context.Background(), tc.attempt); err != nil {
				t.Fatal(err)
			}
			installed, _, _ := h.iso.state()
			if installed == tc.released {
				t.Fatalf("installed=%v", installed)
			}
			if tc.released && h.journal().Phase != journal.PhaseRolledBack {
				t.Fatal("not rolled back")
			}
		})
	}
}

func TestRecoveryBootApplyCleansProvisionalAndNeverPromotes(t *testing.T) {
	for _, phase := range []journal.Phase{journal.PhaseProvisional, journal.PhaseReleasing, journal.PhaseCommitted} {
		t.Run(string(phase), func(t *testing.T) {
			h := newHarness(t)
			seedRecovery(t, h, phase)
			if err := h.m.BootApply(context.Background()); err != nil {
				t.Fatal(err)
			}
			installed, _, _ := h.iso.state()
			if installed != (phase == journal.PhaseCommitted) {
				t.Fatalf("installed=%v", installed)
			}
			if phase == journal.PhaseProvisional && h.journal().Phase != journal.PhaseRolledBack {
				t.Fatal("provisional promoted")
			}
			if h.log.count("iso:Apply") != 0 {
				t.Fatal("boot recovery applied rules")
			}
		})
	}
}

func TestRecoveryOrphansKeepSystemReceipt(t *testing.T) {
	for _, raw := range []string{"", "{", `{"schemaVersion":900,"phase":"committed"}`} {
		t.Run(raw, func(t *testing.T) {
			h := newHarness(t)
			h.iso.set(func(f *fakeIsolator) { f.installed = true; f.cap.Version = 0 })
			if raw != "" {
				if err := os.WriteFile(h.m.path(), []byte(raw), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := h.m.BootApply(context.Background()); err != nil {
				t.Fatal(err)
			}
			j := h.journal()
			if j.PendingReport == nil || j.PendingReport.Kind != ReleaseSystem {
				t.Fatalf("lost receipt: %+v", j)
			}
			if owned, _, _ := h.iso.state(); owned {
				t.Fatal("orphan filters remain")
			}
			restarted := h.newManager()
			if err := restarted.RecoveryExpireCheck(context.Background()); err != nil {
				t.Fatal(err)
			}
			if h.journal().PendingReport == nil {
				t.Fatal("restart lost receipt")
			}
		})
	}
}

func TestRecoveryReleaseAllCleanAndUnavailable(t *testing.T) {
	for _, tc := range []struct {
		name                                                string
		phase                                               journal.Phase
		missing, unsupported, engineError, owned, wantError bool
	}{
		{name: "clean no journal", missing: true},
		{name: "unavailable never isolated", missing: true, engineError: true},
		{name: "unavailable idle journal", phase: journal.PhaseNone, engineError: true, wantError: true},
		{name: "unsupported never isolated", missing: true, unsupported: true},
		{name: "unsupported idle", phase: journal.PhaseNone, unsupported: true},
		{name: "unsupported released", phase: journal.PhaseReleased, unsupported: true},
		{name: "unsupported rolled back", phase: journal.PhaseRolledBack, unsupported: true},
		{name: "unsupported active", phase: journal.PhaseCommitted, unsupported: true, wantError: true},
		{name: "active", phase: journal.PhaseCommitted, owned: true},
		{name: "confirmed absent active", phase: journal.PhaseCommitted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			if !tc.missing {
				seedRecovery(t, h, tc.phase)
			}
			h.iso.set(func(f *fakeIsolator) {
				f.installed = tc.owned
				if tc.engineError {
					f.ownedErr = errors.New("engine unavailable")
				}
				if !tc.owned {
					f.releaseErr = errors.New("must not release absent filters")
				}
			})
			if tc.unsupported {
				h.m.deps.Isolator = unsupportedIsolator{}
			}
			err := h.m.ReleaseAll(context.Background(), ReleaseUninstall)
			if (err != nil) != tc.wantError {
				t.Fatalf("error=%v wantError=%v", err, tc.wantError)
			}
			if tc.owned && !tc.wantError {
				j := h.journal()
				if j.PendingReport == nil || j.PendingReport.Kind != ReleaseUninstall {
					t.Fatalf("missing uninstall receipt: %+v", j)
				}
			}
		})
	}
}

func TestRecoveryCleanupFailureKeepsTasks(t *testing.T) {
	for _, failure := range []string{"release", "enumeration", "still owned", "write"} {
		t.Run(failure, func(t *testing.T) {
			h := newHarness(t)
			seedRecovery(t, h, journal.PhaseCommitted)
			h.clock.Advance(time.Hour)
			switch failure {
			case "release":
				h.iso.releaseErr = errors.New("release failed")
			case "enumeration":
				h.iso.ownedErr = errors.New("enumeration failed")
			case "still owned":
				h.iso.stickyOwned = true
			case "write":
				h.m.saveJournal = func(string, *journal.Journal) error { return errors.New("disk failed") }
			}
			if err := h.m.RecoveryExpireCheck(context.Background()); err == nil {
				t.Fatal("cleanup failure returned success")
			}
			if h.log.count("sched:RemoveAll") != 0 {
				t.Fatal("removed recovery tasks after failure")
			}
		})
	}
}

func TestRecoveryCorruptJournalCannotBecomeNeverIsolatedAfterFailedInspection(t *testing.T) {
	h := newHarness(t)
	if err := os.WriteFile(h.m.path(), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	h.iso.ownedErr = errors.New("engine unavailable")
	for n := 0; n < 2; n++ {
		if err := h.newManager().ReleaseAll(context.Background(), ReleaseUninstall); err == nil {
			t.Fatalf("attempt %d treated corrupt journal as never-isolated", n)
		}
	}
}

type recoveryFailingScheduler struct{ *fakeScheduler }

func (s recoveryFailingScheduler) RemoveAll() error { return errors.New("scheduler unavailable") }

func TestRecoveryNeverIsolatedDoesNotRequireScheduler(t *testing.T) {
	h := newHarness(t)
	h.m.deps.Scheduler = recoveryFailingScheduler{h.sched}
	if err := h.m.ReleaseAll(context.Background(), ReleaseUninstall); err != nil {
		t.Fatalf("clean uninstall requires scheduler: %v", err)
	}
}

func TestRecoveryTaskRemovalFailureIsReturnedAndRetried(t *testing.T) {
	h := newHarness(t)
	seedRecovery(t, h, journal.PhaseCommitted)
	h.clock.Advance(time.Hour)
	h.m.deps.Scheduler = recoveryFailingScheduler{h.sched}
	if err := h.m.RecoveryExpireCheck(context.Background()); err == nil {
		t.Fatal("task removal failure hidden")
	}
	if h.journal().PendingReport == nil {
		t.Fatal("cleanup lost durable receipt")
	}
	if h.log.count("sched:RemoveAll") != 0 {
		t.Fatal("failed scheduler removed tasks")
	}
	restarted := h.newManager()
	if err := restarted.BootApply(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.log.count("sched:RemoveAll") != 1 {
		t.Fatal("terminal startup did not retry task removal")
	}
}

func TestRecoveryTerminalWriteFailureKeepsTasksUntilRetry(t *testing.T) {
	h := newHarness(t)
	seedRecovery(t, h, journal.PhaseCommitted)
	h.clock.Advance(time.Hour)
	save := h.m.saveJournal
	h.m.saveJournal = func(path string, j *journal.Journal) error {
		if j.Phase == journal.PhaseReleased {
			return errors.New("terminal fsync failed")
		}
		return save(path, j)
	}
	if err := h.m.RecoveryExpireCheck(context.Background()); err == nil {
		t.Fatal("terminal write failure hidden")
	}
	if h.log.count("sched:RemoveAll") != 0 {
		t.Fatal("disarmed before durable terminal write")
	}
	if err := h.newManager().RecoveryExpireCheck(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.journal().PendingReport == nil {
		t.Fatal("retry lost receipt")
	}
}

func TestRecoveryBootMalformedProvisionalStillCleansRules(t *testing.T) {
	h := newHarness(t)
	j := seedRecovery(t, h, journal.PhaseProvisional)
	j.AttemptID = ""
	if err := journal.Save(h.m.path(), j); err != nil {
		t.Fatal(err)
	}
	if err := h.m.BootApply(context.Background()); err != nil {
		t.Fatal(err)
	}
	if installed, _, _ := h.iso.state(); installed {
		t.Fatal("malformed provisional rules remained installed")
	}
}
