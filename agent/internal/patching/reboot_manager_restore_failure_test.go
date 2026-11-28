// Failure paths of the pending-restart record (#12827): a write that fails,
// a file the agent cannot read, and files or directories other accounts
// could have touched.
package patching

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// failLedgerWrites makes every ledger write fail until the test ends.
func failLedgerWrites(t *testing.T) {
	t.Helper()
	orig := writeLedger
	writeLedger = func(string, DeferralLedger) error { return errors.New("disk full") }
	t.Cleanup(func() { writeLedger = orig })
}

func readPending(t *testing.T, path string) *PendingRebootRecord {
	t.Helper()
	l, err := readDeferralLedger(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatalf("read ledger: %v", err)
	}
	return l.Pending
}

func TestACancelWhoseRewriteFailsStillRemovesTheRecord(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	failLedgerWrites(t)
	if err := a.rm.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	stopAgent(a)
	if _, err := os.Stat(g.ledger); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the record survived a failed rewrite (stat err %v): an agent restart would bring the cancelled restart back", err)
	}
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("a cancelled restart came back after a failed rewrite")
	}
}

func TestAPostponementWhoseWriteFailsNeverRestoresTheEarlierTime(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.ScheduleWithOptions(30*time.Minute, g.clock.now().Add(4*time.Hour), "Patch", "patch_job", allowDeferral(3, 60)); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	failLedgerWrites(t)
	if _, err := a.rm.Defer(); err != nil {
		t.Fatalf("Defer must succeed even when the record cannot be written: %v", err)
	}
	stopAgent(a)
	// The record on disk still said +30m. Restoring it would restart the
	// machine an hour before the person was told.
	g.clock.advance(40 * time.Minute)
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatalf("restored the pre-postponement time %v", b.rm.State().ScheduledAt)
	}
}

func TestANewScheduleWhoseWriteFailsNeverRestoresTheOldOne(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(20*time.Minute, g.clock.now().Add(20*time.Minute), "Old", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	failLedgerWrites(t)
	if err := a.rm.Schedule(3*time.Hour, g.clock.now().Add(3*time.Hour), "New", "manual"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	stopAgent(a)
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatalf("restored the superseded schedule %q", b.rm.State().Reason)
	}
}

func TestAHoldDroppedWhileRunningClearsTheRecord(t *testing.T) {
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.ScheduleWithOptions(30*time.Minute, g.clock.now().Add(40*time.Minute), "Firmware", "oem_update",
		RebootOptions{DeadlineAction: DeadlineActionHold}); err != nil {
		t.Fatalf("ScheduleWithOptions: %v", err)
	}
	if readPending(t, g.ledger) == nil {
		t.Fatal("setup: no record written")
	}
	// The machine slept through the window; the next rung drops the restart.
	g.clock.advance(time.Hour)
	a.timers.runAt(0)
	if st := a.rm.State(); st.RebootScheduled || !st.Held {
		t.Fatalf("setup: restart not held (%+v)", st)
	}
	if rec := readPending(t, g.ledger); rec != nil {
		t.Fatalf("a held restart left its record on disk: %+v", rec)
	}
}

func TestAnUnreadableRecordIsLeftAlone(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs unix permission bits and a non-root user")
	}
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	stopAgent(a)
	if err := os.Chmod(g.ledger, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(g.ledger, 0o600) })
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("restored a record it could not read")
	}
	if _, err := os.Lstat(g.ledger); err != nil {
		t.Fatalf("an unreadable record was deleted (lstat err %v); only a corrupt one may be", err)
	}
}

func TestARecordReachedThroughALinkIsRefusedAndNotRewritten(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix links")
	}
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	stopAgent(a)
	target := filepath.Join(t.TempDir(), "elsewhere.json")
	if err := os.Rename(g.ledger, target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, g.ledger); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(target)
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("restored a record reached through a link")
	}
	if after, _ := os.ReadFile(target); !bytes.Equal(before, after) {
		t.Fatal("an untrusted record was rewritten")
	}
	if fi, err := os.Lstat(g.ledger); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the untrusted link was replaced (err %v): refusing must not touch it", err)
	}
}

func TestARecordInADirectoryOthersCanWriteIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits")
	}
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	stopAgent(a)
	dir := filepath.Dir(g.ledger)
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("restored a record from a directory any local user could write")
	}
}

// The data dir is 0700. A group member who could write it could swap or
// delete the record, so group write refuses the restore too.
func TestARecordInAGroupWritableDirectoryIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits")
	}
	g := newRestoreRig(t)
	a := g.manager()
	if err := a.rm.Schedule(30*time.Minute, g.clock.now().Add(30*time.Minute), "Patch", "patch_job"); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	stopAgent(a)
	dir := filepath.Dir(g.ledger)
	if err := os.Chmod(dir, 0o770); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	b := g.manager()
	if b.rm.RestorePendingReboot() {
		t.Fatal("restored a record from a directory a group member could write")
	}
}

// The trust check and the read are one descriptor: a record that becomes a
// link is refused at open, never followed.
func TestTheTrustedReadNeverFollowsALink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix links")
	}
	dir := t.TempDir()
	real := filepath.Join(dir, "real.json")
	if err := os.WriteFile(real, []byte(`{"used":0}`), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, deferralLedgerFile)
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	_, err := readTrustedRecordFile(link)
	if _, untrusted := errors.AsType[*untrustedRecordError](err); !untrusted {
		t.Fatalf("readTrustedRecordFile through a link = %v, want an untrusted-record refusal", err)
	}
	if data, err := readTrustedRecordFile(real); err != nil || string(data) != `{"used":0}` {
		t.Fatalf("the real record = %q, %v", data, err)
	}
}

// The directory check claims nothing can be swapped in: a data directory
// reached through a link is refused too (its target could be anywhere).
func TestTheTrustedReadRefusesADirectoryReachedThroughALink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix links; on Windows the agent start replaces a linked data directory")
	}
	parent := t.TempDir()
	realDir := filepath.Join(parent, "real")
	if err := os.Mkdir(realDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(realDir, deferralLedgerFile), []byte(`{"used":0}`), 0o600); err != nil {
		t.Fatal(err)
	}
	linkDir := filepath.Join(parent, "data")
	if err := os.Symlink(realDir, linkDir); err != nil {
		t.Fatal(err)
	}
	_, err := readTrustedRecordFile(filepath.Join(linkDir, deferralLedgerFile))
	if _, untrusted := errors.AsType[*untrustedRecordError](err); !untrusted {
		t.Fatalf("readTrustedRecordFile through a linked directory = %v, want an untrusted-record refusal", err)
	}
	if data, err := readTrustedRecordFile(filepath.Join(realDir, deferralLedgerFile)); err != nil || string(data) != `{"used":0}` {
		t.Fatalf("the record in the real directory = %q, %v", data, err)
	}
}
