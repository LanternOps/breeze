package heartbeat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// Backup-result outbox tuning (terminal-result outbox: backup results
// survive WS blips). This is deliberately a small, last-resort retry buffer
// for TERMINAL backup results only — never progress messages, which are
// ephemeral by design and superseded by the next one. Server side already
// tolerates a late flush (expectation TTL + terminal-status guard make it a
// harmless no-op), so the caps below just bound the worst case disk/backlog
// growth from a persistently unreachable server, not correctness.
const (
	backupResultOutboxDirName    = "outbox"
	backupResultOutboxMaxPending = 20
	backupResultOutboxMaxAge     = 48 * time.Hour
)

// backupResultOutboxEntry is the on-disk envelope for one pending backup
// result awaiting redelivery.
type backupResultOutboxEntry struct {
	EnqueuedAt time.Time               `json:"enqueuedAt"`
	Result     websocket.CommandResult `json:"result"`
}

// backupResultOutboxFile pairs a loaded entry with the path it was read
// from, so callers can act on individual files after sorting/filtering.
type backupResultOutboxFile struct {
	path  string
	entry backupResultOutboxEntry
}

// backupResultOutbox persists backup command results that failed to reach
// the server over the WebSocket connection, so a transient WS blip doesn't
// silently orphan the backup job server-side — without it, a dropped
// terminal result leaves the job "running" forever since nothing ever
// retries it. Progress messages are intentionally never routed through this
// outbox. Bounded to backupResultOutboxMaxPending pending entries and
// backupResultOutboxMaxAge age; both are enforced on every Enqueue.
type backupResultOutbox struct {
	dir string
	mu  sync.Mutex

	// nowFn is a test seam for deterministic ordering; defaults to time.Now.
	nowFn func() time.Time
}

// newBackupResultOutbox returns an outbox that persists pending backup
// results as JSON files under dir. dir is created lazily on first Enqueue.
func newBackupResultOutbox(dir string) *backupResultOutbox {
	return &backupResultOutbox{dir: dir, nowFn: time.Now}
}

func (o *backupResultOutbox) entryPath(commandID string) string {
	return filepath.Join(o.dir, commandID+".json")
}

// safeOutboxFilenameID reports whether a server-supplied CommandID can be used
// verbatim as an outbox filename component without escaping o.dir. The ID
// reaches us over IPC from the server's command, so a value containing a path
// separator or a "."/".." segment could otherwise redirect the write outside
// the outbox directory (path traversal, e.g. "../../etc/x"). We don't demand a
// strict UUID here — synthetic IDs like "cmd-1" are legitimate — only that the
// ID is a single, non-traversing path element on any platform.
func safeOutboxFilenameID(id string) bool {
	if strings.TrimSpace(id) == "" || id == "." || id == ".." {
		return false
	}
	// Reject both separators explicitly so a Windows-style "a\b" is caught even
	// on a POSIX host, where filepath.Base would not treat "\" as a separator.
	if strings.ContainsAny(id, `/\`) || strings.ContainsRune(id, os.PathSeparator) {
		return false
	}
	return filepath.Base(id) == id
}

// loadAllLocked reads every persisted entry, oldest first. Corrupt entries
// (malformed JSON) are dropped on sight — they can never be delivered and
// would otherwise wedge Flush forever. Unreadable entries (e.g. a transient
// permissions error) are logged and skipped but kept on disk for a later
// Flush. Must be called with o.mu held.
func (o *backupResultOutbox) loadAllLocked() []backupResultOutboxFile {
	matches, err := filepath.Glob(filepath.Join(o.dir, "*.json"))
	if err != nil || len(matches) == 0 {
		return nil
	}

	files := make([]backupResultOutboxFile, 0, len(matches))
	for _, path := range matches {
		raw, err := os.ReadFile(path)
		if err != nil {
			// Unlike a corrupt entry (dropped below), an unreadable one may be a
			// transient/permissions problem, so we keep the file for a later
			// Flush — but log it, otherwise redelivery silently stalls until the
			// 48h expiry with no trace of why.
			log.Warn("skipping unreadable backup result outbox entry", "path", path, "error", err.Error())
			continue
		}
		var entry backupResultOutboxEntry
		if err := json.Unmarshal(raw, &entry); err != nil {
			log.Warn("dropping corrupt backup result outbox entry", "path", path, "error", err.Error())
			_ = os.Remove(path)
			continue
		}
		files = append(files, backupResultOutboxFile{path: path, entry: entry})
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].entry.EnqueuedAt.Before(files[j].entry.EnqueuedAt)
	})
	return files
}

// Enqueue persists result to disk so a later Flush can retry delivery, even
// across an agent restart. Before writing, it evicts expired (older than
// backupResultOutboxMaxAge) entries and, if the pending count would
// otherwise exceed backupResultOutboxMaxPending once the new entry lands,
// the oldest surviving entries — so Enqueue never leaves more than
// backupResultOutboxMaxPending files behind.
func (o *backupResultOutbox) Enqueue(result websocket.CommandResult) {
	if !safeOutboxFilenameID(result.CommandID) {
		log.Warn("refusing to outbox backup result with empty or unsafe commandId", "commandId", result.CommandID)
		return
	}

	o.mu.Lock()
	defer o.mu.Unlock()

	if err := os.MkdirAll(o.dir, 0700); err != nil {
		log.Warn("failed to create backup result outbox directory", "dir", o.dir, "error", err.Error())
		return
	}

	now := o.nowFn()
	kept := make([]backupResultOutboxFile, 0)
	for _, f := range o.loadAllLocked() {
		if now.Sub(f.entry.EnqueuedAt) > backupResultOutboxMaxAge {
			_ = os.Remove(f.path)
			continue
		}
		kept = append(kept, f)
	}

	// This enqueue adds one more entry, so make room first (oldest evicted).
	for len(kept) >= backupResultOutboxMaxPending {
		_ = os.Remove(kept[0].path)
		kept = kept[1:]
	}

	entry := backupResultOutboxEntry{EnqueuedAt: now, Result: result}
	payload, err := json.Marshal(entry)
	if err != nil {
		log.Warn("failed to encode backup result for outbox", "commandId", result.CommandID, "error", err.Error())
		return
	}

	path := o.entryPath(result.CommandID)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0600); err != nil {
		log.Warn("failed to write backup result outbox entry", "commandId", result.CommandID, "error", err.Error())
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		log.Warn("failed to persist backup result outbox entry", "commandId", result.CommandID, "error", err.Error())
	}
}

// Flush attempts to redeliver every pending entry via send, oldest first. A
// successful send deletes the persisted entry; a failure leaves it on disk
// for the next Flush (e.g. the next WS reconnect). Entries older than
// backupResultOutboxMaxAge are dropped without attempting delivery — the
// server-side expectation TTL means a result that stale would be a harmless
// no-op at best, so there's nothing to gain from spending a send attempt.
//
// Held across the whole call: the mutex only guards local file bookkeeping,
// and send is expected to be non-blocking (websocket.Client.SendResult
// enqueues onto a buffered channel and returns immediately), so this never
// blocks on network I/O.
func (o *backupResultOutbox) Flush(send func(websocket.CommandResult) error) {
	o.mu.Lock()
	defer o.mu.Unlock()

	files := o.loadAllLocked()
	if len(files) == 0 {
		return
	}

	now := o.nowFn()
	for _, f := range files {
		if now.Sub(f.entry.EnqueuedAt) > backupResultOutboxMaxAge {
			_ = os.Remove(f.path)
			continue
		}
		if err := send(f.entry.Result); err != nil {
			log.Warn("failed to flush outboxed backup result", "commandId", f.entry.Result.CommandID, "error", err.Error())
			continue
		}
		_ = os.Remove(f.path)
	}
}

// backupResultOutboxDir returns the directory the outbox persists pending
// backup results under. Mirrors the ipStatePath/reliabilityStatePath
// fallback order used elsewhere in this package (per-user ~/.breeze dir,
// then the configured data dir, then a temp dir as a last resort) so it
// lands in the same place as the agent's other small persisted-state files.
func backupResultOutboxDir() string {
	if homeDir, err := os.UserHomeDir(); err == nil && strings.TrimSpace(homeDir) != "" {
		return filepath.Join(homeDir, ".breeze", backupResultOutboxDirName)
	}

	dataDir := strings.TrimSpace(config.GetDataDir())
	if dataDir == "" {
		tmpPath := filepath.Join(os.TempDir(), "breeze", backupResultOutboxDirName)
		log.Warn("backup result outbox directory unavailable, falling back to temp dir", "path", tmpPath)
		return tmpPath
	}
	return filepath.Join(dataDir, backupResultOutboxDirName)
}
