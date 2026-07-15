package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// collectDiagnosticsHarness spins up a fake API that routes /logs and
// /commands/.../result, drives handleFailoverCommand with a collect_diagnostics
// command against a journal pre-seeded with `entryCount` on-disk entries, and
// returns the submitted command-result body. The logsStatus callback decides
// the HTTP status for each /logs POST (1-indexed call number) so a test can
// stage a mixed 201/500 (partial) or all-201 (full success) ship outcome.
func collectDiagnosticsHarness(t *testing.T, entryCount int, logsStatus func(call int) int) map[string]any {
	t.Helper()

	journal, err := watchdog.NewJournal(t.TempDir(), 10, 3)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	defer journal.Close()
	for i := 0; i < entryCount; i++ {
		journal.Log(watchdog.LevelInfo, "seed.entry", map[string]any{"i": i})
	}

	var logsCalls int
	var resultBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/result"):
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &resultBody); err != nil {
				t.Errorf("decode result body: %v", err)
			}
			w.WriteHeader(http.StatusOK)
		case strings.HasSuffix(r.URL.Path, "/logs"):
			logsCalls++
			w.WriteHeader(logsStatus(logsCalls))
			w.Write([]byte(`{}`)) //nolint:errcheck
		default:
			t.Errorf("unexpected request path %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	fc := watchdog.NewFailoverClient(srv.URL, "agent-1", "tok", nil)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	cfg := &config.Config{AgentID: "agent-1", ServerURL: srv.URL}
	tokens := &tokenHolder{}
	recovery := watchdog.NewRecoveryManager(3, 0)

	cmd := watchdog.FailoverCommand{ID: "cmd-diag", Type: "collect_diagnostics"}
	handleFailoverCommand(context.Background(), fc, cmd, wd, journal, cfg, tokens, recovery)

	if resultBody == nil {
		t.Fatal("no command result was submitted")
	}
	return resultBody
}

// nestedResult extracts the "result" object submitted alongside the status.
func nestedResult(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	res, ok := body["result"].(map[string]any)
	if !ok {
		t.Fatalf("result field missing/not an object: %#v", body["result"])
	}
	return res
}

// TestCollectDiagnosticsPartialShipFailsWithPartialFlag drives collect_diagnostics
// with >200 seeded entries so ShipLogs splits into two batches; the first lands
// (201) and the second fails (500). The submitted result must report
// status=failed, partial=true, and shipped_logs=200 (only the first batch) — the
// headline of finding #7: an operator sees a truthful partial, not a false
// "completed" for diagnostics that only half-reached the API.
func TestCollectDiagnosticsPartialShipFailsWithPartialFlag(t *testing.T) {
	// 250 seeded + the "failover.command" entry handleFailoverCommand itself
	// logs = 251 entries → batches of 200 + 51. First 201, rest 500.
	body := collectDiagnosticsHarness(t, 250, func(call int) int {
		if call == 1 {
			return http.StatusCreated
		}
		return http.StatusInternalServerError
	})

	if got, _ := body["status"].(string); got != "failed" {
		t.Errorf("status = %v, want failed", body["status"])
	}
	res := nestedResult(t, body)
	if got := res["partial"]; got != true {
		t.Errorf("result.partial = %v, want true", got)
	}
	if got := res["shipped_logs"]; got != float64(200) {
		t.Errorf("result.shipped_logs = %v, want 200 (first batch only)", got)
	}
	if _, ok := res["ship_error"]; !ok {
		t.Errorf("result.ship_error missing, want the ship failure detail")
	}
}

// TestCollectDiagnosticsFullShipCompletes drives collect_diagnostics when every
// /logs batch lands (201). The result must report status=completed, carry a
// positive shipped_logs count, and NOT flag a partial.
func TestCollectDiagnosticsFullShipCompletes(t *testing.T) {
	body := collectDiagnosticsHarness(t, 250, func(int) int { return http.StatusCreated })

	if got, _ := body["status"].(string); got != "completed" {
		t.Errorf("status = %v, want completed", body["status"])
	}
	res := nestedResult(t, body)
	shipped, _ := res["shipped_logs"].(float64)
	if shipped <= 0 {
		t.Errorf("result.shipped_logs = %v, want > 0", res["shipped_logs"])
	}
	if got, ok := res["partial"]; ok && got == true {
		t.Errorf("result.partial = true on full success, want absent/false")
	}
}

// TestRecoveryJournalFieldsSeparateStateAndSCMPIDs is the forensic contract:
// the state-file PID is a stale hint the agent wrote about itself, while
// old/new SCM PIDs are what the service manager reported. A journal that
// conflated them would make it impossible to prove after the fact that
// recovery never took destructive action on the hint.
func TestRecoveryJournalFieldsSeparateStateAndSCMPIDs(t *testing.T) {
	result := watchdog.RecoveryResult{
		Intent: watchdog.RecoveryIntentUnhealthy,
		Action: watchdog.RecoveryActionForced, Phase: "verify_running",
		InitialState: "running", FinalState: "running", StateFilePID: 50,
		OldPID: 100, NewPID: 200, ActionTaken: true, Elapsed: 1500 * time.Millisecond,
		Disposition: watchdog.RecoveryDispositionVerifyHeartbeat,
	}
	fields := recoveryJournalFields(result, nil)
	for _, tc := range []struct {
		key  string
		want any
	}{
		{"state_file_pid", 50},
		{"old_scm_pid", 100},
		{"new_scm_pid", 200},
		{"elapsed_ms", int64(1500)},
		{"intent", string(watchdog.RecoveryIntentUnhealthy)},
		{"action", string(watchdog.RecoveryActionForced)},
		{"disposition", string(watchdog.RecoveryDispositionVerifyHeartbeat)},
		{"phase", "verify_running"},
		{"initial_state", "running"},
		{"final_state", "running"},
		{"action_taken", true},
	} {
		if got := fields[tc.key]; got != tc.want {
			t.Errorf("fields[%q] = %#v, want %#v", tc.key, got, tc.want)
		}
	}
	if _, ok := fields["failure_class"]; ok {
		t.Errorf("failure_class present on a successful attempt: %#v", fields["failure_class"])
	}
	if _, ok := fields["error"]; ok {
		t.Errorf("error present on a successful attempt: %#v", fields["error"])
	}
}

// TestRecoveryJournalFieldsCarryFailureClass proves a typed RecoveryError is
// journaled by class, not just as an opaque string — the class is what tells an
// operator whether the failure was a timeout or an identity mismatch.
func TestRecoveryJournalFieldsCarryFailureClass(t *testing.T) {
	result := watchdog.RecoveryResult{Action: watchdog.RecoveryActionForced, Phase: "validate_image"}
	err := &watchdog.RecoveryError{Class: watchdog.RecoveryFailureIdentityMismatch, Phase: "validate_image", PID: 200}
	fields := recoveryJournalFields(result, err)
	if got := fields["failure_class"]; got != string(watchdog.RecoveryFailureIdentityMismatch) {
		t.Errorf("failure_class = %#v, want %q", got, watchdog.RecoveryFailureIdentityMismatch)
	}
	if got, _ := fields["error"].(string); got == "" {
		t.Errorf("error = %#v, want the error text", fields["error"])
	}
}

// TestRecoveryJournalFieldsClassifyUntypedError keeps an unexpected (non
// RecoveryError) failure from silently journaling an empty class.
func TestRecoveryJournalFieldsClassifyUntypedError(t *testing.T) {
	fields := recoveryJournalFields(watchdog.RecoveryResult{}, context.DeadlineExceeded)
	if got := fields["failure_class"]; got != "unclassified" {
		t.Errorf("failure_class = %#v, want \"unclassified\"", got)
	}
}

// TestObservationDoesNotEnterPendingVerification: observing an in-flight SCM
// transition restarted nothing, so there is nothing to verify.
func TestObservationDoesNotEnterPendingVerification(t *testing.T) {
	result := watchdog.RecoveryResult{Action: watchdog.RecoveryActionObserve, ActionTaken: false, Disposition: watchdog.RecoveryDispositionNone}
	if shouldVerifyRecovery(result, nil) {
		t.Fatal("observation-only result entered heartbeat verification")
	}
}

// TestShouldVerifyRecoveryFailsClosed pins the fail-closed rule: only an
// error-free VerifyHeartbeat disposition may be read as "the agent is coming
// back". Every other shape — including the zero value and a disposition the
// binary does not know — must not.
func TestShouldVerifyRecoveryFailsClosed(t *testing.T) {
	verifyResult := watchdog.RecoveryResult{ActionTaken: true, Disposition: watchdog.RecoveryDispositionVerifyHeartbeat}
	for _, tc := range []struct {
		name   string
		result watchdog.RecoveryResult
		err    error
		want   bool
	}{
		{"verify disposition, no error", verifyResult, nil, true},
		{"verify disposition but errored", verifyResult, &watchdog.RecoveryError{Class: watchdog.RecoveryFailureStartTimeout}, false},
		{"zero value result", watchdog.RecoveryResult{}, nil, false},
		{"unknown disposition", watchdog.RecoveryResult{ActionTaken: true, Disposition: "resurrected"}, nil, false},
		{"failover disposition", watchdog.RecoveryResult{Disposition: watchdog.RecoveryDispositionFailover}, nil, false},
	} {
		if got := shouldVerifyRecovery(tc.result, tc.err); got != tc.want {
			t.Errorf("%s: shouldVerifyRecovery = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// TestTerminalRecoveryDispositionEntersFailoverImmediately: an identity/
// ownership failure is terminal — it must go straight to failover rather than
// wait out a heartbeat verification or select another attempt.
func TestTerminalRecoveryDispositionEntersFailoverImmediately(t *testing.T) {
	result := watchdog.RecoveryResult{
		Action:      watchdog.RecoveryActionForced,
		Disposition: watchdog.RecoveryDispositionFailover,
	}
	err := &watchdog.RecoveryError{Class: watchdog.RecoveryFailureIdentityMismatch, Phase: "validate_image"}
	if !shouldFailoverRecovery(result) {
		t.Fatal("terminal disposition did not enter failover")
	}
	if shouldVerifyRecovery(result, err) {
		t.Fatal("terminal disposition entered heartbeat verification")
	}
}

// TestRecoveryCanceledDetectsShutdownNotFailure: a cancelled recovery is the
// watchdog shutting down, not a diagnosis about the agent. Treating it as a
// recovery failure would burn the escalation budget on every service stop.
func TestRecoveryCanceledDetectsShutdownNotFailure(t *testing.T) {
	canceled := &watchdog.RecoveryError{Class: watchdog.RecoveryFailureCanceled, Phase: "wait_stopped"}
	if !recoveryCanceled(canceled) {
		t.Error("canceled RecoveryError not detected as cancellation")
	}
	if recoveryCanceled(&watchdog.RecoveryError{Class: watchdog.RecoveryFailureStopTimeout}) {
		t.Error("stop timeout misread as cancellation")
	}
	if recoveryCanceled(nil) {
		t.Error("nil error misread as cancellation")
	}
	if recoveryCanceled(context.Canceled) {
		t.Error("untyped context.Canceled misread as a recovery cancellation")
	}
}

// TestSCMStopCancelsRunContextBeforeServiceStopDeadline: the SCM stop channel
// must cancel the run context from its own goroutine. Recovery runs
// synchronously inside the main loop, so if cancellation had to wait for the
// loop to come back around, an SCM stop during a transition wait would block
// for the full recovery deadline and the service would hang in STOP_PENDING.
func TestSCMStopCancelsRunContextBeforeServiceStopDeadline(t *testing.T) {
	stopCh := make(chan struct{})
	runCtx, stopRun := watchdogRunContext(context.Background(), nil, stopCh)
	defer stopRun()

	close(stopCh)
	select {
	case <-runCtx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("SCM stop did not cancel the run context")
	}
	if cause := context.Cause(runCtx); cause != errShutdownSCM {
		t.Fatalf("cause = %v, want %v", cause, errShutdownSCM)
	}
	if got := shutdownTrigger(context.Cause(runCtx)); got != "scm" {
		t.Fatalf("trigger = %q, want \"scm\"", got)
	}
}

// TestSignalCancelsRunContext is the unix half of the same contract.
func TestSignalCancelsRunContext(t *testing.T) {
	sigCh := make(chan os.Signal, 1)
	runCtx, stopRun := watchdogRunContext(context.Background(), sigCh, nil)
	defer stopRun()

	sigCh <- syscall.SIGTERM
	select {
	case <-runCtx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("signal did not cancel the run context")
	}
	if cause := context.Cause(runCtx); cause != errShutdownSignal {
		t.Fatalf("cause = %v, want %v", cause, errShutdownSignal)
	}
	if got := shutdownTrigger(context.Cause(runCtx)); got != "signal" {
		t.Fatalf("trigger = %q, want \"signal\"", got)
	}
}

// TestStopRunCancelsForwardersWithoutTriggerLabel proves the normal-exit path
// releases both forwarder goroutines (run under -race with goroutine leak
// visibility) and does not fabricate a shutdown trigger.
func TestStopRunCancelsForwardersWithoutTriggerLabel(t *testing.T) {
	runCtx, stopRun := watchdogRunContext(context.Background(), make(chan os.Signal, 1), make(chan struct{}))
	stopRun()
	select {
	case <-runCtx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("stopRun did not cancel the run context")
	}
	if got := shutdownTrigger(context.Cause(runCtx)); got != "unknown" {
		t.Fatalf("trigger = %q, want \"unknown\"", got)
	}
}
