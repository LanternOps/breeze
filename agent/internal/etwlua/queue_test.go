package etwlua

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func qPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "q.jsonl")
}

func mkEvent(user, path string, age time.Duration) Event {
	return Event{
		SubjectUsername:      user,
		TargetExecutablePath: path,
		ObservedAt:           time.Now().Add(-age).UTC(),
	}
}

func TestQueueEnqueueAndLen(t *testing.T) {
	q, err := NewQueue(qPath(t))
	if err != nil {
		t.Fatalf("NewQueue: %v", err)
	}

	for i := 0; i < 3; i++ {
		if err := q.Enqueue(mkEvent("alice", "/tmp/a", 0)); err != nil {
			t.Fatalf("Enqueue: %v", err)
		}
	}

	n, err := q.Len()
	if err != nil {
		t.Fatalf("Len: %v", err)
	}
	if n != 3 {
		t.Fatalf("Len = %d, want 3", n)
	}
}

func TestQueueOverflowEvictsOldestByLineCap(t *testing.T) {
	q, err := NewQueue(qPath(t))
	if err != nil {
		t.Fatalf("NewQueue: %v", err)
	}
	q.maxLines = 3
	q.maxBytes = 0 // disable byte cap

	// Insert 5 distinct events; oldest 2 should be evicted.
	for i := 0; i < 5; i++ {
		ev := Event{
			SubjectUsername:      "alice",
			TargetExecutablePath: "/tmp/" + string(rune('a'+i)),
			ObservedAt:           time.Now().UTC(),
		}
		if err := q.Enqueue(ev); err != nil {
			t.Fatalf("Enqueue %d: %v", i, err)
		}
	}

	n, err := q.Len()
	if err != nil {
		t.Fatalf("Len: %v", err)
	}
	if n != 3 {
		t.Fatalf("after overflow Len = %d, want 3", n)
	}

	// Verify FIFO: the remaining events should be the last 3 (paths c, d, e).
	q.mu.Lock()
	events, err := q.readAllLocked()
	q.mu.Unlock()
	if err != nil {
		t.Fatalf("readAllLocked: %v", err)
	}
	gotPaths := make([]string, len(events))
	for i, ev := range events {
		gotPaths[i] = ev.TargetExecutablePath
	}
	want := []string{"/tmp/c", "/tmp/d", "/tmp/e"}
	for i := range want {
		if gotPaths[i] != want[i] {
			t.Fatalf("FIFO violation: events[%d]=%q, want %q (full=%v)", i, gotPaths[i], want[i], gotPaths)
		}
	}
}

func TestQueueOverflowEvictsOldestByByteCap(t *testing.T) {
	q, err := NewQueue(qPath(t))
	if err != nil {
		t.Fatalf("NewQueue: %v", err)
	}
	q.maxLines = 0
	// A typical Event marshals to ~150 bytes. Cap at 300 → keep ~2 events.
	q.maxBytes = 300

	for i := 0; i < 6; i++ {
		ev := Event{
			SubjectUsername:      "alice",
			TargetExecutablePath: "/tmp/" + string(rune('a'+i)),
			ObservedAt:           time.Now().UTC(),
		}
		if err := q.Enqueue(ev); err != nil {
			t.Fatalf("Enqueue %d: %v", i, err)
		}
	}

	n, err := q.Len()
	if err != nil {
		t.Fatalf("Len: %v", err)
	}
	if n < 1 || n > 3 {
		t.Fatalf("byte-capped Len = %d, want 1-3", n)
	}
}

func TestQueueDrainPostsAllAndClears(t *testing.T) {
	q, err := NewQueue(qPath(t))
	if err != nil {
		t.Fatalf("NewQueue: %v", err)
	}
	for i := 0; i < 4; i++ {
		if err := q.Enqueue(mkEvent("alice", "/tmp/foo", 0)); err != nil {
			t.Fatalf("Enqueue: %v", err)
		}
	}

	hb := &fakeHB{}
	posted, err := q.Drain(hb)
	if err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if posted != 4 {
		t.Fatalf("posted = %d, want 4", posted)
	}
	if got := len(hb.Received()); got != 4 {
		t.Fatalf("hb received %d events, want 4", got)
	}

	n, err := q.Len()
	if err != nil {
		t.Fatalf("Len: %v", err)
	}
	if n != 0 {
		t.Fatalf("queue Len after full drain = %d, want 0", n)
	}
}

func TestQueueDrainStopsOnFirstFailure(t *testing.T) {
	q, err := NewQueue(qPath(t))
	if err != nil {
		t.Fatalf("NewQueue: %v", err)
	}
	for i := 0; i < 5; i++ {
		if err := q.Enqueue(mkEvent("alice", "/tmp/foo", 0)); err != nil {
			t.Fatalf("Enqueue: %v", err)
		}
	}

	hb := &fakeHB{}
	hb.failNext.Store(10) // fail every drain post
	hb.failErr = errors.New("api down")

	posted, err := q.Drain(hb)
	if err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if posted != 0 {
		t.Fatalf("posted = %d on always-failing API, want 0", posted)
	}

	n, err := q.Len()
	if err != nil {
		t.Fatalf("Len: %v", err)
	}
	if n != 5 {
		t.Fatalf("queue Len after failed drain = %d, want 5 (all retained)", n)
	}
}

func TestQueueDrainSkipsExpiredEvents(t *testing.T) {
	q, err := NewQueue(qPath(t))
	if err != nil {
		t.Fatalf("NewQueue: %v", err)
	}
	q.maxAge = 1 * time.Hour

	// 2 fresh, 2 expired
	if err := q.Enqueue(mkEvent("alice", "/tmp/fresh1", 0)); err != nil {
		t.Fatal(err)
	}
	if err := q.Enqueue(mkEvent("alice", "/tmp/old1", 2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := q.Enqueue(mkEvent("alice", "/tmp/fresh2", 0)); err != nil {
		t.Fatal(err)
	}
	if err := q.Enqueue(mkEvent("alice", "/tmp/old2", 3*time.Hour)); err != nil {
		t.Fatal(err)
	}

	hb := &fakeHB{}
	posted, err := q.Drain(hb)
	if err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if posted != 4 {
		t.Fatalf("posted (incl. dropped) = %d, want 4", posted)
	}

	rec := hb.Received()
	if len(rec) != 2 {
		t.Fatalf("hb received %d, want 2 (expired should be dropped)", len(rec))
	}
	for _, ev := range rec {
		if ev.TargetExecutablePath == "/tmp/old1" || ev.TargetExecutablePath == "/tmp/old2" {
			t.Fatalf("expired event leaked through drain: %q", ev.TargetExecutablePath)
		}
	}

	n, err := q.Len()
	if err != nil {
		t.Fatalf("Len: %v", err)
	}
	if n != 0 {
		t.Fatalf("queue Len after drain = %d, want 0", n)
	}
}

func TestQueueCorruptionRecoveryTruncatesTrailingJunk(t *testing.T) {
	path := qPath(t)
	q, err := NewQueue(path)
	if err != nil {
		t.Fatalf("NewQueue: %v", err)
	}
	if err := q.Enqueue(mkEvent("alice", "/tmp/a", 0)); err != nil {
		t.Fatal(err)
	}
	if err := q.Enqueue(mkEvent("alice", "/tmp/b", 0)); err != nil {
		t.Fatal(err)
	}

	// Simulate torn trailing line.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatalf("open for tear: %v", err)
	}
	if _, err := f.WriteString(`{"subject_username":"bob","target_executable_path":"/tmp/c","obs`); err != nil {
		t.Fatalf("write tear: %v", err)
	}
	f.Close()

	n, err := q.Len()
	if err != nil {
		t.Fatalf("Len after tear: %v", err)
	}
	if n != 2 {
		t.Fatalf("Len after tear = %d, want 2 (torn line skipped)", n)
	}
}

func TestQueueConcurrentEnqueueAndDrain(t *testing.T) {
	q, err := NewQueue(qPath(t))
	if err != nil {
		t.Fatalf("NewQueue: %v", err)
	}

	hb := &fakeHB{}

	var wg sync.WaitGroup
	wg.Add(2)

	// Writer
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			_ = q.Enqueue(mkEvent("alice", "/tmp/foo", 0))
		}
	}()

	// Drainer
	go func() {
		defer wg.Done()
		for i := 0; i < 10; i++ {
			_, _ = q.Drain(hb)
			time.Sleep(time.Millisecond)
		}
	}()

	wg.Wait()

	// Final drain to make sure nothing's stuck.
	if _, err := q.Drain(hb); err != nil {
		t.Fatalf("final Drain: %v", err)
	}

	n, err := q.Len()
	if err != nil {
		t.Fatalf("Len: %v", err)
	}
	if n != 0 {
		t.Fatalf("queue Len after concurrent run = %d, want 0", n)
	}
	if got := len(hb.Received()); got != 50 {
		t.Fatalf("hb received %d events, want 50 (no losses under contention)", got)
	}
}

func TestQueueEnqueueMissingDir(t *testing.T) {
	// Verifies NewQueue creates the parent dirs.
	dir := filepath.Join(t.TempDir(), "nested", "deeper", "still")
	path := filepath.Join(dir, "q.jsonl")
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("test setup: expected %s to not exist", dir)
	}
	q, err := NewQueue(path)
	if err != nil {
		t.Fatalf("NewQueue should mkdir -p: %v", err)
	}
	if err := q.Enqueue(mkEvent("alice", "/tmp/foo", 0)); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
}
