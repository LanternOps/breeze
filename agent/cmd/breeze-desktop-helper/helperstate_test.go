package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestEnsureHelperStateDir(t *testing.T) {
	tests := []struct {
		name    string
		goos    string
		euid    int
		wantDir bool
	}{
		// #10870: the console-user helper needs a writable per-user dir
		// before its ECH/DNS caches first persist.
		{name: "darwin user creates the state dir", goos: "darwin", euid: 501, wantDir: true},
		// The root login-window helper's state is the agent-owned data dir.
		{name: "darwin root leaves the agent's dir alone", goos: "darwin", euid: 0, wantDir: false},
		{name: "windows is unchanged", goos: "windows", euid: -1, wantDir: false},
		{name: "linux is unchanged", goos: "linux", euid: 1000, wantDir: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "Library", "Application Support", "Breeze")
			gotDir, err := ensureHelperStateDir(tt.goos, tt.euid, func() string { return dir })
			if err != nil {
				t.Fatalf("ensureHelperStateDir: %v", err)
			}
			info, statErr := os.Stat(dir)
			if !tt.wantDir {
				if gotDir != "" {
					t.Fatalf("returned dir = %q, want empty on %s", gotDir, tt.goos)
				}
				if !os.IsNotExist(statErr) {
					t.Fatalf("state dir should not be touched on %s, stat err = %v", tt.goos, statErr)
				}
				return
			}
			if gotDir != dir {
				t.Fatalf("returned dir = %q, want %q", gotDir, dir)
			}
			if statErr != nil {
				t.Fatalf("state dir not created: %v", statErr)
			}
			if perm := info.Mode().Perm(); perm != 0o700 {
				t.Fatalf("state dir mode = %o, want 700", perm)
			}
		})
	}
}

func TestEnsureHelperStateDirReportsMkdirFailure(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "Library")
	if err := os.WriteFile(blocker, []byte("not a dir"), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(blocker, "Application Support", "Breeze")
	gotDir, err := ensureHelperStateDir("darwin", 501, func() string { return dir })
	if err == nil {
		t.Fatal("expected an error when the state dir cannot be created")
	}
	if gotDir != dir {
		t.Fatalf("returned dir = %q, want %q so the warning names it", gotDir, dir)
	}
}

// The HOME-unresolved fallback lands on a dir that exists but this user
// cannot write; MkdirAll succeeds there, so only the write probe reports it.
func TestEnsureHelperStateDirReportsUnwritableExistingDir(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can write a 0500 dir")
	}
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	if _, err := ensureHelperStateDir("darwin", 501, func() string { return dir }); err == nil {
		t.Fatal("expected an error for an existing but unwritable state dir")
	}
}

func TestRecoverWallpaperAtStart(t *testing.T) {
	tests := []struct {
		name    string
		goos    string
		euid    int
		context string
		want    bool
	}{
		// #10870: the console-user helper owns the wallpaper it suppressed
		// and must put it back after a crash.
		{name: "darwin user session recovers", goos: "darwin", euid: 501, context: ipc.DesktopContextUserSession, want: true},
		// A helper started as root resolves to the agent data dir, whose
		// record the root agent's own startup recovery owns.
		{name: "darwin root user-session does not", goos: "darwin", euid: 0, context: ipc.DesktopContextUserSession, want: false},
		// The root login-window helper shares the agent data dir, where the
		// agent's own startup recovery already runs.
		{name: "darwin login window does not", goos: "darwin", euid: 0, context: ipc.DesktopContextLoginWindow, want: false},
		{name: "windows is unchanged", goos: "windows", euid: -1, context: ipc.DesktopContextUserSession, want: false},
		{name: "linux is unchanged", goos: "linux", euid: 1000, context: ipc.DesktopContextUserSession, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			got := recoverWallpaperAtStart(tt.goos, tt.euid, tt.context, func() { calls++ })
			wantCalls := 0
			if tt.want {
				wantCalls = 1
			}
			if got != tt.want || calls != wantCalls {
				t.Fatalf("recoverWallpaperAtStart = %v with %d calls, want %v with %d", got, calls, tt.want, wantCalls)
			}
		})
	}
}
