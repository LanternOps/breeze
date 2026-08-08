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

// The file counts from the #3001 residual reproduction on v0.104.0: two
// 4,000-file / 200 MB runs whose terminal result never arrived, against a
// 1,200-file run that landed normally. The loss threshold sat between them,
// which under the original 1 MiB cap was 1_048_576 / ~522 B-per-entry ≈ 2,008
// files.
//
// The cap is now 5,000,000, so BOTH of those runs deliver their file index
// intact and the degradation threshold has moved out to ~9,500 files —
// oversizeIndexFileCount is what exercises it. The 4,000-file fixture stays in
// the suite precisely because it used to fail: it is the regression that proves
// the raise reached the endpoints the QA reproduction was about.
const (
	qaResidualFileCount = 4000
	qaPassingFileCount  = 1200

	// oversizeIndexFileCount marshals to roughly 6.0 MB — buildLargeRunJob's
	// entries encode to ~375 B each, shorter than the ~522 B of the field
	// report — putting it over the ~4.93 MB server budget and comfortably under
	// the ~15.9 MiB IPC budget. That band is the one the server cap owns, and
	// every test using this count asserts it, so a cap change fails loudly
	// instead of quietly retargeting these tests at the IPC limit.
	oversizeIndexFileCount = 16000
)

// TestFourThousandFileRunSendsItsIndexIntact is the raise, stated as the
// regression it is meant to be.
//
// This exact fixture is #3001's residual reproduction. Under the 1 MiB cap it
// was refused by the server with no log on either side, and the job was reaped
// as stalled 15 minutes after a backup that had SUCCEEDED; after the first fix
// it was degraded to a terminal status with no file index. It must now arrive
// whole — that is what raising the cap to match `stdout` bought, and a
// regression to either earlier behaviour is invisible without this test.
func TestFourThousandFileRunSendsItsIndexIntact(t *testing.T) {
	result := mustRunResult(t, buildLargeRunJob(qaResidualFileCount, 3))

	if len(result.Stdout) <= 1048576 {
		t.Fatalf("fixture stdout is %d bytes, under the ORIGINAL 1 MiB cap — it no longer represents "+
			"the payload that reproduced #3001 and proves nothing about the raise", len(result.Stdout))
	}

	fitted, notes, limit := fitBackupResult(result)

	if notes != "" {
		t.Fatalf("the 4,000-file QA reproduction was degraded (%q); it fits the raised cap and must "+
			"now deliver its file index intact", notes)
	}
	if limit.fired() {
		t.Fatalf("no limit should have fired for a %d-byte body under the %d byte budget, got %q",
			len(result.Stdout), serverResultBudget, limit.name)
	}
	if fitted.Stdout != result.Stdout {
		t.Fatal("stdout was modified for an in-budget result")
	}
	assertFileIndexEntries(t, fitted.Stdout, qaResidualFileCount)
	assertTerminalStatusSurvives(t, fitted, result.CommandID)
}

// TestOversizeIndexIsDegradedForTheServerCap keeps the degradation path pinned
// now that the QA fixture no longer reaches it.
//
// Without this the raise would have silently deleted coverage of the entire
// reason the tiers exist: every remaining fixture would either fit outright or
// be so large that the IPC frame could be blamed instead.
func TestOversizeIndexIsDegradedForTheServerCap(t *testing.T) {
	result := mustRunResult(t, buildLargeRunJob(oversizeIndexFileCount, 3))

	if len(result.Stdout) > resultPayloadBudget {
		t.Fatalf("fixture stdout is %d bytes, over the IPC budget %d — this test must exercise a "+
			"payload only the SERVER cap rejects", len(result.Stdout), resultPayloadBudget)
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
	// oversize result had overflowed a 16 MiB frame.
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

	assertFileIndexEntries(t, fitted.Stdout, qaPassingFileCount)
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
	result := mustRunResult(t, buildLargeRunJob(oversizeIndexFileCount, 3))

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
// the dominant trigger to the server result cap, the headline repro would have
// told a customer that a 2 MB result exceeded a 16 MiB limit — false on its
// face, and self-contradictory in oversizeFailureResult, which prints the
// actual size right next to the limit it supposedly exceeded.
func TestPersistedWarningNamesTheLimitThatFired(t *testing.T) {
	t.Run("snapshot index dropped for the server cap", func(t *testing.T) {
		result := mustRunResult(t, buildLargeRunJob(oversizeIndexFileCount, 3))
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
		// Sized past the server budget: at ~43 B per element this is ~6.5 MB.
		const arrayElements = 150000
		big := make([]string, 0, arrayElements)
		for i := 0; i < arrayElements; i++ {
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
// 4,960,000 bytes — over the 4,934,464 budget, under the 5,000,000 cap — as
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

// assertFileIndexEntries checks how many snapshot file entries survived — the
// difference between "this snapshot is browsable" and "the index was dropped
// to fit". Zero is a legitimate degraded outcome; the WRONG non-zero count
// would be a silently truncated index, which the server cannot distinguish
// from a complete one.
func assertFileIndexEntries(t *testing.T, stdout string, want int) {
	t.Helper()
	var job map[string]any
	if err := json.Unmarshal([]byte(stdout), &job); err != nil {
		t.Fatalf("unmarshal fitted stdout: %v", err)
	}
	snap, _ := job["snapshot"].(map[string]any)
	files, _ := snap["files"].([]any)
	if len(files) != want {
		t.Fatalf("file index has %d entries, want %d — restore browsing depends on this", len(files), want)
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
