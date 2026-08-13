package main

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

func TestDecideWatchdogServerURL(t *testing.T) {
	cases := []struct {
		name     string
		current  string
		lastDisk string
		reloaded config.Config
		failures int
		want     string
	}{
		{"agent already swapped on disk: follow it", "https://old.example.com", "https://old.example.com",
			config.Config{ServerURL: "https://new.example.com"}, 1, "https://new.example.com"},
		{"below threshold, no swap on disk: stay", "https://old.example.com", "https://old.example.com",
			config.Config{ServerURL: "https://old.example.com", BackupServerURL: "https://new.example.com"}, 9, "https://old.example.com"},
		{"at threshold with backup: transient backup", "https://old.example.com", "https://old.example.com",
			config.Config{ServerURL: "https://old.example.com", BackupServerURL: "https://new.example.com"}, 10, "https://new.example.com"},
		{"at threshold without backup: stay", "https://old.example.com", "https://old.example.com",
			config.Config{ServerURL: "https://old.example.com"}, 10, "https://old.example.com"},
		// The flap-back regression: watchdog already switched transiently to
		// the backup, disk still holds the unchanged primary. The stale disk
		// value must NOT read as "agent swapped on disk" (that comparison is
		// anchored to lastDisk, not the client's own mutable URL), and between
		// threshold multiples the transient choice must stick.
		{"on transient backup, disk unchanged, off-boundary: stick", "https://new.example.com", "https://old.example.com",
			config.Config{ServerURL: "https://old.example.com", BackupServerURL: "https://new.example.com"}, 11, "https://new.example.com"},
		// At the next threshold multiple, alternate back to the disk URL so
		// whichever control plane recovers first wins.
		{"on transient backup, next threshold multiple: alternate to disk URL", "https://new.example.com", "https://old.example.com",
			config.Config{ServerURL: "https://old.example.com", BackupServerURL: "https://new.example.com"}, 20, "https://old.example.com"},
		// Disk swap always wins, even while on the transient backup.
		{"on transient backup, agent swapped disk to third URL: follow it", "https://new.example.com", "https://old.example.com",
			config.Config{ServerURL: "https://third.example.com", BackupServerURL: "https://old.example.com"}, 11, "https://third.example.com"},
		// Agent persisted the same URL the watchdog already runs on: no
		// switch needed, stay (the caller advances lastDisk from the reload).
		{"disk caught up to transient choice: stay", "https://new.example.com", "https://old.example.com",
			config.Config{ServerURL: "https://new.example.com", BackupServerURL: "https://old.example.com"}, 11, "https://new.example.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decideWatchdogServerURL(tc.current, tc.lastDisk, &tc.reloaded, tc.failures)
			if got != tc.want {
				t.Fatalf("decideWatchdogServerURL(%q, %q, ..., %d) = %q, want %q", tc.current, tc.lastDisk, tc.failures, got, tc.want)
			}
		})
	}
}

// TestDecideWatchdogServerURLBothDownSequence drives the decision the way the
// poll loop does — carrying current and lastDisk across ticks — with both
// control planes unreachable and nothing changing on disk. The watchdog must
// switch only at threshold multiples (10, 20, 30, ...), never on the
// off-boundary ticks that the flap-back bug used to flip on.
func TestDecideWatchdogServerURLBothDownSequence(t *testing.T) {
	const primary = "https://old.example.com"
	const backup = "https://new.example.com"
	reloaded := &config.Config{ServerURL: primary, BackupServerURL: backup}

	current, lastDisk := primary, primary
	var switches []int
	for failures := 1; failures <= 30; failures++ {
		next := decideWatchdogServerURL(current, lastDisk, reloaded, failures)
		if next != current {
			switches = append(switches, failures)
			current = next
		}
		lastDisk = reloaded.ServerURL // what noteFailoverHeartbeatFailure carries forward
	}

	want := []int{10, 20, 30}
	if len(switches) != len(want) {
		t.Fatalf("switch ticks = %v, want %v", switches, want)
	}
	for i := range want {
		if switches[i] != want[i] {
			t.Fatalf("switch ticks = %v, want %v", switches, want)
		}
	}
	if current != backup { // 10→backup, 20→primary, 30→backup
		t.Fatalf("after tick 30 current = %q, want %q", current, backup)
	}
}
