package state

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteAndRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)

	now := time.Now().Truncate(time.Second)
	hb := now.Add(-30 * time.Second)

	s := &AgentState{
		Status:        StatusRunning,
		PID:           12345,
		Version:       "1.2.3",
		LastHeartbeat: hb,
		Timestamp:     now,
	}

	if err := Write(path, s); err != nil {
		t.Fatalf("Write: %v", err)
	}

	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got == nil {
		t.Fatal("Read returned nil, want state")
	}

	if got.Status != StatusRunning {
		t.Errorf("Status = %q, want %q", got.Status, StatusRunning)
	}
	if got.PID != 12345 {
		t.Errorf("PID = %d, want 12345", got.PID)
	}
	if got.Version != "1.2.3" {
		t.Errorf("Version = %q, want %q", got.Version, "1.2.3")
	}
	if !got.LastHeartbeat.Equal(hb) {
		t.Errorf("LastHeartbeat = %v, want %v", got.LastHeartbeat, hb)
	}
	if !got.Timestamp.Equal(now) {
		t.Errorf("Timestamp = %v, want %v", got.Timestamp, now)
	}
	if got.Reason != "" {
		t.Errorf("Reason = %q, want empty (omitempty)", got.Reason)
	}
}

func TestWriteStopping(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)

	s := &AgentState{
		Status:    StatusStopping,
		Reason:    ReasonUserStop,
		PID:       99,
		Version:   "0.9.0",
		Timestamp: time.Now(),
	}

	if err := Write(path, s); err != nil {
		t.Fatalf("Write: %v", err)
	}

	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got == nil {
		t.Fatal("Read returned nil")
	}
	if got.Status != StatusStopping {
		t.Errorf("Status = %q, want %q", got.Status, StatusStopping)
	}
	if got.Reason != ReasonUserStop {
		t.Errorf("Reason = %q, want %q", got.Reason, ReasonUserStop)
	}
	if got.PID != 99 {
		t.Errorf("PID = %d, want 99", got.PID)
	}
}

func TestReadMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nonexistent.state")

	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read on missing file should return nil error, got: %v", err)
	}
	if got != nil {
		t.Errorf("Read on missing file should return nil state, got: %+v", got)
	}
}

func TestReadCorrupt(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)

	if err := os.WriteFile(path, []byte("this is not json {{{"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	got, err := Read(path)
	if err == nil {
		t.Fatalf("Read on corrupt file should return error, got nil (state: %+v)", got)
	}
	if got != nil {
		t.Errorf("Read on corrupt file should return nil state, got: %+v", got)
	}
}

func TestUpdateHeartbeat(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)

	initial := time.Now().Add(-2 * time.Minute).Truncate(time.Second)
	s := &AgentState{
		Status:        StatusRunning,
		PID:           1,
		Version:       "1.0.0",
		LastHeartbeat: initial,
		Timestamp:     initial,
	}
	if err := Write(path, s); err != nil {
		t.Fatalf("Write: %v", err)
	}

	newHB := time.Now().Truncate(time.Second)
	before := time.Now()
	if err := UpdateHeartbeat(path, newHB); err != nil {
		t.Fatalf("UpdateHeartbeat: %v", err)
	}
	after := time.Now()

	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read after UpdateHeartbeat: %v", err)
	}
	if got == nil {
		t.Fatal("Read returned nil after UpdateHeartbeat")
	}

	if !got.LastHeartbeat.Equal(newHB) {
		t.Errorf("LastHeartbeat = %v, want %v", got.LastHeartbeat, newHB)
	}
	// Timestamp should have been updated to approximately now
	if got.Timestamp.Before(before) || got.Timestamp.After(after.Add(time.Second)) {
		t.Errorf("Timestamp = %v, expected between %v and %v", got.Timestamp, before, after)
	}
	// Status should be unchanged
	if got.Status != StatusRunning {
		t.Errorf("Status changed to %q, want %q", got.Status, StatusRunning)
	}
}

func TestUpdateHeartbeatMissingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nonexistent.state")

	err := UpdateHeartbeat(path, time.Now())
	if err == nil {
		t.Fatal("UpdateHeartbeat on missing file should return error")
	}
}

func TestPathInDir(t *testing.T) {
	dir := "/some/config/dir"
	got := PathInDir(dir)
	want := filepath.Join(dir, FileName)
	if got != want {
		t.Errorf("PathInDir(%q) = %q, want %q", dir, got, want)
	}
}

func TestWriteAtomicNoTmpOnSuccess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)

	s := &AgentState{
		Status:    StatusRunning,
		PID:       1,
		Version:   "1.0.0",
		Timestamp: time.Now(),
	}
	if err := Write(path, s); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Verify no .tmp file was left behind
	tmpPath := path + ".tmp"
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Errorf("tmp file %q should not exist after successful write", tmpPath)
	}
}
