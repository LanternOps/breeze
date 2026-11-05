//go:build linux

package cgroup

import (
	"os"
	"path/filepath"
	"testing"
)

// On systemd < 251 there is no delegate xattr; the answer comes from systemctl.
func TestUnitDelegatedFallsBackToSystemctl(t *testing.T) {
	for _, tc := range []struct {
		out  string
		want bool
	}{{"yes", true}, {"no", false}, {"", false}} {
		t.Run(tc.out, func(t *testing.T) {
			bin := t.TempDir()
			shim := "#!/bin/sh\n[ \"$*\" = \"show --property=Delegate --value -- breeze-agent.service\" ] || exit 9\necho " + tc.out + "\n"
			if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte(shim), 0o755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin)
			got, err := unitDelegated(t.TempDir(), "breeze-agent.service")
			if err != nil || got != tc.want {
				t.Fatalf("unitDelegated = %v, %v; want %v", got, err, tc.want)
			}
		})
	}
}

func TestUnitDelegatedReportsAFailedSystemctl(t *testing.T) {
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	if _, err := unitDelegated(t.TempDir(), "breeze-agent.service"); err == nil {
		t.Fatal("an unanswerable delegation query must be an error, not \"not delegated\" or \"delegated\"")
	}
}
