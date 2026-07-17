package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/websocket"
)

// newTestBackupResultOutbox returns an outbox rooted at a fresh temp dir with
// a deterministic, strictly-increasing clock so enqueue ordering (used by
// the cap-eviction "oldest first" contract) never depends on wall-clock
// resolution.
func newTestBackupResultOutbox(t *testing.T) *backupResultOutbox {
	t.Helper()
	o := newBackupResultOutbox(filepath.Join(t.TempDir(), "outbox"))

	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	tick := 0
	o.nowFn = func() time.Time {
		tick++
		return base.Add(time.Duration(tick) * time.Second)
	}
	return o
}

func testResult(commandID string) websocket.CommandResult {
	return websocket.CommandResult{
		Type:      "command_result",
		CommandID: commandID,
		Status:    "completed",
		Result:    "ok",
	}
}

func TestBackupResultOutbox_EnqueueFlushRoundTrip_SendSucceeds(t *testing.T) {
	o := newTestBackupResultOutbox(t)
	result := testResult("cmd-1")
	o.Enqueue(result)

	entries, err := os.ReadDir(o.dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected 1 persisted entry after Enqueue, got %v (err=%v)", entries, err)
	}

	var delivered []websocket.CommandResult
	o.Flush(func(r websocket.CommandResult) error {
		delivered = append(delivered, r)
		return nil
	})

	if len(delivered) != 1 || delivered[0].CommandID != "cmd-1" {
		t.Fatalf("Flush delivered %v, want [cmd-1]", delivered)
	}

	entries, err = os.ReadDir(o.dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("expected file removed after successful send, got %v (err=%v)", entries, err)
	}
}

func TestBackupResultOutbox_SendFails_EntryRetainedForNextFlush(t *testing.T) {
	o := newTestBackupResultOutbox(t)
	o.Enqueue(testResult("cmd-retry"))

	var attempts int
	o.Flush(func(r websocket.CommandResult) error {
		attempts++
		return errors.New("send channel full")
	})
	if attempts != 1 {
		t.Fatalf("expected 1 send attempt, got %d", attempts)
	}

	entries, err := os.ReadDir(o.dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected entry retained after failed send, got %v (err=%v)", entries, err)
	}

	// A later Flush (e.g. next reconnect), this time succeeding, delivers it.
	var delivered []websocket.CommandResult
	o.Flush(func(r websocket.CommandResult) error {
		delivered = append(delivered, r)
		return nil
	})
	if len(delivered) != 1 || delivered[0].CommandID != "cmd-retry" {
		t.Fatalf("retried Flush delivered %v, want [cmd-retry]", delivered)
	}

	entries, err = os.ReadDir(o.dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("expected entry removed after eventual success, got %v (err=%v)", entries, err)
	}
}

func TestBackupResultOutbox_CapEviction_TwentyFirstEnqueueEvictsOldest(t *testing.T) {
	o := newTestBackupResultOutbox(t)

	for i := 1; i <= 20; i++ {
		o.Enqueue(testResult(fmt.Sprintf("cmd-%02d", i)))
	}
	entries, err := os.ReadDir(o.dir)
	if err != nil || len(entries) != 20 {
		t.Fatalf("expected 20 pending entries at cap, got %d (err=%v)", len(entries), err)
	}

	// 21st enqueue must evict the oldest (cmd-01), not any other entry.
	o.Enqueue(testResult("cmd-21"))

	entries, err = os.ReadDir(o.dir)
	if err != nil || len(entries) != 20 {
		t.Fatalf("expected pending count to stay capped at 20, got %d (err=%v)", len(entries), err)
	}
	if _, err := os.Stat(o.entryPath("cmd-01")); !os.IsNotExist(err) {
		t.Fatalf("expected oldest entry cmd-01 to be evicted, stat err=%v", err)
	}
	if _, err := os.Stat(o.entryPath("cmd-02")); err != nil {
		t.Fatalf("expected second-oldest entry cmd-02 to survive, stat err=%v", err)
	}
	if _, err := os.Stat(o.entryPath("cmd-21")); err != nil {
		t.Fatalf("expected newly enqueued cmd-21 to be present, stat err=%v", err)
	}
}

func TestBackupResultOutbox_ExpiredEntriesSkippedAndRemovedOnFlush(t *testing.T) {
	// Real clock here (not the synthetic one from newTestBackupResultOutbox):
	// the age check compares the persisted EnqueuedAt against wall-clock time,
	// so both sides of the comparison need to agree on what "now" means.
	o := newBackupResultOutbox(filepath.Join(t.TempDir(), "outbox"))
	if err := os.MkdirAll(o.dir, 0700); err != nil {
		t.Fatal(err)
	}

	// Hand-write an entry older than the 48h cap, bypassing Enqueue (which
	// always stamps "now") so the age check is exercised directly.
	expired := backupResultOutboxEntry{
		EnqueuedAt: time.Now().Add(-49 * time.Hour),
		Result:     testResult("cmd-expired"),
	}
	payload, err := json.Marshal(expired)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(o.entryPath("cmd-expired"), payload, 0600); err != nil {
		t.Fatal(err)
	}

	// A fresh, non-expired entry via the normal path.
	o.Enqueue(testResult("cmd-fresh"))

	var delivered []string
	o.Flush(func(r websocket.CommandResult) error {
		delivered = append(delivered, r.CommandID)
		return nil
	})

	if len(delivered) != 1 || delivered[0] != "cmd-fresh" {
		t.Fatalf("Flush delivered %v, want only [cmd-fresh] (expired entry must be skipped, not sent)", delivered)
	}
	if _, err := os.Stat(o.entryPath("cmd-expired")); !os.IsNotExist(err) {
		t.Fatalf("expected expired entry to be removed from disk, stat err=%v", err)
	}
}

func TestBackupResultOutbox_EnqueueRejectsEmptyCommandID(t *testing.T) {
	o := newTestBackupResultOutbox(t)
	o.Enqueue(websocket.CommandResult{Type: "command_result", Status: "completed"})

	if _, err := os.Stat(o.dir); !os.IsNotExist(err) {
		entries, _ := os.ReadDir(o.dir)
		if len(entries) != 0 {
			t.Fatalf("expected no persisted entry for empty commandId, got %v", entries)
		}
	}
}

// TestBackupResultOutbox_RejectsUnsafeCommandID proves the path-traversal
// hardening (FIX 8): a server-supplied CommandID that is not a single,
// non-traversing path element is refused before any file is written, so it can
// never redirect the write outside the outbox directory.
func TestBackupResultOutbox_RejectsUnsafeCommandID(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "outbox")
	o := newBackupResultOutbox(dir)

	unsafe := []string{"../escape", "../../etc/x", "a/b", `a\b`, "..", ".", "", "   "}
	for _, id := range unsafe {
		if safeOutboxFilenameID(id) {
			t.Fatalf("safeOutboxFilenameID(%q) = true, want false", id)
		}
		o.Enqueue(testResult(id))
	}

	// Nothing persisted inside the outbox dir.
	if entries, err := os.ReadDir(dir); err == nil && len(entries) != 0 {
		t.Fatalf("expected no persisted entries for unsafe IDs, got %v", entries)
	}
	// Nothing escaped one level up either — "../escape" would land at
	// root/escape.json if the traversal weren't rejected.
	if _, err := os.Stat(filepath.Join(root, "escape.json")); !os.IsNotExist(err) {
		t.Fatalf("path traversal wrote outside outbox dir: stat err=%v", err)
	}

	// Sanity: a safe ID still persists normally.
	o.Enqueue(testResult("cmd-ok"))
	if _, err := os.Stat(o.entryPath("cmd-ok")); err != nil {
		t.Fatalf("expected safe entry cmd-ok persisted, stat err=%v", err)
	}
}

// TestBackupResultOutbox_FlushDeliversOldestFirst proves multi-entry flush
// ordering: three enqueued entries are delivered oldest-first in a single
// Flush.
func TestBackupResultOutbox_FlushDeliversOldestFirst(t *testing.T) {
	o := newTestBackupResultOutbox(t) // strictly-increasing synthetic clock

	for _, id := range []string{"cmd-a", "cmd-b", "cmd-c"} {
		o.Enqueue(testResult(id))
	}

	var order []string
	o.Flush(func(r websocket.CommandResult) error {
		order = append(order, r.CommandID)
		return nil
	})

	want := []string{"cmd-a", "cmd-b", "cmd-c"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("flush delivery order = %v, want %v", order, want)
	}
	if entries, err := os.ReadDir(o.dir); err != nil || len(entries) != 0 {
		t.Fatalf("expected all entries removed after successful flush, got %v (err=%v)", entries, err)
	}
}

// TestBackupResultOutbox_FlushMixedSuccessFailSuccess proves that within one
// Flush a middle entry whose send fails is retained while the entries around it
// (which succeed) are delivered and removed — and that a later Flush picks up
// the retained one.
func TestBackupResultOutbox_FlushMixedSuccessFailSuccess(t *testing.T) {
	o := newTestBackupResultOutbox(t)

	for _, id := range []string{"cmd-1", "cmd-2", "cmd-3"} {
		o.Enqueue(testResult(id))
	}

	var attempted []string
	o.Flush(func(r websocket.CommandResult) error {
		attempted = append(attempted, r.CommandID)
		if r.CommandID == "cmd-2" {
			return errors.New("transient send failure")
		}
		return nil
	})

	if want := []string{"cmd-1", "cmd-2", "cmd-3"}; !reflect.DeepEqual(attempted, want) {
		t.Fatalf("flush attempted %v, want all three oldest-first %v", attempted, want)
	}
	if _, err := os.Stat(o.entryPath("cmd-1")); !os.IsNotExist(err) {
		t.Fatalf("cmd-1 (succeeded) should be removed, stat err=%v", err)
	}
	if _, err := os.Stat(o.entryPath("cmd-3")); !os.IsNotExist(err) {
		t.Fatalf("cmd-3 (succeeded) should be removed, stat err=%v", err)
	}
	if _, err := os.Stat(o.entryPath("cmd-2")); err != nil {
		t.Fatalf("cmd-2 (failed) should be retained for retry, stat err=%v", err)
	}

	// Next flush (e.g. next reconnect) delivers the retained cmd-2.
	var delivered []string
	o.Flush(func(r websocket.CommandResult) error {
		delivered = append(delivered, r.CommandID)
		return nil
	})
	if len(delivered) != 1 || delivered[0] != "cmd-2" {
		t.Fatalf("second flush delivered %v, want [cmd-2]", delivered)
	}
}
