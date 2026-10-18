package state

import (
	"path/filepath"
	"testing"
	"time"
)

// #8934: the overload marker records liveness without pretending the
// heartbeat succeeded.
func TestUpdateServerUnavailablePreservesLastHeartbeat(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	hb := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)
	if err := Write(path, &AgentState{Status: StatusRunning, PID: 42, LastHeartbeat: hb}); err != nil {
		t.Fatal(err)
	}
	at := hb.Add(10 * time.Minute)
	if err := UpdateServerUnavailable(path, at); err != nil {
		t.Fatalf("UpdateServerUnavailable: %v", err)
	}
	s, err := Read(path)
	if err != nil || s == nil {
		t.Fatalf("read: %v %v", s, err)
	}
	if !s.ServerUnavailableAt.Equal(at) {
		t.Fatalf("ServerUnavailableAt = %v, want %v", s.ServerUnavailableAt, at)
	}
	if !s.LastHeartbeat.Equal(hb) || s.PID != 42 {
		t.Fatalf("UpdateServerUnavailable clobbered other fields: %+v", s)
	}
}

func TestUpdateServerUnavailableRecreatesMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	now := time.Now().UTC().Truncate(time.Second)
	if err := UpdateServerUnavailable(path, now); err != nil {
		t.Fatalf("UpdateServerUnavailable on missing file: %v", err)
	}
	s, err := Read(path)
	if err != nil || s == nil {
		t.Fatalf("read: %v %v", s, err)
	}
	if !s.ServerUnavailableAt.Equal(now) || s.PID == 0 {
		t.Fatalf("recreated state = %+v", s)
	}
}

func TestUpdateHeartbeatClearsServerUnavailable(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	now := time.Now().UTC().Truncate(time.Second)
	if err := UpdateServerUnavailable(path, now); err != nil {
		t.Fatal(err)
	}
	if err := UpdateHeartbeat(path, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	s, err := Read(path)
	if err != nil || s == nil {
		t.Fatalf("read: %v %v", s, err)
	}
	if !s.ServerUnavailableAt.IsZero() {
		t.Fatalf("ServerUnavailableAt = %v, want zero after a successful heartbeat", s.ServerUnavailableAt)
	}
}
