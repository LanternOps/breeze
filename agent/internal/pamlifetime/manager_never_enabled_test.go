package pamlifetime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/breeze-rmm/agent/internal/elevaccount"
)

// Windows status codes the token scan can fail with. ERROR_NONE_MAPPED is what
// windows.LookupSID returns for an account name that exists nowhere on the
// host, which is the never-provisioned ~breeze_elev of issue #4587.
const (
	errorNoneMappedStatus  = 1332 // ERROR_NONE_MAPPED
	errorAccessDenied      = 5    // ERROR_ACCESS_DENIED
	errorInvalidParameter  = 87   // ERROR_INVALID_PARAMETER
	unresolvableAccountFmt = "lookup account name %s: %w"
)

// unresolvableAccountErr is the shape VerifyNoPrivilegedToken returns when its
// first statement, windows.LookupSID("", "~breeze_elev"), finds no such name.
func unresolvableAccountErr() error {
	return fmt.Errorf(unresolvableAccountFmt, elevaccount.AccountName, syscall.Errno(errorNoneMappedStatus))
}

// newNeverEnabledManager builds the manager exactly as Heartbeat.SetStatePath
// does on an agent that has never enabled PAM: an empty ledger, and an account
// lifecycle that reports the dormant ~breeze_elev account as absent — clean
// evidence and no error, which is what elevaccount returns once it treats
// NERR_UserNotFound / ERROR_NONE_MAPPED as "the account does not exist".
func newNeverEnabledManager(t *testing.T, account *fakeAccountLifecycle, win *fakeWindowsPrimitives) *lifecycleManager {
	t.Helper()
	var order []string
	account.order = &order
	if win == nil {
		win = &fakeWindowsPrimitives{}
	}
	win.order = &order
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	if store.loadErr != nil {
		t.Fatalf("NewStore: %v", store.loadErr)
	}
	if entries := store.Entries(); len(entries) != 0 {
		t.Fatalf("ledger has %d entries, want an empty ledger", len(entries))
	}
	return newLifecycleManager(store, win, account, nil)
}

func managerState(t *testing.T, m *lifecycleManager) (enabled, admissionOpen, available bool, unresolved int) {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.enabled, m.admissionOpen, m.available, len(m.unresolved)
}

// TestSetEnabledFalseOnNeverProvisionedAgentIsAQuietIdempotentNoOp pins the
// amplifier that turned one failed probe into issue #4587's unbounded ERROR
// stream. The manager is constructed enabled:true, and every heartbeat with no
// UAC-interception policy calls SetEnabled(ctx, false); with an empty ledger
// that runs verifyAccountClean. Because m.enabled is only cleared on success,
// the disable has to settle on the FIRST call — returning nil, clearing
// m.enabled and leaving the manager available — or the next heartbeat repeats
// the whole cleanup and logs again, forever.
//
// This test passes with and without the absent-account fix: given clean
// evidence it exercises the idempotence contract, not the tolerance. The
// regression detector for the fix itself is
// TestSetEnabledFalseToleratesUnresolvableAccountNameInTokenScan below.
func TestSetEnabledFalseOnNeverProvisionedAgentIsAQuietIdempotentNoOp(t *testing.T) {
	account := &fakeAccountLifecycle{}
	manager := newNeverEnabledManager(t, account, nil)

	if enabled, _, _, _ := managerState(t, manager); !enabled {
		t.Fatal("manager must start enabled; the never-enabled heartbeat path depends on SetEnabled(false) doing real work on the first call")
	}

	if err := manager.SetEnabled(context.Background(), false); err != nil {
		t.Fatalf("first SetEnabled(false) = %v, want nil (nothing was ever provisioned, so there is nothing to clean up)", err)
	}

	enabled, admissionOpen, available, unresolved := managerState(t, manager)
	if enabled {
		t.Fatal("m.enabled still true after a successful disable; every subsequent heartbeat would re-run account cleanup")
	}
	if admissionOpen {
		t.Fatal("m.admissionOpen still true after a disable")
	}
	if !available {
		t.Fatal("m.available false after a successful disable; PAM would report itself unavailable and refuse to enable later")
	}
	if unresolved != 0 {
		t.Fatalf("unresolved cleanup evidence = %d, want 0", unresolved)
	}
	if account.deprovisionCount != 1 || account.verifiedCount != 1 {
		t.Fatalf("first disable made %d Deprovision / %d VerifyClean calls, want 1 / 1",
			account.deprovisionCount, account.verifiedCount)
	}

	// The second heartbeat must hit the early return, not the account manager.
	if err := manager.SetEnabled(context.Background(), false); err != nil {
		t.Fatalf("second SetEnabled(false) = %v, want nil", err)
	}
	if account.deprovisionCount != 1 || account.verifiedCount != 1 {
		t.Fatalf("two disables made %d Deprovision / %d VerifyClean calls, want 1 / 1 — the disable path is not idempotent and re-runs on every heartbeat",
			account.deprovisionCount, account.verifiedCount)
	}
	if enabled, _, available, unresolved := managerState(t, manager); enabled || !available || unresolved != 0 {
		t.Fatalf("state after second disable: enabled=%v available=%v unresolved=%d, want false/true/0", enabled, available, unresolved)
	}
}

// TestSetEnabledFalseStillFailsClosedOnGenuineAccountCleanupFailure is the
// other half: tolerating a missing account must not tolerate a cleanup that
// actually failed. A real error (access denied, a locked SAM) still has to
// surface as account_cleanup_failed, leave m.enabled set so the next heartbeat
// retries, and mark the evidence unresolved so PAM reports itself unavailable.
func TestSetEnabledFalseStillFailsClosedOnGenuineAccountCleanupFailure(t *testing.T) {
	account := &fakeAccountLifecycle{
		deprovisionErr: errors.New("NetUserSetInfo level 1003 failed: Access is denied."),
	}
	manager := newNeverEnabledManager(t, account, nil)

	err := manager.SetEnabled(context.Background(), false)
	if err == nil {
		t.Fatal("SetEnabled(false) returned nil despite a failing Deprovision")
	}
	if got, want := err.Error(), "PAM disable cleanup unverified: account:account_cleanup_failed"; got != want {
		t.Fatalf("SetEnabled(false) error = %q, want %q", got, want)
	}

	enabled, admissionOpen, available, unresolved := managerState(t, manager)
	if !enabled {
		t.Fatal("a failed disable must stay fail-closed: m.enabled must remain true so the next heartbeat retries the cleanup")
	}
	if admissionOpen {
		t.Fatal("m.admissionOpen must be closed while cleanup is unverified")
	}
	if available {
		t.Fatal("m.available must be false while cleanup evidence is unresolved")
	}
	if unresolved != 1 {
		t.Fatalf("unresolved cleanup evidence = %d, want 1", unresolved)
	}

	// Retrying is the intended behaviour for a genuine failure, unlike the
	// absent-account case above.
	if retryErr := manager.SetEnabled(context.Background(), false); retryErr == nil {
		t.Fatal("retry of a still-failing disable returned nil")
	}
	if account.deprovisionCount != 2 {
		t.Fatalf("Deprovision called %d times across two failing disables, want 2", account.deprovisionCount)
	}
}

// TestSetEnabledFalseReportsVerificationFailureSeparately keeps the two
// account failure codes distinguishable. Deprovision succeeding but the
// follow-up verification reporting the account still enabled is a different
// operator problem from Deprovision itself erroring, and #4587 turned on being
// able to read the code in the log line.
func TestSetEnabledFalseReportsVerificationFailureSeparately(t *testing.T) {
	tests := []struct {
		name    string
		account *fakeAccountLifecycle
	}{
		{"verification errored", &fakeAccountLifecycle{verifiedErr: errors.New("NetUserGetInfo failed: Access is denied.")}},
		{"account still enabled", func() *fakeAccountLifecycle {
			a := &fakeAccountLifecycle{}
			a.verified.Enabled = true
			return a
		}()},
		{"account still in Administrators", func() *fakeAccountLifecycle {
			a := &fakeAccountLifecycle{}
			a.verified.InAdministrators = true
			return a
		}()},
		{"deprovision evidence contradicts a clean verify", func() *fakeAccountLifecycle {
			a := &fakeAccountLifecycle{}
			a.deprovision.InAdministrators = true
			return a
		}()},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			manager := newNeverEnabledManager(t, tt.account, nil)

			err := manager.SetEnabled(context.Background(), false)
			if err == nil {
				t.Fatal("SetEnabled(false) returned nil despite unverified account evidence")
			}
			if got, want := err.Error(), "PAM disable cleanup unverified: account:account_verification_failed"; got != want {
				t.Fatalf("SetEnabled(false) error = %q, want %q", got, want)
			}
			if enabled, _, _, _ := managerState(t, manager); !enabled {
				t.Fatal("an unverified disable must leave m.enabled set so the next heartbeat retries")
			}
		})
	}
}

// TestSetEnabledFalseToleratesUnresolvableAccountNameInTokenScan is the second
// half of issue #4587, and the one that keeps the ERROR loop alive after
// elevaccount stops reporting a missing account as a cleanup failure.
// VerifyNoPrivilegedToken starts by resolving ~breeze_elev to a SID; on a host
// that never provisioned the account there is no such name, so the scan errors
// before it inspects a single process. With an empty ledger that is the
// never-provisioned default, not a leak: no process has ever logged on as an
// account that was never created.
func TestSetEnabledFalseToleratesUnresolvableAccountNameInTokenScan(t *testing.T) {
	tokenErr := unresolvableAccountErr()
	if !elevaccount.IsAccountAbsent(tokenErr) {
		t.Fatalf("fixture %v is not classified as an absent account; the test would not exercise the tolerance", tokenErr)
	}

	account := &fakeAccountLifecycle{}
	manager := newNeverEnabledManager(t, account, &fakeWindowsPrimitives{privilegedTokenErr: tokenErr})

	if err := manager.SetEnabled(context.Background(), false); err != nil {
		t.Fatalf("SetEnabled(false) = %v, want nil when the account name resolves to nothing on a never-actuated agent", err)
	}
	enabled, _, available, unresolved := managerState(t, manager)
	if enabled || !available || unresolved != 0 {
		t.Fatalf("state after disable: enabled=%v available=%v unresolved=%d, want false/true/0", enabled, available, unresolved)
	}
}

// TestSetEnabledFalseStillFailsOnEveryOtherTokenScanFailure keeps the
// tolerance above pinned to the one status that proves absence. A scan that
// failed for any other reason proved nothing about live tokens and must stay a
// failure — as must a scan that actually found a privileged token.
func TestSetEnabledFalseStillFailsOnEveryOtherTokenScanFailure(t *testing.T) {
	tests := []struct {
		name string
		win  *fakeWindowsPrimitives
	}{
		{"access denied", &fakeWindowsPrimitives{
			privilegedTokenErr: fmt.Errorf(unresolvableAccountFmt, elevaccount.AccountName, syscall.Errno(errorAccessDenied)),
		}},
		{"invalid parameter", &fakeWindowsPrimitives{
			privilegedTokenErr: fmt.Errorf("open process 1234 while verifying PAM token absence: %w", syscall.Errno(errorInvalidParameter)),
		}},
		{"non-errno failure", &fakeWindowsPrimitives{
			privilegedTokenErr: errors.New("CreateToolhelp32Snapshot failed"),
		}},
		{"status only in the message text", &fakeWindowsPrimitives{
			privilegedTokenErr: errors.New("lookup account name ~breeze_elev: 1332"),
		}},
		{"privileged token found", &fakeWindowsPrimitives{privilegedToken: true}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			manager := newNeverEnabledManager(t, &fakeAccountLifecycle{}, tt.win)

			err := manager.SetEnabled(context.Background(), false)
			if err == nil {
				t.Fatal("SetEnabled(false) returned nil on an unproven token scan")
			}
			if got, want := err.Error(), "PAM disable cleanup unverified: account:privileged_token_verification_failed"; got != want {
				t.Fatalf("SetEnabled(false) error = %q, want %q", got, want)
			}
			if enabled, _, available, _ := managerState(t, manager); !enabled || available {
				t.Fatalf("state after an unproven disable: enabled=%v available=%v, want true/false", enabled, available)
			}
		})
	}
}

// TestReconcileDoesNotTolerateUnresolvableAccountNameInTokenScan is the safety
// boundary on the tolerance above. Once the ledger carries an actuation, the
// account demonstrably existed at some point, and a Windows process keeps its
// token — and therefore the elevated SID — after the account behind it is
// deleted. An unresolvable name there could be hiding exactly the orphaned
// elevated process this scan exists to catch, so it must keep failing closed.
func TestReconcileDoesNotTolerateUnresolvableAccountNameInTokenScan(t *testing.T) {
	var order []string
	win := &fakeWindowsPrimitives{
		order:              &order,
		bootID:             "windows-boot-after-reboot",
		privilegedTokenErr: unresolvableAccountErr(),
	}
	store := &recordingLifetimeStore{Store: NewStore(filepath.Join(t.TempDir(), "ledger.json")), order: &order}
	durableActiveEntry(t, store.Store, validApply(1), crashedIdentity)
	clean := elevaccount.AccountEvidence{Enabled: false, InAdministrators: false}
	manager := newLifecycleManager(store, win, &fakeAccountLifecycle{order: &order, deprovision: clean, verified: clean}, nil)

	results := manager.Reconcile(context.Background())

	if len(results) != 1 {
		t.Fatalf("Reconcile returned %d results, want 1", len(results))
	}
	if results[0].State != ResultFailed || results[0].FailureCode != "privileged_token_verification_failed" {
		t.Fatalf("reconcile result = %+v, want failed/privileged_token_verification_failed: an actuation is on record, so an unresolvable account name proves nothing", results[0])
	}
	if manager.Available() {
		t.Fatal("manager reports available after an unverified reconcile")
	}
}

// TestSetEnabledFalseFailsClosedWhenTheLedgerCannotBeRead is the regression
// test for the review finding that an unreadable ledger is indistinguishable
// from an empty one. Store.Entries() returns zero entries either way, so the
// disable path would have concluded "this device never actuated", tolerated an
// absent account and skipped the privileged-token scan — on a device whose
// actuation history is simply unknown. That has to fail closed, and the
// account manager must not be touched at all.
func TestSetEnabledFalseFailsClosedWhenTheLedgerCannotBeRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.json")
	if err := os.WriteFile(path, []byte("{ this is not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(path)
	if store.LoadError() == nil {
		t.Fatal("setup: a corrupt ledger must report a load error")
	}
	if entries := store.Entries(); len(entries) != 0 {
		t.Fatalf("setup: corrupt ledger reported %d entries; the test depends on it looking empty", len(entries))
	}

	var order []string
	account := &fakeAccountLifecycle{order: &order}
	win := &fakeWindowsPrimitives{order: &order, privilegedTokenErr: unresolvableAccountErr()}
	manager := newLifecycleManager(store, win, account, nil)

	err := manager.SetEnabled(context.Background(), false)
	if err == nil {
		t.Fatal("SetEnabled(false) returned nil on a device whose actuation history could not be read")
	}
	if got, want := err.Error(), "PAM disable cleanup unverified: account:ledger_unavailable"; got != want {
		t.Fatalf("SetEnabled(false) error = %q, want %q", got, want)
	}
	if account.deprovisionCount != 0 || account.verifiedCount != 0 {
		t.Fatalf("account manager was called (%d Deprovision / %d VerifyClean) despite an unreadable ledger",
			account.deprovisionCount, account.verifiedCount)
	}

	enabled, admissionOpen, available, unresolved := managerState(t, manager)
	if !enabled {
		t.Fatal("m.enabled must remain set so the next heartbeat retries")
	}
	if admissionOpen {
		t.Fatal("m.admissionOpen must be closed while cleanup is unverified")
	}
	if available {
		t.Fatal("m.available must be false while the ledger cannot be read")
	}
	if unresolved != 1 {
		t.Fatalf("unresolved cleanup evidence = %d, want 1", unresolved)
	}
}

// TestToleratedTokenScanLeavesPrivilegedTokenEvidenceUnmeasured pins the
// difference between "measured, and no token was present" and "never
// measured". Reporting boolPtr(false) for a scan that was skipped would put a
// claim on the wire the agent never verified.
func TestToleratedTokenScanLeavesPrivilegedTokenEvidenceUnmeasured(t *testing.T) {
	t.Run("skipped scan reports no privileged-token evidence", func(t *testing.T) {
		manager := newNeverEnabledManager(t, &fakeAccountLifecycle{},
			&fakeWindowsPrimitives{privilegedTokenErr: unresolvableAccountErr()})

		evidence, code, verified := manager.verifyAccountClean(context.Background(), ResultEvidence{BootID: "windows-boot-42"})

		if !verified || code != "" {
			t.Fatalf("verifyAccountClean = (%q, %v), want verified with no failure code", code, verified)
		}
		if evidence.PrivilegedTokenPresent != nil {
			t.Fatalf("PrivilegedTokenPresent = %v, want nil: the scan was skipped, not performed", *evidence.PrivilegedTokenPresent)
		}
		if evidence.AccountEnabled == nil || *evidence.AccountEnabled {
			t.Fatalf("AccountEnabled = %v, want a measured false", evidence.AccountEnabled)
		}
	})

	t.Run("performed scan does report it", func(t *testing.T) {
		manager := newNeverEnabledManager(t, &fakeAccountLifecycle{}, &fakeWindowsPrimitives{})

		evidence, code, verified := manager.verifyAccountClean(context.Background(), ResultEvidence{BootID: "windows-boot-42"})

		if !verified || code != "" {
			t.Fatalf("verifyAccountClean = (%q, %v), want verified with no failure code", code, verified)
		}
		if evidence.PrivilegedTokenPresent == nil || *evidence.PrivilegedTokenPresent {
			t.Fatalf("PrivilegedTokenPresent = %v, want a measured false", evidence.PrivilegedTokenPresent)
		}
	})
}
