package heartbeat

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// #3409 PR4b — handleScript's secret-variable invariants.
//
// These tests drive the REAL executor (h.executor is a concrete
// *executor.Executor, not an interface), which is why "the script never ran" is
// asserted against a marker file the script would have created rather than
// against a call counter on a stub. That is the stronger claim anyway: it also
// proves the BREEZE_VAR_* environment really reaches the spawned process.

// testSecretValue is the delivered credential used throughout. It is
// deliberately free of any `token=` / `password:` shape so SanitizeOutput's
// pattern layer cannot take credit for a redaction that the exact-value
// redactor is the one under test for. Length 16, asserted on below.
const testSecretValue = "hunter2-nrfPQxKz"

// testSecretValueLen lets the allowed-context test assert the script saw the
// WHOLE value without ever printing it.
const testSecretValueLen = len(testSecretValue)

// awsKeyInError is an AKIA-shaped string (AKIA + 16 uppercase alphanumerics),
// the SanitizeOutput pattern used to prove result.Error now goes through the
// pattern layer as well.
const awsKeyInError = "AKIAABCDEFGHIJKLMNOP"

// markerScript returns a bash script that creates a file, and that file's path.
// Asserting the file is absent after handleScript returns proves the command
// never reached the executor — a stronger statement than "the result says
// failed", which a post-execution failure would also satisfy.
func markerScript(t *testing.T) (content string, markerPath string) {
	t.Helper()
	markerPath = filepath.Join(t.TempDir(), "executed.marker")
	return "touch " + markerPath, markerPath
}

func assertScriptDidNotRun(t *testing.T, markerPath string) {
	t.Helper()
	_, err := os.Stat(markerPath)
	if err == nil {
		t.Fatalf("script executed but must not have: marker %s exists", markerPath)
	}
	if !os.IsNotExist(err) {
		t.Fatalf("stat marker %s: %v", markerPath, err)
	}
}

func assertNoSecretLeak(t *testing.T, res tools.CommandResult) {
	t.Helper()
	for field, value := range map[string]string{
		"Stdout": res.Stdout,
		"Stderr": res.Stderr,
		"Error":  res.Error,
	} {
		if strings.Contains(value, testSecretValue) {
			t.Fatalf("%s leaked the secret value: %q", field, value)
		}
	}
}

// newFakeUserHelper wires a broker holding one run_as_user helper session whose
// client end records whether it was ever contacted and answers with `reply`.
// Same socket-pair pattern as TestExecuteViaUserHelperSuccess.
func newFakeUserHelper(t *testing.T, username string, reply ipc.IPCCommandResult) (*sessionbroker.Broker, *atomic.Bool) {
	t.Helper()

	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", username, "quartz", "secret-helper-1", []string{"run_as_user"})

	var contacted atomic.Bool
	go func() {
		_ = clientIPC.SetReadDeadline(time.Now().Add(3 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			return
		}
		contacted.Store(true)
		reply.CommandID = env.ID
		payload, err := json.Marshal(reply)
		if err != nil {
			return
		}
		_ = clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeCommandResult, Payload: payload})
	}()
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	t.Cleanup(func() {
		_ = session.Close()
		_ = clientIPC.Close()
	})

	return newTestBrokerWithSessions(t, session), &contacted
}

func helperOKReply(t *testing.T, stdout string) ipc.IPCCommandResult {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"exitCode": 0, "stdout": stdout, "stderr": ""})
	if err != nil {
		t.Fatalf("marshal helper reply: %v", err)
	}
	return ipc.IPCCommandResult{Status: "completed", Result: payload}
}

// --- Decode / fail-closed -------------------------------------------------

func TestHandleScriptMalformedSecretEnvFailsClosed(t *testing.T) {
	cases := []struct {
		name      string
		secretEnv any
		wantIn    []string
		wantNotIn []string
	}{
		{
			name:      "not an object",
			secretEnv: "api_token=" + testSecretValue,
			wantIn:    []string{"secretEnv", "must be an object"},
			wantNotIn: []string{testSecretValue},
		},
		{
			name:      "value below the redaction floor",
			secretEnv: map[string]any{"api_token": "abc"},
			wantIn:    []string{"api_token", "4 characters"},
			// The refusal names the key; it must never quote the value, even a
			// too-short one.
			wantNotIn: []string{"abc"},
		},
		{
			name:      "non-string value",
			secretEnv: map[string]any{"api_token": float64(42)},
			wantIn:    []string{"api_token", "not a string"},
		},
		{
			name:      "key with a space",
			secretEnv: map[string]any{"BAD KEY": testSecretValue},
			wantIn:    []string{"BAD KEY", "not a valid variable key"},
			wantNotIn: []string{testSecretValue},
		},
		{
			name:      "uppercase key",
			secretEnv: map[string]any{"API_TOKEN": testSecretValue},
			wantIn:    []string{"API_TOKEN", "not a valid variable key"},
			wantNotIn: []string{testSecretValue},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			content, marker := markerScript(t)
			h := newTestHeartbeat(nil)

			res := handleScript(h, Command{
				ID:   "cmd-secret-malformed",
				Type: tools.CmdScript,
				Payload: map[string]any{
					"content":        content,
					"language":       "bash",
					"timeoutSeconds": 10,
					"secretEnv":      tc.secretEnv,
				},
			})

			if res.Status != "failed" {
				t.Fatalf("expected failed status, got %q (error: %q)", res.Status, res.Error)
			}
			if res.ExitCode == 0 {
				t.Fatalf("expected non-zero exit code, got %d", res.ExitCode)
			}
			for _, want := range tc.wantIn {
				if !strings.Contains(res.Error, want) {
					t.Fatalf("error %q does not mention %q", res.Error, want)
				}
			}
			for _, unwanted := range tc.wantNotIn {
				if strings.Contains(res.Error, unwanted) {
					t.Fatalf("error %q must not contain %q", res.Error, unwanted)
				}
			}
			assertScriptDidNotRun(t, marker)
		})
	}
}

// TestHandleScriptWithoutSecretEnvIsUnaffected is the regression guard for
// existing traffic: the very same literal that gets redacted when it is
// DELIVERED as a secret must pass through byte-for-byte when the payload
// carries no secretEnv key at all.
func TestHandleScriptWithoutSecretEnvIsUnaffected(t *testing.T) {
	h := newTestHeartbeat(nil)

	res := handleScript(h, Command{
		ID:   "cmd-no-secretenv",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "printf 'out %s\\n' " + testSecretValue,
			"language":       "bash",
			"timeoutSeconds": 10,
		},
	})

	if res.Status != "completed" {
		t.Fatalf("expected completed, got %q (error: %q, stderr: %q)", res.Status, res.Error, res.Stderr)
	}
	if got, want := strings.TrimSpace(res.Stdout), "out "+testSecretValue; got != want {
		t.Fatalf("stdout must be untouched without secretEnv: got %q, want %q", got, want)
	}
	if strings.Contains(res.Stdout, executor.SecretRedactionMarker) {
		t.Fatalf("no redactor may run without secretEnv, got %q", res.Stdout)
	}
	if res.Error != "" {
		t.Fatalf("expected empty error, got %q", res.Error)
	}
}

// --- runAs gating ---------------------------------------------------------

func TestHandleScriptSecretEnvRefusesUserContext(t *testing.T) {
	for _, runAs := range []string{"user", "alice"} {
		t.Run("runAs="+runAs, func(t *testing.T) {
			content, marker := markerScript(t)
			broker, contacted := newFakeUserHelper(t, "alice", helperOKReply(t, "helper ran"))
			h := newTestHeartbeat(broker)

			res := handleScript(h, Command{
				ID:   "cmd-secret-runas",
				Type: tools.CmdScript,
				Payload: map[string]any{
					"content":        content,
					"language":       "bash",
					"runAs":          runAs,
					"timeoutSeconds": 10,
					"secretEnv":      map[string]any{"api_token": testSecretValue},
				},
			})

			if res.Status != "failed" {
				t.Fatalf("expected failed, got %q (error: %q)", res.Status, res.Error)
			}
			if !strings.Contains(res.Error, "secret variables") ||
				!strings.Contains(res.Error, "system-context execution") {
				t.Fatalf("error must explain the secret/system-context refusal, got %q", res.Error)
			}
			if !strings.Contains(res.Error, "was not executed") {
				t.Fatalf("error must state the script did not run, got %q", res.Error)
			}
			if contacted.Load() {
				t.Fatal("user helper was contacted; a helper run would drop the credential")
			}
			assertScriptDidNotRun(t, marker)
			assertNoSecretLeak(t, res)
		})
	}
}

func TestHandleScriptSecretEnvRefusesSessionTargeting(t *testing.T) {
	// runAs=user + targetSessionId is the RDS delivery path; runAs=system +
	// targetSessionId would otherwise fall through to a LOCAL run, so it proves
	// the guard keys on targetSessionId independently of runAs.
	for _, runAs := range []string{"user", "system"} {
		t.Run("runAs="+runAs, func(t *testing.T) {
			content, marker := markerScript(t)
			broker := sessionbroker.New("/tmp/test-broker-secret-target.sock", nil)
			f := &fakeLifecycle{mode: "on-demand"}
			h := newTestHeartbeat(broker)
			h.helperLifecycle = f

			res := handleScript(h, Command{
				ID:   "cmd-secret-target",
				Type: tools.CmdScript,
				Payload: map[string]any{
					"content":         content,
					"language":        "bash",
					"runAs":           runAs,
					"timeoutSeconds":  10,
					"targetSessionId": float64(7),
					"secretEnv":       map[string]any{"api_token": testSecretValue},
				},
			})

			if res.Status != "failed" {
				t.Fatalf("expected failed, got %q (error: %q)", res.Status, res.Error)
			}
			if !strings.Contains(res.Error, "secret variables") ||
				!strings.Contains(res.Error, "system-context execution") {
				t.Fatalf("error must explain the secret/system-context refusal, got %q", res.Error)
			}
			if len(f.acquired) != 0 || len(f.released) != 0 {
				t.Fatalf("session targeting must be refused before any lease, got acquired=%v released=%v", f.acquired, f.released)
			}
			assertScriptDidNotRun(t, marker)
		})
	}
}

// TestHandleScriptSecretEnvRunsInSystemContexts is the positive half of the
// gate: the contexts that DO reach the local executor still run, and the
// executor really receives the secrets as BREEZE_VAR_* environment. The script
// prints the value's LENGTH, never the value, so a passing assertion cannot be
// explained away by the redactor.
func TestHandleScriptSecretEnvRunsInSystemContexts(t *testing.T) {
	for _, runAs := range []string{"", "system"} {
		t.Run("runAs="+runAs, func(t *testing.T) {
			h := newTestHeartbeat(nil)

			res := handleScript(h, Command{
				ID:   "cmd-secret-local",
				Type: tools.CmdScript,
				Payload: map[string]any{
					"content":        `printf 'len=%s\n' "${#BREEZE_VAR_API_TOKEN}"`,
					"language":       "bash",
					"runAs":          runAs,
					"timeoutSeconds": 10,
					"secretEnv":      map[string]any{"api_token": testSecretValue},
				},
			})

			if res.Status != "completed" {
				t.Fatalf("expected completed, got %q (error: %q, stderr: %q)", res.Status, res.Error, res.Stderr)
			}
			want := fmt.Sprintf("len=%d", testSecretValueLen)
			if got := strings.TrimSpace(res.Stdout); got != want {
				t.Fatalf("script did not see the full secret in BREEZE_VAR_API_TOKEN: got %q, want %q", got, want)
			}
			assertNoSecretLeak(t, res)
		})
	}
}

func TestHandleScriptSecretEnvAllowsElevated(t *testing.T) {
	// runAs=elevated stays a local execution (a sudo re-exec on unix), so the
	// gate must let it through. Whether the sudo itself succeeds depends on the
	// host, so assert only that the refusal did not fire.
	h := newTestHeartbeat(nil)

	res := handleScript(h, Command{
		ID:   "cmd-secret-elevated",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo ok",
			"language":       "bash",
			"runAs":          "elevated",
			"timeoutSeconds": 10,
			"secretEnv":      map[string]any{"api_token": testSecretValue},
		},
	})

	if strings.Contains(res.Error, "secret variables") {
		t.Fatalf("runAs=elevated must not be refused by the secret gate, got %q", res.Error)
	}
	assertNoSecretLeak(t, res)
}

// TestHandleScriptEmptySecretEnvDoesNotGate — an empty object is "no secrets",
// so the helper path stays available. Guards against gating on the presence of
// the key rather than on delivered values.
func TestHandleScriptEmptySecretEnvDoesNotGate(t *testing.T) {
	broker, contacted := newFakeUserHelper(t, "alice", helperOKReply(t, "helper ran"))
	h := newTestHeartbeat(broker)

	res := handleScript(h, Command{
		ID:   "cmd-empty-secretenv",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo hi",
			"language":       "bash",
			"runAs":          "user",
			"timeoutSeconds": 10,
			"secretEnv":      map[string]any{},
		},
	})

	if !contacted.Load() {
		t.Fatalf("user helper must still be used when no secrets are delivered (result: %+v)", res)
	}
	if res.Status != "completed" {
		t.Fatalf("expected completed from helper, got %q (error: %q)", res.Status, res.Error)
	}
}

// TestHandleScriptWithoutSecretEnvStillUsesHelper is the runAs half of the
// regression guard: existing runAs=user traffic keeps reaching the helper.
func TestHandleScriptWithoutSecretEnvStillUsesHelper(t *testing.T) {
	broker, contacted := newFakeUserHelper(t, "alice", helperOKReply(t, "helper ran"))
	h := newTestHeartbeat(broker)

	res := handleScript(h, Command{
		ID:   "cmd-helper-no-secretenv",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo hi",
			"language":       "bash",
			"runAs":          "user",
			"timeoutSeconds": 10,
		},
	})

	if !contacted.Load() {
		t.Fatalf("user helper must still be used for runAs=user without secrets (result: %+v)", res)
	}
	if res.Status != "completed" || res.Stdout != "helper ran" {
		t.Fatalf("unexpected helper result: %+v", res)
	}
}

// --- Redaction on every exit path -----------------------------------------

func TestHandleScriptRedactsSecretFromStdoutAndStderr(t *testing.T) {
	h := newTestHeartbeat(nil)

	res := handleScript(h, Command{
		ID:   "cmd-secret-output",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        `printf 'out %s\n' "$BREEZE_VAR_API_TOKEN"; printf 'err %s\n' "$BREEZE_VAR_API_TOKEN" >&2`,
			"language":       "bash",
			"timeoutSeconds": 10,
			"secretEnv":      map[string]any{"api_token": testSecretValue},
		},
	})

	if res.Status != "completed" {
		t.Fatalf("expected completed, got %q (error: %q, stderr: %q)", res.Status, res.Error, res.Stderr)
	}
	if got, want := strings.TrimSpace(res.Stdout), "out "+executor.SecretRedactionMarker; got != want {
		t.Fatalf("stdout: got %q, want %q", got, want)
	}
	if got, want := strings.TrimSpace(res.Stderr), "err "+executor.SecretRedactionMarker; got != want {
		t.Fatalf("stderr: got %q, want %q", got, want)
	}
	assertNoSecretLeak(t, res)
}

// TestHandleScriptRedactsSecretFromError covers the field this task exists to
// fix. `language` is the one payload field the executor echoes verbatim into
// result.Error ("unsupported script type: %s"), so setting it to the delivered
// value is the honest way to make the executor produce an error containing the
// credential without stubbing out the concrete *executor.Executor.
func TestHandleScriptRedactsSecretFromError(t *testing.T) {
	h := newTestHeartbeat(nil)

	res := handleScript(h, Command{
		ID:   "cmd-secret-error",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo hi",
			"language":       testSecretValue,
			"timeoutSeconds": 10,
			"secretEnv":      map[string]any{"api_token": testSecretValue},
		},
	})

	if res.Status != "failed" {
		t.Fatalf("expected failed, got %q", res.Status)
	}
	if got, want := res.Error, "unsupported script type: "+executor.SecretRedactionMarker; got != want {
		t.Fatalf("error: got %q, want %q", got, want)
	}
	assertNoSecretLeak(t, res)
}

// TestHandleScriptSanitizesErrorPatterns proves change (d): Error now goes
// through SanitizeOutput like Stdout/Stderr always have. No secretEnv here, so
// the exact-value redactor is a no-op and only the pattern layer can produce
// the marker.
func TestHandleScriptSanitizesErrorPatterns(t *testing.T) {
	h := newTestHeartbeat(nil)

	res := handleScript(h, Command{
		ID:   "cmd-error-sanitize",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo hi",
			"language":       awsKeyInError,
			"timeoutSeconds": 10,
		},
	})

	if got, want := res.Error, "unsupported script type: [AWS_KEY_REDACTED]"; got != want {
		t.Fatalf("error: got %q, want %q", got, want)
	}
}

// TestHandleScriptHelperErrorSanitized covers the second raw-Error copy: the
// user-helper IPC result. Secrets can never reach this path (the gate refuses
// them), but the pattern layer must still apply.
func TestHandleScriptHelperErrorSanitized(t *testing.T) {
	broker, contacted := newFakeUserHelper(t, "alice", ipc.IPCCommandResult{
		Status: "failed",
		Error:  "aws login failed for " + awsKeyInError,
	})
	h := newTestHeartbeat(broker)

	res := handleScript(h, Command{
		ID:   "cmd-helper-error-sanitize",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "aws sts get-caller-identity",
			"language":       "bash",
			"runAs":          "user",
			"timeoutSeconds": 10,
		},
	})

	if !contacted.Load() {
		t.Fatalf("expected the helper to be used (result: %+v)", res)
	}
	if got, want := res.Error, "aws login failed for [AWS_KEY_REDACTED]"; got != want {
		t.Fatalf("helper error: got %q, want %q", got, want)
	}
}
