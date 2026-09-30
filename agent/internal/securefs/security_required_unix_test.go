//go:build linux || darwin

package securefs

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestInstallFileWithRequiredSecurityApplyErrorFailsTheInstall: a Required
// applier that fails fails the install, and nothing is published — neither
// the destination nor a temporary.
func TestInstallFileWithRequiredSecurityApplyErrorFailsTheInstall(t *testing.T) {
	base := t.TempDir()
	sec := &SecurityApplier{Required: true, Apply: func(uintptr) error { return errors.New("boom") }}
	_, err := InstallFileWithSecurity(base, "f.txt", writeSource(t, "data"), 0o644, time.Time{}, nil, 0, sec)
	if err == nil || !strings.Contains(err.Error(), "apply security descriptor: boom") {
		t.Fatalf("install error = %v, want the required apply failure", err)
	}
	entries, _ := os.ReadDir(base)
	if len(entries) != 0 {
		t.Fatalf("entries left under the target: %v", entries)
	}
	if _, statErr := os.Stat(filepath.Join(base, "f.txt")); !os.IsNotExist(statErr) {
		t.Fatalf("destination published: %v", statErr)
	}
}
