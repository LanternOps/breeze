package heartbeat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/breeze-rmm/agent/internal/websocket"
)

// interruptedCommandError is the error carried by the synthetic failed result
// a restarted agent reports for a command that was still running when the
// previous process died (#8296).
const interruptedCommandError = "agent restarted while command was running"

// commandJournalDirName is the journal's subdirectory under the outbox root.
// A subdirectory, not files beside the outbox's own, because the outbox globs
// "*.json" directly under its root and would otherwise flush journal entries
// as results.
const commandJournalDirName = "inflight"

// commandJournalEntry is the on-disk record of one executing command.
type commandJournalEntry struct {
	CommandID string    `json:"commandId"`
	Type      string    `json:"type"`
	StartedAt time.Time `json:"startedAt"`
}

// commandJournal records which server-tracked commands this process is
// executing, one small file per command, so a restart can tell which of them
// died without a result.
//
// Why it exists (#8296): a command that is still running when the agent stops
// — a hard kill, or a graceful stop whose 5s drain an install_patches inside
// WUA cannot meet — produces no result at all, so the server row stays `sent`
// until the stale-command reaper's per-type budget (2h for patching) runs out,
// holding every power command for the device behind it. With the journal, the
// restarted agent reports the command failed on its first connect.
//
// Lifecycle: Begin when a command passes dedupe and starts executing; End only
// once its result has been handed to a delivery path (queued on the
// websocket, accepted over REST, or written to the outbox). Ending later
// rather than earlier is deliberate: a crash between the two then yields a
// synthetic failure for a command that may actually have finished, which the
// server resolves harmlessly (a terminal row ignores a second result), whereas
// ending first would lose both the result and the record that it ran.
//
// Only commands whose id is a UUID and whose type is not session-ephemeral
// are journaled — see journalable.
type commandJournal struct {
	dir string

	mu sync.Mutex
	// active mirrors the files this process wrote, so End is a map lookup for
	// the overwhelming majority of results (terminal/tunnel/desktop frames,
	// monitor checks) that were never journaled — never a filesystem call.
	active map[string]struct{}
	// handOffExpected holds ids whose websocket delivery ran the command, so
	// that delivery's hand-off — and no other delivery's — clears the entry.
	handOffExpected map[string]struct{}
	// pinned holds ids whose result could not be persisted to the outbox.
	// End forgets them in memory but leaves the file, so the next start
	// reports the command failed rather than nothing at all.
	pinned map[string]struct{}

	nowFn func() time.Time
}

func newCommandJournal(dir string) *commandJournal {
	return &commandJournal{
		dir:             dir,
		active:          make(map[string]struct{}),
		handOffExpected: make(map[string]struct{}),
		pinned:          make(map[string]struct{}),
		nowFn:           time.Now,
	}
}

// commandJournalDir returns where the journal lives for a given outbox root.
func commandJournalDir(outboxRoot string) string {
	return filepath.Join(outboxRoot, commandJournalDirName)
}

// journalable reports whether a synthetic failure for cmd would mean anything
// to the server. Commands the server tracks — device_commands rows, discovery,
// backup and restore jobs — all use UUID ids; the server routes every non-UUID
// id (mon-*, snmp-*, tun-*, term-*, dev-push-*) to its rowless path
// (routes/agentWs.ts processCommandResult), where a failure is noise at best
// and, for an SNMP poll, a false failure recorded. Session-bound ephemeral
// commands are excluded even with a UUID id: their session dies with the
// process, and they are far too frequent to cost a disk write each.
func journalable(cmd Command) bool {
	if isEphemeralCommand(cmd.Type) || !safeOutboxFilenameID(cmd.ID) {
		return false
	}
	_, err := uuid.Parse(cmd.ID)
	return err == nil
}

func (j *commandJournal) entryPath(commandID string) string {
	return filepath.Join(j.dir, commandID+".json")
}

// Begin records cmd as executing. Best effort: a journal that cannot be
// written only means a later crash falls back to the server's reaper, which
// is exactly the behaviour before the journal existed.
func (j *commandJournal) Begin(cmd Command) {
	if j == nil || !journalable(cmd) {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()

	if err := os.MkdirAll(j.dir, 0700); err != nil {
		log.Warn("failed to create command journal directory", "dir", j.dir, "error", err.Error())
		return
	}
	payload, err := json.Marshal(commandJournalEntry{CommandID: cmd.ID, Type: cmd.Type, StartedAt: j.nowFn()})
	if err != nil {
		log.Warn("failed to encode command journal entry", "commandId", cmd.ID, "error", err.Error())
		return
	}
	path := j.entryPath(cmd.ID)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0600); err != nil {
		log.Warn("failed to write command journal entry", "commandId", cmd.ID, "error", err.Error())
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		log.Warn("failed to persist command journal entry", "commandId", cmd.ID, "error", err.Error())
		return
	}
	j.active[cmd.ID] = struct{}{}
}

// End clears the record for commandID once its result has been handed off.
// A no-op, with no filesystem access, for an id this process never journaled.
func (j *commandJournal) End(commandID string) {
	if j == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.endLocked(commandID)
}

func (j *commandJournal) endLocked(commandID string) {
	if _, ok := j.active[commandID]; !ok {
		return
	}
	delete(j.active, commandID)
	delete(j.handOffExpected, commandID)
	if _, pinned := j.pinned[commandID]; pinned {
		// The result never reached the outbox: keep the file for Recover.
		delete(j.pinned, commandID)
		return
	}
	// A failed remove leaves a file Recover will turn into a synthetic
	// failure for a command that finished. That is harmless: by then the
	// server row is terminal, and a terminal row ignores a second result
	// (commandAcceptsAgentResultCondition), so the real result stands.
	if err := os.Remove(j.entryPath(commandID)); err != nil && !os.IsNotExist(err) {
		log.Warn("failed to clear command journal entry", "commandId", commandID, "error", err.Error())
	}
}

// ExpectHandOff marks cmd's current execution as the one whose websocket
// hand-off ends its entry. Called by HandleCommand only when its delivery
// actually ran the command, so a second delivery of the same id — answered
// "duplicate", or rejected before dedupe (pool full) — cannot clear the
// entry of an execution that is still running.
func (j *commandJournal) ExpectHandOff(cmd Command) {
	if j == nil || !journalable(cmd) {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if _, ok := j.active[cmd.ID]; ok {
		j.handOffExpected[cmd.ID] = struct{}{}
	}
}

// HandedOff ends commandID's entry if, and only if, ExpectHandOff marked the
// delivery whose result was just handed off.
func (j *commandJournal) HandedOff(commandID string) {
	if j == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if _, ok := j.handOffExpected[commandID]; !ok {
		return
	}
	j.endLocked(commandID)
}

// Pin records that commandID's result could not be persisted, so the End
// that follows keeps its file for the next start's Recover. A no-op for an
// id that is not journaled.
func (j *commandJournal) Pin(commandID string) {
	if j == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if _, ok := j.active[commandID]; ok {
		j.pinned[commandID] = struct{}{}
	}
}

// Recover runs once at startup, before the first websocket connect. Every
// entry left behind belongs to a command the previous process started and
// never handed a result off for. Each is reported failed through the outbox,
// so the first connect's flush delivers it — unless the outbox already holds
// that command's real result (the process died between the outbox write and
// End), which wins. Returns how many synthetic failures it queued.
//
// An entry is removed only once it is resolved, so one that cannot be read or
// outboxed now is retried at the next start rather than silently dropped.
func (j *commandJournal) Recover(outbox *backupResultOutbox) int {
	if j == nil || outbox == nil {
		return 0
	}
	j.mu.Lock()
	defer j.mu.Unlock()

	// A crash between Begin's write and its rename leaves a .tmp the glob
	// below never matches; clear them so they cannot accumulate.
	if tmps, err := filepath.Glob(filepath.Join(j.dir, "*.json.tmp")); err == nil {
		for _, tmp := range tmps {
			_ = os.Remove(tmp)
		}
	}

	matches, err := filepath.Glob(filepath.Join(j.dir, "*.json"))
	if err != nil {
		log.Warn("failed to scan command journal", "dir", j.dir, "error", err.Error())
		return 0
	}
	if len(matches) == 0 {
		return 0
	}

	reported := 0
	for _, path := range matches {
		raw, err := os.ReadFile(path)
		if err != nil {
			log.Warn("skipping unreadable command journal entry", "path", path, "error", err.Error())
			continue
		}
		var entry commandJournalEntry
		if err := json.Unmarshal(raw, &entry); err != nil || !journalable(Command{ID: entry.CommandID, Type: entry.Type}) ||
			filepath.Base(path) != entry.CommandID+".json" {
			log.Warn("dropping corrupt command journal entry", "path", path)
			_ = os.Remove(path)
			continue
		}

		if outbox.has(entry.CommandID) {
			_ = os.Remove(path)
			continue
		}
		if !outbox.Enqueue(websocket.CommandResult{
			Type:      "command_result",
			CommandID: entry.CommandID,
			Status:    "failed",
			// Synthetic: no exit was observed. ExitCode is not omitempty, so
			// zero would persist a false "exited 0".
			ExitCode: 1,
			Error:    interruptedCommandError,
		}) {
			continue
		}
		_ = os.Remove(path)
		reported++
		log.Warn("reporting command interrupted by agent restart as failed",
			"commandId", entry.CommandID, "commandType", entry.Type,
			"startedAt", entry.StartedAt.Format(time.RFC3339))
	}
	return reported
}
