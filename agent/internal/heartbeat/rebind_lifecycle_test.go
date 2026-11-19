package heartbeat

import (
	"os"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/spf13/viper"
)

func (r *rebindHarness) swapCount() int {
	n := 0
	for _, e := range r.eventLog() {
		if e == "swap" {
			n++
		}
	}
	return n
}

// #8318 review fix 8: the staged set stays on disk until the restarted
// process has authenticated as the target once. Until then token rotation is
// held and every start checks the swap; the first 2xx as the target removes
// the set. The watchdog is handed the target's token right after the swap.
func TestRebindKeepsTheSetUntilTheTargetAuthenticates(t *testing.T) {
	r := newRebindHarness(t)
	r.drive(r.directive(rebindGoldenIntent))
	r.waitRestarts(1)
	set := r.staged()
	if set == nil || set.Phase != config.RebindPhaseConfirmed {
		t.Fatal("the set did not stay after the swap")
	}
	r.eventsMu.Lock()
	pushes := append([]string(nil), r.watchdogPushes...)
	r.eventsMu.Unlock()
	if len(pushes) != 1 || pushes[0] != set.WatchdogAuthToken {
		t.Fatal("the watchdog was not handed the target's watchdog token after the swap")
	}

	if r.startProcess() {
		t.Fatal("start-up rewrote an intact swap")
	}
	r.h.resumeRebind()
	time.Sleep(30 * time.Millisecond)
	if r.restarts.Load() != 1 || r.swapCount() != 1 {
		t.Fatal("the restarted process re-applied or restarted an intact swap")
	}
	if !r.h.rebindInProgress() {
		t.Fatal("token rotation is not held while the set waits for the target to authenticate")
	}
	r.becomeTarget()
	if r.h.rebindInProgress() {
		t.Fatal("token rotation still held after the target authenticated")
	}
}

// Anything that reverts the swap on disk before the target has authenticated
// (the watchdog writing an older token, a stale write of the old process) is
// re-applied: at start-up, or by the heartbeat when start-up could not.
func TestRebindReappliesARevertedSwap(t *testing.T) {
	reverts := []struct {
		name   string
		revert func(t *testing.T, cfgPath string)
	}{
		{name: "the watchdog wrote the source's watchdog token back", revert: func(t *testing.T, _ string) {
			if err := config.SetSecretAndPersist("watchdog_auth_token", "brz_source_watchdog_token"); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "an older write put the source's credentials back", revert: func(t *testing.T, _ string) {
			if err := config.StagePendingCredentials(rebindTestSourceToken, "brz_source_watchdog_token", "brz_source_helper_token"); err != nil {
				t.Fatal(err)
			}
			if err := config.PromotePendingCredentials(rebindTestSourceToken, "brz_source_watchdog_token", "brz_source_helper_token"); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "the source's certificate came back", revert: func(t *testing.T, _ string) {
			if err := config.SetSecretAndPersist("mtls_cert_pem", "SOURCE-CERT"); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "agent.yaml names the source again", revert: func(t *testing.T, _ string) {
			if err := config.SetAndPersist("agent_id", rebindGoldenSource); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, rv := range reverts {
		for _, path := range []string{"at start-up", "by the heartbeat"} {
			t.Run(rv.name+" / "+path, func(t *testing.T) {
				r := newRebindHarness(t)
				r.drive(r.directive(rebindGoldenIntent))
				r.waitRestarts(1)
				set := r.staged()
				r.onDisk() // binds viper to the config, as the writers expect
				rv.revert(t, r.cfgPath)
				id, _ := set.Identity()
				if intact, _ := config.RebindIdentityIntact(r.cfgPath, id); intact {
					t.Fatal("the test did not revert anything")
				}

				if path == "at start-up" {
					if !r.startProcess() {
						t.Fatal("start-up did not re-apply a reverted swap")
					}
				} else {
					r.restart() // start-up could not check it
					r.h.resumeRebind()
					r.waitRestarts(2)
				}
				if intact, err := config.RebindIdentityIntact(r.cfgPath, id); err != nil || !intact {
					t.Fatalf("the swap is not intact after the re-apply (%v)", err)
				}
				r.assertSwapped(set)
			})
		}
	}
}

// A rollback or an upgrade in progress owns the next restart: the swap waits
// for it (the confirmed set stays on disk), then happens.
func TestRebindSwapWaitsForARollbackOrAnUpgrade(t *testing.T) {
	for _, owner := range []string{"rollback", "upgrade"} {
		t.Run(owner, func(t *testing.T) {
			r := newRebindHarness(t)
			rollback := &identityRollbackController{}
			r.h.rollbackController = rollback
			if owner == "rollback" {
				rollback.active.Store(true)
			} else {
				r.h.upgradeInProgress.Store(true)
			}
			r.drive(r.directive(rebindGoldenIntent))
			if r.swapCount() != 0 || r.restarts.Load() != 0 {
				t.Fatal("swapped while a " + owner + " owned the restart")
			}
			if s := r.staged(); s == nil || s.Phase != config.RebindPhaseConfirmed {
				t.Fatal("the confirmed set was not kept")
			}
			if r.onDisk().AgentID != rebindGoldenSource {
				t.Fatal("the identity changed while a " + owner + " was in progress")
			}
			rollback.active.Store(false)
			r.h.upgradeInProgress.Store(false)
			r.drive(nil)
			r.waitRestarts(1)
		})
	}
}

// The restart waits for the commands already running (#8320's bound), and
// yields to a rollback that starts meanwhile; the next tick retries later.
func TestRebindRestartWaitsForWorkInFlightAndYields(t *testing.T) {
	r := newRebindHarness(t)
	rollback := &identityRollbackController{}
	r.h.rollbackController = rollback
	running := r.h.trackInFlight(time.Now(), time.Hour)
	r.drive(r.directive(rebindGoldenIntent))
	if r.swapCount() != 1 {
		t.Fatal("the swap did not happen")
	}
	time.Sleep(50 * time.Millisecond)
	if r.restarts.Load() != 0 {
		t.Fatal("restarted while a command was still running")
	}
	if !r.h.identityIntakePaused() || r.h.beatSkipReason() == "" {
		t.Fatal("the restart gate is not held while the restart waits")
	}
	rollback.active.Store(true) // a rollback starts during the wait
	r.h.untrackInFlight(running)
	waitForIdentityCondition(t, "the restart yields", func() bool { return !r.h.identitySync.restartRequested.Load() })
	if r.restarts.Load() != 0 {
		t.Fatal("restarted although a rollback owned the restart")
	}

	rollback.active.Store(false)
	r.advance(rebindRestartRetry)
	r.h.tickRebind()
	r.waitRestarts(1)
}

// A token rotation in flight settles before the swap; after it no token
// update runs in this process (rotation, reconcile, the watchdog's update).
func TestRebindSwapSettlesARotationAndHoldsTokenUpdates(t *testing.T) {
	r := newRebindHarness(t)
	r.h.tokenRotating.Store(true) // a rotation is running
	r.drive(r.directive(rebindGoldenIntent))
	if r.swapCount() != 0 {
		t.Fatal("swapped while a token rotation was in flight")
	}
	r.h.tokenRotating.Store(false) // it settled
	r.drive(nil)
	r.waitRestarts(1)
	if !r.h.tokenRotating.Load() {
		t.Fatal("the rotation latch was released after the swap")
	}
	r.h.handleTokenRotation()
	r.h.reconcilePendingRotation()
	if n := len(r.fake.callsTo("/rotate-token")) + len(r.fake.callsTo("/confirm")); n != 0 {
		t.Fatalf("a token update ran after the swap (%d calls)", n)
	}
	r.eventsMu.Lock()
	pushes := len(r.watchdogPushes)
	r.eventsMu.Unlock()
	if pushes != 1 {
		t.Fatalf("watchdog token updates = %d, want only the target's", pushes)
	}
	if _, err := os.Stat(config.RebindStagedPath(r.cfgPath)); err != nil {
		t.Fatal("the staged set was removed before the target authenticated")
	}
	viper.Reset()
}
