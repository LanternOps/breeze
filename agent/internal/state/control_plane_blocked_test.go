package state

import (
	"path/filepath"
	"testing"
	"time"
)

// #8868: the blocked-control-plane marker records liveness without pretending
// the heartbeat succeeded.
func TestUpdateControlPlaneBlocked_PreservesLastHeartbeat(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	hb := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)
	if err := Write(path, &AgentState{Status: StatusRunning, PID: 42, LastHeartbeat: hb}); err != nil {
		t.Fatal(err)
	}
	at := hb.Add(10 * time.Minute)
	if err := UpdateControlPlaneBlocked(path, at); err != nil {
		t.Fatalf("UpdateControlPlaneBlocked: %v", err)
	}
	s, err := Read(path)
	if err != nil || s == nil {
		t.Fatalf("read: %v %v", s, err)
	}
	if !s.ControlPlaneBlockedAt.Equal(at) {
		t.Fatalf("ControlPlaneBlockedAt = %v, want %v", s.ControlPlaneBlockedAt, at)
	}
	if !s.LastHeartbeat.Equal(hb) || s.PID != 42 {
		t.Fatalf("UpdateControlPlaneBlocked clobbered other fields: %+v", s)
	}
}

func TestUpdateHeartbeat_ZeroesControlPlaneBlocked(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	now := time.Now().UTC().Truncate(time.Second)
	if err := UpdateControlPlaneBlocked(path, now); err != nil {
		t.Fatal(err)
	}
	if err := UpdateHeartbeat(path, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	s, err := Read(path)
	if err != nil || s == nil {
		t.Fatalf("read: %v %v", s, err)
	}
	if !s.ControlPlaneBlockedAt.IsZero() {
		t.Fatalf("ControlPlaneBlockedAt = %v after a successful heartbeat, want zero", s.ControlPlaneBlockedAt)
	}
}
