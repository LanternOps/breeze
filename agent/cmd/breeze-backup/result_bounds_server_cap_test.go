package main

import (
	"encoding/json"
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

	fitted, notes, limitName, limitBytes := fitBackupResult(result)

	if notes == "" {
		t.Fatal("a result over the server's `result` cap was passed through undegraded — this is #3001")
	}
	if len(fitted.Stdout) > serverResultBudget {
		t.Fatalf("degraded stdout is %d bytes, still over the server budget %d",
			len(fitted.Stdout), serverResultBudget)
	}
	if limitName != limitServerResult {
		t.Fatalf("degradation attributed to %q, want the server result cap", limitName)
	}
	if limitBytes != wire.MaxCommandResultBytes {
		t.Fatalf("reported limitBytes = %d, want %d", limitBytes, wire.MaxCommandResultBytes)
	}
	if !strings.Contains(notes, "snapshot file index dropped") {
		t.Fatalf("expected the per-file index to be the thing dropped, got notes %q", notes)
	}

	assertTerminalStatusSurvives(t, fitted, result.CommandID)
}

// TestTwelveHundredFileRunIsSentIntact is the other half of the QA
// reproduction: the run that WORKED must keep working. A fix that degrades
// every backup would "pass" the test above while destroying restore browsing
// for the endpoints that never had a problem.
func TestTwelveHundredFileRunIsSentIntact(t *testing.T) {
	result := mustRunResult(t, buildLargeRunJob(qaPassingFileCount, 0))

	fitted, notes, limitName, _ := fitBackupResult(result)

	if notes != "" {
		t.Fatalf("a 1,200-file run was degraded (%q); it fits the server cap and must be sent intact", notes)
	}
	if limitName != "" {
		t.Fatalf("no limit should have been reported for an in-budget result, got %q", limitName)
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

	fitted, notes, _, _ := fitBackupResult(result)

	if notes == "" {
		t.Fatal("a 100k-file result was not degraded at all")
	}
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

	fitted, notes, limitName, limitBytes := fitBackupResult(result)

	if notes == "" {
		t.Fatal("oversize stderr was not truncated")
	}
	if limitName != limitResultText {
		t.Fatalf("attributed the degradation to %q; the free-text cap is what fired", limitName)
	}
	if limitBytes != maxResultTextBytes {
		t.Fatalf("reported limitBytes = %d, want the text cap %d", limitBytes, maxResultTextBytes)
	}
	if limitBytes == ipc.MaxMessageSize {
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
	fullResult, fullNotes, _, _ := fitBackupResult(result)

	if wrappedNotes != fullNotes {
		t.Fatalf("wrapper notes %q != %q", wrappedNotes, fullNotes)
	}
	if wrappedResult.Stdout != fullResult.Stdout || wrappedResult.Stderr != fullResult.Stderr {
		t.Fatal("wrapper returned a different result than fitBackupResult")
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
