package pamlifetime

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// PAM ownership epochs W4 (#8206): a server `retired` disposition removes a
// historical-epoch ledger entry, durably, before the caller treats it as gone.

func TestRetireRemovesEntryDurably(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.json")
	store := NewStore(path)
	if _, err := store.PrepareApply(validApply(1)); err != nil {
		t.Fatalf("prepare apply: %v", err)
	}
	if err := store.Retire(testActuationID); err != nil {
		t.Fatalf("retire: %v", err)
	}
	if _, ok := store.Entry(testActuationID); ok {
		t.Fatal("entry still present in memory after Retire")
	}
	reloaded := NewStore(path)
	if err := reloaded.LoadError(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if _, ok := reloaded.Entry(testActuationID); ok {
		t.Fatal("entry still present on disk after Retire")
	}
}

func TestRetireUnknownIsNoop(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.json")
	store := NewStore(path)
	if err := store.Retire(testActuationID); err != nil {
		t.Fatalf("retire unknown: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("retiring an unknown entry must not write the ledger, stat err = %v", err)
	}
}

func TestRetirePersistFailureKeepsEntry(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "ledger")
	path := filepath.Join(dir, "ledger.json")
	store := NewStore(path)
	if _, err := store.PrepareApply(validApply(1)); err != nil {
		t.Fatalf("prepare apply: %v", err)
	}
	// Replace the ledger's parent directory with a regular file so the
	// persist's MkdirAll fails.
	if err := os.Rename(dir, filepath.Join(root, "moved")); err != nil {
		t.Fatalf("move ledger dir: %v", err)
	}
	if err := os.WriteFile(dir, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("plant file: %v", err)
	}
	err := store.Retire(testActuationID)
	if err == nil {
		t.Fatal("expected persist error")
	}
	if !errors.Is(err, ErrLedgerPersist) {
		t.Fatalf("error = %v, want ErrLedgerPersist", err)
	}
	if _, ok := store.Entry(testActuationID); !ok {
		t.Fatal("entry must be restored after a failed persist")
	}
}
