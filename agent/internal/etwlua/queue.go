package etwlua

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// Queue is a bounded on-disk JSONL ring buffer for elevation events that
// failed to post. Newest-on-top via append; oldest-evict on overflow.
// Atomic writes via .tmp+rename mirror agent/internal/pam/cache.go Save().
//
// Concurrency: a single Start() loop owns one Queue. The Mutex is for the
// rare contention with a periodic-drain ticker firing while Enqueue is
// mid-write; not a hot path.
type Queue struct {
	path    string
	maxBytes int64
	maxLines int
	maxAge   time.Duration

	mu sync.Mutex
}

// QueueDefaults: cap = 5 MB OR 1000 events whichever first. Max event age
// 7 days mirrors pam.RefuseAfter (cache.go:82). Defined as exported vars
// rather than const so tests can shrink them.
var (
	DefaultMaxBytes int64         = 5 * 1024 * 1024
	DefaultMaxLines int           = 1000
	DefaultMaxAge   time.Duration = 7 * 24 * time.Hour
)

// DefaultQueuePath returns the platform default. Routes through
// config.GetDataDir so all platforms land under the same data root the
// rest of the agent uses.
func DefaultQueuePath() string {
	return filepath.Join(config.GetDataDir(), "pam", "intercept-queue", "queue.jsonl")
}

// NewQueue opens (or creates) the queue file at path. Parent dirs are
// created with 0750 perms. Returns an empty queue if the file does not
// exist; corruption on existing files is repaired on first Drain.
func NewQueue(path string) (*Queue, error) {
	if path == "" {
		return nil, errors.New("etwlua: empty queue path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return nil, fmt.Errorf("etwlua: mkdir queue parent: %w", err)
	}
	return &Queue{
		path:     path,
		maxBytes: DefaultMaxBytes,
		maxLines: DefaultMaxLines,
		maxAge:   DefaultMaxAge,
	}, nil
}

// Enqueue appends ev to the queue file. If the resulting file exceeds the
// byte or line cap, oldest entries are evicted (FIFO) by rewriting the
// trimmed file atomically.
func (q *Queue) Enqueue(ev Event) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	line, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("etwlua: marshal event: %w", err)
	}
	line = append(line, '\n')

	existing, _ := q.readAllLocked()
	existing = append(existing, ev)

	for shouldEvict(existing, q.maxBytes, q.maxLines) && len(existing) > 1 {
		existing = existing[1:]
	}

	return q.writeAllLocked(existing)
}

// Drain reads every queued event, posts each one via hb.SendElevationRequest,
// and rewrites the queue file with only the events that failed. Returns
// the count of successfully-posted events.
//
// Behavior:
//   - Events older than maxAge are dropped (counted as "drained" so the
//     caller sees forward progress).
//   - Corrupt trailing lines (e.g. torn write) are silently truncated.
//   - First post failure aborts the drain to avoid hammering a down API;
//     the failing event and all remaining events are kept in the queue.
func (q *Queue) Drain(hb HeartbeatPoster) (int, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	events, err := q.readAllLocked()
	if err != nil {
		return 0, err
	}
	if len(events) == 0 {
		return 0, nil
	}

	cutoff := time.Now().Add(-q.maxAge)
	posted := 0
	kept := make([]Event, 0, len(events))
	for i, ev := range events {
		if !ev.ObservedAt.IsZero() && ev.ObservedAt.Before(cutoff) {
			// Too old to be useful — drop.
			posted++
			continue
		}
		if err := hb.SendElevationRequest(ev); err != nil {
			// Keep this and everything after; stop draining.
			kept = append(kept, events[i:]...)
			break
		}
		posted++
	}

	if err := q.writeAllLocked(kept); err != nil {
		return posted, fmt.Errorf("etwlua: rewrite queue after drain: %w", err)
	}
	return posted, nil
}

// Len returns the current count of queued events. Mostly for tests.
func (q *Queue) Len() (int, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	evs, err := q.readAllLocked()
	if err != nil {
		return 0, err
	}
	return len(evs), nil
}

// readAllLocked reads the queue file line by line. Silently skips lines
// that fail to parse — covers torn writes from power-loss mid-Enqueue.
// Caller must hold q.mu.
func (q *Queue) readAllLocked() ([]Event, error) {
	f, err := os.Open(q.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("etwlua: open queue: %w", err)
	}
	defer f.Close()

	var out []Event
	// Allow long lines (default bufio.Scanner cap is 64 KB; CommandLine
	// fields can be large).
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		raw := scanner.Bytes()
		if len(raw) == 0 {
			continue
		}
		var ev Event
		if err := json.Unmarshal(raw, &ev); err != nil {
			// Torn or corrupted line — skip.
			continue
		}
		out = append(out, ev)
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		// Return what we've read so far rather than nothing.
		return out, fmt.Errorf("etwlua: scan queue: %w", err)
	}
	return out, nil
}

// writeAllLocked rewrites the queue file with exactly the given events,
// using the .tmp+rename atomic pattern from pam/cache.go.
// Caller must hold q.mu.
func (q *Queue) writeAllLocked(events []Event) error {
	if len(events) == 0 {
		// Empty queue: truncate to a zero-byte file (atomic) so callers
		// observe a clean state rather than the prior contents.
		return atomicWriteFile(q.path, nil, 0600)
	}

	var buf []byte
	for _, ev := range events {
		line, err := json.Marshal(ev)
		if err != nil {
			return fmt.Errorf("etwlua: marshal queued event: %w", err)
		}
		buf = append(buf, line...)
		buf = append(buf, '\n')
	}
	return atomicWriteFile(q.path, buf, 0600)
}

// shouldEvict reports whether the queue exceeds either cap. Byte size is
// estimated as the sum of marshalled lengths plus one newline each — cheap
// and within ~5% of the on-disk size, which is good enough for a cap check.
func shouldEvict(events []Event, maxBytes int64, maxLines int) bool {
	if maxLines > 0 && len(events) > maxLines {
		return true
	}
	if maxBytes > 0 {
		var total int64
		for _, ev := range events {
			line, err := json.Marshal(ev)
			if err != nil {
				// Treat marshalling failure as worst-case (force eviction).
				return true
			}
			total += int64(len(line)) + 1
			if total > maxBytes {
				return true
			}
		}
	}
	return false
}

// atomicWriteFile mirrors agent/internal/pam/cache.go atomicWriteFile.
// Duplicated locally (rather than imported) because the pam helper is
// unexported and we don't want a cross-package dependency for a 30-line
// helper.
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".partial"
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	if d, derr := os.Open(filepath.Dir(path)); derr == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}
