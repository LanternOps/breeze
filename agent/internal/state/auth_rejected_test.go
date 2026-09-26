package state

import (
	"path/filepath"
	"testing"
	"time"
)

// #2796: an agent whose credentials the server rejects never takes the
// HTTP-200 path, so LastHeartbeat never advances. UpdateAuthRejected is the
// liveness signal it writes instead, and it must not disturb LastHeartbeat.
func TestUpdateAuthRejectedPreservesLastHeartbeat(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	hb := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	if err := Write(path, &AgentState{Status: StatusRunning, PID: 42, LastHeartbeat: hb}); err != nil {
		t.Fatal(err)
	}
	rejected := hb.Add(10 * time.Minute)
	if err := UpdateAuthRejected(path, rejected); err != nil {
		t.Fatalf("UpdateAuthRejected: %v", err)
	}
	s, err := Read(path)
	if err != nil || s == nil {
		t.Fatalf("read: %v %v", s, err)
	}
	if !s.AuthRejectedAt.Equal(rejected) {
		t.Fatalf("AuthRejectedAt = %v, want %v", s.AuthRejectedAt, rejected)
	}
	if !s.LastHeartbeat.Equal(hb) {
		t.Fatalf("LastHeartbeat changed to %v, want %v", s.LastHeartbeat, hb)
	}
	if s.PID != 42 {
		t.Fatalf("PID = %d, want 42", s.PID)
	}
}

func TestUpdateAuthRejectedRecreatesMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	now := time.Now().UTC().Truncate(time.Second)
	if err := UpdateAuthRejected(path, now); err != nil {
		t.Fatalf("UpdateAuthRejected on missing file: %v", err)
	}
	s, err := Read(path)
	if err != nil || s == nil {
		t.Fatalf("read: %v %v", s, err)
	}
	if !s.AuthRejectedAt.Equal(now) || s.PID == 0 {
		t.Fatalf("recreated state = %+v", s)
	}
}

// A successful heartbeat clears the marker: the credentials work again.
func TestUpdateHeartbeatClearsAuthRejected(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	now := time.Now().UTC().Truncate(time.Second)
	if err := UpdateAuthRejected(path, now); err != nil {
		t.Fatal(err)
	}
	if err := UpdateHeartbeat(path, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	s, err := Read(path)
	if err != nil || s == nil {
		t.Fatalf("read: %v %v", s, err)
	}
	if !s.AuthRejectedAt.IsZero() {
		t.Fatalf("AuthRejectedAt = %v, want zero after a successful heartbeat", s.AuthRejectedAt)
	}
}
