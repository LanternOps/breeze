package state

import (
	"fmt"
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

func TestWriteStarting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)

	// The early startup write records the live PID with StatusStarting and a
	// zero LastHeartbeat (startup grace), so the watchdog sees the live process
	// rather than a prior run's stale PID. See #1029.
	s := &AgentState{
		Status:    StatusStarting,
		PID:       4321,
		Version:   "2.0.0",
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
	if got.Status != StatusStarting {
		t.Errorf("Status = %q, want %q", got.Status, StatusStarting)
	}
	if got.PID != 4321 {
		t.Errorf("PID = %d, want 4321", got.PID)
	}
	if !got.LastHeartbeat.IsZero() {
		t.Errorf("LastHeartbeat = %v, want zero (startup grace)", got.LastHeartbeat)
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

// Behavior change (#2763): UpdateHeartbeat used to return an error for a
// missing state file and leave it missing. That error was decorative — the
// only caller logs a warning and continues — while the real consequence was
// permanent: read-modify-write with no create path meant the agent never
// recorded another heartbeat for the life of the process, and the watchdog
// restarted a healthy agent until it burned its 24h budget. It now recreates
// the file; see TestUpdateHeartbeatRecreatesMissingFile for the contract.
func TestUpdateHeartbeatMissingFileRecreatesRatherThanErroring(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nonexistent.state")

	if err := UpdateHeartbeat(path, time.Now()); err != nil {
		t.Fatalf("UpdateHeartbeat on a missing file must recreate it, got error: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("state file was not created: %v", err)
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

func TestWriteRetriesTransientRenameFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)

	// Fail the first two rename attempts the way a Windows sharing violation
	// would, then let the real rename through.
	calls := 0
	renameStateFile = func(oldpath, newpath string) error {
		calls++
		if calls <= 2 {
			return fmt.Errorf("simulated sharing violation")
		}
		return os.Rename(oldpath, newpath)
	}
	defer func() { renameStateFile = renameReplace }()

	s := &AgentState{Status: StatusRunning, PID: 7, Version: "1.0.0", Timestamp: time.Now()}
	if err := Write(path, s); err != nil {
		t.Fatalf("Write should succeed after transient rename failures: %v", err)
	}
	if calls != 3 {
		t.Errorf("rename calls = %d, want 3", calls)
	}

	got, err := Read(path)
	if err != nil || got == nil {
		t.Fatalf("Read after retried write: state=%+v err=%v", got, err)
	}
	if got.PID != 7 {
		t.Errorf("PID = %d, want 7", got.PID)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("tmp file should not remain after successful retried write")
	}
}

func TestWritePersistentRenameFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)

	calls := 0
	renameStateFile = func(oldpath, newpath string) error {
		calls++
		return fmt.Errorf("simulated persistent sharing violation")
	}
	defer func() { renameStateFile = renameReplace }()

	s := &AgentState{Status: StatusRunning, PID: 7, Version: "1.0.0", Timestamp: time.Now()}
	err := Write(path, s)
	if err == nil {
		t.Fatal("Write should fail when every rename attempt fails")
	}
	if calls != renameAttempts {
		t.Errorf("rename calls = %d, want %d", calls, renameAttempts)
	}
	if _, statErr := os.Stat(path + ".tmp"); !os.IsNotExist(statErr) {
		t.Errorf("tmp file should be removed after exhausting rename attempts")
	}
}

// A missing agent.state must be recreated by UpdateHeartbeat, not error
// forever. Without this, one lost file (AV/EDR quarantine, or a startup Write
// that lost its rename to a sharing violation) means the agent never records
// another heartbeat for the life of the process, and the watchdog restarts a
// healthy agent until it burns its 24h budget (#2763).
func TestUpdateHeartbeatRecreatesMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.state")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("precondition: state file should not exist")
	}
	hb := time.Now().Truncate(time.Second)
	if err := UpdateHeartbeat(path, hb); err != nil {
		t.Fatalf("UpdateHeartbeat on missing file: %v", err)
	}
	s, err := Read(path)
	if err != nil {
		t.Fatalf("Read after recreate: %v", err)
	}
	if s == nil {
		t.Fatal("state file was not recreated")
	}
	if !s.LastHeartbeat.Equal(hb) {
		t.Fatalf("LastHeartbeat = %v, want %v", s.LastHeartbeat, hb)
	}
	if s.PID != os.Getpid() {
		t.Fatalf("PID = %d, want %d (a zero PID silently disables the watchdog process check)", s.PID, os.Getpid())
	}
}

// Recreating must never clobber fields of an existing file.
func TestUpdateHeartbeatPreservesExistingFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.state")
	orig := &AgentState{Status: StatusRunning, PID: 4242, Version: "9.9.9", Reason: ReasonUpdate}
	if err := Write(path, orig); err != nil {
		t.Fatalf("seed Write: %v", err)
	}
	hb := time.Now().Truncate(time.Second)
	if err := UpdateHeartbeat(path, hb); err != nil {
		t.Fatalf("UpdateHeartbeat: %v", err)
	}
	s, err := Read(path)
	if err != nil || s == nil {
		t.Fatalf("Read: %v", err)
	}
	if s.Status != StatusRunning || s.PID != 4242 || s.Version != "9.9.9" || s.Reason != ReasonUpdate {
		t.Fatalf("existing fields clobbered: %+v", s)
	}
	if !s.LastHeartbeat.Equal(hb) {
		t.Fatalf("LastHeartbeat = %v, want %v", s.LastHeartbeat, hb)
	}
}
