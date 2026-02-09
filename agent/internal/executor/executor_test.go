package executor

import (
	"os/exec"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

func newTestExecutor() *Executor {
	return New(config.Default())
}

func hasEnvEntry(env []string, key, value string) bool {
	target := key + "=" + value
	for _, entry := range env {
		if entry == target {
			return true
		}
	}
	return false
}

func TestExecuteRejectsUnsupportedScriptType(t *testing.T) {
	e := newTestExecutor()

	result, err := e.Execute(ScriptExecution{
		ID:         "exec-unsupported",
		ScriptID:   "script-1",
		ScriptType: "ruby",
		Script:     "puts 'hi'",
	})

	if err == nil {
		t.Fatal("expected unsupported script type to fail")
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.ExitCode != -1 {
		t.Fatalf("expected exit code -1, got %d", result.ExitCode)
	}
	if !strings.Contains(result.Error, "unsupported script type") {
		t.Fatalf("unexpected error: %q", result.Error)
	}
	if result.CompletedAt == "" {
		t.Fatal("expected completed timestamp to be set")
	}
	if e.GetRunningCount() != 0 {
		t.Fatal("expected no running executions after failure")
	}
}

func TestExecuteRejectsCmdOnNonWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("CMD is supported on Windows")
	}

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "exec-cmd",
		ScriptID:   "script-2",
		ScriptType: ScriptTypeCMD,
		Script:     "echo hi",
	})

	if err == nil {
		t.Fatal("expected CMD script to fail on non-Windows")
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if !strings.Contains(result.Error, "not available on") {
		t.Fatalf("unexpected error: %q", result.Error)
	}
	if result.ExitCode != -1 {
		t.Fatalf("expected exit code -1, got %d", result.ExitCode)
	}
}

func TestExecuteRejectsDangerousContent(t *testing.T) {
	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "exec-dangerous",
		ScriptID:   "script-3",
		ScriptType: ScriptTypeBash,
		Script:     "rm -rf /",
	})

	if err == nil {
		t.Fatal("expected dangerous script to fail validation")
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if !strings.Contains(result.Error, "script validation failed") {
		t.Fatalf("unexpected error: %q", result.Error)
	}
	if result.ExitCode != -1 {
		t.Fatalf("expected exit code -1, got %d", result.ExitCode)
	}
	if e.GetRunningCount() != 0 {
		t.Fatal("expected no running executions after validation failure")
	}
}

func TestBuildEnvironmentIncludesBreezeMetadataAndParameters(t *testing.T) {
	e := newTestExecutor()
	env := e.buildEnvironment(ScriptExecution{
		ID:       "exec-env",
		ScriptID: "script-env",
		Parameters: map[string]string{
			"api-key": "secret",
			"site":    "hq",
		},
	})

	if !hasEnvEntry(env, "BREEZE_EXECUTION_ID", "exec-env") {
		t.Fatal("missing BREEZE_EXECUTION_ID")
	}
	if !hasEnvEntry(env, "BREEZE_SCRIPT_ID", "script-env") {
		t.Fatal("missing BREEZE_SCRIPT_ID")
	}
	if !hasEnvEntry(env, "BREEZE_PARAM_API_KEY", "secret") {
		t.Fatal("missing transformed parameter env for api-key")
	}
	if !hasEnvEntry(env, "BREEZE_PARAM_SITE", "hq") {
		t.Fatal("missing parameter env for site")
	}
}

func TestConfigureRunAsSystemNoOp(t *testing.T) {
	e := newTestExecutor()
	cmd := exec.Command("echo", "hello")
	originalPath := cmd.Path
	originalArgs := append([]string(nil), cmd.Args...)

	if err := e.configureRunAs(cmd, "system"); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if cmd.Path != originalPath {
		t.Fatalf("path changed unexpectedly: got %q want %q", cmd.Path, originalPath)
	}
	if !reflect.DeepEqual(cmd.Args, originalArgs) {
		t.Fatalf("args changed unexpectedly: got %#v want %#v", cmd.Args, originalArgs)
	}
}

func TestConfigureRunAsUserRequiresHelperSession(t *testing.T) {
	e := newTestExecutor()
	cmd := exec.Command("echo", "hello")

	err := e.configureRunAs(cmd, "user")
	if err == nil {
		t.Fatal("expected runAs=user to require helper session")
	}
	if !strings.Contains(err.Error(), "requires a connected user helper session") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestConfigureRunAsRootUsesSudoOnUnix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sudo runAs path applies to Unix only")
	}

	e := newTestExecutor()
	cmd := exec.Command("bash", "-lc", "echo hello")

	if err := e.configureRunAs(cmd, "root"); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if cmd.Path != "/usr/bin/sudo" {
		t.Fatalf("expected sudo path, got %q", cmd.Path)
	}
	if len(cmd.Args) < 3 || cmd.Args[0] != "sudo" || cmd.Args[1] != "-n" || cmd.Args[2] != "bash" {
		t.Fatalf("unexpected sudo args: %#v", cmd.Args)
	}
}
