package main

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
)

// A ~200k-file verify must not send one IPC/WS progress message per file
// (each costs a server-side lookup); it sends one per interval plus the
// final count.
func TestVerifyProgressReporter_ThrottlesAndAlwaysSendsFinal(t *testing.T) {
	clock := time.Unix(0, 0)
	now := func() time.Time { return clock }
	var sent []backupipc.BackupProgress
	report := newVerifyProgressReporter(func(p backupipc.BackupProgress) { sent = append(sent, p) },
		"cmd-1", "verifying", 30*time.Second, now)

	for done := 1; done <= 100; done++ {
		clock = clock.Add(time.Second)
		report(done, 100)
	}

	want := []int{30, 60, 90, 100}
	if len(sent) != len(want) {
		t.Fatalf("sent %d progress messages (%+v), want %d", len(sent), sent, len(want))
	}
	for i, p := range sent {
		if p.FilesDone != want[i] || p.FilesTotal != 100 || p.Current != int64(want[i]) || p.Total != 100 {
			t.Fatalf("message %d = %+v, want filesDone=current=%d of 100", i, p, want[i])
		}
		if p.CommandID != "cmd-1" || p.Phase != "verifying" {
			t.Fatalf("message %d = %+v, want commandId cmd-1 phase verifying", i, p)
		}
	}
}

func TestVerifyProgressReporter_NilSendStillSafe(t *testing.T) {
	report := newVerifyProgressReporter(nil, "cmd-2", "test_restore", time.Nanosecond, time.Now)
	report(1, 2)
	report(2, 2)
}
