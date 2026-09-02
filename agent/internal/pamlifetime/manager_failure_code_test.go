package pamlifetime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// stubbedLedgerStore lets a test choose exactly which error the ledger returns
// from PrepareApply/PrepareCleanup, so the manager's failure-code mapping can be
// exercised without a broken filesystem.
type stubbedLedgerStore struct {
	*Store
	err error
}

func (s *stubbedLedgerStore) PrepareApply(ApplyCommand) (Decision, error) { return "", s.err }

func (s *stubbedLedgerStore) PrepareCleanup(CleanupCommand) (Decision, error) { return "", s.err }

func newStubbedLedgerManager(t *testing.T, err error) *lifecycleManager {
	t.Helper()
	var order []string
	store := &stubbedLedgerStore{Store: NewStore(filepath.Join(t.TempDir(), "ledger.json")), err: err}
	return newLifecycleManager(store, &fakeWindowsPrimitives{order: &order}, &fakeAccountLifecycle{order: &order}, nil)
}

// TestLedgerPersistFailureReportsItsOwnFailureCode keeps a ledger WRITE outage
// distinguishable from a rejected command on the wire. Under issue #4184 every
// pam_apply_v2 and pam_cleanup_v2 failed with "invalid_command" because the
// ledger could not be renamed into the pinned config directory, which pointed
// operators at the command payload instead of at the agent's write path.
func TestLedgerPersistFailureReportsItsOwnFailureCode(t *testing.T) {
	persistErr := fmt.Errorf("%w: replace PAM lifetime ledger: sharing violation", ErrLedgerPersist)

	applyResult := newStubbedLedgerManager(t, persistErr).Apply(context.Background(), validApply(1))
	if applyResult.State != ResultFailed || applyResult.FailureCode != "ledger_persist_failed" {
		t.Fatalf("apply result = %+v, want failed/ledger_persist_failed", applyResult)
	}

	cleanupResult := newStubbedLedgerManager(t, persistErr).Cleanup(context.Background(), validCleanup(2))
	if cleanupResult.State != ResultFailed || cleanupResult.FailureCode != "ledger_persist_failed" {
		t.Fatalf("cleanup result = %+v, want failed/ledger_persist_failed", cleanupResult)
	}
}

// TestLedgerRejectionStillReportsInvalidCommand is the other half: a command the
// ledger legitimately refuses must keep its existing failure code.
func TestLedgerRejectionStillReportsInvalidCommand(t *testing.T) {
	rejection := errors.New("apply generation is stale")

	applyResult := newStubbedLedgerManager(t, rejection).Apply(context.Background(), validApply(1))
	if applyResult.State != ResultFailed || applyResult.FailureCode != "invalid_command" {
		t.Fatalf("apply result = %+v, want failed/invalid_command", applyResult)
	}

	cleanupResult := newStubbedLedgerManager(t, rejection).Cleanup(context.Background(), validCleanup(2))
	if cleanupResult.State != ResultFailed || cleanupResult.FailureCode != "invalid_command" {
		t.Fatalf("cleanup result = %+v, want failed/invalid_command", cleanupResult)
	}
}

// TestStoreWrapsPersistFailuresWithSentinel proves the sentinel is attached by
// the real Store, not just by the stub above. The store loads cleanly and is
// then pointed at a path whose parent is an existing regular file, so only the
// persist step can fail.
func TestStoreWrapsPersistFailuresWithSentinel(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "ledger.json"))
	if store.loadErr != nil {
		t.Fatalf("load: %v", store.loadErr)
	}
	blocker := filepath.Join(dir, "not-a-directory")
	if err := os.WriteFile(blocker, []byte("regular file"), 0o600); err != nil {
		t.Fatal(err)
	}
	store.path = filepath.Join(blocker, "ledger.json")

	_, err := store.PrepareApply(validApply(1))
	if err == nil {
		t.Fatal("expected persist failure")
	}
	if !errors.Is(err, ErrLedgerPersist) {
		t.Fatalf("error %v is not marked as a ledger persist failure", err)
	}
	if _, present := store.Entry(testActuationID); present {
		t.Fatal("failed persist must not leave the entry in memory")
	}
}

// TestUnreadableLedgerReportsItsOwnFailureCode covers the READ half of the same
// hazard as TestLedgerPersistFailureReportsItsOwnFailureCode. Store.loadErr is
// computed once in NewStore and is sticky for the store's lifetime, so a
// corrupt or unreadable ledger fails every subsequent apply and cleanup. That
// is an agent-side storage outage, not a malformed command, and must not be
// reported to the server as invalid_command.
func TestUnreadableLedgerReportsItsOwnFailureCode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.json")
	if err := os.WriteFile(path, []byte("{ this is not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := NewStore(path).PrepareApply(validApply(1))
	if !errors.Is(err, ErrLedgerUnavailable) {
		t.Fatalf("PrepareApply error %v is not marked as a ledger read failure", err)
	}

	var order []string
	newManager := func() *lifecycleManager {
		return newLifecycleManager(NewStore(path), &fakeWindowsPrimitives{order: &order}, &fakeAccountLifecycle{order: &order}, nil)
	}
	applyResult := newManager().Apply(context.Background(), validApply(1))
	if applyResult.State != ResultFailed || applyResult.FailureCode != "ledger_unavailable" {
		t.Fatalf("apply result = %+v, want failed/ledger_unavailable", applyResult)
	}
	cleanupResult := newManager().Cleanup(context.Background(), validCleanup(2))
	if cleanupResult.State != ResultFailed || cleanupResult.FailureCode != "ledger_unavailable" {
		t.Fatalf("cleanup result = %+v, want failed/ledger_unavailable", cleanupResult)
	}
}
