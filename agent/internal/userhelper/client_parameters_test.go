package userhelper

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// decodeHelperScriptStdout pulls the stdout field out of the IPC result
// payload executeScript marshals.
func decodeHelperScriptStdout(t *testing.T, result ipc.IPCCommandResult) string {
	t.Helper()
	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (%s)", result.Status, result.Error)
	}
	var payload struct {
		ExitCode int    `json:"exitCode"`
		Stdout   string `json:"stdout"`
		Stderr   string `json:"stderr"`
	}
	if err := json.Unmarshal(result.Result, &payload); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if payload.ExitCode != 0 {
		t.Fatalf("exitCode = %d, stderr = %q", payload.ExitCode, payload.Stderr)
	}
	return payload.Stdout
}

// TestExecuteScriptDeliversParameters is the regression guard for #4882:
// the helper rebuilt executor.ScriptExecution from the forwarded payload but
// never decoded `parameters`, so every runAs=user run reached the shell with
// no BREEZE_PARAM_* environment and with its {{name}} placeholders unexpanded
// — while the identical script in SYSTEM context worked. Covers all three
// consequences of the drop: the env var, the template substitution, and the
// "-" → "_" key folding buildEnvironment applies.
func TestExecuteScriptDeliversParameters(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("script execution test requires Unix/macOS shell")
	}

	c := New("/tmp/test.sock", ipc.HelperRoleUser)

	result := c.executeScript(ipc.IPCCommand{
		CommandID: "exec-params",
		Type:      tools.CmdScript,
		Payload: marshalPayload(t, map[string]any{
			"language":       "bash",
			"scriptId":       "script-4882",
			"timeoutSeconds": 10,
			"content": strings.Join([]string{
				`echo "env=$BREEZE_PARAM_GOOGLEEMAIL"`,
				`echo "folded=$BREEZE_PARAM_TENANT_DOMAIN"`,
				`echo "sub={{GoogleEmail}}"`,
				`echo "scriptid=$BREEZE_SCRIPT_ID"`,
			}, "\n"),
			"parameters": map[string]any{
				"GoogleEmail":   "gcpw.user@example.com",
				"tenant-domain": "example.com",
				// Non-string values are dropped, matching the daemon's
				// string-only filter in handlers_script.go.
				"retries": 3,
			},
		}),
	})

	stdout := decodeHelperScriptStdout(t, result)

	if !strings.Contains(stdout, "env=gcpw.user@example.com") {
		t.Errorf("BREEZE_PARAM_GOOGLEEMAIL missing from the spawned process environment; stdout = %q", stdout)
	}
	if !strings.Contains(stdout, "folded=example.com") {
		t.Errorf("BREEZE_PARAM_TENANT_DOMAIN (dash folded to underscore) missing; stdout = %q", stdout)
	}
	if !strings.Contains(stdout, "sub=gcpw.user@example.com") {
		t.Errorf("{{GoogleEmail}} was not substituted into the script content; stdout = %q", stdout)
	}
	if !strings.Contains(stdout, "scriptid=script-4882") {
		t.Errorf("BREEZE_SCRIPT_ID missing — ScriptID was not decoded from the payload; stdout = %q", stdout)
	}
}

// TestExecuteScriptWithoutParametersLeavesPlaceholdersAlone confirms the
// no-parameters case is unchanged: nothing is substituted and no stray
// BREEZE_PARAM_* entry appears.
func TestExecuteScriptWithoutParametersLeavesPlaceholdersAlone(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("script execution test requires Unix/macOS shell")
	}

	c := New("/tmp/test.sock", ipc.HelperRoleUser)

	result := c.executeScript(ipc.IPCCommand{
		CommandID: "exec-no-params",
		Type:      tools.CmdScript,
		Payload: marshalPayload(t, map[string]any{
			"language":       "bash",
			"timeoutSeconds": 10,
			"content":        `echo "sub={{GoogleEmail}}"; echo "count=$(printenv | grep -c '^BREEZE_PARAM_' || true)"`,
		}),
	})

	stdout := decodeHelperScriptStdout(t, result)

	if !strings.Contains(stdout, "sub={{GoogleEmail}}") {
		t.Errorf("placeholder must be left intact when no parameters were sent; stdout = %q", stdout)
	}
	if !strings.Contains(stdout, "count=0") {
		t.Errorf("expected zero BREEZE_PARAM_* entries; stdout = %q", stdout)
	}
}

// TestExecuteScriptNeverDeliversSecretEnv locks in the #3409 refusal from the
// other side of the IPC hop. handleScript already refuses a secret-bearing
// runAs=user run before it forwards anything (runAsSupportsSecrets), but the
// helper must not become a second delivery route if a `secretEnv` key ever
// reaches it: BREEZE_VAR_* is a SYSTEM-context-only capability, and #4882's
// fix (decoding `parameters` here) must not be widened into decoding secrets
// here too.
func TestExecuteScriptNeverDeliversSecretEnv(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("script execution test requires Unix/macOS shell")
	}

	c := New("/tmp/test.sock", ipc.HelperRoleUser)

	result := c.executeScript(ipc.IPCCommand{
		CommandID: "exec-secretenv",
		Type:      tools.CmdScript,
		Payload: marshalPayload(t, map[string]any{
			"language":       "bash",
			"timeoutSeconds": 10,
			"content":        `echo "count=$(printenv | grep -c '^BREEZE_VAR_' || true)"; echo "value=[$BREEZE_VAR_API_TOKEN]"`,
			executor.SecretEnvPayloadKey: map[string]any{
				"api_token": "hunter2-not-a-real-credential",
			},
		}),
	})

	stdout := decodeHelperScriptStdout(t, result)

	if !strings.Contains(stdout, "count=0") {
		t.Errorf("user-context runs must never receive BREEZE_VAR_* entries; stdout = %q", stdout)
	}
	if strings.Contains(stdout, "hunter2-not-a-real-credential") {
		t.Errorf("a secretEnv value reached the user-context process environment; stdout = %q", stdout)
	}
}
