package timesync

import (
	"context"
	"sort"
	"time"
)

func isSignal(id uint32) bool {
	switch id {
	case 12, 24, 29, 35, 36, 37, 47, 52, 129, 134:
		return true
	}
	return false
}
func newest(events []Event) {
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].OccurredAt.Equal(events[j].OccurredAt) {
			return events[i].RecordID > events[j].RecordID
		}
		return events[i].OccurredAt.After(events[j].OccurredAt)
	})
}
func collectEvents(ctx context.Context, sys System, since, until time.Time) ([]Event, error) {
	fresh, err := sys.Events(ctx, since, until, 100)
	if err != nil {
		return nil, err
	}
	recent, err := sys.RecentEvents(ctx, until, 20)
	if err != nil {
		return nil, err
	}
	valid := func(e Event) bool {
		return !e.OccurredAt.IsZero() && !e.OccurredAt.After(until) && e.Level >= 0 && e.Level <= 5 && e.RecordID <= maxSafeSequence
	}
	// Sort before ID-only deduplication so a reused record ID retains its newest occurrence.
	union := append(append([]Event(nil), fresh...), recent...)
	newest(union)
	latest := map[uint64]Event{}
	for _, e := range union {
		if !valid(e) {
			continue
		}
		if _, ok := latest[e.RecordID]; !ok {
			latest[e.RecordID] = e
		}
	}
	recent = append([]Event(nil), recent...)
	newest(recent)
	reserved := map[uint64]bool{}
	for _, e := range recent {
		if len(reserved) == 20 {
			break
		}
		if valid(e) {
			reserved[e.RecordID] = true
		}
	}
	candidates := []Event{}
	freshIDs := map[uint64]bool{}
	for _, e := range fresh {
		if valid(e) && e.OccurredAt.After(since) {
			freshIDs[e.RecordID] = true
		}
	}
	for id, e := range latest {
		if reserved[id] || freshIDs[id] {
			candidates = append(candidates, e)
		}
	}
	newest(candidates)
	out := []Event{}
	seen := map[uint64]bool{}
	add := func(e Event) {
		if len(out) >= 100 || seen[e.RecordID] {
			return
		}
		seen[e.RecordID] = true
		e.OccurredAt = e.OccurredAt.UTC()
		e.Message = limitText(e.Message, 1000)
		properties := []string{}
		for i, p := range e.Properties {
			if i == 10 {
				break
			}
			properties = append(properties, limitText(p, 500))
		}
		e.Properties = properties
		e.displayReserved = reserved[e.RecordID]
		out = append(out, e)
	}
	// Reserve display rows first, then prioritize fresh signals within remaining capacity.
	for _, e := range candidates {
		if reserved[e.RecordID] {
			add(e)
		}
	}
	for _, e := range candidates {
		if freshIDs[e.RecordID] && isSignal(e.EventID) {
			add(e)
		}
	}
	for _, e := range candidates {
		add(e)
	}
	newest(out)
	return out, nil
}

const maxSafeSequence uint64 = 9007199254740991
