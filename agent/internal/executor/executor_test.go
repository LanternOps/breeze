package executor

import (
	"encoding/json"
	"fmt"
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

func TestExecuteCapturesAccentedUTF8Output(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash accent test runs on Unix")
	}

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "exec-accent",
		ScriptID:   "script-accent",
		ScriptType: ScriptTypeBash,
		Script:     "printf 'café\\n'",
	})
	if err != nil {
		t.Fatalf("execute failed: %v", err)
	}
	if result.Stdout != "café\n" {
		t.Fatalf("stdout = %q, want %q", result.Stdout, "café\n")
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

// countEnvEntries returns how many entries in env exactly equal key+"="+value.
// os/exec dedupes Cmd.Env by keeping the LAST occurrence, but buildEnvironment
// returns the raw (possibly duplicated) slice, so tests that care about
// duplication count occurrences rather than relying on a single membership
// check.
func countEnvEntries(env []string, key, value string) int {
	target := key + "=" + value
	count := 0
	for _, entry := range env {
		if entry == target {
			count++
		}
	}
	return count
}

// lastEnvEntry returns the last entry in env whose key matches, or "" if none
// exists. Mirrors the dedupe behavior os/exec applies to Cmd.Env (keep last).
func lastEnvEntry(env []string, key string) (string, bool) {
	prefix := key + "="
	for i := len(env) - 1; i >= 0; i-- {
		if strings.HasPrefix(env[i], prefix) {
			return strings.TrimPrefix(env[i], prefix), true
		}
	}
	return "", false
}

func TestBuildEnvironmentIncludesSecretEnv(t *testing.T) {
	e := newTestExecutor()
	env := e.buildEnvironment(ScriptExecution{
		ID:       "exec-secret",
		ScriptID: "script-secret",
		SecretEnv: SecretEnv{
			"api_token": "super-secret-value",
		},
	})

	if !hasEnvEntry(env, "BREEZE_VAR_API_TOKEN", "super-secret-value") {
		t.Fatal("missing BREEZE_VAR_API_TOKEN")
	}
	if !hasEnvEntry(env, "BREEZE_EXECUTION_ID", "exec-secret") {
		t.Fatal("missing BREEZE_EXECUTION_ID")
	}
	if !hasEnvEntry(env, "BREEZE_SCRIPT_ID", "script-secret") {
		t.Fatal("missing BREEZE_SCRIPT_ID")
	}
}

func TestBuildEnvironmentParamAndSecretNamespacesDoNotCollide(t *testing.T) {
	e := newTestExecutor()
	env := e.buildEnvironment(ScriptExecution{
		ID:       "exec-both",
		ScriptID: "script-both",
		Parameters: map[string]string{
			"token": "param-value",
		},
		SecretEnv: SecretEnv{
			"token": "secret-value",
		},
	})

	if !hasEnvEntry(env, "BREEZE_PARAM_TOKEN", "param-value") {
		t.Fatal("missing BREEZE_PARAM_TOKEN")
	}
	if !hasEnvEntry(env, "BREEZE_VAR_TOKEN", "secret-value") {
		t.Fatal("missing BREEZE_VAR_TOKEN")
	}
	if hasEnvEntry(env, "BREEZE_PARAM_TOKEN", "secret-value") {
		t.Fatal("secret value leaked into the BREEZE_PARAM_ namespace")
	}
	if hasEnvEntry(env, "BREEZE_VAR_TOKEN", "param-value") {
		t.Fatal("parameter value leaked into the BREEZE_VAR_ namespace")
	}
}

func TestBuildEnvironmentSecretIsAppendedAfterOsEnvironAndWins(t *testing.T) {
	// Seed a machine-environment value under the same BREEZE_VAR_ key the
	// delivered secret will use. os/exec dedupes Cmd.Env keeping the LAST
	// occurrence, so the delivered secret must be the last entry with this
	// key or a hostile pre-existing environment variable could shadow it.
	t.Setenv("BREEZE_VAR_API_TOKEN", "inherited-value")

	e := newTestExecutor()
	env := e.buildEnvironment(ScriptExecution{
		ID:       "exec-shadow",
		ScriptID: "script-shadow",
		SecretEnv: SecretEnv{
			"api_token": "delivered-value",
		},
	})

	got, ok := lastEnvEntry(env, "BREEZE_VAR_API_TOKEN")
	if !ok {
		t.Fatal("missing BREEZE_VAR_API_TOKEN entry")
	}
	if got != "delivered-value" {
		t.Fatalf("last BREEZE_VAR_API_TOKEN entry = %q, want %q (inherited value must not win)", got, "delivered-value")
	}
	if countEnvEntries(env, "BREEZE_VAR_API_TOKEN", "delivered-value") != 1 {
		t.Fatalf("expected exactly one delivered-value entry, env: %#v", env)
	}
	if countEnvEntries(env, "BREEZE_VAR_API_TOKEN", "inherited-value") != 1 {
		t.Fatalf("expected the inherited os.Environ() entry to still be present ahead of the delivered one, env: %#v", env)
	}
}

func TestBuildEnvironmentEmptyOrNilSecretEnvAddsNoEntries(t *testing.T) {
	e := newTestExecutor()

	for name, secretEnv := range map[string]SecretEnv{
		"nil":   nil,
		"empty": {},
	} {
		t.Run(name, func(t *testing.T) {
			env := e.buildEnvironment(ScriptExecution{
				ID:        "exec-nosecrets",
				ScriptID:  "script-nosecrets",
				SecretEnv: secretEnv,
			})
			for _, entry := range env {
				if strings.HasPrefix(entry, SecretEnvPrefix) {
					t.Fatalf("unexpected %s entry with %s SecretEnv: %q", SecretEnvPrefix, name, entry)
				}
			}
		})
	}
}

func TestScriptExecutionRedactsSecretEnvUnderEveryVerbAndJSON(t *testing.T) {
	const secretValue = "super-secret-value"
	script := ScriptExecution{
		ID:       "exec-redact",
		ScriptID: "script-redact",
		Script:   "echo hi",
		SecretEnv: SecretEnv{
			"api_token": secretValue,
		},
	}

	renderings := map[string]string{
		"%v":  fmt.Sprintf("%v", script),
		"%+v": fmt.Sprintf("%+v", script),
		"%#v": fmt.Sprintf("%#v", script),
	}
	for verb, rendered := range renderings {
		if strings.Contains(rendered, secretValue) {
			t.Fatalf("%s rendering of ScriptExecution leaked the secret value: %s", verb, rendered)
		}
	}

	marshaled, err := json.Marshal(script)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	if strings.Contains(string(marshaled), secretValue) {
		t.Fatalf("json.Marshal of ScriptExecution leaked the secret value: %s", marshaled)
	}
	if strings.Contains(string(marshaled), "SecretEnv") {
		t.Fatalf("json.Marshal of ScriptExecution should omit SecretEnv entirely (json:\"-\"), got: %s", marshaled)
	}
}
