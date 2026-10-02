package heartbeat

import (
	"os"
	"path/filepath"
	"reflect"
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
	supportSelfDeleteFn = func(string) {}

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
	supportSelfDeleteFn = func(string) {}
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
	supportSelfDeleteFn = func(string) {}
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
// SysProcAttr.CmdLine (see support_selfdelete_windows.go), so the text here
// is load-bearing:
//   - the paths are never written into the line: cmd.exe expands %NAME% in
//     its command line (quoted or not) and there is no escape for it there,
//     so a profile or file name containing % would make the cleanup act on a
//     different path. The paths travel in the child's environment and are
//     read with delayed expansion (!NAME!), which happens after the FOR
//     variable is substituted, so a %i in a path is not replaced by the loop
//     counter either;
//   - every reference stays quoted as one argument (a profile may contain a
//     space);
//   - there are no backslash-escaped quotes, which cmd.exe does not
//     understand;
//   - the first character after `cmd /C` is not a quote, so cmd.exe strips
//     no quote characters from the line;
//   - it polls: the executable cannot be deleted while it is still running,
//     and files the process still holds keep the folder in place, so it
//     retries until both are gone or about a minute has passed.
func TestBuildSupportSelfDeleteCmdLine(t *testing.T) {
	const exe = `C:\Users\Jo%USERNAME%Smith\Downloads\breeze-support-KTM4H7P2X-us.2breeze.app-%i.exe`
	const ws = `C:\Users\Jo%USERNAME%Smith\AppData\Local\Temp\breeze-support-%~i4242`
	cases := []struct {
		name    string
		workDir string
		want    string
		wantEnv []string
	}{
		{
			name:    "executable and private folder",
			workDir: ws,
			want: `cmd /V:ON /C for /L %i in (1,1,60) do (ping 127.0.0.1 -n 2 >NUL & del /f /q "!BREEZE_SUPPORT_CLEANUP_EXE!" 2>NUL & ` +
				`rmdir /s /q "!BREEZE_SUPPORT_CLEANUP_DIR!" 2>NUL & ` +
				`if not exist "!BREEZE_SUPPORT_CLEANUP_EXE!" if not exist "!BREEZE_SUPPORT_CLEANUP_DIR!" exit)`,
			wantEnv: []string{"BREEZE_SUPPORT_CLEANUP_EXE=" + exe, "BREEZE_SUPPORT_CLEANUP_DIR=" + ws},
		},
		{
			name:    "executable only",
			want:    `cmd /V:ON /C for /L %i in (1,1,60) do (ping 127.0.0.1 -n 2 >NUL & del /f /q "!BREEZE_SUPPORT_CLEANUP_EXE!" 2>NUL & if not exist "!BREEZE_SUPPORT_CLEANUP_EXE!" exit)`,
			wantEnv: []string{"BREEZE_SUPPORT_CLEANUP_EXE=" + exe},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, env := buildSupportSelfDeleteCmdLine(exe, tc.workDir)
			if got != tc.want {
				t.Fatalf("got  %s\nwant %s", got, tc.want)
			}
			if !reflect.DeepEqual(env, tc.wantEnv) {
				t.Fatalf("env = %q, want %q", env, tc.wantEnv)
			}
			if strings.Contains(got, "%BREEZE") {
				t.Errorf("a path variable is read with %%NAME%%, which is expanded before the FOR variable and lets a %%i in its value be replaced: %s", got)
			}
			if strings.Contains(got, "USERNAME") || strings.Contains(got, `C:\Users`) {
				t.Errorf("command line carries a path, which cmd.exe would expand: %s", got)
			}
			if strings.Contains(got, `\"`) {
				t.Errorf("command line contains a backslash-escaped quote, which cmd.exe does not understand: %s", got)
			}
			if strings.HasPrefix(strings.TrimPrefix(got, "cmd /V:ON /C "), `"`) {
				t.Errorf("the line after cmd /C must not start with a quote, or cmd.exe strips quote characters: %s", got)
			}
		})
	}
}

// TestSupportCleanupReleasesFilesBeforeRemoving: the session's open files
// (its log) are released before the folder is removed (an open file keeps a
// Windows folder in place), and the post-exit cleanup is handed the folder so
// anything still held until exit goes too.
func TestSupportCleanupReleasesFilesBeforeRemoving(t *testing.T) {
	workDir := filepath.Join(t.TempDir(), "breeze-support-4242")
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		t.Fatal(err)
	}
	var events []string
	orig := supportSelfDeleteFn
	t.Cleanup(func() { supportSelfDeleteFn = orig })
	supportSelfDeleteFn = func(dir string) { events = append(events, "schedule:"+dir) }

	h := &Heartbeat{supportMode: true, supportWorkDir: workDir}
	h.SetSupportFileReleaser(func() {
		if _, err := os.Stat(workDir); err != nil {
			t.Errorf("files released after the folder was already removed: %v", err)
		}
		events = append(events, "release")
	})
	supportCleanup(h)

	if _, err := os.Stat(workDir); !os.IsNotExist(err) {
		t.Errorf("support folder should be gone, stat err = %v", err)
	}
	want := []string{"release", "schedule:" + workDir}
	if strings.Join(events, ",") != strings.Join(want, ",") {
		t.Errorf("events = %v, want %v", events, want)
	}
}

// TestScheduleSupportSelfCleanupRunsOnce: runSupportSession schedules the
// post-exit cleanup at the start of teardown (a closed console window allows
// only a few seconds), and supportCleanup schedules it again for the
// technician-ended path. Only one is ever started.
func TestScheduleSupportSelfCleanupRunsOnce(t *testing.T) {
	workDir := filepath.Join(t.TempDir(), "breeze-support-4242")
	calls := 0
	orig := supportSelfDeleteFn
	t.Cleanup(func() { supportSelfDeleteFn = orig })
	supportSelfDeleteFn = func(string) { calls++ }

	(&Heartbeat{supportWorkDir: workDir}).ScheduleSupportSelfCleanup()
	if calls != 0 {
		t.Fatalf("ScheduleSupportSelfCleanup ran outside support mode")
	}
	h := &Heartbeat{supportMode: true, supportWorkDir: workDir}
	h.ScheduleSupportSelfCleanup()
	h.ScheduleSupportSelfCleanup()
	supportCleanup(h)
	if calls != 1 {
		t.Errorf("post-exit cleanup scheduled %d times, want 1", calls)
	}
}

// TestSupportCleanupOnlyRemovesASupportFolder: the folder is removed, here and
// after exit, only when it is named like one runSupportSession creates. A
// wrong value can never turn into removing some other directory.
func TestSupportCleanupOnlyRemovesASupportFolder(t *testing.T) {
	other := filepath.Join(t.TempDir(), "Breeze")
	if err := os.MkdirAll(other, 0o700); err != nil {
		t.Fatal(err)
	}
	var scheduled []string
	orig := supportSelfDeleteFn
	t.Cleanup(func() { supportSelfDeleteFn = orig })
	supportSelfDeleteFn = func(dir string) { scheduled = append(scheduled, dir) }

	supportCleanup(&Heartbeat{supportMode: true, supportWorkDir: other})
	if _, err := os.Stat(other); err != nil {
		t.Errorf("a folder not named breeze-support-* was removed: %v", err)
	}
	if len(scheduled) != 1 || scheduled[0] != "" {
		t.Errorf("post-exit cleanup was handed %q, want no folder", scheduled)
	}
}

func TestSupportEndIsRegistered(t *testing.T) {
	if _, ok := handlerRegistry["support_end"]; !ok {
		t.Fatal("support_end is not registered in handlerRegistry")
	}
}
