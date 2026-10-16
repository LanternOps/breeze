//go:build windows

package pamlifetime

import (
	"context"
	"path/filepath"
	"testing"
)

func TestWindowsManagerAdvertisesLifetimeProtocolV2(t *testing.T) {
	manager := NewManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")))
	if got := manager.ProtocolVersion(); got != 2 {
		t.Fatalf("ProtocolVersion = %d, want 2", got)
	}
}

// Match a fresh Windows agent without touching its real SAM or process tokens.
// elevaccount's mocked-SAM tests separately pin the native absent-account
// Deprovision/VerifyClean contract that supplies these clean account proofs.
func TestWindowsEmptyLedgerNeverProvisionedAccountIsClean(t *testing.T) {
	account := &fakeAccountLifecycle{}
	manager := newNeverEnabledManager(t, account, &fakeWindowsPrimitives{
		privilegedTokenErr: unresolvableAccountErr(),
	})
	manager.Reconcile(context.Background())
	if !manager.Available() || !manager.AccountProvisioningRequired() {
		t.Fatal("empty ledger with positive account absence did not reconcile cleanly")
	}
	if account.deprovisionCount != 1 || account.verifiedCount != 1 {
		t.Fatalf("cleanup probes = %d Deprovision / %d VerifyClean", account.deprovisionCount, account.verifiedCount)
	}
	if len(manager.store.Entries()) != 0 {
		t.Fatal("never-provisioned reconciliation manufactured an actuation entry")
	}
}
