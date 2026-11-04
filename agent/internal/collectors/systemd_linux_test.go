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

// useCronFile points the change tracker at one temporary crontab, so these
// tests never read the host's cron paths, which an unprivileged runner can't.
func useCronFile(t *testing.T, content string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "crontab")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	prev := linuxCronFiles
	linuxCronFiles = func() ([]string, error) { return []string{path}, nil }
	t.Cleanup(func() { linuxCronFiles = prev })
}

func TestChangeTrackerWithoutSystemdSkipsSystemctl(t *testing.T) {
	setHostSystemd(t, false)
	useCronFile(t, "@reboot /usr/local/bin/boot-task\n0 1 * * * /usr/local/bin/nightly\n")
	rec := recordCollectorCommands(t)
	c := &ChangeTrackerCollector{}
	startup, err := c.collectStartupItems(t.Context())
	if err != nil {
		t.Fatalf("startup err: %v", err)
	}
	if len(startup) != 1 || startup[0].Type != "cron" || startup[0].Name != "boot-task" {
		t.Fatalf("want only the @reboot cron item, got %+v", startup)
	}
	tasks, err := c.collectScheduledTasks(t.Context())
	if err != nil {
		t.Fatalf("tasks err: %v", err)
	}
	if len(tasks) != 2 || tasks[0].Name != "boot-task" || tasks[1].Name != "nightly" {
		t.Fatalf("want only the two cron tasks, got %+v", tasks)
	}
	if rec.count() != 0 {
		t.Fatalf("spawned %v without systemd", rec.calls)
	}
}

func TestChangeTrackerWithSystemdRunsSystemctl(t *testing.T) {
	setHostSystemd(t, true)
	useCronFile(t, "")
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
