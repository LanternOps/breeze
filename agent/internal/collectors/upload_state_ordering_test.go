package collectors

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Collector-level contracts behind the "collect → send → commit" ordering fix
// (#3529): local state must survive a caller whose upload was rejected.

func sessionEvent(name string, at int64) UserSessionEvent {
	return UserSessionEvent{
		Type:        "login",
		Username:    name,
		SessionType: "console",
		Timestamp:   time.Unix(at, 0).UTC(),
	}
}

func seedSessionEvents(t *testing.T, count int) []UserSessionEvent {
	t.Helper()

	events := make([]UserSessionEvent, 0, count)
	for i := range count {
		events = append(events, sessionEvent(fmt.Sprintf("user-%d", i), int64(i)))
	}
	return events
}

func TestSessionCollectorDrainEvents(t *testing.T) {
	tests := []struct {
		name          string
		buffered      int
		max           int
		wantDrained   int
		wantRemaining int
		wantFirstUser string
	}{
		{name: "empty buffer drains nothing", buffered: 0, max: 256, wantDrained: 0, wantRemaining: 0},
		{name: "whole buffer fits in one batch", buffered: 3, max: 256, wantDrained: 3, wantRemaining: 0, wantFirstUser: "user-0"},
		{name: "backlog drains oldest first and keeps the remainder", buffered: 10, max: 4, wantDrained: 4, wantRemaining: 6, wantFirstUser: "user-0"},
		{name: "non-positive max falls back to the default batch", buffered: 3, max: 0, wantDrained: 3, wantRemaining: 0, wantFirstUser: "user-0"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			col := NewSessionCollector()
			col.events = seedSessionEvents(t, tc.buffered)

			drained := col.DrainEvents(tc.max)
			if len(drained) != tc.wantDrained {
				t.Fatalf("drained %d events, want %d", len(drained), tc.wantDrained)
			}
			if tc.wantFirstUser != "" && drained[0].Username != tc.wantFirstUser {
				t.Fatalf("first drained event = %q, want %q (oldest first)", drained[0].Username, tc.wantFirstUser)
			}
			if len(col.events) != tc.wantRemaining {
				t.Fatalf("buffer holds %d events after drain, want %d", len(col.events), tc.wantRemaining)
			}
		})
	}
}

func TestSessionCollectorRequeueEvents(t *testing.T) {
	tests := []struct {
		name          string
		requeue       []UserSessionEvent
		alreadyQueued []UserSessionEvent
		wantOrder     []string
		wantLen       int
	}{
		{
			name:      "no events is a no-op",
			requeue:   nil,
			wantOrder: []string{},
		},
		{
			name:      "requeued events return to the front of an empty buffer",
			requeue:   []UserSessionEvent{sessionEvent("alice", 1), sessionEvent("bob", 2)},
			wantOrder: []string{"alice", "bob"},
		},
		{
			name:          "requeued events precede everything observed while the upload was in flight",
			requeue:       []UserSessionEvent{sessionEvent("alice", 1)},
			alreadyQueued: []UserSessionEvent{sessionEvent("carol", 3)},
			wantOrder:     []string{"alice", "carol"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			col := NewSessionCollector()
			col.events = append([]UserSessionEvent(nil), tc.alreadyQueued...)

			col.RequeueEvents(tc.requeue)

			got := make([]string, 0, len(col.events))
			for _, event := range col.events {
				got = append(got, event.Username)
			}
			if len(got) != len(tc.wantOrder) {
				t.Fatalf("buffer = %v, want %v", got, tc.wantOrder)
			}
			for i := range got {
				if got[i] != tc.wantOrder[i] {
					t.Fatalf("buffer = %v, want %v", got, tc.wantOrder)
				}
			}
		})
	}
}

func TestSessionCollectorRequeueEventsBoundsTheBacklog(t *testing.T) {
	col := NewSessionCollector()
	col.events = seedSessionEvents(t, maxBufferedSessionEvents)

	// A failed upload hands back one more batch than the cap can hold.
	col.RequeueEvents([]UserSessionEvent{sessionEvent("oldest", -1)})

	if len(col.events) != maxBufferedSessionEvents {
		t.Fatalf("buffer grew to %d events, want it capped at %d", len(col.events), maxBufferedSessionEvents)
	}
	// The requeued event is the oldest, so it is the one shed.
	if col.events[0].Username != "user-0" {
		t.Fatalf("oldest buffered event = %q, want user-0 (the requeued event should have been shed first)", col.events[0].Username)
	}
}

func TestSessionCollectorRequeueDoesNotAliasCallerSlice(t *testing.T) {
	col := NewSessionCollector()
	drained := []UserSessionEvent{sessionEvent("alice", 1)}

	col.RequeueEvents(drained)
	drained[0].Username = "mutated-by-caller"

	if col.events[0].Username != "alice" {
		t.Fatalf("buffered event = %q, want alice: the collector aliased the caller's slice", col.events[0].Username)
	}
}

func newTestChangeTracker(t *testing.T, snapshots func() (*Snapshot, error)) *ChangeTrackerCollector {
	t.Helper()

	tracker := NewChangeTrackerCollector(filepath.Join(t.TempDir(), "snapshot.json"))
	tracker.gatherSnapshot = snapshots
	return tracker
}

func emptySnapshot() *Snapshot {
	return &Snapshot{
		Timestamp:       time.Unix(0, 0).UTC(),
		Software:        map[string]SoftwareItem{},
		Services:        map[string]ServiceInfo{},
		StartupItems:    map[string]TrackedStartupItem{},
		NetworkAdapters: map[string]NetworkAdapterInfo{},
		ScheduledTasks:  map[string]TrackedScheduledTask{},
		UserAccounts:    map[string]TrackedUserAccount{},
	}
}

func TestChangeTrackerPendingChangesHoldsBaselineUntilCommit(t *testing.T) {
	tests := []struct {
		name          string
		commit        bool
		wantRedetects bool
	}{
		{name: "uncommitted changes are re-detected on the next collection", commit: false, wantRedetects: true},
		{name: "committed changes are not re-detected", commit: true, wantRedetects: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			installed := false
			tracker := newTestChangeTracker(t, func() (*Snapshot, error) {
				snap := emptySnapshot()
				if installed {
					snap.Software["acme::1.0"] = SoftwareItem{Name: "acme", Version: "1.0"}
				}
				return snap, nil
			})

			// Baseline.
			baseline, err := tracker.CollectPendingChanges()
			if err != nil {
				t.Fatalf("baseline collect: %v", err)
			}
			if err := tracker.Commit(baseline); err != nil {
				t.Fatalf("baseline commit: %v", err)
			}

			installed = true
			pending, err := tracker.CollectPendingChanges()
			if err != nil {
				t.Fatalf("collect: %v", err)
			}
			if len(pending.Records) != 1 {
				t.Fatalf("records = %d, want 1", len(pending.Records))
			}
			if tc.commit {
				if err := tracker.Commit(pending); err != nil {
					t.Fatalf("commit: %v", err)
				}
			}

			next, err := tracker.CollectPendingChanges()
			if err != nil {
				t.Fatalf("second collect: %v", err)
			}
			if tc.wantRedetects && len(next.Records) != 1 {
				t.Fatalf("second collect returned %d records, want the change re-detected", len(next.Records))
			}
			if !tc.wantRedetects && len(next.Records) != 0 {
				t.Fatalf("second collect returned %d records, want none after a commit", len(next.Records))
			}
		})
	}
}

func TestChangeTrackerPendingChangesDoesNotPersistUntilCommit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snapshot.json")
	tracker := NewChangeTrackerCollector(path)
	tracker.gatherSnapshot = func() (*Snapshot, error) { return emptySnapshot(), nil }

	pending, err := tracker.CollectPendingChanges()
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("snapshot persisted before commit (stat err = %v)", err)
	}

	if err := tracker.Commit(pending); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("snapshot not persisted after commit: %v", err)
	}
}

func TestChangeTrackerCommitIsNilSafe(t *testing.T) {
	tracker := newTestChangeTracker(t, func() (*Snapshot, error) { return emptySnapshot(), nil })
	if err := tracker.Commit(nil); err != nil {
		t.Fatalf("Commit(nil) = %v, want nil", err)
	}
	if err := tracker.Commit(&PendingChanges{}); err != nil {
		t.Fatalf("Commit(empty) = %v, want nil", err)
	}
}

func TestCollectConfigStateReportsIncompleteCollection(t *testing.T) {
	const sshdPath = "/etc/ssh/sshd_config"
	const loginDefsPath = "/etc/login.defs"

	probes := []ConfigProbe{
		{FilePath: sshdPath, ConfigKey: "PermitRootLogin"},
		{FilePath: loginDefsPath, ConfigKey: "PASS_MAX_DAYS"},
	}

	tests := []struct {
		name        string
		readFile    func(string) ([]byte, error)
		wantEntries int
		wantErr     bool
	}{
		{
			name: "every probe readable is a complete collection",
			readFile: func(path string) ([]byte, error) {
				if path == loginDefsPath {
					return []byte("PASS_MAX_DAYS 90\n"), nil
				}
				return []byte("PermitRootLogin no\n"), nil
			},
			wantEntries: 2,
			wantErr:     false,
		},
		{
			name: "an absent probe target is absence, not failure",
			readFile: func(path string) ([]byte, error) {
				if path == loginDefsPath {
					return nil, os.ErrNotExist
				}
				return []byte("PermitRootLogin no\n"), nil
			},
			wantEntries: 1,
			wantErr:     false,
		},
		{
			name: "an unreadable probe target makes the collection incomplete",
			readFile: func(path string) ([]byte, error) {
				if path == loginDefsPath {
					return nil, os.ErrPermission
				}
				return []byte("PermitRootLogin no\n"), nil
			},
			wantEntries: 1,
			wantErr:     true,
		},
		{
			name:        "every probe unreadable reports both failures",
			readFile:    func(string) ([]byte, error) { return nil, os.ErrPermission },
			wantEntries: 0,
			wantErr:     true,
		},
		{
			name: "a file that lacks the key is absence, not failure",
			readFile: func(string) ([]byte, error) {
				return []byte("# nothing relevant here\n"), nil
			},
			wantEntries: 0,
			wantErr:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			col := NewPolicyStateCollector()
			col.readFile = tc.readFile

			entries, err := col.CollectConfigState(probes)
			if len(entries) != tc.wantEntries {
				t.Fatalf("entries = %d, want %d", len(entries), tc.wantEntries)
			}
			if tc.wantErr && err == nil {
				t.Fatal("err = nil, want an incomplete-collection error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("err = %v, want nil", err)
			}
		})
	}
}
