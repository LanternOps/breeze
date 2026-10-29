package collectors

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCutWinEventStreams(t *testing.T) {
	stamp := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	record := func(stream string, id int64, level string) winEventRecord {
		r := winEventRecord{bookmark: eventLogBookmark{RecordID: id, Time: stamp.Add(time.Duration(id) * time.Second)}}
		if level != "" {
			r.entry = &EventLogEntry{EventID: fmt.Sprintf("%s:%d", stream, id), Level: level}
		}
		return r
	}
	for _, tc := range []struct {
		name         string
		streams      []winEventStreamResult
		minimum      string
		limit        int
		wantIDs      []string
		wantConsumed []int
	}{
		{
			name: "round robin",
			streams: []winEventStreamResult{
				{key: "a", records: []winEventRecord{record("a", 1, "error"), record("a", 2, "error")}},
				{key: "b", records: []winEventRecord{record("b", 1, "error"), record("b", 2, "error")}},
				{key: "c", records: []winEventRecord{record("c", 1, "error"), record("c", 2, "error")}},
			},
			minimum: "info", limit: 4,
			wantIDs: []string{"a:1", "b:1", "c:1", "a:2"}, wantConsumed: []int{2, 1, 1},
		},
		{
			name: "consume dropped and filtered prefix through first untaken eligible record",
			streams: []winEventStreamResult{
				{key: "a", records: []winEventRecord{record("a", 1, ""), record("a", 2, "info"), record("a", 3, "error"), record("a", 4, ""), record("a", 5, "error")}},
				{key: "b", records: []winEventRecord{record("b", 1, "info"), record("b", 2, "error"), record("b", 3, "warning")}},
				{key: "c", records: []winEventRecord{record("c", 1, "error")}},
			},
			minimum: "warning", limit: 2,
			wantIDs: []string{"a:3", "b:2"}, wantConsumed: []int{4, 2, 0},
		},
		{
			name: "filtered tail consumed even at cap",
			streams: []winEventStreamResult{
				{key: "a", records: []winEventRecord{record("a", 1, "error"), record("a", 2, "info"), record("a", 3, "")}},
				{key: "empty"},
			},
			minimum: "error", limit: 1,
			wantIDs: []string{"a:1"}, wantConsumed: []int{3, 0},
		},
		{
			name: "failed query excluded even with partial records",
			streams: []winEventStreamResult{
				{key: "failed", err: errors.New("timeout"), records: []winEventRecord{record("failed", 1, "error")}},
				{key: "empty"},
			},
			minimum: "info", limit: 10, wantConsumed: []int{0, 0},
		},
		{
			name: "zero budget still consumes ineligible prefixes",
			streams: []winEventStreamResult{
				{key: "a", records: []winEventRecord{record("a", 1, ""), record("a", 2, "error")}},
				{key: "b", records: []winEventRecord{record("b", 1, "info")}},
			},
			minimum: "error", limit: 0, wantConsumed: []int{1, 1},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// The same input must always produce the same cut and bookmarks.
			for attempt := 0; attempt < 10; attempt++ {
				got, advances, consumed := cutWinEventStreams(tc.streams, tc.minimum, tc.limit)
				var ids []string
				for _, entry := range got {
					ids = append(ids, entry.EventID)
				}
				if !reflect.DeepEqual(ids, tc.wantIDs) || !reflect.DeepEqual(consumed, tc.wantConsumed) {
					t.Fatalf("cut = %v, consumed %v; want %v, %v", ids, consumed, tc.wantIDs, tc.wantConsumed)
				}
				wantAdvances := make(map[string]eventLogBookmark)
				for i, count := range tc.wantConsumed {
					if count > 0 {
						wantAdvances[tc.streams[i].key] = tc.streams[i].records[count-1].bookmark
					}
				}
				if !reflect.DeepEqual(advances, wantAdvances) {
					t.Fatalf("advances = %v, want %v", advances, wantAdvances)
				}
			}
		})
	}
}

func streamTestEvent(id int64, stamp time.Time) winEvent {
	return winEvent{RecordId: id, LogName: "Security", Level: 2, TimeCreated: stamp.Format(time.RFC3339Nano), TimeCreatedUtc: stamp.Format(time.RFC3339Nano), ProviderName: "test", Id: 1104, Message: "event"}
}

func streamTestBookmark(t *testing.T, c *EventLogCollector, key string) eventLogBookmark {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bookmarks[key]
}

func TestWindowsStreamsFailureIsolation(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	c := NewEventLogCollector()
	c.categories = []string{"security", "application"}
	old := eventLogBookmark{RecordID: 10, Time: now.Add(-time.Minute)}
	c.bookmarks = map[string]eventLogBookmark{"security": old}
	got := c.collectWindowsStreams(func(logName, xpath string) ([]winEvent, error) {
		if logName == "Security" {
			return []winEvent{streamTestEvent(99, now)}, errors.New("query timed out")
		}
		if strings.Contains(xpath, "Provider[") {
			return []winEvent{streamTestEvent(22, now)}, nil
		}
		return []winEvent{streamTestEvent(21, now)}, nil
	}, now)
	if len(got) != 2 || got[0].EventID != "1104:21" || got[1].EventID != "1104:22" {
		t.Fatalf("healthy streams did not retain deterministic output: %+v", got)
	}
	if got := streamTestBookmark(t, c, "security"); got != old {
		t.Fatalf("failed stream advanced: %+v", got)
	}
	for key, want := range map[string]int64{"application-errors": 21, "application-providers": 22} {
		if got := streamTestBookmark(t, c, key).RecordID; got != want {
			t.Errorf("%s bookmark = %d, want %d", key, got, want)
		}
	}
}

func TestWindowsStreamsCapDrainsFromLastRecord(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	c := NewEventLogCollector()
	c.categories = []string{"security"}
	c.lastCollectTime = now.Add(-time.Hour)
	batch := make([]winEvent, 50)
	for i := range batch {
		batch[i] = streamTestEvent(int64(i+1), now.Add(time.Duration(i-50)*time.Second))
	}
	if got := c.collectWindowsStreams(func(_, _ string) ([]winEvent, error) { return batch, nil }, now); len(got) != 50 {
		t.Fatalf("collected %d events, want 50", len(got))
	}
	if got := streamTestBookmark(t, c, "security"); got != (eventLogBookmark{RecordID: 50, Time: now.Add(-time.Second)}) {
		t.Fatalf("capped query was incorrectly treated as caught up: %+v", got)
	}
	var nextXPath string
	c.collectWindowsStreams(func(_, xpath string) ([]winEvent, error) { nextXPath = xpath; return nil, nil }, now.Add(time.Minute))
	if !strings.Contains(nextXPath, "EventRecordID>50") {
		t.Fatalf("next pass skipped or repeated capped batch: %s", nextXPath)
	}
	if c.ackRequired || c.bookmarkPath != "" || len(c.pending) != 0 {
		t.Fatalf("reliability collector must commit immediately without persistence: %+v", c)
	}
}

func TestWindowsStreamsAckRetryAndRestart(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "eventlog_bookmarks.json")
	c := NewPersistentEventLogCollector(path)
	c.categories = []string{"security"}
	c.lastCollectTime = now.Add(-time.Minute)
	old := eventLogBookmark{RecordID: 10, Time: now.Add(-time.Minute)}
	c.bookmarks = map[string]eventLogBookmark{"security": old}
	c.bookmarksLoaded = true
	var queries []string
	run := func(_, xpath string) ([]winEvent, error) {
		queries = append(queries, xpath)
		return []winEvent{streamTestEvent(20, now)}, nil
	}
	c.collectWindowsStreams(run, now)
	if got := streamTestBookmark(t, c, "security"); got != old {
		t.Fatalf("unacknowledged pass advanced bookmark: %+v", got)
	}
	c.CompletePass(false)
	c.collectWindowsStreams(run, now)
	if len(queries) != 2 || queries[0] != queries[1] || !strings.Contains(queries[1], "EventRecordID>10") {
		t.Fatalf("failed send did not retry old bookmark: %v", queries)
	}
	c.CompletePass(true)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved struct {
		Version int                         `json:"version"`
		Streams map[string]eventLogBookmark `json:"streams"`
	}
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Version != 1 || saved.Streams["security"].RecordID != 20 || !saved.Streams["security"].Time.Equal(now) {
		t.Fatalf("saved state = %s", raw)
	}
	restarted := NewPersistentEventLogCollector(path)
	restarted.categories = []string{"security"}
	var restartXPath string
	restarted.collectWindowsStreams(func(_, xpath string) ([]winEvent, error) { restartXPath = xpath; return nil, nil }, now)
	if !strings.Contains(restartXPath, "EventRecordID>20") {
		t.Fatalf("restart did not load persisted bookmark: %s", restartXPath)
	}
}

func TestWindowsStreamsRepeatedSendFailuresCommit(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	c := NewPersistentEventLogCollector(filepath.Join(t.TempDir(), "bookmarks.json"))
	c.categories = []string{"security"}
	c.lastCollectTime = now.Add(-time.Minute)
	for pass := 1; pass <= 3; pass++ {
		c.collectWindowsStreams(func(_, _ string) ([]winEvent, error) { return []winEvent{streamTestEvent(7, now)}, nil }, now)
		c.CompletePass(false)
		got := streamTestBookmark(t, c, "security").RecordID
		if pass < 3 && got != 0 {
			t.Fatalf("failure %d committed prematurely: %d", pass, got)
		}
		if pass == 3 && got != 7 {
			t.Fatalf("poison batch did not advance on third failure: %d", got)
		}
	}
}

func TestWindowsStreamsCorruptStateUsesSeed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bookmarks.json")
	if err := os.WriteFile(path, []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	c := NewPersistentEventLogCollector(path)
	c.categories = []string{"security"}
	c.lastCollectTime = now.Add(-15 * time.Minute)
	var query string
	c.collectWindowsStreams(func(_, xpath string) ([]winEvent, error) { query = xpath; return nil, nil }, now)
	if !strings.Contains(query, "TimeCreated[@SystemTime>='2026-10-29T11:45:00.0000000Z']") || strings.Contains(query, "EventRecordID>") {
		t.Fatalf("corrupt state did not fall back to seed: %s", query)
	}
}

func TestWindowsStreamsCategoryEnablement(t *testing.T) {
	for _, tc := range []struct {
		category string
		want     []string
	}{
		{"security", []string{"security"}},
		{"hardware", []string{"system-errors"}},
		{"system", []string{"system-errors", "system-power"}},
		{"application", []string{"application-errors", "application-providers"}},
	} {
		t.Run(tc.category, func(t *testing.T) {
			c := NewEventLogCollector()
			c.categories = []string{tc.category}
			now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
			old := eventLogBookmark{RecordID: 1, Time: now.Add(-time.Minute)}
			c.bookmarks = map[string]eventLogBookmark{"security": old, "system-errors": old, "system-power": old, "application-errors": old, "application-providers": old}
			var mu sync.Mutex
			queried := make(map[string]bool)
			c.collectWindowsStreams(func(logName, xpath string) ([]winEvent, error) {
				key := "security"
				switch logName {
				case "Application":
					key = "application-errors"
					if strings.Contains(xpath, "Provider[") {
						key = "application-providers"
					}
				case "System":
					key = "system-errors"
					if strings.Contains(xpath, "EventID=41") {
						key = "system-power"
					}
				}
				mu.Lock()
				queried[key] = true
				mu.Unlock()
				return []winEvent{streamTestEvent(2, now)}, nil
			}, now)
			want := make(map[string]bool)
			for _, key := range tc.want {
				want[key] = true
			}
			if !reflect.DeepEqual(queried, want) {
				t.Fatalf("queried %v, want %v", queried, want)
			}
			for key, bookmark := range c.bookmarks {
				if !want[key] && bookmark != old {
					t.Errorf("disabled stream %s advanced to %+v", key, bookmark)
				}
			}
		})
	}
}

func TestWindowsStreamsInvalidUTCTimeKeepsRecordID(t *testing.T) {
	c := NewEventLogCollector()
	c.categories = []string{"security"}
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	event := streamTestEvent(42, now)
	event.TimeCreatedUtc = "invalid"
	c.collectWindowsStreams(func(_, _ string) ([]winEvent, error) { return []winEvent{event}, nil }, now)
	got := streamTestBookmark(t, c, "security")
	if got.RecordID != 42 || !got.Time.Equal(now) {
		t.Fatalf("caught-up bookmark = %+v, want record 42 and pass start", got)
	}
}

func TestWindowsStreamsCutStagesOnlyConsumedRecords(t *testing.T) {
	c := NewPersistentEventLogCollector(filepath.Join(t.TempDir(), "bookmarks.json"))
	c.categories = []string{"security"}
	c.maxEvents = 2
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	c.lastCollectTime = now.Add(-time.Minute)
	recordTime := now.Add(-time.Minute)
	batch := []winEvent{streamTestEvent(1, recordTime), streamTestEvent(2, recordTime), streamTestEvent(3, recordTime)}
	got := c.collectWindowsStreams(func(_, _ string) ([]winEvent, error) { return batch, nil }, now)
	if len(got) != 2 || got[0].EventID != "1104:1" || got[1].EventID != "1104:2" {
		t.Fatalf("unexpected cut: %+v", got)
	}
	c.CompletePass(true)
	if got := streamTestBookmark(t, c, "security"); got != (eventLogBookmark{RecordID: 2, Time: recordTime}) {
		t.Fatalf("cut stream was incorrectly treated as caught up: %+v", got)
	}
	var query string
	c.collectWindowsStreams(func(_, xpath string) ([]winEvent, error) { query = xpath; return nil, nil }, now)
	if !strings.Contains(query, "EventRecordID>2") {
		t.Fatalf("cut advanced past an untaken event: %s", query)
	}
}

func TestWindowsStreamsPendingReplacedWithoutAck(t *testing.T) {
	c := NewPersistentEventLogCollector(filepath.Join(t.TempDir(), "bookmarks.json"))
	c.categories = []string{"security"}
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	c.lastCollectTime = now.Add(-time.Minute)
	c.collectWindowsStreams(func(_, _ string) ([]winEvent, error) { return []winEvent{streamTestEvent(7, now)}, nil }, now)
	// A deferred upload leaves pending untouched. The next collection replaces
	// that batch; a failed query must not accidentally acknowledge stale data.
	var retryXPath string
	c.collectWindowsStreams(func(_, xpath string) ([]winEvent, error) {
		retryXPath = xpath
		return nil, errors.New("access denied")
	}, now)
	if strings.Contains(retryXPath, "EventRecordID>") || !strings.Contains(retryXPath, "2026-10-29T11:59:00.0000000Z") {
		t.Fatalf("unacknowledged batch changed next query: %s", retryXPath)
	}
	c.CompletePass(true)
	if got := streamTestBookmark(t, c, "security").RecordID; got != 0 {
		t.Fatalf("stale pending batch committed after failed query: %d", got)
	}
	if c.failedSends != 0 {
		t.Fatalf("unacknowledged deferred pass counted as send failure: %d", c.failedSends)
	}
}

func TestWinEventRecordFor(t *testing.T) {
	stamp := "2026-10-29T06:00:00.1234567-06:00"
	wantTime := time.Date(2026, 10, 29, 12, 0, 0, 123456700, time.UTC)
	for _, tc := range []struct {
		name             string
		key              string
		categories       []string
		event            winEvent
		wantLevel        string
		wantCategory     string
		wantAuditFailure bool
		wantEventType    string
		wantDropped      bool
	}{
		{"audit failure", "security", []string{"security"}, winEvent{Id: 4625, Level: 0, Keywords: -9218868437227405312}, "warning", "security", true, "", false},
		{"curated audit success", "security", []string{"security"}, winEvent{Id: 4740, Level: 0}, "warning", "security", false, "", false},
		{"power", "system-power", []string{"system"}, winEvent{Id: 41, Level: 1}, "critical", "system", false, "unexpected_shutdown", false},
		{"hardware", "system-errors", []string{"hardware"}, winEvent{Id: 7, Level: 2, ProviderName: "disk"}, "error", "hardware", false, "", false},
		{"system", "system-errors", []string{"system"}, winEvent{Id: 7000, Level: 2, ProviderName: "Service Control Manager"}, "error", "system", false, "", false},
		{"application error", "application-errors", []string{"application"}, winEvent{Id: 1000, Level: 2}, "error", "application", false, "", false},
		{"application provider", "application-providers", []string{"application"}, winEvent{Id: 1033, Level: 4, ProviderName: "MsiInstaller"}, "info", "application", false, "", false},
		{"disabled derived category", "system-errors", []string{"hardware"}, winEvent{Id: 7000, Level: 2}, "", "", false, "", true},
		{"power owned by separate stream", "system-errors", []string{"system"}, winEvent{Id: 41, Level: 1}, "", "", false, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			event := tc.event
			event.RecordId = 12
			event.TimeCreated = stamp
			event.TimeCreatedUtc = stamp
			event.Message = "  "
			event.InsertionText = " fallback text "
			got := winEventRecordFor(tc.key, event, tc.categories)
			if got.bookmark.RecordID != 12 || !got.bookmark.Time.Equal(wantTime) || got.bookmark.Time.Location() != time.UTC {
				t.Errorf("bookmark must retain consumed record with UTC time: %+v", got.bookmark)
			}
			if tc.wantDropped {
				if got.entry != nil {
					t.Fatalf("expected dropped entry, got %+v", got.entry)
				}
				return
			}
			if got.entry == nil {
				t.Fatal("expected entry")
			}
			entry := got.entry
			if entry.Category != tc.wantCategory || entry.Level != tc.wantLevel || entry.Message != "fallback text" || entry.EventID != fmt.Sprintf("%d:12", event.Id) {
				t.Errorf("unexpected conversion: %+v", entry)
			}
			if audit, _ := entry.Details["auditFailure"].(bool); audit != tc.wantAuditFailure {
				t.Errorf("auditFailure = %v, want %v", audit, tc.wantAuditFailure)
			}
			if eventType, _ := entry.Details["eventType"].(string); eventType != tc.wantEventType {
				t.Errorf("eventType = %q, want %q", eventType, tc.wantEventType)
			}
		})
	}
}
