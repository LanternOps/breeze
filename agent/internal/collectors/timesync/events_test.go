package timesync

import (
	"context"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

func TestEventWindowAndCaps(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	since := now.Add(-time.Hour)
	f := &fakeSystem{}
	for i := 0; i < 140; i++ {
		f.events = append(f.events, Event{RecordID: uint64(i + 1), EventID: 134, Level: i % 6,
			OccurredAt: now.Add(-time.Duration(i) * time.Second), Message: strings.Repeat("😀", 800),
			Properties: []string{strings.Repeat("ü", 700), "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"}})
	}
	f.recent = []Event{{RecordID: 500, EventID: 999, Level: 4, OccurredAt: since.Add(-time.Hour), Properties: nil}}
	got, err := collectEvents(context.Background(), f, since, now)
	if err != nil || len(got) != 100 {
		t.Fatalf("%d %v", len(got), err)
	}
	if !f.since.Equal(since) || !f.until.Equal(now) {
		t.Fatal("window not passed through")
	}
	found := false
	for i, e := range got {
		if e.RecordID == 500 {
			found = true
		}
		if len(utf16.Encode([]rune(e.Message))) > 1000 || len(e.Properties) > 10 || e.Properties == nil {
			t.Fatal("event cap")
		}
		for _, p := range e.Properties {
			if len(utf16.Encode([]rune(p))) > 500 {
				t.Fatal("property cap")
			}
		}
		if i > 0 && e.OccurredAt.After(got[i-1].OccurredAt) {
			t.Fatal("not newest first")
		}
	}
	if !found {
		t.Fatal("recent display event lost on quiet window")
	}
}

func TestEventErrorsAndBoundaries(t *testing.T) {
	now := time.Unix(100000, 0).UTC()
	since := now.Add(-time.Hour)
	f := &fakeSystem{eventErr: errUnavailable}
	if _, err := collectEvents(context.Background(), f, since, now); err == nil {
		t.Fatal("query error hidden")
	}
	f.eventErr = nil
	e := Event{RecordID: 3, EventID: 37, Level: 4, OccurredAt: now.Add(-time.Second)}
	f.events = []Event{e, {RecordID: 1, OccurredAt: since}, {RecordID: 2, OccurredAt: now.Add(time.Second)}}
	f.recent = []Event{e}
	got, err := collectEvents(context.Background(), f, since, now)
	if err != nil || len(got) != 1 || got[0].RecordID != 3 {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestEventDeduplicationKeepsNewestOccurrenceByRecordID(t *testing.T) {
	now := time.Unix(100000, 0).UTC()
	since := now.Add(-time.Hour)
	old := Event{RecordID: 7, EventID: 134, Level: 3, OccurredAt: now.Add(-time.Minute), Message: "older", Properties: []string{}}
	latest := old
	latest.OccurredAt = now.Add(-time.Second)
	latest.Message = "newest"
	latest.EventID = 37
	for _, tc := range []struct {
		name          string
		fresh, recent []Event
	}{
		{"newest in recent", []Event{old}, []Event{latest}},
		{"newest in fresh", []Event{latest, old}, []Event{old}},
		{"duplicates within fresh", []Event{old, latest}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := collectEvents(context.Background(), &fakeSystem{events: tc.fresh, recent: tc.recent}, since, now)
			if err != nil || len(got) != 1 || got[0].RecordID != 7 || got[0].Message != "newest" || got[0].EventID != 37 || !got[0].OccurredAt.Equal(latest.OccurredAt) {
				t.Fatal(got, err)
			}
			if len(tc.recent) > 0 && !got[0].displayReserved {
				t.Fatal("deduplication lost display reservation")
			}
		})
	}
}

func TestAllTwentyDisplayEventsSurviveCountCap(t *testing.T) {
	now := time.Unix(100000, 0).UTC()
	since := now.Add(-time.Hour)
	f := &fakeSystem{}
	for i := 0; i < 100; i++ {
		f.events = append(f.events, Event{RecordID: uint64(i + 1), EventID: 134, Level: 3, OccurredAt: now.Add(-time.Duration(i+1) * time.Second)})
	}
	for i := 0; i < 20; i++ {
		f.recent = append(f.recent, Event{RecordID: uint64(1000 + i), EventID: 999, Level: 4, OccurredAt: since.Add(-time.Duration(i+1) * time.Hour)})
	}
	got, err := collectEvents(context.Background(), f, since, now)
	if err != nil || len(got) != 100 {
		t.Fatal(len(got), err)
	}
	reserved := 0
	for _, e := range got {
		if e.displayReserved {
			reserved++
		}
	}
	if reserved != 20 {
		t.Fatal("display reservation lost", reserved)
	}
}
