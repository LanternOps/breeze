package helper

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/yaml.v3"
)

// Status represents the helper_status.yaml file written by the Breeze Helper app.
type Status struct {
	Version      string    `yaml:"version"`
	ChatActive   bool      `yaml:"chat_active"`
	LastActivity time.Time `yaml:"last_activity"`
	PID          int       `yaml:"pid"`
}

// idleTimeout is how long since last activity before we consider the helper idle
// even if chat_active is still true (covers crashes/hangs).
const idleTimeout = 5 * time.Minute

// ReadStatus reads and parses the helper_status.yaml file.
func ReadStatus(configPath string) (*Status, error) {
	statusPath := statusPathFrom(configPath)
	data, err := os.ReadFile(statusPath)
	if err != nil {
		return nil, fmt.Errorf("read helper status: %w", err)
	}
	var s Status
	if err := yaml.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("parse helper status: %w", err)
	}
	return &s, nil
}

// IsIdle returns true if the helper is not actively chatting.
// Returns true (idle) when:
//   - Status file doesn't exist or can't be read
//   - chat_active is false
//   - last_activity is older than idleTimeout
//   - PID in file doesn't match a running process
func IsIdle(configPath string) bool {
	status, err := ReadStatus(configPath)
	if err != nil {
		return true // can't read = treat as idle
	}

	// If chat not active, it's idle
	if !status.ChatActive {
		return true
	}

	// If last activity is stale, treat as idle (crash/hang recovery)
	if time.Since(status.LastActivity) > idleTimeout {
		return true
	}

	// Check if the PID is still alive
	if status.PID > 0 && !processExists(status.PID) {
		return true
	}

	return false
}

// statusPathFrom derives the status file path from the config path.
// e.g., /Library/Application Support/Breeze/helper_config.yaml -> helper_status.yaml
func statusPathFrom(configPath string) string {
	dir := filepath.Dir(configPath)
	return filepath.Join(dir, "helper_status.yaml")
}
