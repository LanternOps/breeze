package pamlifetime

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// PAM ownership epochs W4 (#8206): the server's `retired` disposition reaches
// the ledger only through lifecycleManager.Retire, which must never orphan a
// live elevated process or drop an entry the local reconcile could not verify.

func newRetireManager(t *testing.T, generation uint64) (*lifecycleManager, *Store) {
	t.Helper()
	store := NewStore(filepath.Join(t.TempDir(), "ledger.json"))
	if _, err := store.PrepareApply(validApply(generation)); err != nil {
		t.Fatalf("prepare apply: %v", err)
	}
	order := []string{}
	manager := newLifecycleManager(store, &fakeWindowsPrimitives{order: &order}, &fakeAccountLifecycle{order: &order}, nil)
	return manager, store
}

func TestManagerRetireRemovesHistoricalEntry(t *testing.T) {
	manager, store := newRetireManager(t, 1)
	if err := manager.Retire(context.Background(), testActuationID, 1); err != nil {
		t.Fatalf("retire: %v", err)
	}
	if _, ok := store.Entry(testActuationID); ok {
		t.Fatal("retired entry still in the ledger")
	}
}

func TestManagerRetireUnknownIsNoop(t *testing.T) {
	manager, store := newRetireManager(t, 1)
	if err := manager.Retire(context.Background(), "10000000-0000-4000-8000-0000000000ff", 1); err != nil {
		t.Fatalf("retire unknown: %v", err)
	}
	if _, ok := store.Entry(testActuationID); !ok {
		t.Fatal("retiring an unknown id removed another entry")
	}
}

func TestManagerRetireRefusesUnresolvedEntry(t *testing.T) {
	manager, store := newRetireManager(t, 1)
	manager.markUnresolved(testActuationID, 1)
	if err := manager.Retire(context.Background(), testActuationID, 1); err == nil {
		t.Fatal("expected refusal for an entry the local reconcile left unresolved")
	}
	if _, ok := store.Entry(testActuationID); !ok {
		t.Fatal("refused retirement removed the entry")
	}
}

func TestManagerRetireRefusesLiveJob(t *testing.T) {
	manager, store := newRetireManager(t, 1)
	// Reconcile re-adopted a still-running job (verified_active).
	manager.jobs[testActuationID] = jobOwnership{}
	if err := manager.Retire(context.Background(), testActuationID, 1); err == nil {
		t.Fatal("expected refusal for an entry with a live job")
	}
	if _, ok := store.Entry(testActuationID); !ok {
		t.Fatal("refused retirement removed the entry")
	}
}

func TestManagerRetireRefusesOwnedProcess(t *testing.T) {
	manager, store := newRetireManager(t, 1)
	manager.processes[testActuationID] = suspendedProcessOwnership{}
	if err := manager.Retire(context.Background(), testActuationID, 1); err == nil {
		t.Fatal("expected refusal for an entry with an owned process")
	}
	if _, ok := store.Entry(testActuationID); !ok {
		t.Fatal("refused retirement removed the entry")
	}
}

func TestManagerRetireRefusesGenerationMismatch(t *testing.T) {
	manager, store := newRetireManager(t, 2)
	if err := manager.Retire(context.Background(), testActuationID, 1); err == nil {
		t.Fatal("expected refusal when the ledger holds a different generation")
	}
	if _, ok := store.Entry(testActuationID); !ok {
		t.Fatal("refused retirement removed the entry")
	}
}

func TestManagerRetireTakesOperationGate(t *testing.T) {
	manager, store := newRetireManager(t, 1)
	if err := manager.acquireOperation(context.Background()); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer manager.releaseOperation()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := manager.Retire(ctx, testActuationID, 1); err == nil {
		t.Fatal("expected Retire to wait on the operation gate and fail on context expiry")
	}
	if _, ok := store.Entry(testActuationID); !ok {
		t.Fatal("retirement ran without the operation gate")
	}
}
