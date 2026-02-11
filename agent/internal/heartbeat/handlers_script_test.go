package heartbeat

import (
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// newTestHeartbeat creates a minimal Heartbeat for testing script handlers.
func newTestHeartbeat(broker *sessionbroker.Broker) *Heartbeat {
	return &Heartbeat{
		executor:      executor.New(nil),
		sessionBroker: broker,
	}
}

func createTestSocketPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	clientCh := make(chan net.Conn, 1)
	go func() {
		conn, err := net.Dial("tcp", listener.Addr().String())
		if err != nil {
			return
		}
		clientCh <- conn
	}()

	serverConn, err := listener.Accept()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	return serverConn, <-clientCh
}

// --- resolveRunAsSession tests ---

func TestResolveRunAsSessionEmpty(t *testing.T) {
	broker := sessionbroker.New("/tmp/test-broker.sock", nil)
	session := resolveRunAsSession(broker, "")
	if session != nil {
		t.Fatal("expected nil for empty runAs")
	}
}

func TestResolveRunAsSessionSystem(t *testing.T) {
	broker := sessionbroker.New("/tmp/test-broker.sock", nil)
	for _, v := range []string{"system", "System", "SYSTEM"} {
		session := resolveRunAsSession(broker, v)
		if session != nil {
			t.Fatalf("expected nil for runAs=%q", v)
		}
	}
}

func TestResolveRunAsSessionElevated(t *testing.T) {
	broker := sessionbroker.New("/tmp/test-broker.sock", nil)
	session := resolveRunAsSession(broker, "elevated")
	if session != nil {
		t.Fatal("expected nil for elevated")
	}
}

func TestResolveRunAsSessionUserNoSessions(t *testing.T) {
	broker := sessionbroker.New("/tmp/test-broker.sock", nil)
	session := resolveRunAsSession(broker, "user")
	if session != nil {
		t.Fatal("expected nil when no user sessions connected")
	}
}

func TestResolveRunAsSessionSpecificUserNotFound(t *testing.T) {
	broker := sessionbroker.New("/tmp/test-broker.sock", nil)
	session := resolveRunAsSession(broker, "nonexistent")
	if session != nil {
		t.Fatal("expected nil for nonexistent user")
	}
}

// --- handleScript tests ---

func TestHandleScriptEmptyContent(t *testing.T) {
	h := newTestHeartbeat(nil)
	result := handleScript(h, Command{
		ID:   "cmd-empty",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":  "",
			"language": "bash",
		},
	})

	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %s", result.Status)
	}
	if result.Error == "" {
		t.Fatal("expected error message for empty content")
	}
}

func TestHandleScriptBashExecution(t *testing.T) {
	h := newTestHeartbeat(nil)
	result := handleScript(h, Command{
		ID:   "cmd-bash",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo 'hello from breeze'",
			"language":       "bash",
			"timeoutSeconds": 10,
		},
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (error: %s, stderr: %s)", result.Status, result.Error, result.Stderr)
	}
	if result.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", result.ExitCode)
	}
	if result.Stdout == "" {
		t.Fatal("expected non-empty stdout")
	}
}

func TestHandleScriptNonZeroExitCode(t *testing.T) {
	h := newTestHeartbeat(nil)
	result := handleScript(h, Command{
		ID:   "cmd-fail",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "exit 1",
			"language":       "bash",
			"timeoutSeconds": 10,
		},
	})

	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %s", result.Status)
	}
	if result.ExitCode != 1 {
		t.Fatalf("expected exit code 1, got %d", result.ExitCode)
	}
}

func TestHandleScriptDefaultLanguage(t *testing.T) {
	h := newTestHeartbeat(nil)
	// No language specified, should default to bash
	result := handleScript(h, Command{
		ID:   "cmd-default-lang",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo 'default lang'",
			"timeoutSeconds": 10,
		},
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (error: %s)", result.Status, result.Error)
	}
}

func TestHandleScriptRunAsSystemFallsThrough(t *testing.T) {
	h := newTestHeartbeat(nil)
	result := handleScript(h, Command{
		ID:   "cmd-system",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo 'system context'",
			"language":       "bash",
			"runAs":          "system",
			"timeoutSeconds": 10,
		},
	})

	// runAs=system should execute directly
	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (error: %s)", result.Status, result.Error)
	}
}

func TestHandleScriptRunAsUserNoHelper(t *testing.T) {
	// When no user helper is connected, runAs=user falls through to the local
	// executor which correctly rejects it — there's no user session to target.
	broker := sessionbroker.New("/tmp/test-broker-no-helper.sock", nil)
	h := newTestHeartbeat(broker)

	result := handleScript(h, Command{
		ID:   "cmd-user-noop",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo 'fallback'",
			"language":       "bash",
			"runAs":          "user",
			"timeoutSeconds": 10,
		},
	})

	// The executor rejects runAs=user without a connected user helper
	if result.Status != "failed" {
		t.Fatalf("expected failed (no helper for runAs=user), got %s", result.Status)
	}
	if result.Error == "" {
		t.Fatal("expected error message")
	}
}

func TestHandleScriptWithParameters(t *testing.T) {
	h := newTestHeartbeat(nil)
	result := handleScript(h, Command{
		ID:   "cmd-params",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo $BREEZE_PARAM_GREETING",
			"language":       "bash",
			"timeoutSeconds": 10,
			"parameters":     map[string]any{"greeting": "hello-world"},
		},
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (error: %s)", result.Status, result.Error)
	}
	if result.Stdout == "" {
		t.Fatal("expected parameter value in stdout")
	}
}

func TestHandleScriptTimeout(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping timeout test in short mode")
	}

	h := newTestHeartbeat(nil)
	result := handleScript(h, Command{
		ID:   "cmd-timeout",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "sleep 300",
			"language":       "bash",
			"timeoutSeconds": 1,
		},
	})

	if result.Status != "timeout" {
		t.Fatalf("expected timeout status, got %s", result.Status)
	}
}

func TestHandleScriptCancel(t *testing.T) {
	h := newTestHeartbeat(nil)

	// Cancel with missing executionId
	result := handleScriptCancel(h, Command{
		ID:      "cmd-cancel-missing",
		Type:    tools.CmdScriptCancel,
		Payload: map[string]any{},
	})
	if result.Status != "failed" {
		t.Fatalf("expected failed for missing executionId, got %s", result.Status)
	}

	// Cancel nonexistent execution
	result = handleScriptCancel(h, Command{
		ID:   "cmd-cancel-nonexist",
		Type: tools.CmdScriptCancel,
		Payload: map[string]any{
			"executionId": "nonexistent",
		},
	})
	if result.Status != "failed" {
		t.Fatalf("expected failed for nonexistent execution, got %s", result.Status)
	}
}

func TestHandleScriptListRunning(t *testing.T) {
	h := newTestHeartbeat(nil)
	result := handleScriptListRunning(h, Command{
		ID:   "cmd-list-running",
		Type: tools.CmdScriptListRunning,
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s", result.Status)
	}
}

// --- executeViaUserHelper integration test ---

func TestExecuteViaUserHelperMissingScope(t *testing.T) {
	// Create session without run_as_user scope
	serverConn, clientConn := createTestSocketPair(t)
	defer serverConn.Close()
	defer clientConn.Close()

	serverIPC := ipc.NewConn(serverConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "testuser", "quartz", "test-1", []string{"notify"})
	defer session.Close()

	h := newTestHeartbeat(nil)
	result := h.executeViaUserHelper(session, Command{
		ID:      "cmd-noscope",
		Type:    tools.CmdScript,
		Payload: map[string]any{"content": "echo hi", "language": "bash"},
	}, 10)

	if result.Status != "failed" {
		t.Fatalf("expected failed, got %s", result.Status)
	}
	if result.Error == "" || result.Error != "user helper does not have run_as_user scope" {
		t.Fatalf("unexpected error: %q", result.Error)
	}
}

func TestExecuteViaUserHelperSuccess(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)

	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "testuser", "quartz", "test-2", []string{"run_as_user"})

	// Simulate user helper receiving and responding to the command
	go func() {
		clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			t.Errorf("client recv: %v", err)
			return
		}

		// Build a mock result
		resultPayload, _ := json.Marshal(map[string]any{
			"exitCode": 0,
			"stdout":   "hello from user helper",
			"stderr":   "",
		})
		ipcResult := ipc.IPCCommandResult{
			CommandID: env.ID,
			Status:    "completed",
			Result:    resultPayload,
		}
		payload, _ := json.Marshal(ipcResult)
		resp := &ipc.Envelope{
			ID:      env.ID,
			Type:    ipc.TypeCommandResult,
			Payload: payload,
		}
		if err := clientIPC.Send(resp); err != nil {
			t.Errorf("client send: %v", err)
		}
	}()

	// Start recv loop to route responses
	go session.RecvLoop(func(s *sessionbroker.Session, env *ipc.Envelope) {})

	h := newTestHeartbeat(nil)
	result := h.executeViaUserHelper(session, Command{
		ID:   "cmd-user-exec",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo hello",
			"language":       "bash",
			"timeoutSeconds": 10,
		},
	}, 10)

	session.Close()
	clientIPC.Close()

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (error: %s)", result.Status, result.Error)
	}
	if result.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", result.ExitCode)
	}
	if result.Stdout != "hello from user helper" {
		t.Fatalf("expected stdout from helper, got %q", result.Stdout)
	}
}

func TestExecuteViaUserHelperFailedScript(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)

	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "testuser", "quartz", "test-3", []string{"run_as_user"})

	// Simulate user helper returning a failed result
	go func() {
		clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			return
		}

		resultPayload, _ := json.Marshal(map[string]any{
			"exitCode": 127,
			"stdout":   "",
			"stderr":   "command not found",
		})
		ipcResult := ipc.IPCCommandResult{
			CommandID: env.ID,
			Status:    "failed",
			Result:    resultPayload,
		}
		payload, _ := json.Marshal(ipcResult)
		clientIPC.Send(&ipc.Envelope{
			ID:      env.ID,
			Type:    ipc.TypeCommandResult,
			Payload: payload,
		})
	}()

	go session.RecvLoop(func(s *sessionbroker.Session, env *ipc.Envelope) {})

	h := newTestHeartbeat(nil)
	result := h.executeViaUserHelper(session, Command{
		ID:   "cmd-user-fail",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":  "nonexistent_command",
			"language": "bash",
		},
	}, 10)

	session.Close()
	clientIPC.Close()

	if result.Status != "failed" {
		t.Fatalf("expected failed, got %s", result.Status)
	}
	if result.ExitCode != 127 {
		t.Fatalf("expected exit code 127, got %d", result.ExitCode)
	}
	if result.Stderr != "command not found" {
		t.Fatalf("expected stderr, got %q", result.Stderr)
	}
}

func TestExecuteViaUserHelperTimeout(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)

	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "testuser", "quartz", "test-4", []string{"run_as_user"})

	// Client receives but never responds
	go func() {
		clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		clientIPC.Recv() // read but don't respond
	}()

	go session.RecvLoop(func(s *sessionbroker.Session, env *ipc.Envelope) {})

	h := newTestHeartbeat(nil)
	result := h.executeViaUserHelper(session, Command{
		ID:   "cmd-user-timeout",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "sleep 30",
			"language":       "bash",
			"timeoutSeconds": 1,
		},
	}, 1) // 1 second timeout

	session.Close()
	clientIPC.Close()

	if result.Status != "failed" {
		t.Fatalf("expected failed, got %s", result.Status)
	}
}

// --- DurationMs tracking ---

func TestHandleScriptDurationMs(t *testing.T) {
	h := newTestHeartbeat(nil)
	result := handleScript(h, Command{
		ID:   "cmd-duration",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo ok",
			"language":       "bash",
			"timeoutSeconds": 10,
		},
	})

	if result.DurationMs <= 0 {
		t.Fatalf("expected positive DurationMs, got %d", result.DurationMs)
	}
}
