package watchdog

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	LevelInfo       = "info"
	LevelWarn       = "warn"
	LevelError      = "error"
	journalFileName = "watchdog-journal.log"
	minRotateSize   = 4096
	maxRecentBuffer = 1000
)

// JournalEntry is a single log line written to the health journal.
type JournalEntry struct {
	Time  time.Time      `json:"time"`
	Level string         `json:"level"`
	Event string         `json:"event"`
	Data  map[string]any `json:"data,omitempty"`
}

// Journal is a rolling, append-only health log.
type Journal struct {
	mu       sync.Mutex
	dir      string
	maxBytes int64
	maxFiles int
	file     *os.File
	written  int64
	recent   []JournalEntry
}

// NewJournal opens or creates a journal file in dir. maxSizeMB controls rotation
// threshold; maxFiles controls how many rotated files are retained (active file
// not counted). If maxBytes would be below minRotateSize, minRotateSize is used.
func NewJournal(dir string, maxSizeMB int, maxFiles int) (*Journal, error) {
	maxBytes := int64(maxSizeMB) * 1024 * 1024
	if maxBytes < minRotateSize {
		maxBytes = minRotateSize
	}

	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("watchdog journal: mkdir %s: %w", dir, err)
	}

	j := &Journal{
		dir:      dir,
		maxBytes: maxBytes,
		maxFiles: maxFiles,
	}

	if err := j.openFile(); err != nil {
		return nil, err
	}

	return j, nil
}

// openFile opens (or creates) the active journal file and reads its current size.
func (j *Journal) openFile() error {
	path := filepath.Join(j.dir, journalFileName)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("watchdog journal: open %s: %w", path, err)
	}

	info, err := f.Stat()
	if err != nil {
		f.Close()
		return fmt.Errorf("watchdog journal: stat %s: %w", path, err)
	}

	j.file = f
	j.written = info.Size()
	return nil
}

// Log appends a structured entry to the journal. It holds the mutex for the
// entire operation so rotate and write are atomic.
func (j *Journal) Log(level, event string, data map[string]any) {
	entry := JournalEntry{
		Time:  time.Now().UTC(),
		Level: level,
		Event: event,
		Data:  data,
	}

	line, err := json.Marshal(entry)
	if err != nil {
		// Fallback: log a minimal error entry without the unparseable data.
		line, _ = json.Marshal(JournalEntry{
			Time:  entry.Time,
			Level: LevelError,
			Event: "journal.marshal_error",
			Data:  map[string]any{"original_event": event},
		})
	}
	line = append(line, '\n')

	j.mu.Lock()
	defer j.mu.Unlock()

	if j.file == nil {
		fmt.Fprintf(os.Stderr, "watchdog journal: file not open, dropping entry: %s\n", event)
		return
	}

	n, writeErr := j.file.Write(line)
	j.written += int64(n)
	if writeErr != nil {
		fmt.Fprintf(os.Stderr, "watchdog journal: write failed: %v\n", writeErr)
	}

	// Append to in-memory ring buffer.
	j.recent = append(j.recent, entry)
	if len(j.recent) > maxRecentBuffer {
		j.recent = j.recent[len(j.recent)-maxRecentBuffer:]
	}

	if j.written >= j.maxBytes {
		j.rotate()
	}
}

// Recent returns the last n entries held in the in-memory buffer.
// If n <= 0 or n > len(recent), all buffered entries are returned.
func (j *Journal) Recent(n int) []JournalEntry {
	j.mu.Lock()
	defer j.mu.Unlock()

	if n <= 0 || n >= len(j.recent) {
		out := make([]JournalEntry, len(j.recent))
		copy(out, j.recent)
		return out
	}

	src := j.recent[len(j.recent)-n:]
	out := make([]JournalEntry, len(src))
	copy(out, src)
	return out
}

// ReadFromDisk reads all journal files in the journal directory (sorted by name,
// oldest rotated first, active file last) and returns every parsed entry. Intended
// for diagnostic export; does not require the mutex because it only reads files.
func (j *Journal) ReadFromDisk() ([]JournalEntry, error) {
	j.mu.Lock()
	dir := j.dir
	// Flush the active file so all writes are visible on disk before reading.
	if j.file != nil {
		j.file.Sync() // best-effort flush; errors are non-fatal for a read operation
	}
	j.mu.Unlock()

	entries, err := readJournalDir(dir)
	return entries, err
}

// readJournalDir scans dir for journal files and parses them in chronological order.
func readJournalDir(dir string) ([]JournalEntry, error) {
	infos, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("watchdog journal: readdir %s: %w", dir, err)
	}

	var files []string
	for _, info := range infos {
		name := info.Name()
		if name == journalFileName || strings.HasPrefix(name, "watchdog-journal.") && strings.HasSuffix(name, ".log") {
			files = append(files, filepath.Join(dir, name))
		}
	}
	// Sort: rotated files sort before the active file lexicographically because
	// "watchdog-journal.<millis>.log" < "watchdog-journal.log".
	sort.Strings(files)

	var all []JournalEntry
	for _, path := range files {
		entries, err := parseJournalFile(path)
		if err != nil {
			// Partial read is acceptable; skip corrupt files.
			continue
		}
		all = append(all, entries...)
	}
	return all, nil
}

// parseJournalFile reads and parses every JSON line in a single journal file.
// Lines that fail to parse are silently skipped.
func parseJournalFile(path string) ([]JournalEntry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var entries []JournalEntry
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var e JournalEntry
		if err := json.Unmarshal(line, &e); err != nil {
			continue
		}
		entries = append(entries, e)
	}
	return entries, scanner.Err()
}

// rotate closes the current file, renames it with a timestamp suffix, prunes
// old rotated files beyond maxFiles, and opens a fresh active file.
// Caller must hold j.mu.
func (j *Journal) rotate() {
	if j.file != nil {
		j.file.Close()
		j.file = nil
	}

	active := filepath.Join(j.dir, journalFileName)
	stamp := time.Now().UnixMilli()
	rotated := filepath.Join(j.dir, fmt.Sprintf("watchdog-journal.%d.log", stamp))
	if err := os.Rename(active, rotated); err != nil {
		fmt.Fprintf(os.Stderr, "watchdog journal: rename failed: %v\n", err)
	}

	j.pruneOldFiles()

	j.written = 0
	if err := j.openFile(); err != nil {
		fmt.Fprintf(os.Stderr, "watchdog journal: reopen after rotate failed: %v\n", err)
	}
}

// pruneOldFiles removes the oldest rotated journal files so that at most
// j.maxFiles rotated files exist (not counting the active file).
// Caller must hold j.mu.
func (j *Journal) pruneOldFiles() {
	infos, err := os.ReadDir(j.dir)
	if err != nil {
		return
	}

	var rotated []string
	for _, info := range infos {
		name := info.Name()
		if name != journalFileName &&
			strings.HasPrefix(name, "watchdog-journal.") &&
			strings.HasSuffix(name, ".log") {
			rotated = append(rotated, filepath.Join(j.dir, name))
		}
	}
	sort.Strings(rotated)

	for len(rotated) > j.maxFiles {
		os.Remove(rotated[0]) // best-effort; ignore error
		rotated = rotated[1:]
	}
}

// Close flushes and closes the active journal file.
func (j *Journal) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()

	if j.file == nil {
		return nil
	}
	err := j.file.Close()
	j.file = nil
	return err
}
