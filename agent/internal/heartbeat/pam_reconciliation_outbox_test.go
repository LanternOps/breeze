package heartbeat

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/pamlifetime"
)

const (
	testPamCommandID     = "10000000-0000-4000-8000-000000000001"
	testPamNewCommandID  = "10000000-0000-4000-8000-000000000002"
	testPamObservationID = "20000000-0000-4000-8000-000000000001"
)

func testPamObservation(observationID string) pamlifetime.Result {
	return pamlifetime.Result{
		ProtocolVersion: 2,
		ObservationID:   observationID,
		ActuationID:     "30000000-0000-4000-8000-000000000001",
		Generation:      3,
		State:           pamlifetime.ResultFailed,
		ObservedAt:      time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC),
		FailureCode:     "restart_interrupted",
		Evidence:        pamlifetime.ResultEvidence{BootID: "windows-boot-42"},
	}
}

func TestPamReconciliationOutboxEnqueueCoalescesAndPersists(t *testing.T) {
	root := filepath.Join(t.TempDir(), "outbox")
	o := newPamReconciliationOutbox(root)
	o.nowFn = func() time.Time { return time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC) }
	observation := testPamObservation(testPamObservationID)

	if err := o.Enqueue(testPamCommandID, observation); err != nil {
		t.Fatal(err)
	}
	if err := o.Enqueue(testPamCommandID, observation); err != nil {
		t.Fatal(err)
	}
	other := testPamObservation("20000000-0000-4000-8000-000000000002")
	other.Evidence.BootID = "windows-boot-43"
	if err := o.Enqueue(testPamCommandID, other); err != nil {
		t.Fatal(err)
	}

	snapshot, err := newPamReconciliationOutbox(root).Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Pending) != 2 || len(snapshot.Quarantined) != 0 {
		t.Fatalf("snapshot = %+v, want two pending entries", snapshot)
	}
	if snapshot.Pending[0].State != pamReconciliationStatePending {
		t.Fatalf("state = %q, want pending", snapshot.Pending[0].State)
	}
	for _, entry := range snapshot.Pending {
		info, err := os.Stat(o.entryPath(entry.State, entry.CommandID, entry.Observation.ObservationID))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("mode = %o, want 600", info.Mode().Perm())
		}
	}
}

func TestPamReconciliationOutboxPreChangeJSONSubmitsWithoutMigration(t *testing.T) {
	root := filepath.Join(t.TempDir(), "outbox")
	o := newPamReconciliationOutbox(root)
	if err := os.MkdirAll(o.pendingDir, 0700); err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"commandId":"10000000-0000-4000-8000-000000000001","observation":{"protocolVersion":2,"observationId":"20000000-0000-4000-8000-000000000001","actuationId":"30000000-0000-4000-8000-000000000001","generation":3,"state":"received","observedAt":"2026-08-26T12:00:00Z","evidence":{"bootId":"windows-boot-42"}},"enqueuedAt":"2026-08-26T12:00:01Z","state":"pending"}`)
	if err := os.WriteFile(o.entryPath(pamReconciliationStatePending, testPamCommandID, testPamObservationID), raw, 0600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := o.Snapshot()
	if err != nil || len(snapshot.Pending) != 1 || snapshot.Pending[0].Observation.State != pamlifetime.ResultReceived {
		t.Fatalf("pre-change snapshot=%+v err=%v", snapshot, err)
	}
	var submittedCommand string
	var submittedObservation pamlifetime.Result
	h := &Heartbeat{pamReconciliationOutbox: o}
	h.pamSubmitResultFn = func(_ context.Context, commandID string, observation pamlifetime.Result) (pamResultAcknowledgement, error) {
		submittedCommand = commandID
		submittedObservation = observation
		return pamResultAcknowledgement{ProtocolVersion: 1, Classification: pamResultClassificationApplied}, nil
	}
	h.reconcilePamEvidence(context.Background())
	if submittedCommand != testPamCommandID || submittedObservation != snapshot.Pending[0].Observation {
		t.Fatalf("submitted command=%q observation=%+v", submittedCommand, submittedObservation)
	}
	finalSnapshot, err := o.Snapshot()
	if err != nil || len(finalSnapshot.Pending) != 0 {
		t.Fatalf("acknowledged pre-change entry remains: %+v err=%v", finalSnapshot, err)
	}
}

func TestPamReconciliationOutboxRejectsSameKeyWithDifferentObservation(t *testing.T) {
	root := filepath.Join(t.TempDir(), "outbox")
	o := newPamReconciliationOutbox(root)
	observation := testPamObservation(testPamObservationID)
	if err := o.Enqueue(testPamCommandID, observation); err != nil {
		t.Fatal(err)
	}

	conflicting := observation
	conflicting.FailureCode = "different_failure"
	if err := o.Enqueue(testPamCommandID, conflicting); err == nil {
		t.Fatal("accepted different immutable observation under the same key")
	}

	snapshot, err := newPamReconciliationOutbox(root).Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Pending) != 1 || snapshot.Pending[0].Observation.FailureCode != observation.FailureCode {
		t.Fatalf("conflicting enqueue changed persisted observation: %+v", snapshot)
	}
}

func TestPamReconciliationOutboxPersistsPendingAndQuarantineAcrossReconstruction(t *testing.T) {
	root := filepath.Join(t.TempDir(), "outbox")
	o := newPamReconciliationOutbox(root)
	first := testPamObservation(testPamObservationID)
	second := testPamObservation("20000000-0000-4000-8000-000000000002")
	if err := o.Enqueue(testPamCommandID, first); err != nil {
		t.Fatal(err)
	}
	if err := o.Enqueue(testPamCommandID, second); err != nil {
		t.Fatal(err)
	}
	if err := o.Quarantine(testPamCommandID, second.ObservationID, "same_command_rejected"); err != nil {
		t.Fatal(err)
	}

	snapshot, err := newPamReconciliationOutbox(root).Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Pending) != 1 || len(snapshot.Quarantined) != 1 {
		t.Fatalf("snapshot = %+v, want one pending and one quarantined", snapshot)
	}
	quarantined := snapshot.Quarantined[0]
	if quarantined.State != pamReconciliationStateQuarantined || quarantined.Reason != "same_command_rejected" {
		t.Fatalf("quarantined entry = %+v", quarantined)
	}
	wantQuarantineDir := filepath.Join(root, "pam-reconciliation", "quarantine")
	if o.quarantineDir != wantQuarantineDir {
		t.Fatalf("quarantine directory = %q, want %q", o.quarantineDir, wantQuarantineDir)
	}
	if _, err := os.Stat(o.entryPath(pamReconciliationStateQuarantined, quarantined.CommandID, quarantined.Observation.ObservationID)); err != nil {
		t.Fatalf("quarantined entry not persisted in exact namespace: %v", err)
	}
}

func TestPamReconciliationOutboxRebindIsAtomic(t *testing.T) {
	root := filepath.Join(t.TempDir(), "outbox")
	o := newPamReconciliationOutbox(root)
	observation := testPamObservation(testPamObservationID)
	if err := o.Enqueue(testPamCommandID, observation); err != nil {
		t.Fatal(err)
	}

	originalRename := o.renameFn
	o.renameFn = func(_, _ string) error { return errors.New("forced rename failure") }
	if err := o.Rebind(testPamCommandID, observation.ObservationID, testPamNewCommandID); err == nil {
		t.Fatal("expected rebind failure")
	}
	if _, err := os.Stat(o.entryPath(pamReconciliationStatePending, testPamCommandID, observation.ObservationID)); err != nil {
		t.Fatalf("old entry was lost on failed rebind: %v", err)
	}
	o.renameFn = originalRename

	if err := o.Rebind(testPamCommandID, observation.ObservationID, testPamNewCommandID); err != nil {
		t.Fatal(err)
	}
	snapshot, err := o.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Pending) != 1 || snapshot.Pending[0].CommandID != testPamNewCommandID {
		t.Fatalf("snapshot after rebind = %+v", snapshot)
	}
	if _, err := os.Stat(o.entryPath(pamReconciliationStatePending, testPamCommandID, observation.ObservationID)); !os.IsNotExist(err) {
		t.Fatalf("old entry remains after rebind: %v", err)
	}
}

func TestPamReconciliationOutboxRemoveRequiresExactKey(t *testing.T) {
	o := newPamReconciliationOutbox(filepath.Join(t.TempDir(), "outbox"))
	observation := testPamObservation(testPamObservationID)
	if err := o.Enqueue(testPamCommandID, observation); err != nil {
		t.Fatal(err)
	}
	if err := o.Remove(pamReconciliationStatePending, testPamCommandID, "20000000-0000-4000-8000-000000000099"); err == nil {
		t.Fatal("expected exact-key removal failure")
	}
	if _, err := os.Stat(o.entryPath(pamReconciliationStatePending, testPamCommandID, observation.ObservationID)); err != nil {
		t.Fatalf("wrong-key removal deleted entry: %v", err)
	}
	if err := o.Remove(pamReconciliationStatePending, testPamCommandID, observation.ObservationID); err != nil {
		t.Fatal(err)
	}
}

func TestPamReconciliationOutboxReturnsPersistenceFailures(t *testing.T) {
	tests := []struct {
		name string
		fail func(*pamReconciliationOutbox)
	}{
		{
			name: "write",
			fail: func(o *pamReconciliationOutbox) {
				o.writeFn = func(*os.File, []byte) error { return errors.New("forced write failure") }
			},
		},
		{
			name: "sync",
			fail: func(o *pamReconciliationOutbox) {
				o.syncFn = func(*os.File) error { return errors.New("forced sync failure") }
			},
		},
		{
			name: "rename",
			fail: func(o *pamReconciliationOutbox) {
				o.renameFn = func(_, _ string) error { return errors.New("forced rename failure") }
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "outbox")
			o := newPamReconciliationOutbox(root)
			test.fail(o)
			if err := o.Enqueue(testPamCommandID, testPamObservation(testPamObservationID)); err == nil {
				t.Fatal("expected persistence failure")
			}
			snapshot, err := newPamReconciliationOutbox(root).Snapshot()
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(snapshot, pamReconciliationOutboxSnapshot{}) {
				t.Fatalf("failed enqueue left visible entry: %+v", snapshot)
			}
		})
	}
}

func TestPamReconciliationOutboxCorruptOrUnreadableFilesRemainBlocking(t *testing.T) {
	o := newPamReconciliationOutbox(filepath.Join(t.TempDir(), "outbox"))
	if err := os.MkdirAll(o.pendingDir, 0700); err != nil {
		t.Fatal(err)
	}
	corruptPath := o.entryPath(pamReconciliationStatePending, testPamCommandID, testPamObservationID)
	if err := os.WriteFile(corruptPath, []byte("not-json"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := o.Snapshot(); err == nil {
		t.Fatal("expected corrupt file error")
	}
	if _, err := os.Stat(corruptPath); err != nil {
		t.Fatalf("corrupt blocking file was removed: %v", err)
	}

	unreadablePath := o.entryPath(
		pamReconciliationStatePending,
		testPamCommandID,
		"20000000-0000-4000-8000-000000000002",
	)
	if err := os.WriteFile(unreadablePath, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	originalRead := o.readFileFn
	o.readFileFn = func(path string) ([]byte, error) {
		if path == unreadablePath {
			return nil, os.ErrPermission
		}
		return originalRead(path)
	}
	if _, err := o.Snapshot(); err == nil {
		t.Fatal("expected unreadable file error")
	}
	if _, err := os.Stat(unreadablePath); err != nil {
		t.Fatalf("unreadable blocking file was removed: %v", err)
	}
}

func TestPamReconciliationOutboxRejectsNonCanonicalIDs(t *testing.T) {
	o := newPamReconciliationOutbox(filepath.Join(t.TempDir(), "outbox"))
	observation := testPamObservation(testPamObservationID)
	for _, commandID := range []string{
		"not-a-uuid",
		"10000000-0000-4000-8000-000000000001/escape",
		"10000000-0000-4000-8000-000000000001"[:35],
		"A0000000-0000-4000-8000-000000000001",
	} {
		if err := o.Enqueue(commandID, observation); err == nil {
			t.Fatalf("accepted command ID %q", commandID)
		}
	}
	observation.ObservationID = "20000000-0000-4000-8000-000000000001"[:35]
	if err := o.Enqueue(testPamCommandID, observation); err == nil {
		t.Fatal("accepted noncanonical observation ID")
	}
}
