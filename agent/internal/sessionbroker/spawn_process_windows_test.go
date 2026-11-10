//go:build windows

package sessionbroker

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// #6872: cmd.exe /c start "" "<missing>" used to report success with cmd.exe's
// PID; the missing file only surfaced as a "crash" 30s later, and Windows
// showed the user a "cannot find" dialog on every retry. Stat first.
func TestSpawnProcessInSessionWithArgsMissingBinary(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "breeze-helper.exe")

	pid, err := SpawnProcessInSessionWithArgs(missing, []string{"--config", "x"}, 1)

	if !errors.Is(err, ErrBinaryMissing) {
		t.Fatalf("err = %v, want ErrBinaryMissing", err)
	}
	if pid != 0 {
		t.Fatalf("pid = %d, want no launch", pid)
	}
}

// trickyArgs exercise every escaping rule a direct launch depends on: spaces,
// embedded quotes, backslashes before a quote and at the end, an empty arg,
// and the cmd.exe metacharacters the old wrapper escaped with ^ (no cmd.exe
// parses the line any more, so they must arrive untouched).
var trickyArgs = []string{
	"--config",
	`C:\ProgramData\Breeze\sessions\1\helper_config.yaml`,
	`C:\Program Files\Breeze Helper\`,
	`say "hi"`,
	`back\\"slash`,
	"",
	`a&b|c<d>e^f(g)h%PATH%i`,
	"/background",
}

func TestDirectLaunchCommandLineRoundTrips(t *testing.T) {
	cases := []struct {
		name   string
		binary string
		args   []string
	}{
		{"no args", `C:\Program Files\Breeze Helper\breeze-helper.exe`, nil},
		{"helper config", `C:\Program Files\Breeze Helper\breeze-helper.exe`, []string{"--config", `C:\ProgramData\Breeze\sessions\1\helper_config.yaml`}},
		{"taskkill", `C:\Windows\System32\taskkill.exe`, []string{"/f", "/im", "OneDrive.exe"}},
		{"tricky", `C:\Users\Some User\AppData\Local\Microsoft\OneDrive\OneDrive.exe`, trickyArgs},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			line := directLaunchCommandLine(tc.binary, tc.args)

			got, err := windows.DecomposeCommandLine(line)
			if err != nil {
				t.Fatalf("DecomposeCommandLine(%q): %v", line, err)
			}
			want := append([]string{tc.binary}, tc.args...)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("command line %q parses to %q, want %q", line, got, want)
			}
			if strings.Contains(strings.ToLower(line), "cmd.exe") {
				t.Fatalf("command line %q still goes through cmd.exe", line)
			}
		})
	}
}

type capturedLaunch struct {
	token      windows.Token
	appName    string
	cmdLine    string
	flags      uint32
	envBlock   *uint16
	currentDir string
	desktop    string
	calls      int
}

// stubCreateProcessAsUser replaces the Win32 launch. When launch is nil the
// stub records the call and reports pid without starting anything.
func stubCreateProcessAsUser(t *testing.T, pid uint32, launch func(appName, cmdLine, currentDir *uint16, flags uint32, si *windows.StartupInfo, pi *windows.ProcessInformation) error) *capturedLaunch {
	t.Helper()
	orig := createProcessAsUser
	t.Cleanup(func() { createProcessAsUser = orig })
	got := &capturedLaunch{}
	createProcessAsUser = func(token windows.Token, appName *uint16, cmdLine *uint16, procSecurity *windows.SecurityAttributes, threadSecurity *windows.SecurityAttributes, inheritHandles bool, creationFlags uint32, env *uint16, currentDir *uint16, si *windows.StartupInfo, pi *windows.ProcessInformation) error {
		got.calls++
		got.token = token
		got.appName = windows.UTF16PtrToString(appName)
		got.cmdLine = windows.UTF16PtrToString(cmdLine)
		got.flags = creationFlags
		got.envBlock = env
		got.currentDir = windows.UTF16PtrToString(currentDir)
		got.desktop = windows.UTF16PtrToString(si.Desktop)
		if inheritHandles {
			t.Errorf("inheritHandles = true; the agent's handles must not leak into the user's process")
		}
		if launch != nil {
			return launch(appName, cmdLine, currentDir, creationFlags, si, pi)
		}
		pi.ProcessId = pid
		return nil
	}
	return got
}

func userTokenStub(t *testing.T) {
	t.Helper()
	stubUserTokenStrategies(t, []userTokenStrategy{
		{name: "user (WTS)", acquire: func(uint32) (windows.Token, *uint16, error) { return 0, nil, nil }},
	})
}

func existingBinary(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "Breeze Helper", name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// #6923: the launch is the target itself, not cmd.exe /c start, so the PID
// the caller gets back is the target's and no console wrapper runs.
func TestSpawnProcessInSessionWithArgsLaunchesTargetDirectly(t *testing.T) {
	userTokenStub(t)
	binary := existingBinary(t, "breeze-helper.exe")
	got := stubCreateProcessAsUser(t, 3104, nil)

	pid, err := SpawnProcessInSessionWithArgs(binary, trickyArgs, 1)

	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	if pid != 3104 {
		t.Fatalf("pid = %d, want the launched target's pid 3104", pid)
	}
	if got.calls != 1 {
		t.Fatalf("CreateProcessAsUser called %d times, want 1", got.calls)
	}
	if got.appName != binary {
		t.Fatalf("lpApplicationName = %q, want the target %q", got.appName, binary)
	}
	argv, err := windows.DecomposeCommandLine(got.cmdLine)
	if err != nil {
		t.Fatalf("DecomposeCommandLine(%q): %v", got.cmdLine, err)
	}
	if want := append([]string{binary}, trickyArgs...); !reflect.DeepEqual(argv, want) {
		t.Fatalf("command line %q parses to %q, want %q", got.cmdLine, argv, want)
	}
	if want := uint32(windows.CREATE_NO_WINDOW | windows.CREATE_UNICODE_ENVIRONMENT); got.flags != want {
		t.Fatalf("creation flags = %#x, want %#x (no console window for console targets)", got.flags, want)
	}
	if got.currentDir != filepath.Dir(binary) {
		t.Fatalf("current dir = %q, want %q", got.currentDir, filepath.Dir(binary))
	}
	if got.desktop != `winsta0\Default` {
		t.Fatalf("desktop = %q, want winsta0\\Default", got.desktop)
	}
}

func TestSpawnProcessInSessionWithArgsReportsLaunchFailure(t *testing.T) {
	userTokenStub(t)
	binary := existingBinary(t, "breeze-helper.exe")
	stubCreateProcessAsUser(t, 0, func(_, _, _ *uint16, _ uint32, _ *windows.StartupInfo, _ *windows.ProcessInformation) error {
		return windows.ERROR_ACCESS_DENIED
	})

	pid, err := SpawnProcessInSessionWithArgs(binary, nil, 1)

	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("err = %v, want the CreateProcessAsUser error", err)
	}
	if !strings.Contains(err.Error(), binary) {
		t.Fatalf("err = %q should name the target", err)
	}
	if pid != 0 {
		t.Fatalf("pid = %d, want 0 on a failed launch", pid)
	}
}

// The child half of the end-to-end tests below: the test binary re-executed
// with spawnChildEnv set records the argv it received and exits with the
// requested code (or sleeps, to exercise the wait timeout).
const (
	spawnChildEnv    = "BREEZE_SESSIONBROKER_SPAWN_CHILD"
	spawnChildOutEnv = "BREEZE_SESSIONBROKER_SPAWN_CHILD_OUT"
)

func TestSpawnChildProcess(t *testing.T) {
	mode := os.Getenv(spawnChildEnv)
	if mode == "" {
		t.Skip("child half of the spawn end-to-end tests")
	}
	args := os.Args
	for i, a := range args {
		if a == "--" {
			args = args[i+1:]
			break
		}
	}
	data, _ := json.Marshal(args)
	_ = os.WriteFile(os.Getenv(spawnChildOutEnv), data, 0o644)
	if mode == "sleep" {
		time.Sleep(30 * time.Second)
	}
	code, _ := strconv.Atoi(mode)
	os.Exit(code)
}

// launchForReal stands in for CreateProcessAsUser with a plain CreateProcess
// of the same application name, command line and flags (the test has no user
// token or interactive desktop to hand out).
func launchForReal(appName, cmdLine, currentDir *uint16, flags uint32, si *windows.StartupInfo, pi *windows.ProcessInformation) error {
	plain := *si
	plain.Desktop = nil
	return windows.CreateProcess(appName, cmdLine, nil, nil, false, flags, nil, currentDir, &plain, pi)
}

func childArgs(extra ...string) []string {
	return append([]string{"-test.run=^TestSpawnChildProcess$", "--"}, extra...)
}

func setupChild(t *testing.T, mode string) (exe, outPath string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	outPath = filepath.Join(t.TempDir(), "argv.json")
	t.Setenv(spawnChildEnv, mode)
	t.Setenv(spawnChildOutEnv, outPath)
	userTokenStub(t)
	stubCreateProcessAsUser(t, 0, launchForReal)
	return exe, outPath
}

// End to end: a real process launched through the direct path receives every
// argument exactly, and RunProcessInSessionWithArgs reports its exit code.
func TestRunProcessInSessionWithArgsWaitsAndPassesArgsExactly(t *testing.T) {
	exe, outPath := setupChild(t, "7")

	code, err := RunProcessInSessionWithArgs(exe, childArgs(trickyArgs...), 1, 30*time.Second)

	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if code != 7 {
		t.Fatalf("exit code = %d, want 7", code)
	}
	data, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("child wrote no argv: %v", err)
	}
	var got []string
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, trickyArgs) {
		t.Fatalf("child argv = %q, want %q", got, trickyArgs)
	}
}

func TestRunProcessInSessionWithArgsTimesOut(t *testing.T) {
	exe, _ := setupChild(t, "sleep")
	var pid uint32
	t.Cleanup(func() {
		if pid == 0 {
			return
		}
		if h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, pid); err == nil {
			_ = windows.TerminateProcess(h, 1)
			_ = windows.CloseHandle(h)
		}
	})
	orig := createProcessAsUser
	t.Cleanup(func() { createProcessAsUser = orig })
	createProcessAsUser = func(token windows.Token, appName *uint16, cmdLine *uint16, ps *windows.SecurityAttributes, ts *windows.SecurityAttributes, inherit bool, flags uint32, env *uint16, dir *uint16, si *windows.StartupInfo, pi *windows.ProcessInformation) error {
		err := orig(token, appName, cmdLine, ps, ts, inherit, flags, env, dir, si, pi)
		pid = pi.ProcessId
		return err
	}

	start := time.Now()
	_, err := RunProcessInSessionWithArgs(exe, childArgs(), 1, 200*time.Millisecond)
	elapsed := time.Since(start)

	if !errors.Is(err, ErrProcessWaitTimeout) {
		t.Fatalf("err = %v, want ErrProcessWaitTimeout", err)
	}
	if elapsed < 150*time.Millisecond || elapsed > 10*time.Second {
		t.Fatalf("waited %s; want about the 200ms timeout", elapsed)
	}
	// The timed-out process is left running, not killed.
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if err != nil {
		t.Fatalf("OpenProcess(%d): %v", pid, err)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	if event, _ := windows.WaitForSingleObject(h, 0); event != uint32(windows.WAIT_TIMEOUT) {
		t.Fatalf("child pid %d already exited (wait event %#x); a timeout must leave it running", pid, event)
	}
}

func TestRunProcessInSessionWithArgsMissingBinary(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "taskkill.exe")

	_, err := RunProcessInSessionWithArgs(missing, nil, 1, time.Second)

	if !errors.Is(err, ErrBinaryMissing) {
		t.Fatalf("err = %v, want ErrBinaryMissing", err)
	}
}
