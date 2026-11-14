//go:build linux || darwin

package backup

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

func TestNewVaultManagerCreatesOwnerOnlyRoot(t *testing.T) {
	old := syscall.Umask(0o022)
	t.Cleanup(func() { syscall.Umask(old) })
	vaultDir := filepath.Join(t.TempDir(), "vault")
	if _, err := NewVaultManager(VaultConfig{VaultPath: vaultDir, Enabled: true}, providers.NewLocalProvider(t.TempDir())); err != nil {
		t.Fatalf("NewVaultManager: %v", err)
	}
	info, err := os.Stat(vaultDir)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o700 {
		t.Fatalf("vault root mode = %04o, want 0700", got)
	}
}

func TestNewVaultManagerRefusesBroadExistingRoot(t *testing.T) {
	vaultDir := filepath.Join(t.TempDir(), "vault")
	if err := os.MkdirAll(vaultDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(vaultDir, 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := NewVaultManager(VaultConfig{VaultPath: vaultDir, Enabled: true}, providers.NewLocalProvider(t.TempDir()))
	if err == nil || !strings.Contains(err.Error(), "dedicated backup directory") {
		t.Fatalf("expected migration guidance, got %v", err)
	}
	info, err := os.Stat(vaultDir)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o755 {
		t.Fatalf("vault root mode changed to %04o", got)
	}
}
