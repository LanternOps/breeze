//go:build linux

package collectors

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setHostSystemd(t *testing.T, v bool) {
	t.Helper()
	prev := hostHasSystemd
	hostHasSystemd = func() bool { return v }
	t.Cleanup(func() { hostHasSystemd = prev })
}

func TestSystemdBooted(t *testing.T) {
	dir := t.TempDir()
	if !systemdBooted(dir) {
		t.Fatal("directory should count as booted")
	}
	if systemdBooted(filepath.Join(dir, "missing")) {
		t.Fatal("missing path should not count as booted")
	}
	file := filepath.Join(dir, "file")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if systemdBooted(file) {
		t.Fatal("regular file should not count as booted")
	}
	// Only a definite absence closes the gate for the life of the process. A
	// stat that fails some other way (ENOTDIR here) leaves collection running.
	if !systemdBooted(filepath.Join(file, "child")) {
		t.Fatal("a stat error other than not-exist should not count as absent")
	}
}

func TestQueryJournalWithoutSystemdDoesNotSpawn(t *testing.T) {
	setHostSystemd(t, false)
	rec := recordCollectorCommands(t)
	c := NewEventLogCollector()
	entries, err := c.Collect()
	if err != nil || len(entries) != 0 {
		t.Fatalf("entries=%v err=%v", entries, err)
	}
	if rec.count() != 0 {
		t.Fatalf("spawned %v without systemd", rec.calls)
	}
}

func TestQueryJournalWithSystemdRunsJournalctl(t *testing.T) {
	setHostSystemd(t, true)
	useFakeBinary(t, "journalctl", `echo '{"__CURSOR":"c1","__REALTIME_TIMESTAMP":"1700000000000000","SYSLOG_IDENTIFIER":"sshd","MESSAGE":"Failed password for x","PRIORITY":"4"}'`)
	rec := recordCollectorCommands(t)
	c := NewEventLogCollector()
	entries, err := c.queryJournal(c.lastCollectTime, "SYSLOG_IDENTIFIER=sshd")
	if err != nil || len(entries) != 1 || entries[0].Message != "Failed password for x" {
		t.Fatalf("entries=%v err=%v", entries, err)
	}
	if rec.count() != 1 || !strings.HasPrefix(rec.calls[0], "journalctl --output=json --no-pager --since ") ||
		!strings.HasSuffix(rec.calls[0], " -n 50 SYSLOG_IDENTIFIER=sshd") {
		t.Fatalf("calls=%v", rec.calls)
	}
}

func TestCollectServicesWithoutSystemd(t *testing.T) {
	setHostSystemd(t, false)
	rec := recordCollectorCommands(t)
	svcs, err := collectServices()
	if err != nil || svcs == nil || len(svcs) != 0 {
		t.Fatalf("svcs=%#v err=%v", svcs, err)
	}
	if rec.count() != 0 {
		t.Fatalf("spawned %v without systemd", rec.calls)
	}
}

func TestCollectServicesWithSystemd(t *testing.T) {
	setHostSystemd(t, true)
	useFakeBinary(t, "systemctl", `case "$1" in
list-unit-files) echo 'sshd.service enabled enabled';;
list-units) echo 'sshd.service loaded active running OpenSSH';;
esac`)
	rec := recordCollectorCommands(t)
	svcs, err := collectServices()
	if err != nil || len(svcs) != 1 || svcs[0].Name != "sshd" || svcs[0].State != "running" || svcs[0].StartupType != "automatic" {
		t.Fatalf("svcs=%#v err=%v", svcs, err)
	}
	if rec.count() != 2 || !strings.HasPrefix(rec.calls[0], "systemctl list-unit-files --type=service") ||
		!strings.HasPrefix(rec.calls[1], "systemctl list-units --type=service --all") {
		t.Fatalf("calls=%v", rec.calls)
	}
}

// cronRoot is unused by the collectors (they read absolute paths), so these
// tests only assert on systemd-sourced items and on the absence of errors.

func TestChangeTrackerWithoutSystemdSkipsSystemctl(t *testing.T) {
	setHostSystemd(t, false)
	rec := recordCollectorCommands(t)
	c := &ChangeTrackerCollector{}
	startup, err := c.collectStartupItems(t.Context())
	if err != nil {
		t.Fatalf("startup err: %v", err)
	}
	for _, it := range startup {
		if it.Type == "systemd" {
			t.Fatalf("systemd item without systemd: %+v", it)
		}
	}
	tasks, err := c.collectScheduledTasks(t.Context())
	if err != nil {
		t.Fatalf("tasks err: %v", err)
	}
	for _, it := range tasks {
		if strings.HasSuffix(it.Path, ".timer") {
			t.Fatalf("timer item without systemd: %+v", it)
		}
	}
	if rec.count() != 0 {
		t.Fatalf("spawned %v without systemd", rec.calls)
	}
}

func TestChangeTrackerWithSystemdRunsSystemctl(t *testing.T) {
	setHostSystemd(t, true)
	useFakeBinary(t, "systemctl", `case "$1" in
list-unit-files) echo 'cron.service enabled enabled';;
list-timers) echo 'Mon 2026-01-01 00:00:00 UTC 1h left n/a n/a backup.timer backup.service';;
esac`)
	rec := recordCollectorCommands(t)
	c := &ChangeTrackerCollector{}
	startup, err := c.collectStartupItems(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	foundUnit := false
	for _, it := range startup {
		foundUnit = foundUnit || (it.Type == "systemd" && it.Path == "cron.service")
	}
	tasks, err := c.collectScheduledTasks(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	foundTimer := false
	for _, it := range tasks {
		foundTimer = foundTimer || it.Path == "backup.timer"
	}
	if !foundUnit || !foundTimer {
		t.Fatalf("unit=%v timer=%v", foundUnit, foundTimer)
	}
	if rec.count() != 2 || !strings.HasPrefix(rec.calls[0], "systemctl list-unit-files ") || !strings.HasPrefix(rec.calls[1], "systemctl list-timers --all") {
		t.Fatalf("calls=%v", rec.calls)
	}
}
