package heartbeat

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// withSupportSeams swaps the cleanup/exit seams for recording stubs and
// restores them afterwards. Returns accessors for what the async teardown
// goroutine did.
func withSupportSeams(t *testing.T) (cleanupCalls func() int, exitCalls func() []int) {
	t.Helper()

	origCleanup, origExit, origDelete := supportCleanupFn, supportExitFn, supportSelfDeleteFn
	t.Cleanup(func() {
		supportCleanupFn = origCleanup
		supportExitFn = origExit
		supportSelfDeleteFn = origDelete
	})
	supportSelfDeleteFn = func() {}

	var mu sync.Mutex
	cleanups := 0
	exits := []int{}

	supportCleanupFn = func(*Heartbeat) {
		mu.Lock()
		defer mu.Unlock()
		cleanups++
	}
	supportExitFn = func(code int) {
		mu.Lock()
		defer mu.Unlock()
		exits = append(exits, code)
	}

	return func() int {
			mu.Lock()
			defer mu.Unlock()
			return cleanups
		}, func() []int {
			mu.Lock()
			defer mu.Unlock()
			return append([]int(nil), exits...)
		}
}

func TestHandleSupportEnd(t *testing.T) {
	cases := []struct {
		name        string
		supportMode bool
		payload     map[string]any
		wantStatus  string
		wantCleanup bool
		wantErrPart string
	}{
		{
			// THE GUARD. support_end is a self-destruct delivered over the
			// same command channel as everything else; a forged or misrouted
			// one must never be able to wipe a real installed agent.
			name:        "refuses on a permanently-installed agent and destroys nothing",
			supportMode: false,
			payload:     map[string]any{"sessionId": "11111111-1111-1111-1111-111111111111"},
			wantStatus:  "failed",
			wantCleanup: false,
			wantErrPart: "permanently-installed",
		},
		{
			name:        "refuses even with no payload at all",
			supportMode: false,
			payload:     nil,
			wantStatus:  "failed",
			wantCleanup: false,
			wantErrPart: "refused",
		},
		{
			name:        "ends the session on an ephemeral support client",
			supportMode: true,
			payload:     map[string]any{"sessionId": "22222222-2222-2222-2222-222222222222"},
			wantStatus:  "completed",
			wantCleanup: true,
		},
		{
			name:        "ends the session even when the payload omits sessionId",
			supportMode: true,
			payload:     map[string]any{},
			wantStatus:  "completed",
			wantCleanup: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cleanupCalls, exitCalls := withSupportSeams(t)

			h := &Heartbeat{supportMode: tc.supportMode, supportWorkDir: t.TempDir()}
			result := handleSupportEnd(h, Command{ID: "cmd-1", Type: "support_end", Payload: tc.payload})

			if result.Status != tc.wantStatus {
				t.Fatalf("status: got %q, want %q (error=%q)", result.Status, tc.wantStatus, result.Error)
			}
			if tc.wantErrPart != "" && !strings.Contains(result.Error, tc.wantErrPart) {
				t.Errorf("error %q does not mention %q", result.Error, tc.wantErrPart)
			}
			if tc.wantStatus == "failed" && result.ExitCode == 0 {
				// exit_code 0 must always mean "ran and exited cleanly" (#2474).
				t.Error("a failed result must carry a nonzero exit code")
			}

			// The teardown is asynchronous so the result can flush first. Poll
			// past supportEndFlushDelay either way: the refusal cases must
			// still be given a real chance to (wrongly) fire before we
			// conclude they didn't.
			deadline := time.Now().Add(supportEndFlushDelay + 500*time.Millisecond)
			for time.Now().Before(deadline) {
				if cleanupCalls() > 0 {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}

			if got := cleanupCalls() > 0; got != tc.wantCleanup {
				t.Fatalf("cleanup invoked=%v, want %v", got, tc.wantCleanup)
			}
			if got := len(exitCalls()) > 0; got != tc.wantCleanup {
				t.Fatalf("process exit scheduled=%v, want %v", got, tc.wantCleanup)
			}
			if tc.wantCleanup {
				if codes := exitCalls(); codes[0] != 0 {
					t.Errorf("exit code: got %d, want 0", codes[0])
				}
			}
		})
	}
}

// A refused support_end must leave the workspace on disk untouched — the
// result-status assertion above would still pass if the async goroutine ran
// and deleted things, so pin the filesystem effect directly.
func TestHandleSupportEndRefusalLeavesFilesystemUntouched(t *testing.T) {
	origCleanup, origExit, origDelete := supportCleanupFn, supportExitFn, supportSelfDeleteFn
	t.Cleanup(func() {
		supportCleanupFn = origCleanup
		supportExitFn = origExit
		supportSelfDeleteFn = origDelete
	})
	supportSelfDeleteFn = func() {}
	supportExitFn = func(int) { t.Error("os.Exit must not be scheduled when support_end is refused") }
	// Deliberately the REAL cleanup: if the guard ever regresses, this test
	// fails by deleting the sentinel rather than by a stubbed counter.
	supportCleanupFn = supportCleanup

	dir := t.TempDir()
	sentinel := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(sentinel, []byte("agent_id: real-agent\n"), 0o600); err != nil {
		t.Fatalf("seed sentinel: %v", err)
	}

	h := &Heartbeat{supportMode: false, supportWorkDir: dir}
	result := handleSupportEnd(h, Command{ID: "cmd-forged", Type: "support_end", Payload: map[string]any{"sessionId": "x"}})
	if result.Status != "failed" {
		t.Fatalf("expected refusal, got status %q", result.Status)
	}

	time.Sleep(supportEndFlushDelay + 300*time.Millisecond)

	if _, err := os.Stat(sentinel); err != nil {
		t.Fatalf("refused support_end deleted a file it must never touch: %v", err)
	}
}

// RunSupportCleanup is the signal-path entry point (Ctrl+C / console close).
// It carries the same guard as the command handler so it can never be reached
// on a normal agent through some future call site.
func TestRunSupportCleanupHonoursTheSupportModeGuard(t *testing.T) {
	cases := []struct {
		name        string
		heartbeat   *Heartbeat
		wantCleanup bool
	}{
		{"nil heartbeat is a no-op", nil, false},
		{"installed agent is refused", &Heartbeat{supportMode: false}, false},
		{"support client cleans up", &Heartbeat{supportMode: true}, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cleanupCalls, _ := withSupportSeams(t)
			tc.heartbeat.RunSupportCleanup()
			if got := cleanupCalls() > 0; got != tc.wantCleanup {
				t.Fatalf("cleanup invoked=%v, want %v", got, tc.wantCleanup)
			}
		})
	}
}

// stubSelfDelete keeps the real cleanup from deleting the test binary.
func stubSelfDelete(t *testing.T) {
	t.Helper()
	orig := supportSelfDeleteFn
	t.Cleanup(func() { supportSelfDeleteFn = orig })
	supportSelfDeleteFn = func() {}
}

func TestSupportCleanupRemovesOnlyItsOwnWorkspace(t *testing.T) {
	stubSelfDelete(t)
	root := t.TempDir()
	workDir := filepath.Join(root, "breeze-support-4242")
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workDir, "secrets.yaml"), []byte("auth_token: t\n"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	neighbour := filepath.Join(root, "unrelated.yaml")
	if err := os.WriteFile(neighbour, []byte("x\n"), 0o600); err != nil {
		t.Fatalf("seed neighbour: %v", err)
	}

	supportCleanup(&Heartbeat{supportMode: true, supportWorkDir: workDir})

	if _, err := os.Stat(workDir); !os.IsNotExist(err) {
		t.Fatalf("workspace should be gone, stat err = %v", err)
	}
	if _, err := os.Stat(neighbour); err != nil {
		t.Fatalf("cleanup removed a sibling it does not own: %v", err)
	}
}

// An empty workDir must not turn os.RemoveAll into a no-op on "" that some
// future refactor could widen into the process CWD.
func TestSupportCleanupWithEmptyWorkDirIsSafe(t *testing.T) {
	stubSelfDelete(t)
	supportCleanup(&Heartbeat{supportMode: true, supportWorkDir: ""})
	supportCleanup(nil)
}

// The trampoline is passed to CreateProcess verbatim via
// SysProcAttr.CmdLine (see support_selfdelete_windows.go), so the quoting
// here is load-bearing: a path containing a space must stay one argument to
// del, and there must be no backslash-escaped quotes for cmd.exe to choke on.
func TestBuildSupportSelfDeleteCmdLine(t *testing.T) {
	cases := []struct {
		name    string
		exePath string
		want    string
	}{
		{
			name:    "plain path",
			exePath: `C:\Users\me\Downloads\breeze-support-KTM4H7P2X-us.2breeze.app.exe`,
			want:    `cmd /C ping 127.0.0.1 -n 3 >NUL & del /f "C:\Users\me\Downloads\breeze-support-KTM4H7P2X-us.2breeze.app.exe"`,
		},
		{
			name:    "user profile containing a space stays quoted as one argument",
			exePath: `C:\Users\John Smith\Downloads\breeze-support-KTM4H7P2X-us.2breeze.app.exe`,
			want:    `cmd /C ping 127.0.0.1 -n 3 >NUL & del /f "C:\Users\John Smith\Downloads\breeze-support-KTM4H7P2X-us.2breeze.app.exe"`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildSupportSelfDeleteCmdLine(tc.exePath)
			if got != tc.want {
				t.Fatalf("got  %s\nwant %s", got, tc.want)
			}
			if strings.Contains(got, `\"`) {
				t.Errorf("command line contains a backslash-escaped quote, which cmd.exe does not understand: %s", got)
			}
			if strings.Count(got, `"`) != 2 {
				t.Errorf("cmd /C only strips outer quotes when the line has exactly two quote characters; got %d in %s", strings.Count(got, `"`), got)
			}
		})
	}
}

func TestSupportEndIsRegistered(t *testing.T) {
	if _, ok := handlerRegistry["support_end"]; !ok {
		t.Fatal("support_end is not registered in handlerRegistry")
	}
}
