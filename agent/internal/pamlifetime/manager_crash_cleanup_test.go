package pamlifetime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/elevaccount"
)

// These tests pin the #4196 decision: when the agent crashed during an active
// grant, the named Job Object died with it and KILL_ON_JOB_CLOSE reaped the
// target. The restarted agent cannot reopen the job, so cleanup must be proven
// by independent endpoint evidence (durable PID identity positively gone,
// account deprovisioned and verified, no privileged token) instead of by the
// job handle. The genuinely unverifiable case, job gone but the exact process
// still alive, stays fail-closed under its own distinct failure code.

const crashBootID = "windows-boot-42"

// crashedIdentity is the process identity the ledger still carries after the
// agent that launched it died on the same boot.
var crashedIdentity = ProcessIdentity{
	PID: 4242, ProcessCreationTime: time.Unix(1234, 0).UTC(),
	JobName: JobName(testActuationID, 1), BootID: crashBootID,
}

// jobAbsentErr is the shape the Windows primitive returns for
// OpenJobObjectW -> ERROR_FILE_NOT_FOUND on the durable job name.
func jobAbsentErr() error {
	return fmt.Errorf("%w: OpenJobObjectW(%s): The system cannot find the file specified.",
		ErrJobObjectAbsent, JobName(testActuationID, 1))
}

// newCrashRecoveryManager builds what a restarted agent constructs over a
// ledger whose active entry is bound to a same-boot process it no longer owns:
// no in-memory job or process ownership, so cleanup must go through the
// durable job name.
func newCrashRecoveryManager(t *testing.T, win *fakeWindowsPrimitives) (*lifecycleManager, *recordingLifetimeStore) {
	t.Helper()
	store := &recordingLifetimeStore{Store: NewStore(filepath.Join(t.TempDir(), "ledger.json")), order: win.order}
	durableActiveEntry(t, store.Store, validApply(1), crashedIdentity)
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: win.order, deprovision: clean, verified: clean}, nil)
	return manager, store
}

func containsStep(order []string, step string) bool {
	for _, entry := range order {
		if entry == step {
			return true
		}
	}
	return false
}

func TestCleanupAfterAgentCrashAcceptsIndependentEndpointEvidence(t *testing.T) {
	var order []string
	win := &fakeWindowsPrimitives{order: &order, bootID: crashBootID, cleanupErr: jobAbsentErr(), identityGone: true}
	manager, store := newCrashRecoveryManager(t, win)
	// A prior doomed pass has already pinned the device (the observed loop).
	manager.markUnresolved(testActuationID, 2)
	if manager.Available() {
		t.Fatal("setup: manager must start pinned unavailable")
	}

	result := manager.Cleanup(context.Background(), validCleanup(2))

	if result.State != ResultCleaned {
		t.Fatalf("crash-path cleanup = %+v, want cleaned on independent evidence", result)
	}
	wantOrder := []string{
		"persist cleanup tombstone",
		"TerminateJobObject and observe zero members",
		"verify durable process identity gone",
		"rotate password, remove Administrators, disable account",
		"verify account disabled and non-admin",
		"verify privileged-token absence",
		"clear durable process identity",
	}
	if !reflect.DeepEqual(order, wantOrder) {
		t.Fatalf("crash-path cleanup order =\n%q\nwant\n%q", order, wantOrder)
	}
	got := win.identityGoneProcess
	if got.PID != crashedIdentity.PID || !got.ProcessCreationTime.Equal(crashedIdentity.ProcessCreationTime) ||
		got.JobName != crashedIdentity.JobName || got.BootID != crashedIdentity.BootID {
		t.Fatalf("identity check received %+v, want the ledger identity %+v", got, crashedIdentity)
	}
	ev := result.Evidence
	if ev.JobObjectAbsent == nil || !*ev.JobObjectAbsent {
		t.Fatalf("crash-path cleaned evidence must carry jobObjectAbsent=true: %+v", ev)
	}
	if ev.JobMemberCount == nil || *ev.JobMemberCount != 0 {
		t.Fatalf("crash-path cleaned evidence jobMemberCount = %v, want 0", ev.JobMemberCount)
	}
	if ev.AccountEnabled == nil || *ev.AccountEnabled || ev.AccountInAdministrators == nil || *ev.AccountInAdministrators ||
		ev.PrivilegedTokenPresent == nil || *ev.PrivilegedTokenPresent {
		t.Fatalf("crash-path cleaned evidence lacks the independent negative fields: %+v", ev)
	}
	if ev.BootID != crashBootID {
		t.Fatalf("evidence bootId = %q, want current boot %q", ev.BootID, crashBootID)
	}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"jobObjectAbsent":true`) {
		t.Fatalf("wire form omitted jobObjectAbsent: %s", raw)
	}
	entry, _ := store.Entry(testActuationID)
	if entry.DesiredState != DesiredCleanup || entry.Generation != 2 || entry.PID != 0 || entry.ProcessCreationTime != nil || entry.JobName != "" || entry.BootID != "" {
		t.Fatalf("cleaned tombstone retained dead process identity: %+v", entry)
	}
	if _, unresolved := manager.unresolved[testActuationID]; unresolved {
		t.Fatalf("crash-path cleaned left the entry unresolved: %v", manager.unresolved)
	}
	if !manager.Available() {
		t.Fatal("crash-path cleaned did not restore availability")
	}
	if err := manager.SetEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetEnabled(true) after crash-path cleaned: %v", err)
	}
	next := validApply(1)
	next.ActuationID = "40000000-0000-4000-8000-000000000001"
	next.RequestID = "40000000-0000-4000-8000-000000000002"
	if got := manager.Apply(context.Background(), next); got.State != ResultVerifiedActive {
		t.Fatalf("apply after crash-path cleaned = %+v, want admitted and verified", got)
	}
}

func TestCleanupFailsClosedWhenJobAbsentButExactProcessAlive(t *testing.T) {
	var order []string
	win := &fakeWindowsPrimitives{order: &order, bootID: crashBootID, cleanupErr: jobAbsentErr(), identityGone: false}
	manager, store := newCrashRecoveryManager(t, win)

	result := manager.Cleanup(context.Background(), validCleanup(2))

	if result.State != ResultFailed || result.FailureCode != "job_absent_process_alive" {
		t.Fatalf("orphaned elevated process cleanup = %+v, want failed/job_absent_process_alive", result)
	}
	if win.identityGoneCalls != 1 {
		t.Fatalf("identity check calls = %d, want 1", win.identityGoneCalls)
	}
	if containsStep(order, "clear durable process identity") {
		t.Fatalf("orphaned process cleanup cleared the ledger identity: %q", order)
	}
	entry, _ := store.Entry(testActuationID)
	if entry.PID != crashedIdentity.PID || entry.JobName == "" || entry.ProcessCreationTime == nil || entry.BootID != crashBootID {
		t.Fatalf("orphaned process cleanup erased the durable identity: %+v", entry)
	}
	if manager.unresolved[testActuationID] != 2 || manager.Available() || manager.admissionOpen {
		t.Fatalf("orphaned process left manager unresolved/available/admitting = %v/%v/%v, want 2/false/false",
			manager.unresolved, manager.Available(), manager.admissionOpen)
	}
}

func TestCleanupFailsClosedWhenProcessIdentityCannotBeVerified(t *testing.T) {
	var order []string
	win := &fakeWindowsPrimitives{order: &order, bootID: crashBootID, cleanupErr: jobAbsentErr(),
		identityGone: true, identityGoneErr: errors.New("OpenProcess: access is denied")}
	manager, store := newCrashRecoveryManager(t, win)

	result := manager.Cleanup(context.Background(), validCleanup(2))

	if result.State != ResultFailed || result.FailureCode != "job_cleanup_failed" {
		t.Fatalf("unverifiable identity cleanup = %+v, want failed/job_cleanup_failed", result)
	}
	if containsStep(order, "clear durable process identity") {
		t.Fatalf("unverifiable identity cleanup cleared the ledger identity: %q", order)
	}
	entry, _ := store.Entry(testActuationID)
	if entry.PID != crashedIdentity.PID || entry.JobName == "" {
		t.Fatalf("unverifiable identity cleanup erased the durable identity: %+v", entry)
	}
	if manager.unresolved[testActuationID] != 2 || manager.Available() {
		t.Fatalf("unverifiable identity left manager unresolved/available = %v/%v", manager.unresolved, manager.Available())
	}
}

// TestCleanupConsultsProcessIdentityOnlyForUnownedAbsentJob keeps every other
// job failure exactly as it was: the identity primitive is not consulted, and
// the result stays job_cleanup_failed. identityGone is deliberately true in
// each case so that a missing guard would surface as a false cleaned.
func TestCleanupConsultsProcessIdentityOnlyForUnownedAbsentJob(t *testing.T) {
	cases := []struct {
		name           string
		ownsJob        bool
		cleanupErr     error
		cleanupMembers int
	}{
		{name: "owned job reports absent", ownsJob: true, cleanupErr: jobAbsentErr()},
		{name: "non-absent terminate error", cleanupErr: errors.New("OpenJobObjectW: access is denied")},
		{name: "members remain after terminate", cleanupMembers: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var order []string
			win := &fakeWindowsPrimitives{order: &order, bootID: crashBootID, identityGone: true,
				cleanupErr: tc.cleanupErr, cleanupMembers: tc.cleanupMembers}
			var manager *lifecycleManager
			var store *recordingLifetimeStore
			if tc.ownsJob {
				store = &recordingLifetimeStore{Store: NewStore(filepath.Join(t.TempDir(), "ledger.json")), order: &order}
				clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
				manager = newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)
				if got := manager.Apply(context.Background(), validApply(1)); got.State != ResultVerifiedActive {
					t.Fatalf("apply setup = %+v", got)
				}
				if _, owned := manager.jobs[testActuationID]; !owned {
					t.Fatal("setup: manager must own the job")
				}
			} else {
				manager, store = newCrashRecoveryManager(t, win)
			}

			result := manager.Cleanup(context.Background(), validCleanup(2))

			if result.State != ResultFailed || result.FailureCode != "job_cleanup_failed" {
				t.Fatalf("cleanup = %+v, want failed/job_cleanup_failed", result)
			}
			if win.identityGoneCalls != 0 {
				t.Fatalf("identity check consulted %d times, want 0", win.identityGoneCalls)
			}
			if result.Evidence.JobObjectAbsent != nil {
				t.Fatalf("failed result carried jobObjectAbsent: %+v", result.Evidence)
			}
			entry, _ := store.Entry(testActuationID)
			if entry.PID == 0 || entry.JobName == "" {
				t.Fatalf("job failure erased the durable identity: %+v", entry)
			}
		})
	}
}

// TestReconcileFinishesCrashedCleanupTombstoneOnIndependentEvidence is the
// restart shape from the lab: the ledger holds a cleanup tombstone that still
// carries the dead process identity, the job is gone, and Reconcile must end
// with cleaned and an available manager instead of re-running a doomed cleanup
// forever.
func TestReconcileFinishesCrashedCleanupTombstoneOnIndependentEvidence(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	durableActiveEntry(t, store, validApply(1), crashedIdentity)
	if _, err := store.PrepareCleanup(validCleanup(2)); err != nil {
		t.Fatal(err)
	}
	if entry, _ := store.Entry(testActuationID); entry.DesiredState != DesiredCleanup || entry.PID != crashedIdentity.PID {
		t.Fatalf("setup: tombstone must retain the dead identity: %+v", entry)
	}
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	win := &fakeWindowsPrimitives{order: &order, bootID: crashBootID, cleanupErr: jobAbsentErr(), identityGone: true}
	manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)

	results := manager.Reconcile(context.Background())

	if len(results) != 1 || results[0].State != ResultCleaned {
		t.Fatalf("restart reconcile = %+v, want cleaned on independent evidence", results)
	}
	if results[0].Evidence.JobObjectAbsent == nil || !*results[0].Evidence.JobObjectAbsent {
		t.Fatalf("restart reconcile evidence lacks jobObjectAbsent: %+v", results[0].Evidence)
	}
	if !manager.Available() || len(manager.unresolved) != 0 {
		t.Fatalf("restart reconcile left available/unresolved = %v/%v", manager.Available(), manager.unresolved)
	}
	if err := manager.SetEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetEnabled(true) after restart reconcile: %v", err)
	}
}

// TestNormalCleanupOmitsJobObjectAbsent guards the audit distinction: a
// cleanup that went through the job handle must not claim the crash path.
func TestNormalCleanupOmitsJobObjectAbsent(t *testing.T) {
	var order []string
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	win := &fakeWindowsPrimitives{order: &order, identityGone: true}
	manager := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")), win,
		&fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)
	if got := manager.Apply(context.Background(), validApply(1)); got.State != ResultVerifiedActive {
		t.Fatalf("apply setup = %+v", got)
	}

	result := manager.Cleanup(context.Background(), validCleanup(2))

	if result.State != ResultCleaned {
		t.Fatalf("cleanup = %+v", result)
	}
	if result.Evidence.JobObjectAbsent != nil {
		t.Fatalf("normal cleanup claimed the crash path: %+v", result.Evidence)
	}
	if win.identityGoneCalls != 0 {
		t.Fatalf("normal cleanup consulted the identity check %d times", win.identityGoneCalls)
	}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "jobObjectAbsent") {
		t.Fatalf("normal cleaned wire form carries jobObjectAbsent: %s", raw)
	}
}
