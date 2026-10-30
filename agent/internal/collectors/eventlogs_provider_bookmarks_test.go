package collectors

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestApplicationProviderBookmarkReanchor(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	oldTime := now.Add(-time.Hour)
	builtins := []string{"MsiInstaller", "APCPBEAgent"}
	for _, tc := range []struct {
		name           string
		stored, policy []string
		stamp          time.Time
		reset          bool
	}{
		{"addition", builtins, []string{"UPS"}, oldTime, true},
		{"removal", append(append([]string(nil), builtins...), "UPS"), nil, oldTime, false},
		{"legacy unchanged", nil, nil, oldTime, false},
		{"legacy addition", nil, []string{"UPS"}, oldTime, true},
		{"zero time", nil, []string{"UPS"}, time.Time{}, true},
		{"case only", []string{"msiinstaller", "apcpbeagent", "ups"}, []string{"UPS"}, oldTime, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := NewEventLogCollector()
			c.categories = []string{"application"}
			c.lastCollectTime = now.Add(-15 * time.Minute)
			c.bookmarks = map[string]eventLogBookmark{"application-providers": {RecordID: 123, Time: tc.stamp, Providers: tc.stored}}
			c.UpdateApplicationProviders(tc.policy)
			var query string
			c.collectWindowsStreams(func(_, xpath string) ([]winEvent, error) {
				if strings.Contains(xpath, "Provider[") {
					query = xpath
				}
				return nil, nil
			}, now)
			if strings.Contains(query, "EventRecordID>123") == tc.reset {
				t.Fatalf("reset=%v query=%s", tc.reset, query)
			}
			if tc.reset {
				anchor := tc.stamp
				if anchor.IsZero() {
					anchor = c.lastCollectTime
				}
				if !strings.Contains(query, "TimeCreated[@SystemTime>='"+anchor.Format(winEventTimeFormat)+"']") {
					t.Fatalf("wrong time anchor: %s", query)
				}
			}
			got := streamTestBookmark(t, c, "application-providers")
			wantID := int64(123)
			if tc.reset {
				wantID = 0
			}
			if got.RecordID != wantID || !got.Time.Equal(now) || !reflect.DeepEqual(got.Providers, effectiveApplicationProviders(tc.policy)) {
				t.Fatalf("committed bookmark=%+v", got)
			}
		})
	}
}

func TestApplicationProviderBookmarkAcknowledgement(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	for _, failQuery := range []bool{false, true} {
		t.Run(map[bool]string{false: "unacked", true: "query failed"}[failQuery], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "bookmarks.json")
			c := NewPersistentEventLogCollector(path)
			c.categories = []string{"application"}
			c.bookmarksLoaded = true
			old := eventLogBookmark{RecordID: 123, Time: now.Add(-time.Minute), Providers: append([]string(nil), applicationInfoProviderAllowlist...)}
			c.bookmarks = map[string]eventLogBookmark{"application-providers": old}
			c.UpdateApplicationProviders([]string{"UPS"})
			var queries []string
			run := func(_, xpath string) ([]winEvent, error) {
				if !strings.Contains(xpath, "Provider[") {
					return nil, nil
				}
				queries = append(queries, xpath)
				if failQuery {
					return nil, errors.New("query failed")
				}
				return nil, nil
			}
			c.collectWindowsStreams(run, now)
			c.CompletePass(EventLogPassFailed)
			if got := streamTestBookmark(t, c, "application-providers"); !reflect.DeepEqual(got, old) {
				t.Fatalf("failed pass advanced: %+v", got)
			}
			c.collectWindowsStreams(run, now.Add(time.Minute))
			if len(queries) != 2 || queries[0] != queries[1] {
				t.Fatalf("retry anchor changed: %v", queries)
			}
			if failQuery {
				return
			}
			c.CompletePass(EventLogPassSent)
			loaded, err := readEventLogBookmarks(path)
			if err != nil {
				t.Fatal(err)
			}
			got := loaded["application-providers"]
			if got.RecordID != 0 || !reflect.DeepEqual(got.Providers, []string{"MsiInstaller", "APCPBEAgent", "UPS"}) {
				t.Fatalf("round trip=%+v", got)
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var state eventLogBookmarkState
			if err := json.Unmarshal(raw, &state); err != nil || state.Version != 1 {
				t.Fatalf("version changed: %s %v", raw, err)
			}
		})
	}
}

func TestApplicationProviderBookmarkStampsQuerySnapshot(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	for _, count := range []int{1, perQueryCap} {
		t.Run(map[bool]string{false: "caught up", true: "capped"}[count == perQueryCap], func(t *testing.T) {
			c := NewEventLogCollector()
			c.categories = []string{"application"}
			c.UpdateApplicationProviders([]string{"UPS"})
			c.collectWindowsStreams(func(_, xpath string) ([]winEvent, error) {
				if !strings.Contains(xpath, "Provider[") {
					return nil, nil
				}
				c.UpdateApplicationProviders([]string{"Different"})
				events := make([]winEvent, count)
				for i := range events {
					events[i] = streamTestEvent(int64(i+1), now.Add(-time.Second))
				}
				return events, nil
			}, now)
			got := streamTestBookmark(t, c, "application-providers")
			if got.RecordID != int64(count) || !reflect.DeepEqual(got.Providers, []string{"MsiInstaller", "APCPBEAgent", "UPS"}) {
				t.Fatalf("did not stamp query providers: %+v", got)
			}
		})
	}
}

func TestApplicationProviderBookmarkRestartBeforeConfiguration(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	for _, configureEmpty := range []bool{false, true} {
		t.Run(map[bool]string{false: "awaiting configuration", true: "configured empty"}[configureEmpty], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "bookmarks.json")
			old := eventLogBookmark{RecordID: 123, Time: now.Add(-time.Hour), Providers: []string{"MsiInstaller", "APCPBEAgent", "UPS"}}
			seed := NewPersistentEventLogCollector(path)
			seed.commitBookmarksLocked(map[string]eventLogBookmark{"application-providers": old})
			c := NewPersistentEventLogCollector(path)
			c.categories = []string{"application"}
			if configureEmpty {
				c.UpdateApplicationProviders([]string{})
			}
			var queries []string
			run := func(_, xpath string) ([]winEvent, error) {
				if strings.Contains(xpath, "Provider[") {
					queries = append(queries, xpath)
				}
				return nil, nil
			}
			c.collectWindowsStreams(run, now)
			if len(queries) != 1 || !strings.Contains(queries[0], "EventRecordID>123") || strings.Contains(queries[0], "@Name='UPS'") == configureEmpty {
				t.Fatalf("restart query lost provider coverage: %v", queries)
			}
			c.CompletePass(EventLogPassSent)
			stored, err := readEventLogBookmarks(path)
			if err != nil {
				t.Fatal(err)
			}
			want := old.Providers
			if configureEmpty {
				want = applicationInfoProviderAllowlist
			}
			if got := stored["application-providers"]; got.RecordID != 123 || !reflect.DeepEqual(got.Providers, want) {
				t.Fatalf("restart stamped wrong coverage: %+v", got)
			}
			if !configureEmpty {
				c.UpdateApplicationProviders([]string{"UPS"})
				c.collectWindowsStreams(run, now.Add(time.Minute))
				if len(queries) != 2 || !strings.Contains(queries[1], "EventRecordID>123") {
					t.Fatalf("configuration unnecessarily re-anchored: %v", queries)
				}
			}
		})
	}
}

func TestApplicationProviderBookmarkResetCappedPass(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "bookmarks.json")
	c := NewPersistentEventLogCollector(path)
	c.categories = []string{"application"}
	c.maxEvents = 10
	c.bookmarksLoaded = true
	c.bookmarks = map[string]eventLogBookmark{"application-providers": {RecordID: 123, Time: now.Add(-time.Hour), Providers: applicationInfoProviderAllowlist}}
	c.UpdateApplicationProviders([]string{"UPS"})
	var queries []string
	run := func(_, xpath string) ([]winEvent, error) {
		if !strings.Contains(xpath, "Provider[") {
			return nil, nil
		}
		queries = append(queries, xpath)
		events := make([]winEvent, perQueryCap)
		for i := range events {
			events[i] = streamTestEvent(int64(200+i), now.Add(-time.Minute))
			events[i].LogName = "Application"
			events[i].ProviderName = "UPS"
			events[i].Level = 3
		}
		return events, nil
	}
	if events := c.collectWindowsStreams(run, now); len(events) != 10 {
		t.Fatalf("consumed %d events, want 10", len(events))
	}
	if len(queries) != 1 || strings.Contains(queries[0], "EventRecordID>") || !strings.Contains(queries[0], now.Add(-time.Hour).Format(winEventTimeFormat)) {
		t.Fatalf("did not reset to old time: %v", queries)
	}
	c.CompletePass(EventLogPassSent)
	stored, err := readEventLogBookmarks(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := stored["application-providers"]; got.RecordID != 209 || !reflect.DeepEqual(got.Providers, []string{"MsiInstaller", "APCPBEAgent", "UPS"}) {
		t.Fatalf("capped reset must commit last consumed record and new providers: %+v", got)
	}
	c.collectWindowsStreams(run, now.Add(time.Minute))
	if len(queries) != 2 || !strings.Contains(queries[1], "EventRecordID>209") {
		t.Fatalf("capped reset repeated: %v", queries)
	}
}

func TestApplicationProviderBookmarkResetBudgetExhausted(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	c := NewPersistentEventLogCollector(filepath.Join(t.TempDir(), "bookmarks.json"))
	c.categories = []string{"security", "application"}
	// The round-robin cut visits security first; a one-record budget leaves
	// no application records consumed, even though its query succeeds.
	c.maxEvents = 1
	c.bookmarksLoaded = true
	old := eventLogBookmark{RecordID: 123, Time: now.Add(-time.Hour), Providers: applicationInfoProviderAllowlist}
	c.bookmarks = map[string]eventLogBookmark{"application-providers": old}
	c.UpdateApplicationProviders([]string{"UPS"})
	var queries []string
	run := func(logName, xpath string) ([]winEvent, error) {
		if logName == "Security" {
			return []winEvent{streamTestEvent(200, now.Add(-time.Minute))}, nil
		}
		if strings.Contains(xpath, "Provider[") {
			queries = append(queries, xpath)
			event := streamTestEvent(201, now.Add(-time.Minute))
			event.LogName, event.ProviderName, event.Level = "Application", "UPS", 3
			return []winEvent{event}, nil
		}
		return nil, nil
	}
	for i := 0; i < 2; i++ {
		events := c.collectWindowsStreams(run, now.Add(time.Duration(i)*time.Minute))
		if len(events) != 1 || events[0].Category != "security" {
			t.Fatalf("security did not exhaust budget: %+v", events)
		}
		c.CompletePass(EventLogPassSent)
		if got := streamTestBookmark(t, c, "application-providers"); !reflect.DeepEqual(got, old) {
			t.Fatalf("unconsumed stream advanced: %+v", got)
		}
	}
	if len(queries) != 2 || queries[0] != queries[1] || strings.Contains(queries[0], "EventRecordID>") || !strings.Contains(queries[0], old.Time.Format(winEventTimeFormat)) {
		t.Fatalf("unconsumed reset must retry same anchor: %v", queries)
	}
}
