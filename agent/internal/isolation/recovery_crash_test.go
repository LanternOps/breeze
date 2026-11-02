package isolation

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

func TestRecoveryCrashAtEveryCleanupEffect(t *testing.T) {
	for _, operation := range []string{"expiry", "rollback", "uninstall"} {
		perform := func(h *harness) error {
			switch operation {
			case "expiry":
				return h.m.RecoveryExpireCheck(context.Background())
			case "rollback":
				return h.m.RollbackIfUncommitted(context.Background(), "attempt-current")
			default:
				return h.m.ReleaseAll(context.Background(), ReleaseUninstall)
			}
		}
		setup := func(h *harness) {
			phase := journal.PhaseCommitted
			if operation == "rollback" {
				phase = journal.PhaseProvisional
			}
			seedRecovery(t, h, phase)
			h.clock.Advance(time.Hour)
		}
		ref := newHarness(t)
		setup(ref)
		count := crashAt(ref.m, -1)
		if err := perform(ref); err != nil {
			t.Fatal(err)
		}
		if *count == 0 {
			t.Fatalf("%s: no cleanup effects observed; the crash matrix would run zero cases", operation)
		}
		for n := 0; n < *count; n++ {
			t.Run(fmt.Sprintf("%s/%d", operation, n), func(t *testing.T) {
				h := newHarness(t)
				setup(h)
				crashAt(h.m, n)
				if err := perform(h); err == nil {
					t.Fatal("crash reported success")
				}
				h.m = h.newManager()
				if err := h.m.BootApply(context.Background()); err != nil {
					t.Fatal(err)
				}
				installed, _, _ := h.iso.state()
				if installed {
					t.Fatal("rules survived cleanup restart")
				}
				if h.journal().PendingReport == nil {
					t.Fatal("terminal receipt lost")
				}
			})
		}
	}
}

func TestRecoveryRollbackReadsAttemptUnderMachineLock(t *testing.T) {
	h := newHarness(t)
	j := seedRecovery(t, h, journal.PhaseProvisional)
	stale := h.newManager()
	j.AttemptID = "replacement-attempt"
	if err := journal.Save(h.m.path(), j); err != nil {
		t.Fatal(err)
	}
	if err := stale.RollbackIfUncommitted(context.Background(), "attempt-current"); err != nil {
		t.Fatal(err)
	}
	if installed, _, _ := h.iso.state(); !installed {
		t.Fatal("stale snapshot released replacement attempt")
	}
}
