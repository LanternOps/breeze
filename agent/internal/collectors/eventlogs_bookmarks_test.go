package collectors

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

type eventLogBookmarkSyncTestFile struct {
	calls    []string
	syncErr  error
	closeErr error
}

func (f *eventLogBookmarkSyncTestFile) Sync() error {
	f.calls = append(f.calls, "sync")
	return f.syncErr
}

func (f *eventLogBookmarkSyncTestFile) Close() error {
	f.calls = append(f.calls, "close")
	return f.closeErr
}

func TestEventLogBookmarksSyncBeforeClose(t *testing.T) {
	syncErr := errors.New("sync failed")
	closeErr := errors.New("close failed")
	for _, tc := range []struct {
		name     string
		syncErr  error
		closeErr error
		wantErr  error
	}{
		{"success", nil, nil, nil},
		{"sync fails but still closes", syncErr, nil, syncErr},
		{"close fails", nil, closeErr, closeErr},
		{"sync error takes precedence", syncErr, closeErr, syncErr},
	} {
		t.Run(tc.name, func(t *testing.T) {
			file := &eventLogBookmarkSyncTestFile{syncErr: tc.syncErr, closeErr: tc.closeErr}
			err := syncAndCloseEventLogBookmarks(file)
			if !errors.Is(err, tc.wantErr) || !reflect.DeepEqual(file.calls, []string{"sync", "close"}) {
				t.Fatalf("calls=%v error=%v; want sync then close and %v", file.calls, err, tc.wantErr)
			}
		})
	}
}

func TestPersistentEventLogCollectorConstructor(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bookmarks.json")
	before := time.Now()
	c := NewPersistentEventLogCollector(path)
	after := time.Now()
	if !c.ackRequired || c.bookmarkPath != path || c.bookmarksLoaded {
		t.Fatalf("persistent collector configuration: ack=%v path=%q loaded=%v", c.ackRequired, c.bookmarkPath, c.bookmarksLoaded)
	}
	seed := c.lastCollectTime.Add(eventLogFirstRunLookback)
	if seed.Before(before) || seed.After(after) {
		t.Fatalf("seed %v does not use the first-run lookback", c.lastCollectTime)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("constructor wrote bookmarks: %v", err)
	}
	memory := NewEventLogCollector()
	if memory.ackRequired || memory.bookmarkPath != "" {
		t.Fatal("in-memory collector requires ack or has a persistence path")
	}
}

func TestLoadEventLogBookmarks(t *testing.T) {
	now := time.Date(2026, 10, 29, 10, 20, 30, 123456789, time.UTC)
	valid := `{"version":1,"streams":{"security":{"recordId":42,"time":"2026-10-29T10:20:30.123456789Z"},"future-stream":"ignored"}}`
	for _, tc := range []struct {
		name string
		data string
		want map[string]eventLogBookmark
	}{
		{"missing", "", nil},
		{"valid and unknown key", valid, map[string]eventLogBookmark{"security": {RecordID: 42, Time: now}}},
		{"invalid JSON", `{`, nil},
		{"wrong version", `{"version":2,"streams":{}}`, nil},
		{"invalid time", `{"version":1,"streams":{"security":{"recordId":42,"time":"bad"}}}`, nil},
		{"oversize", valid + strings.Repeat(" ", eventLogBookmarkFileLimit), nil},
		{"unreadable directory", "", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "bookmarks.json")
			if tc.name == "unreadable directory" {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			} else if tc.data != "" {
				if err := os.WriteFile(path, []byte(tc.data), 0600); err != nil {
					t.Fatal(err)
				}
			}
			c := NewPersistentEventLogCollector(path)
			seed := c.lastCollectTime
			c.mu.Lock()
			c.loadBookmarksLocked()
			c.mu.Unlock()
			if !c.bookmarksLoaded || !reflect.DeepEqual(c.bookmarks, tc.want) || !c.lastCollectTime.Equal(seed) {
				t.Fatalf("loaded=%v bookmarks=%v seed=%v; want %v, seed=%v", c.bookmarksLoaded, c.bookmarks, c.lastCollectTime, tc.want, seed)
			}
			// Loading is lazy and happens once, including after a read failure.
			if tc.name != "unreadable directory" {
				if err := os.WriteFile(path, []byte(valid), 0600); err != nil {
					t.Fatal(err)
				}
				c.mu.Lock()
				c.loadBookmarksLocked()
				c.mu.Unlock()
				if !reflect.DeepEqual(c.bookmarks, tc.want) {
					t.Fatalf("second load changed bookmarks: %v", c.bookmarks)
				}
			}
		})
	}
}

func TestCompleteEventLogPass(t *testing.T) {
	now := time.Date(2026, 10, 29, 10, 20, 30, 123456789, time.UTC)
	old := eventLogBookmark{RecordID: 10, Time: now.Add(-time.Minute)}
	next := eventLogBookmark{RecordID: 20, Time: now}
	for _, tc := range []struct {
		name     string
		outcomes []EventLogPassOutcome
		want     eventLogBookmark
		failures int
		saved    bool
	}{
		{"success", []EventLogPassOutcome{EventLogPassSent}, next, 0, true},
		{"one rejection", []EventLogPassOutcome{EventLogPassRejected}, old, 1, false},
		{"two rejections", []EventLogPassOutcome{EventLogPassRejected, EventLogPassRejected}, old, 2, false},
		{"poison batch", []EventLogPassOutcome{EventLogPassRejected, EventLogPassRejected, EventLogPassRejected}, next, 0, true},
		{"success resets rejections", []EventLogPassOutcome{EventLogPassRejected, EventLogPassSent}, next, 0, true},
		{"repeated failures never skip", []EventLogPassOutcome{EventLogPassFailed, EventLogPassFailed, EventLogPassFailed, EventLogPassFailed, EventLogPassFailed}, old, 0, false},
		{"failure does not spend rejection budget", []EventLogPassOutcome{EventLogPassRejected, EventLogPassFailed, EventLogPassFailed, EventLogPassRejected}, old, 2, false},
		{"three rejections across transient failures skip", []EventLogPassOutcome{EventLogPassRejected, EventLogPassFailed, EventLogPassRejected, EventLogPassFailed, EventLogPassRejected}, next, 0, true},
		{"failure then success", []EventLogPassOutcome{EventLogPassFailed, EventLogPassSent}, next, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "nested", "bookmarks.json")
			c := NewPersistentEventLogCollector(path)
			c.bookmarks = map[string]eventLogBookmark{"security": old, "system-power": old}
			for _, outcome := range tc.outcomes {
				c.pending = map[string]eventLogBookmark{"security": next}
				c.CompletePass(outcome)
				if c.pending != nil {
					t.Fatal("pending not cleared")
				}
			}
			if !reflect.DeepEqual(c.bookmarks["security"], tc.want) || !reflect.DeepEqual(c.bookmarks["system-power"], old) || c.failedSends != tc.failures {
				t.Fatalf("bookmarks=%v failures=%d; want security=%v failures=%d", c.bookmarks, c.failedSends, tc.want, tc.failures)
			}
			if !tc.saved {
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatalf("failed upload persisted bookmarks: %v", err)
				}
				return
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var state eventLogBookmarkState
			if err := json.Unmarshal(data, &state); err != nil {
				t.Fatal(err)
			}
			if state.Version != 1 || !reflect.DeepEqual(state.Streams, c.bookmarks) {
				t.Fatalf("saved state %s does not match bookmarks %v", data, c.bookmarks)
			}
			if runtime.GOOS != "windows" {
				info, err := os.Stat(path)
				if err != nil {
					t.Fatal(err)
				}
				if info.Mode().Perm() != 0600 {
					t.Fatalf("saved file permissions = %v, want 0600", info.Mode().Perm())
				}
			}
			files, err := os.ReadDir(filepath.Dir(path))
			if err != nil || len(files) != 1 {
				t.Fatalf("temporary file leaked: files=%v error=%v", files, err)
			}
		})
	}
}

func TestCompleteEventLogPassWithoutPending(t *testing.T) {
	for _, outcome := range []EventLogPassOutcome{EventLogPassSent, EventLogPassRejected, EventLogPassFailed} {
		c := NewPersistentEventLogCollector(filepath.Join(t.TempDir(), "bookmarks.json"))
		c.failedSends = 2
		c.CompletePass(outcome)
		if c.failedSends != 2 || c.bookmarks != nil {
			t.Fatalf("ack with no pending mutated state: failures=%d bookmarks=%v", c.failedSends, c.bookmarks)
		}
		if _, err := os.Stat(c.bookmarkPath); !os.IsNotExist(err) {
			t.Fatalf("ack with no pending wrote state: %v", err)
		}
	}
}

func TestEventLogBookmarkSaveFailureKeepsMemory(t *testing.T) {
	// A file used as the parent directory forces save to fail on every OS.
	parent := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(parent, []byte("file"), 0600); err != nil {
		t.Fatal(err)
	}
	c := NewPersistentEventLogCollector(filepath.Join(parent, "bookmarks.json"))
	next := eventLogBookmark{RecordID: 42, Time: time.Now().UTC()}
	c.pending = map[string]eventLogBookmark{"security": next}
	c.CompletePass(EventLogPassSent)
	if !reflect.DeepEqual(c.bookmarks["security"], next) || c.pending != nil || c.failedSends != 0 {
		t.Fatalf("save failure lost committed state: bookmarks=%v pending=%v failures=%d", c.bookmarks, c.pending, c.failedSends)
	}
}

func TestEventLogBookmarkSaveFailureRecovers(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "state")
	if err := os.WriteFile(parent, []byte("blocks directory"), 0600); err != nil {
		t.Fatal(err)
	}
	c := NewPersistentEventLogCollector(filepath.Join(parent, "bookmarks.json"))
	for i := int64(1); i <= 2; i++ {
		c.pending = map[string]eventLogBookmark{"security": {RecordID: i}}
		c.CompletePass(EventLogPassSent)
		if !c.saveFailing || c.bookmarks["security"].RecordID != i {
			t.Fatalf("failed save %d: saveFailing=%v bookmarks=%v", i, c.saveFailing, c.bookmarks)
		}
	}
	if err := os.Remove(parent); err != nil {
		t.Fatal(err)
	}
	c.pending = map[string]eventLogBookmark{"security": {RecordID: 3}}
	c.CompletePass(EventLogPassSent)
	if c.saveFailing {
		t.Fatal("save failure state did not recover")
	}
	saved, err := readEventLogBookmarks(c.bookmarkPath)
	if err != nil || saved["security"].RecordID != 3 {
		t.Fatalf("recovered saved state=%v error=%v", saved, err)
	}
}
