package userhelper

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// #5129 — the helper rebuilds executor.ScriptExecution from the forwarded
// payload and runs the SAME security validator as the daemon. If it does not
// decode `acknowledgedSecurityPatterns`, an acknowledged script succeeds in
// SYSTEM context and is refused in user context — the exact asymmetry #4882
// produced for `parameters`.

const helperHKLMScript = `Set-ItemProperty -Path 'HKLM:\SOFTWARE\Contoso' -Name Enabled -Value 1`

// decodeHelperScriptError pulls the error text out of an executeScript result
// regardless of which arm produced it: a validation refusal comes back as a
// failed IPC result, while a run that merely exits non-zero comes back
// "completed" with the detail in the marshalled payload.
func decodeHelperScriptError(t *testing.T, result ipc.IPCCommandResult) string {
	t.Helper()
	if result.Error != "" {
		return result.Error
	}
	var payload struct {
		Error  string `json:"error"`
		Stderr string `json:"stderr"`
	}
	if len(result.Result) > 0 {
		if err := json.Unmarshal(result.Result, &payload); err != nil {
			t.Fatalf("unmarshal result: %v", err)
		}
	}
	return payload.Error
}

func TestExecuteScriptHonoursAcknowledgedSecurityPatterns(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("script execution test requires Unix/macOS shell")
	}

	tests := []struct {
		name         string
		acknowledged any
		omit         bool
		wantRefusal  bool
	}{
		{name: "absent key is fail closed", omit: true, wantRefusal: true},
		{name: "empty list is fail closed", acknowledged: []any{}, wantRefusal: true},
		{name: "unrelated acknowledgement grants nothing", acknowledged: []any{"crontab modification"}, wantRefusal: true},
		{
			name:         "matching acknowledgement is honoured",
			acknowledged: []any{"PowerShell HKLM modification"},
			wantRefusal:  false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := New("/tmp/test.sock", ipc.HelperRoleUser)

			payload := map[string]any{
				"language":       "bash",
				"scriptId":       "script-5129",
				"timeoutSeconds": 10,
				"content":        helperHKLMScript,
			}
			if !tc.omit {
				payload["acknowledgedSecurityPatterns"] = tc.acknowledged
			}

			result := c.executeScript(ipc.IPCCommand{
				CommandID: "exec-ack",
				Type:      tools.CmdScript,
				Payload:   marshalPayload(t, payload),
			})

			errText := decodeHelperScriptError(t, result)
			refused := strings.Contains(errText, "potentially dangerous pattern detected")
			if refused != tc.wantRefusal {
				t.Fatalf("validation refusal = %v, want %v; error was %q", refused, tc.wantRefusal, errText)
			}
		})
	}
}

// A basic-level pattern is unconditional on the helper too.
func TestExecuteScriptNeverAcknowledgesBasicPatterns(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("script execution test requires Unix/macOS shell")
	}

	c := New("/tmp/test.sock", ipc.HelperRoleUser)

	result := c.executeScript(ipc.IPCCommand{
		CommandID: "exec-ack-basic",
		Type:      tools.CmdScript,
		Payload: marshalPayload(t, map[string]any{
			"language":                     "bash",
			"timeoutSeconds":               10,
			"content":                      `Format-Volume -DriveLetter D`,
			"acknowledgedSecurityPatterns": []any{"PowerShell volume format"},
		}),
	})

	errText := decodeHelperScriptError(t, result)
	if !strings.Contains(errText, "cannot be overridden") {
		t.Fatalf("a basic pattern must stay blocked on the helper path; error was %q", errText)
	}
}
