package backup

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestJournal_OneRunAtATimePerJournalFile(t *testing.T) {
	dir := t.TempDir()
	j1, _, err := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := openSnapshotJournal(dir, "identity-a", journalMaxAge); !errors.Is(err, errJournalBusy) {
		t.Fatalf("second open of a journal in use = %v, want errJournalBusy", err)
	}
	// Another destination's journal is independent.
	j3, _, err := openSnapshotJournal(dir, "identity-b", journalMaxAge)
	if err != nil {
		t.Fatalf("other journal: %v", err)
	}
	j3.Abandon()

	// The operating-system lock holds against any other opener too.
	other, err := os.OpenFile(filepath.Join(dir, journalFileName("identity-a")+journalLockSuffix), os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := lockJournalFile(other); err == nil {
		t.Fatal("the journal lock file could be locked twice")
	}
	_ = other.Close()

	j1.Abandon()
	j2, _, err := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	if err != nil {
		t.Fatalf("reopen after release: %v", err)
	}
	if err := j2.Complete(); err != nil {
		t.Fatal(err)
	}
	j4, _, err := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	if err != nil {
		t.Fatalf("reopen after complete: %v", err)
	}
	j4.Abandon()
}

type scopedIssuer struct {
	*fakeIssuer
	scope string
}

func (s *scopedIssuer) JournalScope() string { return s.scope }

func TestJournalIdentity_SeparatesConfigurationsOfOneDestination(t *testing.T) {
	a := &scopedIssuer{fakeIssuer: newFakeIssuer(brokeredIssuedID), scope: "config=a"}
	b := &scopedIssuer{fakeIssuer: newFakeIssuer(brokeredIssuedID), scope: "config=b"}
	paths := []string{"/data"}
	if backupIdentity(a, paths) != backupIdentity(b, paths) {
		t.Fatal("setup: the destination identities should match")
	}
	if journalFileName(journalIdentity(a, paths)) == journalFileName(journalIdentity(b, paths)) {
		t.Fatal("two configurations of one destination share a journal file")
	}
	if journalIdentity(newMockProvider(), paths) != backupIdentity(newMockProvider(), paths) {
		t.Fatal("an unscoped provider's journal identity changed")
	}
}
