package heartbeat

import (
	"os"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/httputil"
)

// The crash and loss table of spec §6.6 (and the hand-off's §6), one test per
// row. A "crash" is a write that lands and then reports an error (the flow
// stops right there) or a dropped answer; the "restart" is a fresh process
// over the same config directory (rebindHarness.restart).

// Row 1: before the first phase 1 call — the next process resends phase 1
// with the SAME hashes.
func TestRebindCrashBeforeTheFirstPhase1Call(t *testing.T) {
	r := newRebindHarness(t)
	r.killAfter = config.RebindPhaseGenerated
	r.drive(r.directive(rebindGoldenIntent))
	if n := len(r.fake.callsTo("/rebind")); n != 0 {
		t.Fatalf("phase 1 calls = %d before the crash, want 0", n)
	}
	before := r.staged()

	r.killAfter = ""
	r.restart()
	r.h.resumeRebind()
	r.waitRestarts(1)
	calls := r.fake.callsTo("/rebind")
	if len(calls) != 1 || *calls[0].stage != hashesOf(before) {
		t.Fatal("the resumed phase 1 did not send the set persisted before the crash")
	}
	r.assertSwapped(before)
}

// Row 1, the other case: the crash came before the set reached the disk —
// the server knows nothing, and the next directive starts a fresh set.
func TestRebindCrashBeforeTheSetReachedTheDisk(t *testing.T) {
	r := newRebindHarness(t)
	r.failWrites = true
	r.drive(r.directive(rebindGoldenIntent))
	r.failWrites = false
	r.restart()
	r.h.resumeRebind()
	if n := len(r.fake.callsTo("/rebind")); n != 0 || r.staged() != nil {
		t.Fatal("a resume acted with nothing on disk")
	}
	r.drive(r.directive(rebindGoldenIntent))
	r.waitRestarts(1)
}

// Row 2: phase 1's response lost — phase 1 again with the same hashes gets
// the same staged agent id and a FRESH certificate, and the newest is kept.
func TestRebindCrashPhase1ResponseLost(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.queue(&r.fake.stageQueue, rebindInjection{commitThenDrop: true})
	r.drive(r.directive(rebindGoldenIntent))
	if s := r.staged(); s == nil || s.Phase != config.RebindPhaseGenerated {
		t.Fatal("a lost phase 1 answer advanced the set")
	}
	if r.fake.currentState() != "staged" {
		t.Fatal("the fake did not stage")
	}

	r.restart()
	r.h.resumeRebind()
	r.waitRestarts(1)
	calls := r.fake.callsTo("/rebind")
	if len(calls) != 2 || *calls[0].stage != *calls[1].stage {
		t.Fatal("the retry after a lost phase 1 answer did not resend the same hashes")
	}
	if c := r.fake.callsTo("/rebind-confirm")[0]; c.cert != "staged-cert-2" {
		t.Fatalf("confirm presented %q, want the newest staged certificate (staged-cert-2)", c.cert)
	}
	r.assertSwapped(r.lastWritten())
}

// Row 3: the staged set lost after phase 1 (a disk restore) — phase 1 with a
// new set is refused (restage_refused, the intent cancelled); the new set is
// discarded once the source credentials are proven current.
func TestRebindCrashStagedSetLostAfterPhase1(t *testing.T) {
	r := newRebindHarness(t)
	r.killAfter = config.RebindPhaseStaged
	r.drive(r.directive(rebindGoldenIntent))
	if err := os.Remove(config.RebindStagedPath(r.cfgPath)); err != nil {
		t.Fatal(err)
	}

	r.killAfter = ""
	r.restart()
	r.drive(r.directive(rebindGoldenIntent))
	s := r.staged()
	if s == nil || s.Phase != config.RebindPhaseEnded || s.EndedCode != "restage_refused" {
		t.Fatalf("set = %+v, want ended (restage_refused)", s)
	}
	if n := len(r.fake.callsTo("/rebind-confirm")); n != 0 {
		t.Fatal("confirmed after a restage refusal")
	}
	if r.fake.currentState() != "cancelled" {
		t.Fatal("the fake intent is not cancelled")
	}
	r.h.healthMon = health.NewMonitor()
	r.h.retryCfg = httputil.RetryConfig{MaxRetries: 0}
	if _, ok := r.h.doHeartbeatPost(r.fake.srv.URL, &HeartbeatPayload{Status: "ok", AgentVersion: "1.2.3"}); !ok {
		t.Fatal("source heartbeat failed")
	}
	if r.staged() != nil {
		t.Fatal("the refused set was kept after the source credentials were proven current")
	}
	if r.restarts.Load() != 0 {
		t.Fatal("restarted although nothing was confirmed")
	}
}

// Row 4: after phase 1, before confirm — the next process retries confirm.
func TestRebindCrashAfterPhase1BeforeConfirm(t *testing.T) {
	r := newRebindHarness(t)
	r.killAfter = config.RebindPhaseStaged
	r.drive(r.directive(rebindGoldenIntent))
	if n := len(r.fake.callsTo("/rebind-confirm")); n != 0 {
		t.Fatal("confirm was sent before the staged state was durable")
	}
	r.killAfter = ""
	r.restart()
	r.h.resumeRebind()
	r.waitRestarts(1)
	if n := len(r.fake.callsTo("/rebind")); n != 1 {
		t.Fatalf("phase 1 calls = %d, want 1 (the staged state was on disk)", n)
	}
	r.assertSwapped(r.lastWritten())
}

// Row 4, ended: confirm says expired — the set is kept until the source
// credentials are proven current, then discarded; staging never reopens.
func TestRebindCrashAfterPhase1ThenTheIntentExpired(t *testing.T) {
	r := newRebindHarness(t)
	r.killAfter = config.RebindPhaseStaged
	r.drive(r.directive(rebindGoldenIntent))
	r.fake.setState("expired", "")

	r.killAfter = ""
	r.restart()
	r.h.resumeRebind()
	if s := r.staged(); s == nil || s.Phase != config.RebindPhaseEnded || s.EndedState != "expired" {
		t.Fatalf("set = %+v, want ended (expired)", s)
	}
	r.drive(r.directive(rebindGoldenIntent))
	if n := len(r.fake.callsTo("/rebind")); n != 1 {
		t.Fatal("staging reopened for an expired intent")
	}
	r.h.noteCredentialsCurrent()
	if r.staged() != nil {
		t.Fatal("the ended set was kept after the source credentials were proven current")
	}
}

// Row 5a: confirm committed, its response lost — the replay answers 200 with
// the identity, and the swap completes.
func TestRebindCrashConfirmCommittedResponseLostReplays(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.queue(&r.fake.confirmQueue, rebindInjection{commitThenDrop: true})
	r.drive(r.directive(rebindGoldenIntent))
	if r.fake.currentState() != "confirmed" || r.restarts.Load() != 0 {
		t.Fatal("expected a committed confirm with its answer lost")
	}
	set := r.staged()

	r.restart()
	r.h.resumeRebind()
	r.waitRestarts(1)
	if n := len(r.fake.callsTo("/rebind-confirm")); n != 2 {
		t.Fatalf("confirm calls = %d, want 2", n)
	}
	if c := r.fake.callsTo("/rebind-confirm")[1]; c.cert != set.Certificate.SerialNumber {
		t.Fatalf("the replay presented %q, want the staged (now active) certificate", c.cert)
	}
	r.assertSwapped(set)
}

// Row 5b: confirm committed, its response lost, and confirm keeps failing —
// the source gets 401, the staged set probes as the target, and swaps.
func TestRebindCrashConfirmCommittedThenProbe(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.queue(&r.fake.confirmQueue, rebindInjection{commitThenDrop: true})
	r.drive(r.directive(rebindGoldenIntent))
	set := r.staged()
	for range 5 {
		r.fake.queue(&r.fake.confirmQueue, rebindInjection{status: 502})
	}

	r.restart()
	r.h.resumeRebind() // confirm 502; no source rejection seen yet: no probe
	if n := len(r.fake.callsTo("/config")); n != 0 {
		t.Fatal("probed before the source credentials were rejected")
	}
	r.h.healthMon = health.NewMonitor()
	r.h.retryCfg = httputil.RetryConfig{MaxRetries: 0}
	if _, ok := r.h.doHeartbeatPost(r.fake.srv.URL, &HeartbeatPayload{Status: "ok", AgentVersion: "1.2.3"}); ok {
		t.Fatal("the retired source credentials still authenticate")
	}
	if !r.h.rebind.sourceRejected.Load() {
		t.Fatal("the source 401 was not noted")
	}
	r.advance(rebindRetryMax) // past the backoff: the next ticks
	r.tickUntilRestart()
	if n := len(r.fake.callsTo("/heartbeat")); n != 1 {
		t.Fatalf("heartbeat calls = %d, want only the source's 401", n)
	}
	if n := len(r.fake.callsTo("/config")); n < 1 {
		t.Fatal("no probe of /config as the target")
	}
	r.assertSwapped(set)
}

// Row 6: a crash during the local swap — the next start finishes it
// (config.FinishConfirmedRebind, run by agentapp before anything reads the
// identity), or the heartbeat's resume re-applies it and restarts.
func TestRebindCrashDuringTheLocalSwap(t *testing.T) {
	t.Run("finished at start-up", func(t *testing.T) {
		r := newRebindHarness(t)
		r.killAfter = config.RebindPhaseConfirmed
		r.drive(r.directive(rebindGoldenIntent))
		set := r.staged()
		if set == nil || set.Phase != config.RebindPhaseConfirmed || r.restarts.Load() != 0 {
			t.Fatal("expected a confirmed set and no swap")
		}
		changed, err := config.FinishConfirmedRebind(r.cfgPath)
		if err != nil || !changed {
			t.Fatalf("FinishConfirmedRebind = (%v, %v)", changed, err)
		}
		r.assertSwapped(set)
		r.startProcess()
		r.h.resumeRebind()
		if r.restarts.Load() != 0 || r.swapCount() != 0 {
			t.Fatal("the resumed process re-applied or restarted after start-up finished the swap")
		}
		if !r.h.rebind.pendingOnDisk.Load() {
			t.Fatal("the set must stay until the target authenticates")
		}
		r.becomeTarget()
	})
	t.Run("the write fails, then the heartbeat retries", func(t *testing.T) {
		r := newRebindHarness(t)
		r.failApply = true
		r.drive(r.directive(rebindGoldenIntent))
		set := r.staged()
		if set == nil || set.Phase != config.RebindPhaseConfirmed || r.restarts.Load() != 0 || r.h.rebindOwnsIdentity() {
			t.Fatal("a failed swap was treated as done")
		}
		if r.h.tokenRotating.Load() {
			t.Fatal("a failed swap kept token rotation blocked")
		}
		r.failApply = false
		r.restart()
		r.h.resumeRebind()
		r.waitRestarts(1)
		r.assertSwapped(set)
	})
}

// Row 7: the server crashed mid-confirm (its transaction rolled back) —
// confirm again; the revalidation runs again.
func TestRebindCrashServerMidConfirm(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.queue(&r.fake.confirmQueue, rebindInjection{status: 500})
	r.drive(r.directive(rebindGoldenIntent))
	if r.fake.currentState() != "staged" || r.restarts.Load() != 0 {
		t.Fatal("expected the intent still staged after a rolled-back confirm")
	}
	r.advance(time.Minute)
	r.tickUntilRestart()
	r.assertSwapped(r.lastWritten())
}

// tickUntilRestart runs heartbeat ticks until the restart: a tick's drive is
// dropped while an earlier trigger's drive still holds the flow.
func (r *rebindHarness) tickUntilRestart() {
	r.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for r.restarts.Load() == 0 {
		if time.Now().After(deadline) {
			r.t.Fatal("no restart after the ticks")
		}
		r.h.tickRebind()
		time.Sleep(20 * time.Millisecond)
	}
}

// Every kill point, resumed by a fresh process: one confirm commits, with
// the one set this install generated.
func TestRebindResumesFromEveryKillPoint(t *testing.T) {
	for _, phase := range []string{config.RebindPhaseGenerated, config.RebindPhaseStaged, config.RebindPhaseConfirmed} {
		t.Run(phase, func(t *testing.T) {
			r := newRebindHarness(t)
			r.killAfter = phase
			r.drive(r.directive(rebindGoldenIntent))
			r.killAfter = ""
			r.restart()
			r.h.resumeRebind()
			r.waitRestarts(1)
			first := r.firstWritten()
			r.assertSwapped(first)
			for _, c := range r.fake.callsTo("/rebind") {
				if *c.stage != hashesOf(first) {
					t.Fatal("a second set was sent for the intent")
				}
			}
		})
	}
}
