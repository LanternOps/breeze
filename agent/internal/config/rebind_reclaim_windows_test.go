//go:build windows

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// #8318 review fix 7: when the agent replaces a config folder another account
// controlled, the staged reattach set an administrator wrote with the secrets
// DACL is carried into the new folder (it may hold the only copy of the
// credentials the server accepts), under the secrets file's trust checks: one
// that inherited the other account's write access is not carried.
func TestReclaimConfigDirCarriesTheStagedRebindSet(t *testing.T) {
	requireElevatedRunner(t)
	const body = `{"version":1,"phase":"confirmed"}`
	for name, tc := range map[string]struct {
		secretsDACL bool
		carried     bool
	}{
		"written with the secrets DACL":               {secretsDACL: true, carried: true},
		"inheriting the other account's write access": {secretsDACL: false, carried: false},
	} {
		t.Run(name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "Breeze")
			plantFolderAsStandardUser(t, root)
			p := filepath.Join(root, rebindStagedFileName)
			_ = os.Remove(p)
			if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			if tc.secretsDACL {
				if err := applyWindowsDACL(p, windowsSecretFileSDDL); err != nil {
					t.Fatal(err)
				}
			}
			if err := reclaimConfigDir(root, false); err != nil {
				t.Fatalf("reclaimConfigDir: %v", err)
			}
			b, err := os.ReadFile(p)
			if !tc.carried {
				if err == nil {
					t.Fatalf("a staged set another account could write was carried over: %q", b)
				}
				return
			}
			if err != nil || string(b) != body {
				t.Fatalf("the staged set was not carried over: %q, %v", b, err)
			}
			assertTrustedObject(t, p)
			if sddl := reclaimSDDL(t, p); strings.Contains(sddl, ";;;BU)") {
				t.Errorf("the carried staged set is readable by Users: %s", sddl)
			}
		})
	}
}
