//go:build windows

package securefs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreatePrivateTempDirIsProtected(t *testing.T) {
	base := t.TempDir()
	dir, err := CreatePrivateTempDir(base, "probe-")
	if err != nil {
		t.Fatalf("CreatePrivateTempDir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	if filepath.Dir(dir) != filepath.Clean(base) || !strings.HasPrefix(filepath.Base(dir), "probe-") {
		t.Fatalf("directory %q is not probe-* directly under %q", dir, base)
	}
	if err := VerifyPrivateDir(dir); err != nil {
		t.Fatalf("directory is not protected: %v", err)
	}

	// Positive control: a plain MkdirTemp under the same base inherits its
	// ACL and must fail the same check, so the assertion above discriminates.
	plain, err := os.MkdirTemp(base, "plain-")
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyPrivateDir(plain); err == nil {
		t.Fatal("VerifyPrivateDir accepted an inheriting MkdirTemp directory; the check is vacuous")
	}
}

func TestCreatePrivateTempDirMissingBaseFails(t *testing.T) {
	if _, err := CreatePrivateTempDir(filepath.Join(t.TempDir(), "absent"), "probe-"); err == nil {
		t.Fatal("expected an error for a base directory that does not exist")
	}
}
