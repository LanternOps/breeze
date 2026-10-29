package collectors

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

const (
	eventLogFirstRunLookback  = 15 * time.Minute
	eventLogMaxSendFailures   = 3
	eventLogBookmarkFileLimit = 64 * 1024
)

type eventLogBookmark struct {
	RecordID int64     `json:"recordId"`
	Time     time.Time `json:"time"`
}

type eventLogBookmarkState struct {
	Version int                         `json:"version"`
	Streams map[string]eventLogBookmark `json:"streams"`
}

// NewPersistentEventLogCollector keeps Windows bookmarks across restarts and
// requires CompletePass to acknowledge delivery before advancing them.
func NewPersistentEventLogCollector(path string) *EventLogCollector {
	c := NewEventLogCollector()
	c.bookmarkPath = path
	c.ackRequired = true
	c.lastCollectTime = time.Now().Add(-eventLogFirstRunLookback)
	return c
}

func winEventStreamKeyKnown(key string) bool {
	switch key {
	case "security", "system-errors", "system-power", "application-errors", "application-providers":
		return true
	default:
		return false
	}
}

// loadBookmarksLocked is called only by the Windows pipeline, under c.mu.
// Failed reads leave the collector using its initial lookback seed.
func (c *EventLogCollector) loadBookmarksLocked() {
	if c.bookmarksLoaded || c.bookmarkPath == "" {
		return
	}
	c.bookmarksLoaded = true
	bookmarks, err := readEventLogBookmarks(c.bookmarkPath)
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Warn("failed to load event log bookmarks", "error", err)
		}
		return
	}
	c.bookmarks = bookmarks
}

func readEventLogBookmarks(path string) (map[string]eventLogBookmark, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, eventLogBookmarkFileLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > eventLogBookmarkFileLimit {
		return nil, fmt.Errorf("event log bookmark file exceeds %d bytes", eventLogBookmarkFileLimit)
	}
	// Decode known streams separately so unknown future streams are ignored.
	var state struct {
		Version int                        `json:"version"`
		Streams map[string]json.RawMessage `json:"streams"`
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	if state.Version != 1 {
		return nil, fmt.Errorf("unsupported event log bookmark version %d", state.Version)
	}
	bookmarks := make(map[string]eventLogBookmark)
	for key, raw := range state.Streams {
		if !winEventStreamKeyKnown(key) {
			continue
		}
		var bookmark eventLogBookmark
		if err := json.Unmarshal(raw, &bookmark); err != nil {
			return nil, fmt.Errorf("event log bookmark %s: %w", key, err)
		}
		bookmarks[key] = bookmark
	}
	return bookmarks, nil
}

// commitBookmarksLocked merges consumed prefixes and persists while holding
// c.mu, so a later acknowledgement cannot overtake an earlier disk write.
func (c *EventLogCollector) commitBookmarksLocked(advances map[string]eventLogBookmark) {
	if len(advances) == 0 {
		return
	}
	if c.bookmarks == nil {
		c.bookmarks = make(map[string]eventLogBookmark)
	}
	for key, bookmark := range advances {
		c.bookmarks[key] = bookmark
	}
	if c.bookmarkPath != "" {
		if err := c.saveBookmarksLocked(); err != nil {
			slog.Warn("failed to save event log bookmarks", "error", err)
		}
	}
}

func (c *EventLogCollector) saveBookmarksLocked() error {
	data, err := json.Marshal(eventLogBookmarkState{Version: 1, Streams: c.bookmarks})
	if err != nil {
		return err
	}
	dir := filepath.Dir(c.bookmarkPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".eventlog-bookmarks-*")
	if err != nil {
		return err
	}
	tmpPath := file.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, c.bookmarkPath)
}

// CompletePass acknowledges a Windows pass. Failed uploads are re-collected
// from committed bookmarks, with a bounded retry count for poison batches.
// Other platforms never stage bookmarks, making this a no-op there.
func (c *EventLogCollector) CompletePass(sent bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.pending) == 0 {
		return
	}
	if !sent {
		c.failedSends++
		if c.failedSends < eventLogMaxSendFailures {
			slog.Warn("event log upload failed; window will be re-collected next pass")
			c.pending = nil
			return
		}
		slog.Warn("event log upload failed repeatedly; skipping this batch", "streams", len(c.pending))
	}
	c.commitBookmarksLocked(c.pending)
	c.pending = nil
	c.failedSends = 0
}
