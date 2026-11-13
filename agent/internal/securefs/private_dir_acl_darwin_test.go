//go:build darwin

package securefs

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A private directory must not carry an extended access list: one can grant
// another account access while the mode bits still read 0700.
func TestPrivateDirInfoRefusesExtendedACL(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "store")
	if err := EnsurePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := PrivateDirInfo(dir); err != nil {
		t.Fatalf("plain private directory refused: %v", err)
	}
	if out, err := exec.Command("/bin/chmod", "+a", "everyone allow list,search", dir).CombinedOutput(); err != nil {
		t.Skipf("cannot add an access entry: %v %s", err, out)
	}
	_, err := PrivateDirInfo(dir)
	if err == nil || !strings.Contains(err.Error(), "access control list") {
		t.Fatalf("expected the extended access list to be refused, got %v", err)
	}
}
