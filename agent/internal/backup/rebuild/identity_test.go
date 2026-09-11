package rebuild

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustMkdirAll(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWriteFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestStripEnrollment_RemovesIdentityKeysKeepsServer(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "etc", "breeze")
	mustMkdirAll(t, dir)
	mustWriteFile(t, filepath.Join(dir, "agent.yaml"), "server_url: https://example.invalid\nagent_id: a1\ndevice_id: d1\norg_id: o1\nsite_id: s1\nauth_token: t1\nwatchdog_auth_token: w1\nhelper_auth_token: h1\nlog_level: info\n")
	mustWriteFile(t, filepath.Join(dir, "secrets.yaml"), "auth_token: t1\n")
	mustMkdirAll(t, filepath.Join(root, "etc"))
	mustWriteFile(t, filepath.Join(root, "etc", "machine-id"), "abc\n")
	mustWriteFile(t, filepath.Join(root, "etc", "hostname"), "srv-1\n")

	if err := applyNewIdentity(root); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "agent.yaml"))
	for _, gone := range []string{"agent_id", "device_id", "auth_token", "watchdog_auth_token", "helper_auth_token"} {
		if strings.Contains(string(b), gone+":") {
			t.Errorf("%s still present:\n%s", gone, b)
		}
	}
	for _, kept := range []string{"server_url: https://example.invalid", "log_level: info"} {
		if !strings.Contains(string(b), kept) {
			t.Errorf("%s lost:\n%s", kept, b)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "secrets.yaml")); !os.IsNotExist(err) {
		t.Error("secrets.yaml must be removed")
	}
	if mid, _ := os.ReadFile(filepath.Join(root, "etc", "machine-id")); len(strings.TrimSpace(string(mid))) != 0 {
		t.Errorf("machine-id = %q, want empty (systemd regenerates on first boot)", mid)
	}
	if hn, _ := os.ReadFile(filepath.Join(root, "etc", "hostname")); string(hn) != "srv-1-restored\n" {
		t.Errorf("hostname = %q", hn)
	}
}
