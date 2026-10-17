package pamlifetime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/elevaccount"
)

type recoveryWindows struct {
	*fakeWindowsPrimitives
	jobAbsent      bool
	jobErr         error
	orphan         bool
	orphanErr      error
	probedJob      string
	accountLookups int
	tokenScans     int
	orphanScans    int
}

func (w *recoveryWindows) VerifyElevationAccountAbsent(context.Context) (bool, error) {
	w.accountLookups++
	if elevaccount.IsAccountAbsent(w.privilegedTokenErr) {
		return true, nil
	}
	return false, w.privilegedTokenErr
}

func (w *recoveryWindows) VerifyNoPrivilegedToken(ctx context.Context, name string) (bool, error) {
	w.tokenScans++
	return w.fakeWindowsPrimitives.VerifyNoPrivilegedToken(ctx, name)
}

func (w *recoveryWindows) VerifyJobAbsent(_ context.Context, name string) (bool, error) {
	w.probedJob = name
	return w.jobAbsent, w.jobErr
}
func (w *recoveryWindows) VerifyNoOrphanedAccountToken(context.Context) (bool, error) {
	w.orphanScans++
	return w.orphan, w.orphanErr
}

func TestReconciliationScansExistingAccountTokensOnlyOnce(t *testing.T) {
	for _, tc := range []struct {
		name        string
		lookupErr   error
		wantClean   bool
		wantScans   int
		wantOrphans int
	}{
		{"existing account", nil, true, 1, 0},
		{"absent account", unresolvableAccountErr(), true, 0, 1},
		{"unknown account lookup", errors.New("account lookup access denied"), false, 1, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var order []string
			win := &recoveryWindows{fakeWindowsPrimitives: &fakeWindowsPrimitives{
				order: &order, privilegedTokenErr: tc.lookupErr,
			}, jobAbsent: true}
			store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
			if _, err := store.PrepareApply(validApply(1)); err != nil {
				t.Fatal(err)
			}
			if err := store.BindProcess(testActuationID, 1, crashedIdentity); err != nil {
				t.Fatal(err)
			}
			if _, err := store.PrepareCleanup(validCleanup(2)); err != nil {
				t.Fatal(err)
			}
			win.identityGone = true
			manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order}, nil)
			results := manager.Reconcile(context.Background())
			if manager.Available() != tc.wantClean || len(results) != 1 || verifiedCleanupOutcome(results[0]) != tc.wantClean {
				t.Fatalf("reconcile = %+v, available %v", results, manager.Available())
			}
			if win.tokenScans != tc.wantScans || win.orphanScans != tc.wantOrphans {
				t.Fatalf("token/orphan scans = %d/%d, want %d/%d", win.tokenScans, win.orphanScans, tc.wantScans, tc.wantOrphans)
			}
			if win.accountLookups == 0 {
				t.Fatal("recovery skipped account lookup")
			}
		})
	}
}

func TestReconcileAbsentAccountRecovery(t *testing.T) {
	cases := []struct {
		name      string
		bound     bool
		cleanup   bool
		live      bool
		orphan    bool
		orphanErr error
		jobErr    error
		partial   bool
		clean     bool
	}{
		{name: "promotion failed before identity bound", clean: true},
		{name: "cleanup failed with absent account and dead identity", bound: true, cleanup: true, clean: true},
		{name: "active dead identity", bound: true, clean: true},
		{name: "live process stays closed", bound: true, live: true},
		{name: "orphan token stays closed", bound: true, orphan: true},
		{name: "unknown token identity stays closed", orphanErr: errors.New("SID cannot be resolved")},
		{name: "uninspectable job stays closed", jobErr: errors.New("access denied")},
		{name: "partial durable identity stays closed", partial: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var order []string
			primitive := &fakeWindowsPrimitives{order: &order, privilegedTokenErr: unresolvableAccountErr(), identityGone: !tc.live, reopenErr: jobAbsentErr(), cleanupErr: jobAbsentErr()}
			win := &recoveryWindows{fakeWindowsPrimitives: primitive, jobAbsent: true, jobErr: tc.jobErr, orphan: tc.orphan, orphanErr: tc.orphanErr}
			path := filepath.Join(t.TempDir(), "ledger.json")
			store := NewStore(path)
			if _, err := store.PrepareApply(validApply(1)); err != nil {
				t.Fatal(err)
			}
			if tc.bound {
				if err := store.BindProcess(testActuationID, 1, crashedIdentity); err != nil {
					t.Fatal(err)
				}
			}
			if tc.partial {
				entry := store.entries[testActuationID]
				entry.PID = 42
				store.entries[testActuationID] = entry
			}
			generation := uint64(1)
			if tc.cleanup {
				generation = 2
				if _, err := store.PrepareCleanup(validCleanup(2)); err != nil {
					t.Fatal(err)
				}
			}
			manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order}, nil)
			manager.markUnresolved(testActuationID, generation)
			results := manager.Reconcile(context.Background())
			if manager.AccountProvisioningRequired() != tc.clean {
				t.Fatalf("provisioning required = %v, want %v", manager.AccountProvisioningRequired(), tc.clean)
			}
			if len(results) != 1 {
				t.Fatalf("results = %+v", results)
			}
			if tc.clean {
				expectedState := ResultFailed
				if tc.cleanup {
					expectedState = ResultCleaned
				}
				if results[0].State != expectedState || !manager.Available() {
					t.Fatalf("recovery = %+v, available=%v", results, manager.Available())
				}
				entry, ok := NewStore(path).Entry(testActuationID)
				if !ok || entry.DesiredState != DesiredCleanup || entry.PID != 0 || entry.Generation != generation {
					t.Fatalf("persisted recovery tombstone = %+v", entry)
				}
				if _, err := store.PrepareApply(validApply(1)); err == nil {
					t.Fatal("cleaned actuation allowed replayed apply")
				}
				if _, err := store.PrepareCleanup(validCleanup(generation + 1)); err != nil {
					t.Fatalf("server cleanup after recovery: %v", err)
				}
			} else if manager.Available() || results[0].State != ResultFailed {
				t.Fatalf("unknown identity must stay closed: %+v available=%v", results, manager.Available())
			}
		})
	}
}

func TestReconcileUnreadableLedgerFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.json")
	if err := os.WriteFile(path, []byte("broken ledger"), 0600); err != nil {
		t.Fatal(err)
	}
	var order []string
	manager := newLifecycleManager(NewStore(path), &recoveryWindows{fakeWindowsPrimitives: &fakeWindowsPrimitives{order: &order, privilegedTokenErr: unresolvableAccountErr()}, jobAbsent: true}, &fakeAccountLifecycle{order: &order}, nil)
	manager.Reconcile(context.Background())
	if manager.Available() {
		t.Fatal("unreadable ledger must remain unavailable")
	}
	if err := manager.SetEnabled(context.Background(), true); err == nil {
		t.Fatal("unreadable ledger permitted admission")
	}
}

func TestAbsentAccountRecoveryRequiresDurableTombstone(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	if _, err := store.PrepareApply(validApply(1)); err != nil {
		t.Fatal(err)
	}
	// Replacing a directory with the ledger's file must fail on every platform.
	store.path = t.TempDir()
	win := &recoveryWindows{fakeWindowsPrimitives: &fakeWindowsPrimitives{order: &order, privilegedTokenErr: unresolvableAccountErr()}, jobAbsent: true}
	manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order}, nil)
	results := manager.Reconcile(context.Background())
	if len(results) != 1 || results[0].FailureCode != "persist_cleanup_evidence_failed" || manager.Available() {
		t.Fatalf("unpersisted recovery = %+v, available=%v", results, manager.Available())
	}
	entry, _ := store.Entry(testActuationID)
	if entry.DesiredState != DesiredActive {
		t.Fatal("failed write changed the durable desired state")
	}
}

func TestCleanupRecoversAbsentAccountWithoutRestart(t *testing.T) {
	var order []string
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	if _, err := store.PrepareApply(validApply(1)); err != nil {
		t.Fatal(err)
	}
	win := &recoveryWindows{fakeWindowsPrimitives: &fakeWindowsPrimitives{order: &order, privilegedTokenErr: unresolvableAccountErr()}, jobAbsent: true}
	manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order}, nil)
	manager.markUnresolved(testActuationID, 1)
	result := manager.Cleanup(context.Background(), validCleanup(2))
	if result.State != ResultCleaned || !manager.Available() {
		t.Fatalf("cleanup retry = %+v, available=%v", result, manager.Available())
	}
	if err := manager.SetEnabled(context.Background(), false); err != nil {
		t.Fatalf("disable after recovery: %v", err)
	}
	if err := manager.SetEnabled(context.Background(), true); err != nil {
		t.Fatalf("re-enable after recovery: %v", err)
	}
}

func TestEmptyLedgerReconcileRetriesTransientAccountFailure(t *testing.T) {
	account := &fakeAccountLifecycle{deprovisionErr: errors.New("temporary SAM failure")}
	win := &fakeWindowsPrimitives{privilegedTokenErr: unresolvableAccountErr()}
	manager := newNeverEnabledManager(t, account, win)
	if err := manager.SetEnabled(context.Background(), false); err == nil {
		t.Fatal("setup: failing cleanup must close admission")
	}
	if manager.Available() {
		t.Fatal("setup: failed account proof must be unavailable")
	}
	manager.Reconcile(context.Background())
	if manager.Available() {
		t.Fatal("retry still failing must not restore availability")
	}
	account.deprovisionErr = nil
	if results := manager.Reconcile(context.Background()); len(results) != 0 {
		t.Fatalf("empty history produced actuation results: %+v", results)
	}
	if !manager.Available() {
		t.Fatal("fresh clean account proof did not clear transient account ambiguity")
	}
	if err := manager.SetEnabled(context.Background(), true); err != nil {
		t.Fatalf("enable after verified reset: %v", err)
	}
}

func TestEmptyLedgerReconcileStillRequiresTokenProof(t *testing.T) {
	for _, tc := range []struct {
		name  string
		token bool
		err   error
	}{
		{name: "live token", token: true},
		{name: "uninspectable token", err: errors.New("access denied")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			win := &fakeWindowsPrimitives{privilegedToken: tc.token, privilegedTokenErr: tc.err}
			manager := newNeverEnabledManager(t, &fakeAccountLifecycle{}, win)
			manager.Reconcile(context.Background())
			if manager.Available() {
				t.Fatal("readable empty ledger bypassed unverified token evidence")
			}
			if err := manager.SetEnabled(context.Background(), true); err == nil {
				t.Fatal("unverified token evidence reopened admission")
			}
		})
	}
}

func TestRecoveredActiveMarkerSurvivesCrashAndAccountProvisioning(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.json")
	store := NewStore(path)
	if _, err := store.PrepareApply(validApply(1)); err != nil {
		t.Fatal(err)
	}
	// Crash after persisting local clean evidence, before the first observation
	// reached the server. Server generation 1 still desires active.
	if err := store.MarkReconciledClean(testActuationID, 1); err != nil {
		t.Fatal(err)
	}
	for _, accountAbsent := range []bool{true, false} {
		var order []string
		primitives := &fakeWindowsPrimitives{order: &order}
		if accountAbsent {
			primitives.privilegedTokenErr = unresolvableAccountErr()
		}
		win := &recoveryWindows{fakeWindowsPrimitives: primitives, jobAbsent: true}
		restarted := newLifecycleManager(NewStore(path), win, &fakeAccountLifecycle{order: &order}, nil)
		results := restarted.Reconcile(context.Background())
		if len(results) != 1 || results[0].State != ResultFailed || results[0].FailureCode != "reconciled_account_absent" || !verifiedCleanupOutcome(results[0]) || !restarted.Available() {
			t.Fatalf("restart absent=%v returned %+v available=%v", accountAbsent, results, restarted.Available())
		}
		entry, _ := NewStore(path).Entry(testActuationID)
		if !entry.RecoveredFromActive || entry.DesiredState != DesiredCleanup || entry.Generation != 1 {
			t.Fatalf("recovery provenance lost: %+v", entry)
		}
		if err := restarted.SetEnabled(context.Background(), false); err != nil {
			t.Fatalf("policy disable on recovered grant: %v", err)
		}
		if err := restarted.SetEnabled(context.Background(), true); err != nil {
			t.Fatalf("policy re-enable on recovered grant: %v", err)
		}
	}
	var order []string
	manager := newLifecycleManager(NewStore(path), &recoveryWindows{fakeWindowsPrimitives: &fakeWindowsPrimitives{order: &order, privilegedTokenErr: unresolvableAccountErr()}, jobAbsent: true}, &fakeAccountLifecycle{order: &order}, nil)
	// A genuine server cleanup advances the generation and may finally emit
	// cleaned. The constructor intentionally clears old recovery provenance.
	cleaned := manager.Cleanup(context.Background(), validCleanup(2))
	if cleaned.State != ResultCleaned || !manager.Available() {
		t.Fatalf("next server cleanup = %+v available=%v", cleaned, manager.Available())
	}
	entry, _ := NewStore(path).Entry(testActuationID)
	if entry.RecoveredFromActive || entry.Generation != 2 {
		t.Fatalf("server cleanup retained old active marker: %+v", entry)
	}
}

func TestRecoveredActiveMarkerRequiresFreshNegativeEvidence(t *testing.T) {
	for _, tc := range []struct {
		name    string
		orphan  bool
		token   bool
		unknown bool
	}{
		{name: "orphan token", orphan: true},
		{name: "live elevation account token", token: true},
		{name: "uninspectable identity", unknown: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var order []string
			store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
			if _, err := store.PrepareApply(validApply(1)); err != nil {
				t.Fatal(err)
			}
			if err := store.MarkReconciledClean(testActuationID, 1); err != nil {
				t.Fatal(err)
			}
			win := &recoveryWindows{fakeWindowsPrimitives: &fakeWindowsPrimitives{order: &order, privilegedToken: tc.token}, jobAbsent: true, orphan: tc.orphan}
			if tc.unknown {
				win.orphanErr = errors.New("cannot inspect identity")
			}
			manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order}, nil)
			results := manager.Reconcile(context.Background())
			if len(results) != 1 || verifiedCleanupOutcome(results[0]) || manager.Available() {
				t.Fatalf("unproven marked recovery = %+v available=%v", results, manager.Available())
			}
		})
	}
	// A failure code alone is never equivalent to verified cleanup evidence.
	if verifiedCleanupOutcome(Result{State: ResultFailed, FailureCode: "reconciled_account_absent"}) {
		t.Fatal("failure code without measured negatives restored availability")
	}
}

// writeLedger puts a hand-built entry on disk, as an older agent left it.
func writeLedger(t *testing.T, path string, entry LedgerEntry) {
	t.Helper()
	raw, err := json.Marshal(ledgerFile{Entries: map[string]LedgerEntry{entry.ActuationID: entry}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

// An active entry with no process identity, left by an apply that failed
// before launch on an agent without failBeforeLaunch.
func TestStuckActiveEntryOnRestart(t *testing.T) {
	now := time.Now().UTC()
	stuck := LedgerEntry{
		ActuationID: testActuationID, RequestID: testRequestID, DeviceID: testDeviceID, OrgID: testOrgID,
		Generation: 1, DesiredState: DesiredActive, CreatedAt: now, UpdatedAt: now,
	}
	partial := stuck
	partial.JobName = JobName(testActuationID, 1) // something got partway: stays ambiguous

	tests := []struct {
		name          string
		entry         LedgerEntry
		orphan        bool
		wantAvailable bool
		wantCode      string
	}{
		{"no identity recovers", stuck, false, true, "reconciled_account_absent"},
		{"no identity with orphan token stays closed", stuck, true, false, "privileged_token_verification_failed"},
		{"partial identity stays closed", partial, false, false, "reconcile_identity_unavailable"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "ledger.json")
			writeLedger(t, path, tt.entry)
			var order []string
			manager := newLifecycleManager(NewStore(path),
				&recoveryWindows{fakeWindowsPrimitives: &fakeWindowsPrimitives{order: &order}, jobAbsent: true, orphan: tt.orphan},
				&fakeAccountLifecycle{order: &order}, nil)

			results := manager.Reconcile(context.Background())

			if manager.Available() != tt.wantAvailable {
				t.Fatalf("Available() = %v, want %v; results: %+v", manager.Available(), tt.wantAvailable, results)
			}
			if len(results) != 1 || results[0].FailureCode != tt.wantCode {
				t.Fatalf("results = %+v, want failure code %s", results, tt.wantCode)
			}
			if tt.wantAvailable {
				entry, _ := NewStore(path).Entry(testActuationID)
				if entry.DesiredState != DesiredCleanup || !entry.RecoveredFromActive {
					t.Fatalf("recovered entry not tombstoned: %+v", entry)
				}
			}
		})
	}
}
