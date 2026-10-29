package collectors

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCaughtUpWinEventAdvances(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	old := eventLogBookmark{RecordID: 10, Time: now.Add(-72 * time.Hour)}
	last := eventLogBookmark{RecordID: 11, Time: now.Add(-time.Minute)}
	future := eventLogBookmark{RecordID: 12, Time: now.Add(time.Minute)}
	full := make([]winEventRecord, perQueryCap)
	for i := range full {
		full[i].bookmark = last
	}
	for _, tc := range []struct {
		name     string
		previous map[string]eventLogBookmark
		result   winEventStreamResult
		consumed int
		want     *eventLogBookmark
	}{
		{"empty without bookmark", nil, winEventStreamResult{}, 0, &eventLogBookmark{Time: now}},
		{"empty with old bookmark", map[string]eventLogBookmark{"security": old}, winEventStreamResult{}, 0, &eventLogBookmark{RecordID: 10, Time: now}},
		{"consumed record", nil, winEventStreamResult{records: []winEventRecord{{bookmark: last}}}, 1, &eventLogBookmark{RecordID: 11, Time: now}},
		{"future record time retained", nil, winEventStreamResult{records: []winEventRecord{{bookmark: future}}}, 1, &future},
		{"query cap", nil, winEventStreamResult{records: full}, perQueryCap, nil},
		{"cut leaves record", nil, winEventStreamResult{records: []winEventRecord{{bookmark: last}, {bookmark: future}}}, 1, nil},
		{"cut consumes nothing", nil, winEventStreamResult{records: []winEventRecord{{bookmark: last}}}, 0, nil},
		{"failed empty query", map[string]eventLogBookmark{"security": old}, winEventStreamResult{err: errors.New("timeout")}, 0, nil},
		{"failed partial query", nil, winEventStreamResult{records: []winEventRecord{{bookmark: last}}, err: errors.New("failed")}, 1, nil},
		{"disabled stream", map[string]eventLogBookmark{"security": old}, winEventStreamResult{skipped: true}, 0, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.result.key = "security"
			got := caughtUpWinEventAdvances([]winEventStreamResult{tc.result}, []int{tc.consumed}, tc.previous, now)
			if tc.want == nil {
				if len(got) != 0 {
					t.Fatalf("unexpected caught-up advance: %v", got)
				}
				return
			}
			if len(got) != 1 || got["security"] != *tc.want {
				t.Fatalf("advances = %v, want security=%+v", got, *tc.want)
			}
		})
	}
}

func TestWindowsQuietStreamRefreshesAnchor(t *testing.T) {
	for _, tc := range []struct {
		name      string
		gap       time.Duration
		wantFloor bool
	}{
		{"normal interval", 15 * time.Minute, false},
		{"offline beyond backlog limit", 25 * time.Hour, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			first := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
			c := NewPersistentEventLogCollector(filepath.Join(t.TempDir(), "bookmarks.json"))
			c.categories = []string{"security"}
			c.lastCollectTime = first.Add(-25 * time.Hour)
			c.collectWindowsStreams(func(_, _ string) ([]winEvent, error) { return nil, nil }, first)
			want := eventLogBookmark{Time: first}
			if c.pending["security"] != want || len(c.bookmarks) != 0 {
				t.Fatalf("quiet advance must wait for ack: pending=%v committed=%v", c.pending, c.bookmarks)
			}
			c.CompletePass(EventLogPassSent)
			bookmark := streamTestBookmark(t, c, "security")
			if bookmark != want {
				t.Fatalf("quiet bookmark = %+v, want %+v", bookmark, want)
			}
			second := first.Add(tc.gap)
			wantXPath, floor := buildWinEventXPath(securityEventSelection(), &bookmark, c.lastCollectTime, second)
			if floor != tc.wantFloor {
				t.Fatalf("floor = %v, want %v", floor, tc.wantFloor)
			}
			var query string
			c.collectWindowsStreams(func(_, xpath string) ([]winEvent, error) { query = xpath; return nil, nil }, second)
			if query != wantXPath || !strings.Contains(query, "TimeCreated[@SystemTime>='2026-10-29T12:00:00.0000000Z']") || strings.Contains(query, "EventRecordID") {
				t.Fatalf("second quiet pass did not use first pass anchor: %s", query)
			}
			c.CompletePass(EventLogPassSent)
			if got := streamTestBookmark(t, c, "security"); got != (eventLogBookmark{Time: second}) {
				t.Fatalf("second quiet bookmark = %+v", got)
			}
		})
	}
}

func TestWindowsQuietStreamRetainsRecordID(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	c := NewEventLogCollector()
	c.categories = []string{"security"}
	c.bookmarks = map[string]eventLogBookmark{"security": {RecordID: 10, Time: now.Add(-72 * time.Hour)}}
	c.collectWindowsStreams(func(_, _ string) ([]winEvent, error) { return nil, nil }, now)
	if got := streamTestBookmark(t, c, "security"); got != (eventLogBookmark{RecordID: 10, Time: now}) {
		t.Fatalf("quiet stream lost ID or retained stale time: %+v", got)
	}
}
