package bmr

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// These tests cover the pure logic in restore_linux_logic.go and must pass
// on every platform (no build tag), including macOS dev machines.

func TestIsExcludedEtcPathExactFileMatches(t *testing.T) {
	cases := []string{"fstab", "machine-id", "hostname"}
	for _, relPath := range cases {
		if !isExcludedEtcPath(relPath) {
			t.Errorf("isExcludedEtcPath(%q) = false, want true", relPath)
		}
	}
}

func TestIsExcludedEtcPathDirectoryMatches(t *testing.T) {
	cases := []string{
		"netplan/01-netcfg.yaml",
		"NetworkManager/system-connections/eth0.nmconnection",
	}
	for _, relPath := range cases {
		if !isExcludedEtcPath(relPath) {
			t.Errorf("isExcludedEtcPath(%q) = false, want true", relPath)
		}
	}
}

func TestIsExcludedEtcPathNetworkInterfacesFileOnly(t *testing.T) {
	if !isExcludedEtcPath("network/interfaces") {
		t.Fatal("isExcludedEtcPath(\"network/interfaces\") = false, want true")
	}
	// Sibling files under etc/network/ that are NOT the excluded file must
	// still be restored — only the exact interfaces file is excluded.
	if isExcludedEtcPath("network/if-up.d/mtu") {
		t.Fatal("isExcludedEtcPath(\"network/if-up.d/mtu\") = true, want false")
	}
}

func TestIsExcludedEtcPathDoesNotOverMatchPrefix(t *testing.T) {
	// "hostname" must not exclude an unrelated file that merely starts
	// with the same characters.
	if isExcludedEtcPath("hostname.d/extra") {
		t.Fatal(`isExcludedEtcPath("hostname.d/extra") = true, want false (must match "hostname" exactly, not as a prefix of a different path segment)`)
	}
}

func TestIsExcludedEtcPathOrdinaryFilesNotExcluded(t *testing.T) {
	cases := []string{"passwd", "ssh/sshd_config", "hosts", "resolv.conf"}
	for _, relPath := range cases {
		if isExcludedEtcPath(relPath) {
			t.Errorf("isExcludedEtcPath(%q) = true, want false", relPath)
		}
	}
}

func TestParseEnabledServicesFiltersByState(t *testing.T) {
	data := []byte(strings.Join([]string{
		"UNIT FILE                             STATE",
		"acpid.service                         enabled",
		"cron.service                          enabled",
		"bluetooth.service                     disabled",
		"rescue.service                        static",
		"",
		"3 unit files listed.",
	}, "\n"))

	got := parseEnabledServices(data)
	want := []string{"acpid.service", "cron.service"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseEnabledServices() = %v, want %v", got, want)
	}
}

func TestParseEnabledServicesEmptyInput(t *testing.T) {
	if got := parseEnabledServices([]byte("")); len(got) != 0 {
		t.Fatalf("parseEnabledServices(empty) = %v, want empty", got)
	}
}

func TestCrontabSpoolEntriesFlatLayout(t *testing.T) {
	// RHEL/Fedora layout: /var/spool/cron/<user> directly.
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "alice"), "* * * * * alice-job\n")
	writeFile(t, filepath.Join(dir, "bob"), "* * * * * bob-job\n")

	got, _, err := crontabSpoolEntries(dir)
	if err != nil {
		t.Fatalf("crontabSpoolEntries: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("crontabSpoolEntries() = %v, want 2 entries", got)
	}
	if got["alice"] != filepath.Join(dir, "alice") {
		t.Errorf("alice path = %q, want %q", got["alice"], filepath.Join(dir, "alice"))
	}
	if got["bob"] != filepath.Join(dir, "bob") {
		t.Errorf("bob path = %q, want %q", got["bob"], filepath.Join(dir, "bob"))
	}
}

func TestCrontabSpoolEntriesNestedDebianLayout(t *testing.T) {
	// Debian/Ubuntu layout: /var/spool/cron/crontabs/<user> — the
	// collector copies /var/spool/cron verbatim, so the staged spool dir
	// itself gains an extra "crontabs" level.
	dir := t.TempDir()
	nested := filepath.Join(dir, "crontabs")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(nested, "alice"), "* * * * * alice-job\n")

	got, _, err := crontabSpoolEntries(dir)
	if err != nil {
		t.Fatalf("crontabSpoolEntries: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("crontabSpoolEntries() = %v, want 1 entry", got)
	}
	if got["alice"] != filepath.Join(nested, "alice") {
		t.Errorf("alice path = %q, want %q", got["alice"], filepath.Join(nested, "alice"))
	}
}

func TestCrontabSpoolEntriesIgnoresEtcCrontabSibling(t *testing.T) {
	// stagingDir/crontabs/crontab (the /etc/crontab copy) lives one level
	// above stagingDir/crontabs/spool — a walk rooted at spool/ must never
	// see it.
	cronRoot := t.TempDir()
	writeFile(t, filepath.Join(cronRoot, "crontab"), "# /etc/crontab copy\n")
	spool := filepath.Join(cronRoot, "spool")
	if err := os.MkdirAll(spool, 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(spool, "alice"), "* * * * * alice-job\n")

	got, _, err := crontabSpoolEntries(spool)
	if err != nil {
		t.Fatalf("crontabSpoolEntries: %v", err)
	}
	if _, ok := got["crontab"]; ok {
		t.Fatal(`crontabSpoolEntries() included "crontab" from outside spool/, want it excluded`)
	}
	if len(got) != 1 {
		t.Fatalf("crontabSpoolEntries() = %v, want exactly 1 entry (alice)", got)
	}
}

// TestCrontabSpoolEntriesSkipsAtJobsAndAtSpool covers the real Debian
// /var/spool/cron layout, which the collector copies verbatim: besides
// crontabs/<user>, it also contains atjobs/ and atspool/ (at(1) job
// queues) and sometimes a lock file. Walking every descendant and taking
// the basename as a username — the previous implementation's approach —
// would try to run `crontab -u .SEQ` on an atjobs sequence file and fail
// the whole crontab restore step over something that was never a user
// crontab in the first place.
func TestCrontabSpoolEntriesSkipsAtJobsAndAtSpool(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "crontabs", "alice"), "* * * * * alice-job\n")
	writeFile(t, filepath.Join(dir, "atjobs", ".SEQ"), "1\n")
	writeFile(t, filepath.Join(dir, "atspool", "x"), "at job payload\n")

	got, skipped, err := crontabSpoolEntries(dir)
	if err != nil {
		t.Fatalf("crontabSpoolEntries: %v", err)
	}
	if len(got) != 1 || got["alice"] == "" {
		t.Fatalf("crontabSpoolEntries() entries = %v, want exactly {alice: ...}", got)
	}
	if len(skipped) == 0 {
		t.Error("expected atjobs/ and atspool/ to be reported as skipped, got none")
	}
}

// TestCrontabSpoolEntriesSkipsDotfilesAndLockFiles covers a lock/state
// file sitting directly alongside real per-user crontabs (e.g. Debian's
// crontabs/.<something> lock convention) — it must never be handed to
// `crontab -u` as if it were a username.
func TestCrontabSpoolEntriesSkipsDotfilesAndLockFiles(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "crontabs", "alice"), "* * * * * alice-job\n")
	writeFile(t, filepath.Join(dir, "crontabs", ".lock"), "")

	got, skipped, err := crontabSpoolEntries(dir)
	if err != nil {
		t.Fatalf("crontabSpoolEntries: %v", err)
	}
	if len(got) != 1 || got["alice"] == "" {
		t.Fatalf("crontabSpoolEntries() entries = %v, want exactly {alice: ...}", got)
	}
	if _, ok := got[".lock"]; ok {
		t.Fatal(`crontabSpoolEntries() treated ".lock" as a username, want it skipped`)
	}
	foundLockSkipped := false
	for _, s := range skipped {
		if filepath.Base(s) == ".lock" {
			foundLockSkipped = true
		}
	}
	if !foundLockSkipped {
		t.Errorf("expected .lock to be reported as skipped, got %v", skipped)
	}
}

func writeFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir for %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
