package backup

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const resumeStateFile = "resume-state.json"

// ResumeState tracks which files have been restored so a partial restore can
// be resumed without re-downloading completed files.
type ResumeState struct {
	SnapshotID     string          `json:"snapshotId"`
	CompletedFiles map[string]bool `json:"completedFiles"` // backupPath -> true
	BytesRestored  int64           `json:"bytesRestored"`
}

// LoadResumeState reads resume state from the staging directory.
// Returns (nil, nil) if the state file does not exist.
func LoadResumeState(stagingDir string) (*ResumeState, error) {
	p := filepath.Join(stagingDir, resumeStateFile)
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read resume state: %w", err)
	}

	var state ResumeState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("decode resume state: %w", err)
	}
	return &state, nil
}

// SaveResumeState writes resume state atomically (write temp, rename).
func SaveResumeState(stagingDir string, state *ResumeState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("encode resume state: %w", err)
	}

	tmpFile, err := os.CreateTemp(stagingDir, "resume-state-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp resume state: %w", err)
	}
	tmpPath := tmpFile.Name()

	if _, err := tmpFile.Write(data); err != nil {
		_ = tmpFile.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write resume state: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close resume state: %w", err)
	}

	target := filepath.Join(stagingDir, resumeStateFile)
	if err := os.Rename(tmpPath, target); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename resume state: %w", err)
	}
	return nil
}

// CleanupResumeState removes the resume state file from the staging directory.
func CleanupResumeState(stagingDir string) error {
	p := filepath.Join(stagingDir, resumeStateFile)
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("cleanup resume state: %w", err)
	}
	return nil
}
