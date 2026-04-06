package userhelper

import (
	"encoding/json"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

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

	<-done
	waitForCondition(t, 2*time.Second, func() bool {
		return c.executor.GetRunningCount() == 0
	})
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
