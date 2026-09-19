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

// TestExecuteScriptDeliversMetacharacterValueLiterallyInEnvironment covers the
// safe half of parameter delivery. BREEZE_PARAM_* rides Cmd.Env, which is
// never shell-parsed, so a value full of metacharacters must arrive byte-exact
// rather than being re-interpreted. This matters now in a way it did not
// before #4882: this path delivers parameters at all for the first time.
func TestExecuteScriptDeliversMetacharacterValueLiterallyInEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("script execution test requires Unix/macOS shell")
	}

	const meta = `a;b && c | d $(printf zz) "q" 'r'`

	c := New("/tmp/test.sock", ipc.HelperRoleUser)

	result := c.executeScript(ipc.IPCCommand{
		CommandID: "exec-meta-env",
		Type:      tools.CmdScript,
		Payload: marshalPayload(t, map[string]any{
			"language":       "bash",
			"timeoutSeconds": 10,
			// Read through the environment only — the placeholder is
			// deliberately absent from the content, since substitution puts a
			// value into shell SOURCE, where metacharacters are code.
			"content":    `printf 'raw=%s\n' "$BREEZE_PARAM_META"`,
			"parameters": map[string]any{"meta": meta},
		}),
	})

	stdout := decodeHelperScriptStdout(t, result)

	// Byte-exactness is the whole assertion: any shell evaluation of the
	// substring `$(printf zz)` would rewrite the line, so an exact match
	// proves the value was never re-interpreted.
	if got, want := strings.TrimRight(stdout, "\n"), "raw="+meta; got != want {
		t.Fatalf("BREEZE_PARAM_META was not delivered byte-exact.\n got: %q\nwant: %q", got, want)
	}
}

// TestExecuteScriptValidatesAfterParameterSubstitution is the other half:
// substitution writes the value into shell SOURCE, so the security validator
// has to see the resolved text. executor.Execute substitutes first and
// validates second, and the documented contract (docs/features/scripts.mdx)
// says a parameter value that injects a dangerous command is caught.
//
// Before #4882 the helper path could not reach this at all — nothing was
// substituted, so a dangerous value was inert here and the parity with the
// SYSTEM path was untested. Now that parameters are live on this path, prove
// the validator is live with them.
//
// The payload is deliberately harmless if the validator ever fails open: it
// resolves to `echo Format-Volume`, which matches the PowerShell volume-format
// pattern as TEXT while doing nothing but printing a word.
func TestExecuteScriptValidatesAfterParameterSubstitution(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("script execution test requires Unix/macOS shell")
	}

	c := New("/tmp/test.sock", ipc.HelperRoleUser)

	result := c.executeScript(ipc.IPCCommand{
		CommandID: "exec-dangerous-param",
		Type:      tools.CmdScript,
		Payload: marshalPayload(t, map[string]any{
			"language":       "bash",
			"timeoutSeconds": 10,
			"content":        `echo {{marker}}`,
			"parameters":     map[string]any{"marker": "Format-Volume"},
		}),
	})

	if result.Status != "failed" {
		t.Fatalf("a parameter value that resolves to a dangerous pattern must be refused, got status %q (result %s)", result.Status, string(result.Result))
	}
	if !strings.Contains(result.Error, "script validation failed") {
		t.Errorf("expected the validator's refusal, got error %q", result.Error)
	}
}
