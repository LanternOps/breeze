//go:build darwin

package tcc

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSqlStr(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"hello", "'hello'"},
		{"it's", "'it''s'"},
		{"/usr/local/bin/breeze-agent", "'/usr/local/bin/breeze-agent'"},
		{"", "''"},
		{"O'Brien's", "'O''Brien''s'"},
		{"path/with;semicolon", "'path/with;semicolon'"},
		{"value--comment", "'value--comment'"},
		{"back\\slash", "'back\\slash'"},
		{"null\x00byte", "'null\x00byte'"},
	}

	for _, tt := range tests {
		got := sqlStr(tt.input)
		if got != tt.want {
			t.Errorf("sqlStr(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestServicesAreDefined(t *testing.T) {
	if len(services) == 0 {
		t.Fatal("services slice is empty")
	}
	for _, svc := range services {
		if svc.Service == "" {
			t.Errorf("service %q has empty Service identifier", svc.Name)
		}
		if svc.Name == "" {
			t.Errorf("service identifier %q has empty Name", svc.Service)
		}
	}
}

func TestEnsurePermissions_NotRoot(t *testing.T) {
	// When running tests as a normal user (not root), EnsurePermissions
	// should return an error about requiring root.
	if os.Getuid() == 0 {
		t.Skip("test requires non-root execution")
	}

	results, err := EnsurePermissions()
	if err == nil {
		t.Fatal("expected error when not running as root, got nil")
	}
	if results != nil {
		t.Errorf("expected nil results when not root, got %v", results)
	}
}

func TestExpectedServices(t *testing.T) {
	// Verify we're granting the expected set of permissions
	expected := map[string]string{
		"kTCCServiceScreenCapture": "Screen Recording",
		"kTCCServiceAccessibility": "Accessibility",
	}

	if len(services) != len(expected) {
		t.Errorf("expected %d services, got %d", len(expected), len(services))
	}

	for _, svc := range services {
		wantName, ok := expected[svc.Service]
		if !ok {
			t.Errorf("unexpected service %q", svc.Service)
			continue
		}
		if svc.Name != wantName {
			t.Errorf("service %q: expected name %q, got %q", svc.Service, wantName, svc.Name)
		}
	}
}

func TestCheckFDAAtPath_OpenableFile(t *testing.T) {
	// A file this process can open means the OS granted the read —
	// the probe must report FDA as held.
	path := filepath.Join(t.TempDir(), "TCC.db")
	if err := os.WriteFile(path, []byte("stub"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !checkFDAAtPath(path) {
		t.Error("checkFDAAtPath = false for an openable file, want true")
	}
}

func TestCheckFDAAtPath_PermissionDenied(t *testing.T) {
	// EACCES/EPERM on open is exactly how TCC denies access without FDA.
	if os.Getuid() == 0 {
		t.Skip("root bypasses file mode bits; test requires non-root execution")
	}
	path := filepath.Join(t.TempDir(), "TCC.db")
	if err := os.WriteFile(path, []byte("stub"), 0o000); err != nil {
		t.Fatal(err)
	}
	if checkFDAAtPath(path) {
		t.Error("checkFDAAtPath = true for a permission-denied file, want false")
	}
}

func TestCheckFDAAtPath_MissingFile(t *testing.T) {
	// ENOENT (e.g. Apple moves the DB in a future macOS) must read as
	// denied, never as granted.
	path := filepath.Join(t.TempDir(), "does-not-exist.db")
	if checkFDAAtPath(path) {
		t.Error("checkFDAAtPath = true for a missing file, want false")
	}
}

func TestCheckFDA_NotRoot(t *testing.T) {
	// The daemon-side fallback only means anything for the root daemon;
	// non-root callers must get false, not a probe against file modes.
	if os.Getuid() == 0 {
		t.Skip("test requires non-root execution")
	}
	if CheckFDA() {
		t.Error("CheckFDA = true when not running as root, want false")
	}
}

func TestConstants(t *testing.T) {
	if systemTCCDBPath != "/Library/Application Support/com.apple.TCC/TCC.db" {
		t.Errorf("unexpected TCC DB path: %s", systemTCCDBPath)
	}
	if agentBinaryPath != "/usr/local/bin/breeze-agent" {
		t.Errorf("unexpected agent binary path: %s", agentBinaryPath)
	}
	// Helper path must match service_cmd_darwin.go's darwinDesktopHelperBinaryPath
	// and the LaunchAgent plist entries.
	if helperBinaryPath != "/usr/local/bin/breeze-desktop-helper" {
		t.Errorf("unexpected helper binary path: %s", helperBinaryPath)
	}
}
