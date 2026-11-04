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
