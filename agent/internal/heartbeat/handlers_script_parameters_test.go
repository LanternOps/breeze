package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// serveOneHelperCommand stands in for a connected user helper: it reads
// exactly one forwarded IPC command, hands the decoded payload back on the
// returned channel, and answers with a canned success result so the caller
// does not block on the IPC wait.
func serveOneHelperCommand(t *testing.T, clientIPC *ipc.Conn) <-chan map[string]any {
	t.Helper()
	payloads := make(chan map[string]any, 1)
	go func() {
		defer close(payloads)
		_ = clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			t.Errorf("helper recv: %v", err)
			return
		}

		var ipcCmd ipc.IPCCommand
		if err := json.Unmarshal(env.Payload, &ipcCmd); err != nil {
			t.Errorf("unmarshal forwarded command: %v", err)
			return
		}
		var payload map[string]any
		if err := json.Unmarshal(ipcCmd.Payload, &payload); err != nil {
			t.Errorf("unmarshal forwarded payload: %v", err)
			return
		}
		payloads <- payload

		resultPayload, _ := json.Marshal(map[string]any{"exitCode": 0, "stdout": "ok", "stderr": ""})
		respBody, _ := json.Marshal(ipc.IPCCommandResult{
			CommandID: env.ID,
			Status:    "completed",
			Result:    resultPayload,
		})
		if err := clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeCommandResult, Payload: respBody}); err != nil {
			t.Errorf("helper send: %v", err)
		}
	}()
	return payloads
}

// TestHandleScriptForwardsParametersToUserHelper is the daemon half of #4882:
// the fix lives in the helper, but it is only reachable if the re-marshalled
// payload sendCommandToUserHelper puts on the wire still carries
// `parameters`. Asserting it here means a future payload-shaping change on
// the daemon side (a whitelist, a DTO, a rename) reddens a test instead of
// silently re-breaking every runAs=user script.
func TestHandleScriptForwardsParametersToUserHelper(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	t.Cleanup(func() { _ = clientConn.Close() })

	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "testuser", "quartz", "helper-params", []string{"run_as_user"})
	// Pin the console-session binding (#1009) so resolveRunAsSession selects
	// this helper on Windows too, not only on hosts where that binding is a
	// no-op — otherwise the test is silently platform-dependent.
	session.WinSessionID = "1"
	t.Cleanup(func() { _ = session.Close() })
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	payloads := serveOneHelperCommand(t, clientIPC)

	broker := newTestBrokerWithSessions(t, session)
	broker.SetConsoleSessionIDFunc(func() string { return "1" })
	h := newTestHeartbeat(broker)
	result := handleScript(h, Command{
		ID:   "cmd-params",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        `echo "{{GoogleEmail}}"`,
			"language":       "bash",
			"runAs":          "user",
			"scriptId":       "script-4882",
			"timeoutSeconds": 10,
			"parameters":     map[string]any{"GoogleEmail": "gcpw.user@example.com"},
		},
	})
	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (%s)", result.Status, result.Error)
	}

	payload, ok := <-payloads
	if !ok {
		t.Fatal("user helper never received the forwarded command")
	}

	params, ok := payload["parameters"].(map[string]any)
	if !ok {
		t.Fatalf("forwarded payload dropped `parameters`; got keys %v", payloadKeys(payload))
	}
	if params["GoogleEmail"] != "gcpw.user@example.com" {
		t.Errorf("parameters[GoogleEmail] = %#v, want the delivered value", params["GoogleEmail"])
	}
	if payload["scriptId"] != "script-4882" {
		t.Errorf("forwarded payload scriptId = %#v, want script-4882", payload["scriptId"])
	}
	// The daemon must not have substituted the placeholder before forwarding —
	// substitution is the helper executor's job, on the content it received.
	if payload["content"] != `echo "{{GoogleEmail}}"` {
		t.Errorf("forwarded content = %#v, want the unsubstituted script", payload["content"])
	}
}

// TestHandleScriptRefusesSecretEnvForRunAsUser keeps the #3409 refusal in
// place: #4882 forwards `parameters` to the helper, and nothing more. A
// secret-bearing runAs=user run must still be refused before any forwarding
// happens, so a credential never reaches the IPC hop at all.
func TestHandleScriptRefusesSecretEnvForRunAsUser(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	t.Cleanup(func() { _ = clientConn.Close() })

	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "testuser", "quartz", "helper-secret", []string{"run_as_user"})
	session.WinSessionID = "1"
	t.Cleanup(func() { _ = session.Close() })
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	forwarded := make(chan struct{}, 1)
	go func() {
		_ = clientIPC.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, err := clientIPC.Recv(); err == nil {
			forwarded <- struct{}{}
		}
	}()

	broker := newTestBrokerWithSessions(t, session)
	broker.SetConsoleSessionIDFunc(func() string { return "1" })
	h := newTestHeartbeat(broker)
	result := handleScript(h, Command{
		ID:   "cmd-secret-user",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        `echo "$BREEZE_VAR_API_TOKEN"`,
			"language":       "bash",
			"runAs":          "user",
			"timeoutSeconds": 10,
			"parameters":     map[string]any{"GoogleEmail": "gcpw.user@example.com"},
			executor.SecretEnvPayloadKey: map[string]any{
				"api_token": "hunter2-not-a-real-credential",
			},
		},
	})

	if result.Status != "failed" {
		t.Fatalf("secret-bearing runAs=user run must be refused, got %s", result.Status)
	}
	select {
	case <-forwarded:
		t.Fatal("a secret-bearing command was forwarded to the user helper")
	case <-time.After(300 * time.Millisecond):
	}
}

func payloadKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}
