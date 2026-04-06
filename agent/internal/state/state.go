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
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename state file: %w", err)
	}
	return nil
}

// Read reads the state file. Returns nil, nil if the file doesn't exist.
func Read(path string) (*AgentState, error) {
	data, err := os.ReadFile(path)
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
