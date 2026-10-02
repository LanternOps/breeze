//go:build !windows

package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/viper"
)

func modeOf(t *testing.T, path string) os.FileMode {
	t.Helper()
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Mode().Perm()
}

// TestSecureUserWorkspaceUnix: the workspace is created 0700, and a permissive
// pre-existing directory of ours is tightened.
func TestSecureUserWorkspaceUnix(t *testing.T) {
	t.Cleanup(resetUserWorkspaceForTest)
	ws := filepath.Join(t.TempDir(), "breeze-support-1")
	if err := os.Mkdir(ws, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(ws, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := SecureUserWorkspace(ws); err != nil {
		t.Fatalf("SecureUserWorkspace: %v", err)
	}
	if got := modeOf(t, ws); got != 0o700 {
		t.Errorf("workspace mode = %o, want 700", got)
	}
}

// TestSecureUserWorkspaceRefusesSymlink: a symlink planted where the
// workspace should be (shared /tmp on Linux) is refused, not followed, and the
// target's permissions are left alone.
func TestSecureUserWorkspaceRefusesSymlink(t *testing.T) {
	t.Cleanup(resetUserWorkspaceForTest)
	base := t.TempDir()
	target := filepath.Join(base, "elsewhere")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	ws := filepath.Join(base, "breeze-support-1")
	if err := os.Symlink(target, ws); err != nil {
		t.Fatal(err)
	}
	if err := SecureUserWorkspace(ws); err == nil {
		t.Fatal("SecureUserWorkspace must refuse a symlinked workspace")
	}
	if inUserWorkspace(ws) {
		t.Error("a refused workspace must not be registered")
	}
	if got := modeOf(t, target); got != 0o755 {
		t.Errorf("symlink target mode changed to %o", got)
	}
}

// TestUserWorkspaceSavePermissionsUnix: inside the workspace the config dir,
// agent.yaml and secrets.yaml are owner-only; outside it the installed-agent
// modes (0755 / 0644 for the Helper) are unchanged.
func TestUserWorkspaceSavePermissionsUnix(t *testing.T) {
	t.Cleanup(resetUserWorkspaceForTest)
	ws := filepath.Join(t.TempDir(), "breeze-support-1")
	if err := SecureUserWorkspace(ws); err != nil {
		t.Fatalf("SecureUserWorkspace: %v", err)
	}
	cfgPath := filepath.Join(ws, "agent.yaml")
	if err := PrepareSaveDir(cfgPath); err != nil {
		t.Fatalf("PrepareSaveDir: %v", err)
	}
	if got := modeOf(t, ws); got != 0o700 {
		t.Errorf("workspace mode after PrepareSaveDir = %o, want 700", got)
	}
	viper.Reset()
	t.Cleanup(viper.Reset)
	cfg := Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.ServerURL = "https://api.example.test"
	cfg.AuthToken = "brz_support_agent"
	if err := SaveEnrollment(cfg, cfgPath); err != nil {
		t.Fatalf("SaveEnrollment: %v", err)
	}
	if got := modeOf(t, cfgPath); got != 0o600 {
		t.Errorf("workspace agent.yaml mode = %o, want 600", got)
	}
	if got := modeOf(t, filepath.Join(ws, "secrets.yaml")); got != 0o600 {
		t.Errorf("workspace secrets.yaml mode = %o, want 600", got)
	}
	if got := modeOf(t, ws); got != 0o700 {
		t.Errorf("workspace mode after SaveEnrollment = %o, want 700", got)
	}

	// The permission policy is per path: a dir outside the workspace still
	// gets the installed-agent policy. Asserted on the permission layer
	// directly, because with a workspace registered PrepareSaveDir refuses an
	// outside path outright (#7629, TestUserWorkspaceRefusesConfigWritesOutsideIt).
	outside := filepath.Join(t.TempDir(), "Breeze")
	if err := os.Mkdir(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := enforceConfigDirPermissions(outside); err != nil {
		t.Fatalf("enforceConfigDirPermissions outside: %v", err)
	}
	if got := modeOf(t, outside); got != 0o755 {
		t.Errorf("non-workspace config dir mode = %o, want the installed-agent 755", got)
	}
}
