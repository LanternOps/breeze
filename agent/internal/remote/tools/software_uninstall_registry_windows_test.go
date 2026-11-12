//go:build windows

package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckResolvedUninstallerPath(t *testing.T) {
	// The test's temp directory is normally under a user profile or a Temp
	// folder; the refusal below needs that.
	userFile := filepath.Join(t.TempDir(), "unins000.exe")
	if validateUninstallerPath(userFile) == nil {
		t.Skipf("temp directory %q is not in a refused location", userFile)
	}
	if err := os.WriteFile(userFile, []byte("MZ"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := checkResolvedUninstallerPath(userFile); err == nil || !strings.Contains(err.Error(), "user-writable") {
		t.Fatalf("checkResolvedUninstallerPath(%q) = %v, want a user-writable refusal", userFile, err)
	}
	// Spelled with repeated separators, the same file gets the same answer.
	doubled := strings.ReplaceAll(userFile, `\`, `\\`)
	if err := checkResolvedUninstallerPath(doubled); err == nil || !strings.Contains(err.Error(), "user-writable") {
		t.Fatalf("checkResolvedUninstallerPath(%q) = %v, want a user-writable refusal", doubled, err)
	}

	system := filepath.Join(os.Getenv("SystemRoot"), "System32", "hostname.exe")
	if err := checkResolvedUninstallerPath(system); err != nil {
		t.Fatalf("checkResolvedUninstallerPath(%q) = %v, want nil", system, err)
	}
}
