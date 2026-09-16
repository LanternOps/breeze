package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestHelperLogDir(t *testing.T) {
	const shared = "/Library/Application Support/Breeze/logs"
	const home = "/Users/canary"
	perUser := filepath.Join(home, "Library", "Logs", "Breeze")

	tests := []struct {
		name   string
		goos   string
		euid   int
		home   string
		shared string
		want   string
	}{
		{
			// The bug in #5877: the LaunchAgent helper runs as the
			// logged-in user and cannot write the root-owned 0700
			// shared directory.
			name:   "darwin user-session helper gets a per-user directory",
			goos:   "darwin",
			euid:   501,
			home:   home,
			shared: shared,
			want:   perUser,
		},
		{
			// The login-window desktop-helper runs as root, where the
			// shared directory is writable — keep it there so its log
			// lands next to agent.log.
			name:   "darwin root helper keeps the shared directory",
			goos:   "darwin",
			euid:   0,
			home:   home,
			shared: shared,
			want:   shared,
		},
		{
			name:   "darwin without a resolvable home falls back to the shared directory",
			goos:   "darwin",
			euid:   501,
			home:   "",
			shared: shared,
			want:   shared,
		},
		{
			name:   "linux semantics unchanged",
			goos:   "linux",
			euid:   1000,
			home:   home,
			shared: "/var/log/breeze",
			want:   "/var/log/breeze",
		},
		{
			name:   "windows semantics unchanged",
			goos:   "windows",
			euid:   -1,
			home:   `C:\Users\canary`,
			shared: `C:\ProgramData\Breeze\logs`,
			want:   `C:\ProgramData\Breeze\logs`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := helperLogDir(tt.goos, tt.euid, tt.home, tt.shared)
			if got != tt.want {
				t.Fatalf("helperLogDir(%q, %d, %q, %q) = %q, want %q",
					tt.goos, tt.euid, tt.home, tt.shared, got, tt.want)
			}
		})
	}
}

// TestHelperLogDirOnThisHost pins HelperLogDir against an expectation
// derived from the host independently of the production expression, so a
// bug in HelperLogDir shows up here rather than cancelling out on both
// sides of the comparison.
func TestHelperLogDirOnThisHost(t *testing.T) {
	var want string
	if runtime.GOOS == "darwin" && os.Geteuid() != 0 {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			t.Skip("no resolvable home directory on this host")
		}
		want = home + "/Library/Logs/Breeze/desktop-helper.log"
	} else {
		want = filepath.Join(LogDir(), "desktop-helper.log")
	}

	dir, homeErr := HelperLogDir()
	if homeErr != nil {
		t.Skipf("home directory unresolvable on this host: %v", homeErr)
	}
	if got := filepath.Join(dir, "desktop-helper.log"); got != want {
		t.Fatalf("helper log path = %q, want %q", got, want)
	}
}
