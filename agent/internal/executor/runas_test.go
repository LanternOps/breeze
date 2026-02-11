package executor

import (
	"os/exec"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestConfigureRunAsEmptyIsNoOp(t *testing.T) {
	e := newTestExecutor()
	cmd := exec.Command("echo", "hello")
	originalPath := cmd.Path
	originalArgs := append([]string(nil), cmd.Args...)

	if err := e.configureRunAs(cmd, ""); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if cmd.Path != originalPath {
		t.Fatalf("path changed: got %q want %q", cmd.Path, originalPath)
	}
	if !reflect.DeepEqual(cmd.Args, originalArgs) {
		t.Fatalf("args changed: got %v want %v", cmd.Args, originalArgs)
	}
}

func TestConfigureRunAsSystemCaseInsensitive(t *testing.T) {
	e := newTestExecutor()
	for _, variant := range []string{"system", "System", "SYSTEM", "  system  "} {
		cmd := exec.Command("echo", "test")
		originalPath := cmd.Path
		if err := e.configureRunAs(cmd, variant); err != nil {
			t.Fatalf("configureRunAs(%q) error: %v", variant, err)
		}
		if cmd.Path != originalPath {
			t.Fatalf("configureRunAs(%q) changed path", variant)
		}
	}
}

func TestConfigureRunAsElevatedWhenNotRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix-only test")
	}

	e := newTestExecutor()
	cmd := exec.Command("echo", "hello")

	// When running tests as non-root, elevated should wrap with sudo
	err := e.configureRunAs(cmd, "elevated")
	if err != nil {
		// If running as root in CI, elevated is a no-op
		t.Skipf("likely running as root: %v", err)
	}
	// Non-root path: should have wrapped with sudo
	if cmd.Path != "/usr/bin/sudo" {
		t.Fatalf("expected sudo path, got %q", cmd.Path)
	}
}

func TestConfigureRunAsSpecificUserUsesSudo(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix-only test")
	}

	e := newTestExecutor()
	cmd := exec.Command("bash", "-c", "whoami")

	if err := e.configureRunAs(cmd, "testuser"); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if cmd.Path != "/usr/bin/sudo" {
		t.Fatalf("expected sudo path, got %q", cmd.Path)
	}
	// Should contain -u testuser
	argsStr := strings.Join(cmd.Args, " ")
	if !strings.Contains(argsStr, "-u testuser") {
		t.Fatalf("expected -u testuser in args, got %v", cmd.Args)
	}
	if !strings.Contains(argsStr, "-n") {
		t.Fatalf("expected -n (non-interactive) in args, got %v", cmd.Args)
	}
}

func TestConfigureRunAsPreservesOriginalArgs(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix-only test")
	}

	e := newTestExecutor()
	cmd := exec.Command("python3", "-c", "print('hello')")

	if err := e.configureRunAs(cmd, "otheruser"); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	// Original command should be preserved after sudo args
	argsStr := strings.Join(cmd.Args, " ")
	if !strings.Contains(argsStr, "python3 -c print('hello')") {
		t.Fatalf("original args not preserved: %v", cmd.Args)
	}
}

func TestExecuteBashScriptAsCurrentUser(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "exec-bash-user",
		ScriptType: ScriptTypeBash,
		Script:     "echo $(whoami)",
		Timeout:    10,
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d (stderr: %s)", result.ExitCode, result.Stderr)
	}
	if strings.TrimSpace(result.Stdout) == "" {
		t.Fatal("expected non-empty stdout with username")
	}
}

func TestExecutePythonScript(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "exec-python",
		ScriptType: ScriptTypePython,
		Script:     "import os; print(os.getenv('BREEZE_EXECUTION_ID', 'missing'))",
		Timeout:    10,
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exit code %d, stderr: %s", result.ExitCode, result.Stderr)
	}
	if !strings.Contains(result.Stdout, "exec-python") {
		t.Fatalf("expected BREEZE_EXECUTION_ID in output, got %q", result.Stdout)
	}
}

func TestExecuteWithParameters(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "exec-params",
		ScriptType: ScriptTypeBash,
		Script:     "echo $BREEZE_PARAM_SITE_NAME",
		Parameters: map[string]string{
			"site-name": "headquarters",
		},
		Timeout: 10,
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exit code %d, stderr: %s", result.ExitCode, result.Stderr)
	}
	if !strings.Contains(result.Stdout, "headquarters") {
		t.Fatalf("expected parameter in output, got %q", result.Stdout)
	}
}

func TestExecuteTimeout(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping timeout test in short mode")
	}
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "exec-timeout",
		ScriptType: ScriptTypeBash,
		Script:     "sleep 300",
		Timeout:    1, // 1 second timeout
	})

	// Should complete (possibly with error)
	if result == nil {
		t.Fatal("expected non-nil result even on timeout")
	}
	if result.ExitCode != -1 {
		t.Fatalf("expected exit code -1 on timeout, got %d", result.ExitCode)
	}
	if !strings.Contains(result.Error, "timed out") {
		t.Fatalf("expected timeout error, got %q", result.Error)
	}
	_ = err
}

func TestExecuteNonZeroExitCode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "exec-nonzero",
		ScriptType: ScriptTypeBash,
		Script:     "exit 42",
		Timeout:    10,
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 42 {
		t.Fatalf("expected exit code 42, got %d", result.ExitCode)
	}
}

func TestExecuteStderrCapture(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "exec-stderr",
		ScriptType: ScriptTypeBash,
		Script:     "echo 'error message' >&2",
		Timeout:    10,
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result.Stderr, "error message") {
		t.Fatalf("expected stderr to contain 'error message', got %q", result.Stderr)
	}
}

func TestExecuteEmptyScript(t *testing.T) {
	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "exec-empty",
		ScriptType: ScriptTypeBash,
		Script:     "",
		Timeout:    10,
	})

	if err == nil {
		t.Fatal("expected error for empty script")
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if !strings.Contains(result.Error, "empty") {
		t.Fatalf("expected empty script error, got %q", result.Error)
	}
}

func TestExecuteTimestamps(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "exec-timestamps",
		ScriptType: ScriptTypeBash,
		Script:     "echo ok",
		Timeout:    10,
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.StartedAt == "" {
		t.Fatal("StartedAt should be set")
	}
	if result.CompletedAt == "" {
		t.Fatal("CompletedAt should be set")
	}
	if result.ExecutionID != "exec-timestamps" {
		t.Fatalf("expected ExecutionID exec-timestamps, got %s", result.ExecutionID)
	}
}

func TestCancelNonexistentExecution(t *testing.T) {
	e := newTestExecutor()
	err := e.Cancel("nonexistent-id")
	if err == nil {
		t.Fatal("expected error cancelling nonexistent execution")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestListRunningEmpty(t *testing.T) {
	e := newTestExecutor()
	running := e.ListRunning()
	if len(running) != 0 {
		t.Fatalf("expected 0 running, got %d", len(running))
	}
}

func TestGetRunningCountEmpty(t *testing.T) {
	e := newTestExecutor()
	if count := e.GetRunningCount(); count != 0 {
		t.Fatalf("expected 0 running count, got %d", count)
	}
}
