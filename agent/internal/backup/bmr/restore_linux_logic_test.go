package bmr

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
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

	got, err := crontabSpoolEntries(dir)
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

	got, err := crontabSpoolEntries(dir)
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

	got, err := crontabSpoolEntries(spool)
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

func writeFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
