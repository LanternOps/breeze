package userhelper

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/helper"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func marshalPayload(t *testing.T, payload map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return data
}

func waitForCondition(t *testing.T, timeout time.Duration, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

func TestExecuteScriptListRunningUsesSharedExecutor(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("script execution test requires Unix/macOS shell")
	}

	c := New("/tmp/test.sock", ipc.HelperRoleUser)

	done := make(chan ipc.IPCCommandResult, 1)
	go func() {
		done <- c.executeScript(ipc.IPCCommand{
			CommandID: "exec-1",
			Type:      tools.CmdScript,
			Payload: marshalPayload(t, map[string]any{
				"language":       "bash",
				"content":        "sleep 30",
				"timeoutSeconds": 30,
			}),
		})
	}()

	waitForCondition(t, 2*time.Second, func() bool {
		return c.executor.GetRunningCount() == 1
	})

	listResult := c.executeScript(ipc.IPCCommand{
		CommandID: "list-1",
		Type:      tools.CmdScriptListRunning,
		Payload:   marshalPayload(t, map[string]any{}),
	})
	if listResult.Status != "completed" {
		t.Fatalf("expected completed list status, got %s (%s)", listResult.Status, listResult.Error)
	}

	var listPayload struct {
		Running []string `json:"running"`
	}
	if err := json.Unmarshal(listResult.Result, &listPayload); err != nil {
		t.Fatalf("unmarshal list result: %v", err)
	}
	if len(listPayload.Running) != 1 || listPayload.Running[0] != "exec-1" {
		t.Fatalf("unexpected running list: %+v", listPayload.Running)
	}

	cancelResult := c.executeScript(ipc.IPCCommand{
		CommandID: "cancel-1",
		Type:      tools.CmdScriptCancel,
		Payload: marshalPayload(t, map[string]any{
			"executionId": "exec-1",
		}),
	})
	if cancelResult.Status != "completed" {
		t.Fatalf("expected completed cancel status, got %s (%s)", cancelResult.Status, cancelResult.Error)
	}

	// #3525: the agent grades every helper's STRUCTURED outcome. A helper that
	// answers `completed` with no recognisable `outcome` is graded kill_failed,
	// so asserting only the status would let this whole branch regress to the
	// old always-`cancelled: true` shape without any test noticing.
	var cancelPayload struct {
		ExecutionID string `json:"executionId"`
		Outcome     string `json:"outcome"`
		Cancelled   bool   `json:"cancelled"`
	}
	if err := json.Unmarshal(cancelResult.Result, &cancelPayload); err != nil {
		t.Fatalf("unmarshal cancel result: %v", err)
	}
	if cancelPayload.Outcome != string(executor.CancelTerminated) {
		t.Fatalf("cancel outcome = %q, want terminated", cancelPayload.Outcome)
	}
	if !cancelPayload.Cancelled {
		t.Fatal("cancelled = false after a proven termination")
	}
	if cancelPayload.ExecutionID != "exec-1" {
		t.Fatalf("executionId = %q, want exec-1", cancelPayload.ExecutionID)
	}

	<-done
	waitForCondition(t, 2*time.Second, func() bool {
		return c.executor.GetRunningCount() == 0
	})
}

// TestExecuteScriptExtractsCustomFieldsBeforeSanitizeOutput is the
// regression guard for the Critical finding in PR #4781's review: this
// executeScript call site is the helper PROCESS that actually runs a
// runAs:user script, so it is the only place that can extract markers from
// genuinely raw stdout for that path — extracting after the IPC round trip
// (in the main agent) would run on stdout this same function has already
// sanitized, corrupting any marker whose JSON contains a token/secret/
// password-shaped key exactly like the marker below.
func TestExecuteScriptExtractsCustomFieldsBeforeSanitizeOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("script execution test requires Unix/macOS shell")
	}

	c := New("/tmp/test.sock", ipc.HelperRoleUser)

	result := c.executeScript(ipc.IPCCommand{
		CommandID: "exec-custom-fields",
		Type:      tools.CmdScript,
		Payload: marshalPayload(t, map[string]any{
			"language":       "bash",
			"content":        `echo 'scanning'; echo '::breeze:custom-fields:: {"vault_token_id":"abcdefgh"}'; echo 'done'`,
			"timeoutSeconds": 10,
		}),
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (%s)", result.Status, result.Error)
	}

	var payload struct {
		Stdout            string `json:"stdout"`
		CustomFieldWrites struct {
			SchemaVersion int            `json:"schemaVersion"`
			Fields        map[string]any `json:"fields"`
		} `json:"customFieldWrites"`
	}
	if err := json.Unmarshal(result.Result, &payload); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}

	if strings.Contains(payload.Stdout, "::breeze:custom-fields::") {
		t.Fatalf("marker line must be stripped from the helper's own stdout, got %q", payload.Stdout)
	}
	if payload.CustomFieldWrites.SchemaVersion != 1 {
		t.Fatalf("schemaVersion = %d, want 1 (envelope missing entirely: %+v)", payload.CustomFieldWrites.SchemaVersion, payload)
	}
	if payload.CustomFieldWrites.Fields["vault_token_id"] != "abcdefgh" {
		t.Fatalf(
			"fields[vault_token_id] = %#v, want the intact secret-shaped value — "+
				"if this is corrupted or missing, extraction ran AFTER SanitizeOutput instead of before it",
			payload.CustomFieldWrites.Fields["vault_token_id"],
		)
	}
}

// TestExecuteScriptNoMarkerOmitsCustomFieldWrites confirms the no-marker case
// doesn't add an empty/spurious customFieldWrites key to the IPC payload.
func TestExecuteScriptNoMarkerOmitsCustomFieldWrites(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("script execution test requires Unix/macOS shell")
	}

	c := New("/tmp/test.sock", ipc.HelperRoleUser)

	result := c.executeScript(ipc.IPCCommand{
		CommandID: "exec-no-custom-fields",
		Type:      tools.CmdScript,
		Payload: marshalPayload(t, map[string]any{
			"language":       "bash",
			"content":        `echo 'hello from breeze'`,
			"timeoutSeconds": 10,
		}),
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (%s)", result.Status, result.Error)
	}

	var payload map[string]any
	if err := json.Unmarshal(result.Result, &payload); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if _, present := payload["customFieldWrites"]; present {
		t.Fatalf("expected no customFieldWrites key when no marker was printed, got %#v", payload["customFieldWrites"])
	}
}

func TestExecuteProcessCapturesAccentedUTF8Output(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("accent capture test uses /bin/sh")
	}

	c := New("/tmp/test.sock", ipc.HelperRoleUser)
	result := c.executeProcess(ipc.IPCCommand{
		CommandID: "proc-accent",
		Type:      "exec",
		Payload: marshalPayload(t, map[string]any{
			"command":        "/bin/sh",
			"args":           []any{"-c", "printf 'café\\n'"},
			"timeoutSeconds": 10,
		}),
	})
	if result.Status != "completed" {
		t.Fatalf("expected completed status, got %s (%s)", result.Status, result.Error)
	}

	var payload struct {
		Stdout string `json:"stdout"`
	}
	if err := json.Unmarshal(result.Result, &payload); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if payload.Stdout != "café\n" {
		t.Fatalf("stdout = %q, want %q", payload.Stdout, "café\n")
	}
}

func TestAuthorizeCommandUsesHelperScopes(t *testing.T) {
	c := New("/tmp/test.sock", ipc.HelperRoleUser)
	c.scopes = []string{"run_as_user"}

	if err := c.authorizeCommand(tools.CmdScript); err != nil {
		t.Fatalf("expected script command to be allowed, got %v", err)
	}

	if err := c.authorizeCommand("exec"); err != nil {
		t.Fatalf("expected exec command to be allowed, got %v", err)
	}

	err := c.authorizeCommand(tools.CmdTakeScreenshot)
	if runtime.GOOS == "darwin" {
		if err != nil {
			t.Fatalf("expected screenshot command to be allowed on darwin run_as_user helper, got %v", err)
		}
	} else if err == nil {
		t.Fatal("expected screenshot command to be rejected without desktop scope")
	}
}

func TestIsAllowedLaunchBinaryAllowsHelperInstallDir(t *testing.T) {
	selfPath := filepath.Join(t.TempDir(), "breeze-agent")
	helperPath := helper.DefaultBinaryPath()

	if !isAllowedLaunchBinary(selfPath, helperPath) {
		t.Fatal("expected helper install path to be allowed")
	}

	otherPath := filepath.Join(t.TempDir(), "other", "random-binary")
	if isAllowedLaunchBinary(selfPath, otherPath) {
		t.Fatal("expected unrelated binary path to be rejected")
	}
}

func TestValidateLaunchProcessRequestRejectsOversizedAndControlChars(t *testing.T) {
	req := &ipc.LaunchProcessRequest{
		BinaryPath: "/usr/local/bin/breeze-agent",
		Args:       []string{"ok"},
	}
	if err := validateLaunchProcessRequest(req); err != nil {
		t.Fatalf("expected valid request, got %v", err)
	}

	if err := validateLaunchProcessRequest(&ipc.LaunchProcessRequest{
		BinaryPath: strings.Repeat("a", maxLaunchBinaryPathBytes+1),
	}); err == nil {
		t.Fatal("expected oversized binaryPath to be rejected")
	}

	if err := validateLaunchProcessRequest(&ipc.LaunchProcessRequest{
		BinaryPath: "/usr/local/bin/breeze-agent",
		Args:       []string{"bad\narg"},
	}); err == nil {
		t.Fatal("expected control-char arg to be rejected")
	}

	tooManyArgs := make([]string, maxLaunchArgs+1)
	for i := range tooManyArgs {
		tooManyArgs[i] = "x"
	}
	if err := validateLaunchProcessRequest(&ipc.LaunchProcessRequest{
		BinaryPath: "/usr/local/bin/breeze-agent",
		Args:       tooManyArgs,
	}); err == nil {
		t.Fatal("expected too many args to be rejected")
	}
}

func TestPermanentRejectCodePassthrough(t *testing.T) {
	// The broker's structured Code must survive into PermanentRejectError so
	// main can distinguish "not_desired" (exit 0) from real fatals (exit 2).
	e := &PermanentRejectError{Code: "not_desired", Reason: "helper Windows session and role are not currently eligible"}
	if e.Code != "not_desired" {
		t.Fatal("code lost")
	}
	var target *PermanentRejectError
	if !errors.As(error(e), &target) {
		t.Fatal("errors.As must match PermanentRejectError")
	}
}
