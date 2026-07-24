package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const FileName = "agent.state"

const (
	// StatusStarting is written early in startup, before the agent is fully
	// initialized, so the watchdog records THIS process's live PID rather than
	// a stale PID from a prior run if startup wedges. It flips to
	// StatusRunning once startup completes. The watchdog does not branch on
	// Status (only PID / LastHeartbeat / IPC drive health decisions), so this
	// is purely an accurate-PID and diagnostic signal.
	StatusStarting = "starting"
	StatusRunning  = "running"
	StatusStopping = "stopping"
	StatusStopped  = "stopped"
)

const (
	ReasonUserStop     = "user_stop"
	ReasonUpdate       = "update"
	ReasonConfigReload = "config_reload"
)

type AgentState struct {
	Status        string    `json:"status"`
	Reason        string    `json:"reason,omitempty"`
	PID           int       `json:"pid"`
	Version       string    `json:"version"`
	LastHeartbeat time.Time `json:"last_heartbeat,omitempty"`
	Timestamp     time.Time `json:"timestamp"`
}

// Rename retry bounds. The Windows renameReplace primitive uses POSIX rename
// semantics so a concurrent reader (the watchdog polling agent.state) never
// blocks the swap — that was the 2026-07-22 US prod restart-storm root cause,
// where MoveFileEx(REPLACE_EXISTING) failed ~78% of the time under a live
// reader. The bounded backoff remains a secondary safety net for a genuinely
// exclusive holder (third-party AV/search indexers briefly locking the fresh
// file with no share access at all), which POSIX rename cannot bypass.
const (
	renameAttempts    = 4
	renameBackoffBase = 25 * time.Millisecond
)

// renameStateFile is a seam for tests to inject rename failures. It defaults to
// renameReplace: POSIX-semantics rename on Windows, os.Rename elsewhere.
var renameStateFile = renameReplace

// Write atomically writes the state file as JSON.
func Write(path string, s *AgentState) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("write temp state: %w", err)
	}
	var renameErr error
	for attempt := 0; attempt < renameAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(renameBackoffBase << (attempt - 1))
		}
		if renameErr = renameStateFile(tmpPath, path); renameErr == nil {
			return nil
		}
	}
	_ = os.Remove(tmpPath)
	// Name the attempt count: a caller's warn log must distinguish "failed
	// instantly once" from "destination held across ~175ms of retries" —
	// the AV-scan-vs-wedged-reader distinction incident forensics hinge on.
	return fmt.Errorf("rename state file after %d attempts: %w", renameAttempts, renameErr)
}

// Read reads the state file. Returns nil, nil if the file doesn't exist.
func Read(path string) (*AgentState, error) {
	data, err := readStateFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read state: %w", err)
	}
	var s AgentState
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("unmarshal state: %w", err)
	}
	return &s, nil
}

// UpdateHeartbeat updates only the last_heartbeat field in the state file.
func UpdateHeartbeat(path string, t time.Time) error {
	s, err := Read(path)
	if err != nil {
		return err
	}
	if s == nil {
		return fmt.Errorf("state file not found")
	}
	s.LastHeartbeat = t
	s.Timestamp = time.Now()
	return Write(path, s)
}

// PathInDir returns the full path to agent.state in the given config directory.
func PathInDir(configDir string) string {
	return filepath.Join(configDir, FileName)
}
