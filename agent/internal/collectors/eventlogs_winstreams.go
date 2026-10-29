package collectors

import (
	"fmt"
	"log/slog"
	"sync"
	"time"
)

type winEventQueryRunner func(logName, xpath string) ([]winEvent, error)

type winEventStream struct {
	key       string
	logName   string
	selection string
	enabled   bool
}

// Keys are persisted: keep their spelling and the round-robin order stable.
func windowsEventStreams(categories []string) []winEventStream {
	return []winEventStream{
		{"security", "Security", securityEventSelection(), categoryEnabled(categories, "security")},
		{"system-errors", "System", "(Level=1 or Level=2)", systemLogQueryEnabled(categories)},
		{"system-power", "System", powerEventSelection(), categoryEnabled(categories, "system")},
		{"application-errors", "Application", "(Level=1 or Level=2)", categoryEnabled(categories, "application")},
		{"application-providers", "Application", applicationProviderSelection(applicationInfoProviderAllowlist), categoryEnabled(categories, "application")},
	}
}

type winEventRecord struct {
	bookmark eventLogBookmark
	entry    *EventLogEntry
}

type winEventStreamResult struct {
	key     string
	records []winEventRecord
	err     error
	skipped bool
}

func winEventRecordFor(key string, e winEvent, categories []string) winEventRecord {
	created, err := time.Parse(time.RFC3339Nano, e.TimeCreatedUtc)
	if err != nil {
		created = time.Time{}
	}
	record := winEventRecord{bookmark: eventLogBookmark{RecordID: e.RecordId, Time: created.UTC()}}
	entry := &EventLogEntry{
		Timestamp: truncateCollectorString(e.TimeCreated),
		Level:     mapWinLevel(e.Level),
		Category:  "application",
		Source:    truncateCollectorString(e.ProviderName),
		EventID:   fmt.Sprintf("%d:%d", e.Id, e.RecordId),
		Message:   winEventMessage(e),
		Details: map[string]any{
			"recordId": e.RecordId,
			"logName":  truncateCollectorString(e.LogName),
			"eventId":  e.Id,
		},
	}
	switch key {
	case "security":
		entry.Category = "security"
		entry.Level = mapSecurityEventLevel(e.Level, e.Keywords, e.Id)
		if uint64(e.Keywords)&auditFailureKeyword != 0 {
			entry.Details["auditFailure"] = true
		}
	case "system-errors":
		category, keep := systemLogCategoryFor(categories, e.ProviderName, e.Id)
		if !keep {
			return record
		}
		entry.Category = category
	case "system-power":
		entry.Category = "system"
		entry.Level = mapPowerEventLevel(e.Id)
		entry.Details["eventType"] = mapPowerEventType(e.Id)
	}
	record.entry = entry
	return record
}

// cutWinEventStreams takes eligible records fairly, then consumes each stream's
// prefix up to its first eligible record left behind. Filtered records do not
// spend the upload budget, but must advance the bookmark to avoid rereading them.
func cutWinEventStreams(streams []winEventStreamResult, minLevel string, maxEvents int) ([]EventLogEntry, map[string]eventLogBookmark, []int) {
	consumed := make([]int, len(streams))
	advances := make(map[string]eventLogBookmark)
	var events []EventLogEntry
	threshold := levelOrder[minLevel]
	for {
		took := false
		for i, stream := range streams {
			if stream.skipped || stream.err != nil {
				continue
			}
			for consumed[i] < len(stream.records) {
				r := stream.records[consumed[i]]
				eligible := r.entry != nil && (threshold == 0 || levelOrder[r.entry.Level] >= threshold)
				if eligible {
					if len(events) >= maxEvents {
						break
					}
					events = append(events, *r.entry)
					took = true
				}
				consumed[i]++
				if eligible {
					break
				}
			}
		}
		// One final traversal after taking the last event consumes any trailing
		// filtered records, including those in streams later in the order.
		if !took {
			break
		}
	}
	for i, count := range consumed {
		if count > 0 {
			advances[streams[i].key] = streams[i].records[count-1].bookmark
		}
	}
	return events, advances, consumed
}

// caughtUpWinEventAdvances refreshes anchors only after a successful query has
// drained its entire result and returned fewer records than the query cap.
func caughtUpWinEventAdvances(streams []winEventStreamResult, consumed []int, previous map[string]eventLogBookmark, now time.Time) map[string]eventLogBookmark {
	advances := make(map[string]eventLogBookmark)
	for i, stream := range streams {
		if stream.skipped || stream.err != nil || len(stream.records) >= perQueryCap || consumed[i] != len(stream.records) {
			continue
		}
		bookmark := eventLogBookmark{RecordID: previous[stream.key].RecordID}
		if consumed[i] > 0 {
			bookmark = stream.records[consumed[i]-1].bookmark
		}
		// The pass start is safe: a record written after the query snapshot has
		// EventRecordID > N and still matches the ID branch. The time branch is
		// only the safety net for record IDs restarting after a log reset.
		if bookmark.Time.Before(now) {
			bookmark.Time = now.UTC()
		}
		advances[stream.key] = bookmark
	}
	return advances
}

type windowsEventPassSnapshot struct {
	categories []string
	minLevel   string
	maxEvents  int
	streams    []winEventStream
	xpaths     []string
	previous   map[string]eventLogBookmark
}

// snapshotWindowsStreams releases the mutex even if query construction or
// logging panics, allowing the outer collector Guard to recover safely.
func (c *EventLogCollector) snapshotWindowsStreams(now time.Time) windowsEventPassSnapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.loadBookmarksLocked()
	snapshot := windowsEventPassSnapshot{
		categories: append([]string(nil), c.categories...),
		minLevel:   c.minimumLevel,
		maxEvents:  c.maxEvents,
		previous:   make(map[string]eventLogBookmark),
	}
	snapshot.streams = windowsEventStreams(snapshot.categories)
	snapshot.xpaths = make([]string, len(snapshot.streams))
	for i, stream := range snapshot.streams {
		if !stream.enabled {
			continue
		}
		var bookmark *eventLogBookmark
		if b, ok := c.bookmarks[stream.key]; ok {
			bookmark = &b
			snapshot.previous[stream.key] = b
		}
		var floored bool
		snapshot.xpaths[i], floored = buildWinEventXPath(stream.selection, bookmark, c.lastCollectTime, now)
		warn, recovered := updateEventLogStreamState(&c.floored, stream.key, floored)
		if floored {
			logFloor := slog.Info
			if warn {
				logFloor = slog.Warn
			}
			logFloor("event log backlog floor applied", "collector", c.name, "stream", stream.key, "floor", now.Add(-eventLogMaxBacklog))
		} else if recovered {
			slog.Info("event log backlog caught up", "collector", c.name, "stream", stream.key)
		}
	}
	return snapshot
}

// collectWindowsStreams never holds c.mu while querying Windows. Each goroutine
// owns a result slot so scheduling cannot change the cut order or starve a stream.
func (c *EventLogCollector) collectWindowsStreams(run winEventQueryRunner, now time.Time) []EventLogEntry {
	snapshot := c.snapshotWindowsStreams(now)
	streams := snapshot.streams

	results := make([]winEventStreamResult, len(streams))
	var wg sync.WaitGroup
	for i, stream := range streams {
		results[i].key = stream.key
		results[i].skipped = !stream.enabled
		if !stream.enabled {
			continue
		}
		wg.Add(1)
		go func(i int, stream winEventStream) {
			defer wg.Done()
			defer func() {
				if value := recover(); value != nil {
					results[i].err = fmt.Errorf("stream %s panicked: %v", stream.key, value)
					results[i].records = nil
				}
			}()
			events, err := run(stream.logName, snapshot.xpaths[i])
			if err != nil {
				results[i].err = fmt.Errorf("stream %s: %w", stream.key, err)
				return
			}
			for _, event := range events {
				results[i].records = append(results[i].records, winEventRecordFor(stream.key, event, snapshot.categories))
			}
		}(i, stream)
	}
	wg.Wait()

	events, advances, consumed := cutWinEventStreams(results, snapshot.minLevel, snapshot.maxEvents)
	for key, bookmark := range caughtUpWinEventAdvances(results, consumed, snapshot.previous, now) {
		advances[key] = bookmark
	}
	for i, result := range results {
		if len(result.records) == perQueryCap || consumed[i] < len(result.records) {
			slog.Info("event log backlog; draining next pass", "collector", c.name, "stream", result.key, "returned", len(result.records), "consumed", consumed[i])
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, result := range results {
		if !result.skipped {
			c.logWindowsQueryResultLocked(result.key, result.err)
		}
	}
	if c.ackRequired {
		c.pending = advances
	} else {
		c.commitBookmarksLocked(advances)
	}
	return events
}
