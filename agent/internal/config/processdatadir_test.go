package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestProcessDataDirMatrix(t *testing.T) {
	const shared = "/Library/Application Support/Breeze/data"
	const home = "/Users/canary"
	perUser := filepath.Join(home, "Library", "Application Support", "Breeze")

	tests := []struct {
		name   string
		goos   string
		euid   int
		home   string
		shared string
		want   string
	}{
		{
			// #10870: the user-session desktop helper runs as the console
			// user and cannot read or write the 0700 root-owned data dir.
			name:   "darwin user-session process gets a per-user directory",
			goos:   "darwin",
			euid:   501,
			home:   home,
			shared: shared,
			want:   perUser,
		},
		{
			// The agent daemon, the watchdog and the login-window helper run
			// as root and keep the shared data dir.
			name:   "darwin root keeps the shared data dir",
			goos:   "darwin",
			euid:   0,
			home:   "/var/root",
			shared: shared,
			want:   shared,
		},
		{
			name:   "darwin without a resolvable home keeps the shared data dir",
			goos:   "darwin",
			euid:   501,
			home:   "",
			shared: shared,
			want:   shared,
		},
		{
			name:   "darwin with a relative HOME keeps the shared data dir",
			goos:   "darwin",
			euid:   501,
			home:   "relative/home",
			shared: shared,
			want:   shared,
		},
		{
			name:   "linux non-root unchanged",
			goos:   "linux",
			euid:   1000,
			home:   "/home/canary",
			shared: "/var/lib/breeze",
			want:   "/var/lib/breeze",
		},
		{
			name:   "windows unchanged",
			goos:   "windows",
			euid:   -1,
			home:   `C:\Users\canary`,
			shared: `C:\ProgramData\Breeze\data`,
			want:   `C:\ProgramData\Breeze\data`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := processDataDir(tt.goos, tt.euid, tt.home, tt.shared); got != tt.want {
				t.Fatalf("processDataDir(%q, %d, %q, %q) = %q, want %q", tt.goos, tt.euid, tt.home, tt.shared, got, tt.want)
			}
		})
	}
}

// TestProcessDataDirOnThisHost pins the wrapper's wiring: the host's GOOS,
// euid and HOME reach the pure core, and every other host keeps GetDataDir.
func TestProcessDataDirOnThisHost(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	want := GetDataDir()
	if runtime.GOOS == "darwin" && os.Geteuid() != 0 {
		want = filepath.Join(home, "Library", "Application Support", "Breeze")
	}
	if got := ProcessDataDir(); got != want {
		t.Fatalf("ProcessDataDir() = %q, want %q", got, want)
	}
}

// A registered user workspace (Quick Support) keeps its own data dir even on a
// non-root macOS process: GetDataDir already scopes it inside the workspace.
func TestProcessDataDirHonoursUserWorkspace(t *testing.T) {
	t.Cleanup(resetUserWorkspaceForTest)
	t.Setenv("HOME", t.TempDir())
	ws := filepath.Join(t.TempDir(), "breeze-support-1")
	if err := SecureUserWorkspace(ws); err != nil {
		t.Fatalf("SecureUserWorkspace: %v", err)
	}
	want := filepath.Join(registeredUserWorkspace(), "data")
	if got := ProcessDataDir(); got != want {
		t.Fatalf("ProcessDataDir() with a user workspace = %q, want %q", got, want)
	}
}
