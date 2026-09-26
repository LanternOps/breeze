//go:build linux

package rebuild

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPollBlkid_WaitsForLatePartitionNode(t *testing.T) {
	calls := 0
	probe := func(string) ([]byte, error) {
		calls++
		if calls < 4 {
			return nil, errors.New("exit status 2") // node not there yet / probe empty
		}
		return []byte("TYPE=ext4\n"), nil
	}
	out, err := pollBlkid("/dev/loop9p3", 2*time.Second, time.Millisecond, probe)
	if err != nil || !strings.Contains(out, "TYPE=ext4") || calls != 4 {
		t.Fatalf("out=%q err=%v calls=%d", out, err, calls)
	}
}

func TestPollBlkid_TimeoutReportsDiagnostics(t *testing.T) {
	probe := func(string) ([]byte, error) { return nil, errors.New("exit status 2") }
	_, err := pollBlkid("/dev/loop9p3", 50*time.Millisecond, time.Millisecond, probe)
	if err == nil || !strings.Contains(err.Error(), "/dev/loop9p3") || !strings.Contains(err.Error(), "exit status 2") {
		t.Fatalf("want diagnostic error naming device and last error, got %v", err)
	}
}
