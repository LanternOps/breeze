package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/wire"
)

// qaResidualFileCount is the file count from the #3001 residual reproduction on
// v0.104.0: two 4,000-file / 200 MB runs whose terminal result never arrived,
// against a 1,200-file run that landed normally. The loss threshold sat between
// them, which is 1_048_576 / ~522 B-per-entry ≈ 2,008 files.
const (
	qaResidualFileCount = 4000
	qaPassingFileCount  = 1200
)

// TestFourThousandFileRunIsDegradedForTheServerCap is the residual #3001
// regression, and the one that would have caught it.
//
// The previous bounding stopped at the 15.9 MiB IPC budget, so a ~2 MB result
// "fitted" and was sent verbatim — then refused by the server's 1 MiB `result`
// cap with no log on either side, and the job was reaped as stalled 15 minutes
// after a backup that had SUCCEEDED. The fixture is deliberately the size that
// passed the old check and failed the real one.
func TestFourThousandFileRunIsDegradedForTheServerCap(t *testing.T) {
	result := mustRunResult(t, buildLargeRunJob(qaResidualFileCount, 3))

	if len(result.Stdout) > resultPayloadBudget {
		t.Fatalf("fixture stdout is %d bytes, over the IPC budget %d — this test must exercise a "+
			"payload the OLD (IPC-only) bounding considered acceptable", len(result.Stdout), resultPayloadBudget)
	}
	if len(result.Stdout) <= wire.MaxCommandResultBytes {
		t.Fatalf("fixture stdout is only %d bytes, under the server cap %d — the test would prove nothing",
			len(result.Stdout), wire.MaxCommandResultBytes)
	}

	fitted, notes, limit := fitBackupResult(result)

	if notes == "" {
		t.Fatal("a result over the server's `result` cap was passed through undegraded — this is #3001")
	}
	if len(fitted.Stdout) > serverResultBudget {
		t.Fatalf("degraded stdout is %d bytes, still over the server budget %d",
			len(fitted.Stdout), serverResultBudget)
	}
	if limit.name != limitServerResult.name {
		t.Fatalf("degradation attributed to %q, want the server result cap", limit.name)
	}
	if limit.budget != serverResultBudget {
		t.Fatalf("reported budget = %d, want the threshold actually crossed (%d)",
			limit.budget, serverResultBudget)
	}
	if limit.cap != wire.MaxCommandResultBytes {
		t.Fatalf("reported cap = %d, want %d", limit.cap, wire.MaxCommandResultBytes)
	}
	if !strings.Contains(notes, "snapshot file index dropped") {
		t.Fatalf("expected the per-file index to be the thing dropped, got notes %q", notes)
	}

	// The warning PERSISTED to backup_jobs.errorLog must name the same limit
	// the log line does. Hardcoding the IPC limit here told the customer their
	// 2 MB result had overflowed a 16 MiB frame.
	assertWarningNamesLimit(t, fitted.Stdout, limit)

	assertTerminalStatusSurvives(t, fitted, result.CommandID)
}

// TestTwelveHundredFileRunIsSentIntact is the other half of the QA
// reproduction: the run that WORKED must keep working. A fix that degrades
// every backup would "pass" the test above while destroying restore browsing
// for the endpoints that never had a problem.
func TestTwelveHundredFileRunIsSentIntact(t *testing.T) {
	result := mustRunResult(t, buildLargeRunJob(qaPassingFileCount, 0))

	fitted, notes, limit := fitBackupResult(result)

	if notes != "" {
		t.Fatalf("a 1,200-file run was degraded (%q); it fits the server cap and must be sent intact", notes)
	}
	if limit.fired() {
		t.Fatalf("no limit should have been reported for an in-budget result, got %q", limit.name)
	}
	if fitted.Stdout != result.Stdout {
		t.Fatal("stdout was modified for an in-budget result")
	}

	var job map[string]any
	if err := json.Unmarshal([]byte(fitted.Stdout), &job); err != nil {
		t.Fatalf("unmarshal fitted stdout: %v", err)
	}
	snap, _ := job["snapshot"].(map[string]any)
	files, _ := snap["files"].([]any)
	if len(files) != qaPassingFileCount {
		t.Fatalf("file index has %d entries, want the full %d — restore browsing must survive here",
			len(files), qaPassingFileCount)
	}
}

// TestHundredThousandFileRunStillReportsCompletion is fix requirement 1 stated
// as a test: "a clean backup of 100k+ files must be able to report completion".
func TestHundredThousandFileRunStillReportsCompletion(t *testing.T) {
	result := mustRunResult(t, buildLargeRunJob(100000, 0))

	fitted, notes, limit := fitBackupResult(result)

	if notes == "" {
		t.Fatal("a 100k-file result was not degraded at all")
	}
	assertWarningNamesLimit(t, fitted.Stdout, limit)
	if len(fitted.Stdout) > serverResultBudget {
		t.Fatalf("degraded stdout is %d bytes, over the server budget %d — the server would refuse it "+
			"and the job would be reaped as stalled", len(fitted.Stdout), serverResultBudget)
	}
	assertTerminalStatusSurvives(t, fitted, result.CommandID)

	// The snapshot IDENTITY is what makes the run a usable restore point even
	// with no browsable index, so it must outlive the degradation.
	var job map[string]any
	if err := json.Unmarshal([]byte(fitted.Stdout), &job); err != nil {
		t.Fatalf("unmarshal fitted stdout: %v", err)
	}
	snap, ok := job["snapshot"].(map[string]any)
	if !ok {
		t.Fatalf("snapshot object did not survive degradation: %v", job)
	}
	if snap["id"] != "snapshot-20260801T125517Z-5edfcd7e" {
		t.Fatalf("snapshot id did not survive degradation: %v", snap["id"])
	}
}

// TestStderrOnlyDegradationNamesTheTextCap is fix requirement 3.
//
// The reported symptom was a log line reading "exceeded the IPC limit …
// sentBytes=10195 limitBytes=16777216": a 10 KB payload described as
// overflowing a 16 MiB frame, because the message and the limit were both
// hardcoded. Here nothing but the 8 KiB free-text cap fires, and that is what
// must be named.
func TestStderrOnlyDegradationNamesTheTextCap(t *testing.T) {
	result := backupipc.BackupCommandResult{
		CommandID: "822e0c7f-7e35-43e6-b0fc-0912a5c0d221",
		Success:   false,
		Stdout:    `{"id":"job-1","status":"failed"}`,
		Stderr:    strings.Repeat("access is denied: C:\\Users\\jdoe\\ntuser.dat; ", 400),
	}
	if len(result.Stderr) <= maxResultTextBytes {
		t.Fatalf("fixture stderr is %d bytes, under the %d text cap — nothing would fire",
			len(result.Stderr), maxResultTextBytes)
	}

	fitted, notes, limit := fitBackupResult(result)

	if notes == "" {
		t.Fatal("oversize stderr was not truncated")
	}
	if limit.name != limitResultText.name {
		t.Fatalf("attributed the degradation to %q; the free-text cap is what fired", limit.name)
	}
	if limit.budget != maxResultTextBytes {
		t.Fatalf("reported budget = %d, want the text cap %d", limit.budget, maxResultTextBytes)
	}
	if limit.cap == ipc.MaxMessageSize {
		t.Fatal("still reporting the IPC frame size for a degradation the IPC frame did not cause")
	}
	if marshalledSize(fitted) > serverResultBudget {
		t.Fatalf("fitted result is %d bytes, over budget", marshalledSize(fitted))
	}
}

// TestDeliveryWrapperMatchesAttributedForm keeps the two-return
// wrapper honest, so the existing suite that calls it keeps testing the code
// the sender actually runs.
func TestDeliveryWrapperMatchesAttributedForm(t *testing.T) {
	result := mustRunResult(t, buildLargeRunJob(qaResidualFileCount, 3))

	wrappedResult, wrappedNotes := fitBackupResultForDelivery(result)
	fullResult, fullNotes, _ := fitBackupResult(result)

	if wrappedNotes != fullNotes {
		t.Fatalf("wrapper notes %q != %q", wrappedNotes, fullNotes)
	}
	if wrappedResult.Stdout != fullResult.Stdout || wrappedResult.Stderr != fullResult.Stderr {
		t.Fatal("wrapper returned a different result than fitBackupResult")
	}
}

// TestPersistedWarningNamesTheLimitThatFired is the operator-facing half of
// requirement 3, and the half that reaches the customer.
//
// The structured log line stays on the endpoint; the `warning` these tiers
// write is persisted to backup_jobs.errorLog and rendered in the UI. All five
// tier warnings used to hardcode ipc.MaxMessageSize, so after this PR shifted
// the dominant trigger to the 1 MiB server cap, the headline repro would have
// told a customer that a 2 MB result exceeded a 16 MiB limit — false on its
// face, and self-contradictory in oversizeFailureResult, which prints the
// actual size right next to the limit it supposedly exceeded.
func TestPersistedWarningNamesTheLimitThatFired(t *testing.T) {
	t.Run("snapshot index dropped for the server cap", func(t *testing.T) {
		result := mustRunResult(t, buildLargeRunJob(qaResidualFileCount, 3))
		fitted, _, limit := fitBackupResult(result)
		warning := warningFromStdout(t, fitted.Stdout)

		if !strings.Contains(warning, "server result budget") {
			t.Fatalf("warning does not name the server result budget: %q", warning)
		}
		if strings.Contains(warning, "agent IPC") {
			t.Fatalf("warning still blames the agent IPC limit for a server-cap degradation: %q", warning)
		}
		if !strings.Contains(warning, fmt.Sprint(limit.budget)) {
			t.Fatalf("warning does not carry the budget %d that was actually crossed: %q", limit.budget, warning)
		}
		if strings.Contains(warning, fmt.Sprint(ipc.MaxMessageSize)) {
			t.Fatalf("warning still contains the IPC frame size %d: %q", ipc.MaxMessageSize, warning)
		}
	})

	t.Run("non-object body degraded to an oversize failure", func(t *testing.T) {
		// backup_list's array body: it cannot be summarised, so tier 2 replaces
		// it with an explicit failure. This is the site where the wrong limit
		// was most visibly self-contradictory.
		big := make([]string, 0, 40000)
		for i := 0; i < 40000; i++ {
			big = append(big, strings.Repeat("s", 40))
		}
		encoded, err := json.Marshal(big)
		if err != nil {
			t.Fatalf("marshal fixture: %v", err)
		}
		result := backupipc.BackupCommandResult{CommandID: "c1", Success: true, Stdout: string(encoded)}

		fitted, notes, limit := fitBackupResult(result)
		if notes == "" {
			t.Fatal("an oversize array body was not degraded")
		}
		if fitted.Success {
			t.Fatal("an unsummarisable oversize body must degrade to an explicit failure, not an empty success")
		}
		if !strings.Contains(fitted.Stderr, limit.describe()) {
			t.Fatalf("failure text does not name the limit that fired (%s): %q", limit.describe(), fitted.Stderr)
		}
		if strings.Contains(fitted.Stderr, fmt.Sprint(ipc.MaxMessageSize)) {
			t.Fatalf("failure text still names the IPC frame size: %q", fitted.Stderr)
		}
	})
}

// TestIPCFrameAttributionForOversizeStderr covers the OTHER delivery limit.
//
// Stdout stays under the server budget while a colossal stderr pushes the raw
// sum past the IPC budget, so the IPC frame is genuinely the binding limit —
// the one case where naming it is correct. Without this, every attribution
// assertion in this file could pass with the server cap hardcoded, which is the
// same mistake in the opposite direction.
func TestIPCFrameAttributionForOversizeStderr(t *testing.T) {
	result := backupipc.BackupCommandResult{
		CommandID: "c1",
		Success:   false,
		Stdout:    `{"id":"job-1","status":"failed"}`,
		Stderr:    strings.Repeat("x", resultPayloadBudget+1),
	}
	if len(result.Stdout) > serverResultBudget {
		t.Fatal("fixture stdout must stay UNDER the server budget so the IPC frame is the binding limit")
	}

	limit := exceededLimit(result)
	if limit.name != limitIPCFrame.name {
		t.Fatalf("attributed to %q, want the IPC frame — stdout is in budget and only the raw sum is over",
			limit.name)
	}
	if limit.budget != resultPayloadBudget {
		t.Fatalf("reported budget = %d, want the IPC budget %d", limit.budget, resultPayloadBudget)
	}
	if limit.cap != ipc.MaxMessageSize {
		t.Fatalf("reported cap = %d, want the IPC frame size %d", limit.cap, ipc.MaxMessageSize)
	}
}

// TestDeliveryLimitReportsTheThresholdActuallyCrossed guards the budget/cap
// split. Reporting the cap as the thing "exceeded" would describe a payload of
// 1,000,000 bytes — over the 983,040 budget, under the 1,048,576 cap — as
// having overflowed a limit it never reached.
func TestDeliveryLimitReportsTheThresholdActuallyCrossed(t *testing.T) {
	between := serverResultBudget + (wire.MaxCommandResultBytes-serverResultBudget)/2
	result := backupipc.BackupCommandResult{
		CommandID: "c1",
		Success:   true,
		Stdout:    `{"pad":"` + strings.Repeat("x", between) + `"}`,
	}

	limit := exceededLimit(result)
	if limit.name != limitServerResult.name {
		t.Fatalf("a body between the budget and the cap must trip the server limit, got %q", limit.name)
	}
	if limit.budget >= limit.cap {
		t.Fatalf("budget (%d) must be strictly below cap (%d) for the server limit", limit.budget, limit.cap)
	}
	if !strings.Contains(limit.describe(), fmt.Sprint(limit.budget)) {
		t.Fatalf("describe() must state the budget that was crossed, got %q", limit.describe())
	}
	if strings.Contains(limit.describe(), fmt.Sprint(limit.cap)) {
		t.Fatalf("describe() must not present the cap as the threshold exceeded, got %q", limit.describe())
	}
}

// warningFromStdout extracts the `warning` field the tiers write into the run
// body — the string the server persists to backup_jobs.errorLog.
func warningFromStdout(t *testing.T, stdout string) string {
	t.Helper()
	var body struct {
		Warning string `json:"warning"`
	}
	if err := json.Unmarshal([]byte(stdout), &body); err != nil {
		t.Fatalf("unmarshal degraded stdout: %v", err)
	}
	if body.Warning == "" {
		t.Fatal("degraded result carries no warning; the operator has no signal at all")
	}
	return body.Warning
}

// assertWarningNamesLimit checks that the persisted warning names the limit the
// structured log names, so the two can never tell an operator different stories.
func assertWarningNamesLimit(t *testing.T, stdout string, limit deliveryLimit) {
	t.Helper()
	warning := warningFromStdout(t, stdout)
	if !strings.Contains(warning, limit.describe()) {
		t.Fatalf("persisted warning does not name the limit that fired (%s): %q", limit.describe(), warning)
	}
}

// assertTerminalStatusSurvives checks the invariant every tier exists to
// protect: whatever else is dropped, the server must still learn that the
// command finished and how.
func assertTerminalStatusSurvives(t *testing.T, fitted backupipc.BackupCommandResult, commandID string) {
	t.Helper()
	if !fitted.Success {
		t.Fatal("Success flag was lost during degradation; a succeeded backup would report as failed")
	}
	if fitted.CommandID != commandID {
		t.Fatalf("CommandID = %q, want %q — the server cannot attribute a result with no command id",
			fitted.CommandID, commandID)
	}
}
