package heartbeat

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/spf13/viper"
)

// Bounds of the flow and its restart (#10122 review): the backoff gate, the
// step budget, a later enrollment, and the restart's yield and failure paths.

// The backoff gate is what makes the rebind bounded: a drive inside the
// backoff window makes no call. (drive() clears retryAt, so these drives go
// through driveRebind directly.)
func TestRebindDrivesInsideTheBackoffMakeNoCall(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.queue(&r.fake.confirmQueue, rebindInjection{status: http.StatusInternalServerError}, rebindInjection{status: http.StatusInternalServerError})
	r.drive(r.directive(rebindGoldenIntent))
	if n := len(r.fake.callsTo("/rebind-confirm")); n != 1 {
		t.Fatalf("confirm calls = %d, want 1", n)
	}
	at := r.h.rebind.retryAt.Load()
	if at == nil || !at.After(r.now()) {
		t.Fatal("a refused confirm scheduled no backoff")
	}

	r.h.driveRebind(nil)
	r.advance(at.Sub(r.now()) - time.Second)
	r.h.driveRebind(nil)
	if n := len(r.fake.callsTo("/rebind-confirm")); n != 1 {
		t.Fatalf("confirm calls inside the backoff window = %d, want still 1", n)
	}

	r.advance(time.Second)
	r.h.driveRebind(nil)
	if n := len(r.fake.callsTo("/rebind-confirm")); n != 2 {
		t.Fatalf("confirm calls once the backoff elapsed = %d, want 2", n)
	}
}

// Answers that keep sending the flow back (phase 1 stages, confirm says not
// staged, phase 1 stages again, ...) use up the step budget once, then the
// flow waits for the backoff instead of starting another round on the next
// tick.
func TestRebindContradictoryAnswersWaitAfterTheStepBudget(t *testing.T) {
	r := newRebindHarness(t)
	for range rebindMaxSteps {
		r.fake.queue(&r.fake.confirmQueue, rebindInjection{status: http.StatusConflict, body: map[string]any{"code": "not_staged", "state": "requested"}})
	}
	r.drive(r.directive(rebindGoldenIntent))
	calls := len(r.fake.callsTo("/rebind")) + len(r.fake.callsTo("/rebind-confirm"))
	if calls != rebindMaxSteps {
		t.Fatalf("calls in one drive = %d, want %d (one per step)", calls, rebindMaxSteps)
	}
	if at := r.h.rebind.retryAt.Load(); at == nil || !at.After(r.now()) {
		t.Fatal("running out of steps scheduled no backoff")
	}
	r.h.driveRebind(nil)
	if after := len(r.fake.callsTo("/rebind")) + len(r.fake.callsTo("/rebind-confirm")); after != calls {
		t.Fatalf("the next tick made %d more calls inside the backoff", after-calls)
	}
	if !strings.Contains(r.logs.String(), "kept contradicting each other") {
		t.Fatal("running out of steps was not logged")
	}
}

// enrollAgain is `breeze-agent enroll` run over this install: a new agent id
// and token, saved by SaveEnrollment.
func (r *rebindHarness) enrollAgain() string {
	r.t.Helper()
	viper.Reset()
	cfg, err := config.Load(r.cfgPath)
	if err != nil {
		r.t.Fatal(err)
	}
	cfg.AgentID = strings.Repeat("e", 64)
	cfg.AuthToken = "brz_enrolled_again_token"
	if err := config.SaveEnrollment(cfg, r.cfgPath); err != nil {
		r.t.Fatalf("SaveEnrollment: %v", err)
	}
	return cfg.AgentID
}

// A confirmed set that outlived a new enrollment is never applied at
// runtime: not by a process still running the source (enrolled by another
// process meanwhile), nor by one running the new enrollment.
func TestRebindConfirmedSetNeverUndoesANewerEnrollment(t *testing.T) {
	for _, running := range []string{"source", "enrolled"} {
		t.Run(running, func(t *testing.T) {
			r := newRebindHarness(t)
			r.killAfter = config.RebindPhaseConfirmed
			r.drive(r.directive(rebindGoldenIntent))
			r.killAfter = ""
			set := r.staged()
			if set == nil || set.Phase != config.RebindPhaseConfirmed {
				t.Fatalf("staged set = %+v, want confirmed (the swap owed)", set)
			}

			enrolled := r.enrollAgain()
			// The set is back beside the enrollment (an older build left it,
			// or a write landed after the removal).
			if err := config.WriteRebindStaged(r.cfgPath, set); err != nil {
				t.Fatal(err)
			}
			if running == "enrolled" {
				r.restart()
			}
			r.drive(nil)

			if got := r.onDisk(); got.AgentID != enrolled || got.AuthToken != "brz_enrolled_again_token" {
				t.Fatalf("agent id on disk = %s; the enrollment was undone", got.AgentID)
			}
			if r.staged() != nil {
				t.Fatal("the superseded confirmed set was kept")
			}
			if r.h.rebind.swapped.Load() || r.restarts.Load() != 0 {
				t.Fatal("the process swapped or restarted for a superseded reattach")
			}
			if r.h.tokenRotating.Load() {
				t.Fatal("token rotation stays blocked after the superseded swap was dropped")
			}
		})
	}
}

// waitRestartReleased waits for the restart goroutine to finish and checks
// it gave the gate back. It waits for the goroutine, not for the gate: the
// goroutine releases the gate first and logs why after, so a caller that
// checks the log must not start on the release alone.
func (r *rebindHarness) waitRestartReleased() {
	r.t.Helper()
	if !r.waitForFlowGoroutines() {
		r.t.Fatal("the restart goroutine never finished")
	}
	if r.h.identitySync.restartRequested.Load() {
		r.t.Fatal("the restart gate was never released")
	}
}

// The restart into the reattached identity yields to a firmware section, and
// is asked for again once rebindRestartRetry has passed.
func TestRebindRestartYieldsToAFirmwareSectionAndRetries(t *testing.T) {
	g := useTestGuard(t)
	release := enterTestSection(t, g)
	r := newRebindHarness(t)
	r.drive(r.directive(rebindGoldenIntent))
	r.waitRestartReleased()
	if r.restarts.Load() != 0 {
		t.Fatal("restarted during a firmware section")
	}
	if !r.h.rebind.swapped.Load() {
		t.Fatal("the identity was not swapped")
	}
	if logs := r.logs.String(); !strings.Contains(logs, "a firmware update started before the restart into the reattached identity") ||
		!strings.Contains(logs, "retryIn="+rebindRestartRetry.String()) {
		t.Fatalf("the yield was not logged with its retry:\n%s", logs)
	}

	if err := release(); err != nil {
		t.Fatal(err)
	}
	r.advance(rebindRestartRetry - time.Second)
	r.drive(nil)
	time.Sleep(50 * time.Millisecond)
	if r.restarts.Load() != 0 {
		t.Fatal("asked for the restart again before rebindRestartRetry")
	}
	r.advance(time.Second)
	r.drive(nil)
	r.waitRestarts(1)
}

// A restart that fails releases the gate, says when it is tried again, and is
// tried again then.
func TestRebindRestartFailureIsRetried(t *testing.T) {
	r := newRebindHarness(t)
	failed := false
	restartForIdentityFn = func() error {
		if !failed {
			failed = true
			return errors.New("service manager refused")
		}
		r.restarts.Add(1)
		return nil
	}
	r.drive(r.directive(rebindGoldenIntent))
	r.waitRestartReleased()
	if !failed || r.restarts.Load() != 0 {
		t.Fatal("the failing restart was not attempted")
	}
	if logs := r.logs.String(); !strings.Contains(logs, "restart after the reattach failed; trying again in "+rebindRestartRetry.String()) {
		t.Fatalf("the restart failure was not logged with its retry:\n%s", logs)
	}
	r.advance(rebindRestartRetry)
	r.drive(nil)
	r.waitRestarts(1)
}
