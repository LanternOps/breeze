// Package desktopfence persists the SEC-038 remote-desktop start fence across
// agent restarts.
//
// The fence itself (high-water generation + terminal tombstone per session)
// lives in the heartbeat package; this package is only the durable half. It
// follows the atomic-write pattern of internal/rollback: temp file in the
// state directory, fsync, then an atomic replace (rename on POSIX, MoveFileEx
// with REPLACE_EXISTING|WRITE_THROUGH on Windows) so a crash mid-write leaves
// either the old file or the new one, never a torn one.
//
// Generations are int64 on the agent and bigint on the server, and they never
// pass through a float — so on disk they are canonical decimal strings, and
// any other spelling (a JSON number, "007", a negative) is treated as
// corruption rather than coerced.
package desktopfence

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

// ErrCorrupt is returned by Load when the state file exists but cannot be
// trusted. The file has already been moved aside to <path>.corrupt so the
// next Save starts clean and the bad bytes are kept for forensics.
var ErrCorrupt = errors.New("desktop fence state is corrupt")

const schemaVersion = 1

// Entry is the durable fence record for one remote session.
type Entry struct {
	// HighWater is the highest start generation admitted for this session.
	HighWater int64
	// HasHighWater distinguishes "generation 0 seen" from "nothing seen".
	HasHighWater bool
	// HighWaterCommandID is the command that claimed HighWater, so a duplicate
	// delivery of that exact command rejoins the in-flight call instead of
	// being refused. Process-local: the call it would join dies with the
	// process, so it is never persisted and a replay after restart cannot use
	// it.
	HighWaterCommandID string
	// Terminal is the absolute tombstone: no start is ever admitted again.
	Terminal bool
	// SyncedGeneration is the server's current generation as last echoed in a
	// lease-renew answer; a start below it is stale relative to the server.
	SyncedGeneration int64
	// Synced is true once a lease-renew answer has been applied IN THIS
	// PROCESS. Process-local and never persisted: a file written before a
	// failed terminal write can be valid yet stale, so every loaded
	// non-terminal entry must be re-confirmed by the control plane before a
	// start is admitted on it.
	Synced bool
	// UpdatedAtUnixMs orders entries for eviction.
	UpdatedAtUnixMs int64
}

// State is the whole fence as persisted.
type State struct {
	Sessions map[string]Entry
}

// wire types keep the on-disk shape explicit and the generations as strings.
type wireEntry struct {
	HighWater        string `json:"highWater,omitempty"`
	HasHighWater     bool   `json:"hasHighWater,omitempty"`
	Terminal         bool   `json:"terminal,omitempty"`
	SyncedGeneration string `json:"syncedGeneration,omitempty"`
	UpdatedAtUnixMs  int64  `json:"updatedAtUnixMs,omitempty"`
}

type wireState struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Sessions      map[string]wireEntry `json:"sessions"`
}

// Store reads and writes one fence state file.
type Store struct {
	path string
	mu   sync.Mutex
}

// NewStore returns a store for the given file. Nothing is touched until Load
// or Save.
func NewStore(path string) *Store { return &Store{path: path} }

// Path returns the state file location.
func (s *Store) Path() string { return s.path }

// Load reads the state file. A missing file yields an empty State and no
// error; a file that cannot be decoded is quarantined and ErrCorrupt is
// returned (wrapped, with the decode reason).
func (s *Store) Load() (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	state := State{Sessions: map[string]Entry{}}
	payload, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	decoded, decodeErr := decodeState(payload)
	if decodeErr != nil {
		s.quarantineLocked()
		return State{Sessions: map[string]Entry{}}, fmt.Errorf("%w: %v", ErrCorrupt, decodeErr)
	}
	return decoded, nil
}

func decodeState(payload []byte) (State, error) {
	var wire wireState
	if err := json.Unmarshal(payload, &wire); err != nil {
		return State{}, err
	}
	if wire.SchemaVersion != schemaVersion {
		return State{}, fmt.Errorf("unsupported schema version %d", wire.SchemaVersion)
	}
	state := State{Sessions: make(map[string]Entry, len(wire.Sessions))}
	for id, w := range wire.Sessions {
		hw, err := parseGeneration(w.HighWater)
		if err != nil {
			return State{}, fmt.Errorf("session %q highWater: %w", id, err)
		}
		sg, err := parseGeneration(w.SyncedGeneration)
		if err != nil {
			return State{}, fmt.Errorf("session %q syncedGeneration: %w", id, err)
		}
		state.Sessions[id] = Entry{
			HighWater:        hw,
			HasHighWater:     w.HasHighWater,
			Terminal:         w.Terminal,
			SyncedGeneration: sg,
			UpdatedAtUnixMs:  w.UpdatedAtUnixMs,
		}
	}
	return state, nil
}

// parseGeneration accepts "" (zero) or a canonical non-negative decimal.
func parseGeneration(s string) (int64, error) {
	if s == "" {
		return 0, nil
	}
	gen, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, err
	}
	if gen < 0 || strconv.FormatInt(gen, 10) != s {
		return 0, fmt.Errorf("not a canonical decimal generation: %q", s)
	}
	return gen, nil
}

func formatGeneration(gen int64) string {
	if gen == 0 {
		return ""
	}
	return strconv.FormatInt(gen, 10)
}

// quarantineLocked moves an undecodable file aside. Best effort: if the
// rename fails the next Save's atomic replace overwrites it anyway.
func (s *Store) quarantineLocked() {
	_ = os.Remove(s.path + ".corrupt")
	_ = os.Rename(s.path, s.path+".corrupt")
}

// Save atomically replaces the state file with state.
func (s *Store) Save(state State) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	wire := wireState{SchemaVersion: schemaVersion, Sessions: make(map[string]wireEntry, len(state.Sessions))}
	for id, e := range state.Sessions {
		wire.Sessions[id] = wireEntry{
			HighWater:        formatGeneration(e.HighWater),
			HasHighWater:     e.HasHighWater,
			Terminal:         e.Terminal,
			SyncedGeneration: formatGeneration(e.SyncedGeneration),
			UpdatedAtUnixMs:  e.UpdatedAtUnixMs,
		}
	}
	payload, err := json.Marshal(wire)
	if err != nil {
		return err
	}

	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".desktop-fence-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	ok := false
	defer func() {
		_ = tmp.Close()
		if !ok {
			_ = os.Remove(name)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(payload); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := replaceStateFile(name, s.path); err != nil {
		return err
	}
	if err := syncStateDir(s.path); err != nil {
		return err
	}
	ok = true
	return nil
}
