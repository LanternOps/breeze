//go:build darwin

package updater

import "testing"

// installViaPkg must refuse to run `installer` when it has no signed checksum to
// verify the .pkg against — the caller (UpdateTo) falls back to verified-binary
// replacement in that case. This is the guard that prevents running unverified
// bytes as root.
func TestInstallViaPkg_RefusesEmptyChecksum(t *testing.T) {
	u := New(&Config{})
	if err := u.installViaPkg("1.0.0", ""); err == nil {
		t.Fatal("installViaPkg must refuse an empty signed checksum")
	}
}
