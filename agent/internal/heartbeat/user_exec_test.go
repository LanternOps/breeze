package heartbeat

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

type fakeSender struct {
	gotID      string
	gotType    string
	gotPayload any
	gotTimeout time.Duration
	resp       *ipc.Envelope
	err        error
}

func (f *fakeSender) SendCommand(id, cmdType string, payload any, timeout time.Duration) (*ipc.Envelope, error) {
	f.gotID, f.gotType, f.gotPayload, f.gotTimeout = id, cmdType, payload, timeout
	return f.resp, f.err
}

func execEnvelope(t *testing.T, status string, errMsg string, result map[string]any) *ipc.Envelope {
	t.Helper()
	var raw json.RawMessage
	if result != nil {
		b, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		raw = b
	}
	payload, err := json.Marshal(ipc.IPCCommandResult{
		CommandID: "cmd", Status: status, Error: errMsg, Result: raw,
	})
	if err != nil {
		t.Fatal(err)
	}
	return &ipc.Envelope{Payload: payload}
}

// TestSendUserExecShape pins the IPC contract the helper decodes today:
// type "exec" (run_as_user scope) carrying command/args and an explicit
// timeoutSeconds so the helper enforces the deadline too.
func TestSendUserExecShape(t *testing.T) {
	s := &fakeSender{resp: execEnvelope(t, "completed", "", map[string]any{
		"stdout": "table", "stderr": "", "exitCode": 0,
	})}

	stdout, stderr, code, err := sendUserExec(s, "winget", []string{"upgrade", "--scope", "user"}, 120*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if stdout != "table" || stderr != "" || code != 0 {
		t.Fatalf("got stdout=%q stderr=%q code=%d", stdout, stderr, code)
	}
	if s.gotType != ipc.TypeCommand {
		t.Fatalf("envelope type = %q, want %q", s.gotType, ipc.TypeCommand)
	}
	cmd, ok := s.gotPayload.(ipc.IPCCommand)
	if !ok {
		t.Fatalf("payload = %T, want ipc.IPCCommand", s.gotPayload)
	}
	if cmd.Type != "exec" {
		t.Fatalf("command type = %q, want exec", cmd.Type)
	}
	var inner map[string]any
	if err := json.Unmarshal(cmd.Payload, &inner); err != nil {
		t.Fatal(err)
	}
	if inner["command"] != "winget" {
		t.Fatalf("command = %#v", inner["command"])
	}
	if inner["timeoutSeconds"] != float64(120) {
		t.Fatalf("timeoutSeconds = %#v, want 120", inner["timeoutSeconds"])
	}
	// The IPC wait must outlast the helper's own kill timer, so a hung winget
	// surfaces as the helper's error rather than a bare IPC timeout.
	if s.gotTimeout <= 120*time.Second {
		t.Fatalf("IPC timeout = %v, want more than the command budget", s.gotTimeout)
	}
}

func TestSendUserExecFailureModes(t *testing.T) {
	tests := []struct {
		name    string
		sender  *fakeSender
		wantErr string
	}{
		{
			name:    "transport error",
			sender:  &fakeSender{err: errors.New("session closed")},
			wantErr: "user helper exec",
		},
		{
			name:    "nil response",
			sender:  &fakeSender{},
			wantErr: "session closed during exec",
		},
		{
			name:    "undecodable envelope",
			sender:  &fakeSender{resp: &ipc.Envelope{Payload: json.RawMessage("not json")}},
			wantErr: "unmarshal exec result",
		},
		{
			name:    "helper reported failure",
			sender:  &fakeSender{resp: execEnvelope(t, "failed", "start: file not found", nil)},
			wantErr: "user helper exec failed",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, _, err := sendUserExec(tt.sender, "winget", nil, time.Second)
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("err = %v, want it to mention %q", err, tt.wantErr)
			}
		})
	}
}

// TestSendUserExecNonZeroExitIsData asserts a non-zero winget exit is returned
// as an exit code rather than an error: winget exits non-zero for several
// benign outcomes and the caller's parser decides what the run meant.
func TestSendUserExecNonZeroExitIsData(t *testing.T) {
	s := &fakeSender{resp: execEnvelope(t, "failed", "", map[string]any{
		"stdout": "some table", "stderr": "warn", "exitCode": 1,
	})}
	stdout, stderr, code, err := sendUserExec(s, "winget", nil, time.Second)
	if err != nil {
		t.Fatalf("non-zero exit must not be an error: %v", err)
	}
	if stdout != "some table" || stderr != "warn" || code != 1 {
		t.Fatalf("got stdout=%q stderr=%q code=%d", stdout, stderr, code)
	}
}

func TestNewUserExecFuncWithoutSession(t *testing.T) {
	fn := newUserExecFunc(stubBroker{})
	_, _, _, err := fn("winget", nil, time.Second)
	if err == nil || !strings.Contains(err.Error(), "no user helper session connected") {
		t.Fatalf("err = %v, want a no-session error", err)
	}
}

// stubBroker stands in for the session broker with nobody logged in — the
// normal state of an unattended workstation.
type stubBroker struct{}

func (stubBroker) PreferredRunAsUserSession() *sessionbroker.Session { return nil }

func TestMakeUserExecFuncNilWithoutBroker(t *testing.T) {
	h := &Heartbeat{}
	if fn := h.makeUserExecFunc(); fn != nil {
		t.Fatal("no broker must yield a nil executor, not a failing one")
	}
}

func TestDecodeUserExecResult(t *testing.T) {
	tests := []struct {
		name       string
		raw        string
		wantStdout string
		wantCode   int
	}{
		{name: "empty", raw: ""},
		{name: "not json", raw: "garbage"},
		{name: "missing fields", raw: `{}`},
		{name: "full", raw: `{"stdout":"out","stderr":"err","exitCode":3}`, wantStdout: "out", wantCode: 3},
		{name: "wrong types are ignored", raw: `{"stdout":5,"exitCode":"x"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stdout, _, code := decodeUserExecResult(json.RawMessage(tt.raw))
			if stdout != tt.wantStdout || code != tt.wantCode {
				t.Fatalf("got stdout=%q code=%d, want %q/%d", stdout, code, tt.wantStdout, tt.wantCode)
			}
		})
	}
}

// TestAvailablePatchesToMapsCarriesScope asserts the per-package scope label
// reaches the upload payload, and is omitted for providers with no scope
// concept rather than defaulted to a value they never reported.
func TestAvailablePatchesToMapsCarriesScope(t *testing.T) {
	h := &Heartbeat{}
	items := h.availablePatchesToMaps([]patching.AvailablePatch{
		{ID: "Google.Chrome", Provider: "winget", Scope: patching.PatchScopeUser},
		{ID: "Mozilla.Firefox", Provider: "winget", Scope: patching.PatchScopeMachine},
		{ID: "KB5000001", Provider: "windows-update"},
	})
	if items[0]["scope"] != patching.PatchScopeUser {
		t.Fatalf("scope = %#v, want user", items[0]["scope"])
	}
	if items[1]["scope"] != patching.PatchScopeMachine {
		t.Fatalf("scope = %#v, want machine", items[1]["scope"])
	}
	if _, ok := items[2]["scope"]; ok {
		t.Fatalf("scopeless provider must omit scope, got %#v", items[2]["scope"])
	}
}

// TestWingetUserScopeStatus covers the reporting path that lets the UI say
// "per-user apps not scanned" instead of silently under-reporting.
func TestWingetUserScopeStatus(t *testing.T) {
	t.Run("no patch manager", func(t *testing.T) {
		h := &Heartbeat{}
		if _, present := h.wingetUserScopeStatus(); present {
			t.Fatal("want absent")
		}
	})

	t.Run("no winget provider", func(t *testing.T) {
		h := &Heartbeat{patchMgr: patching.NewPatchManager()}
		if _, present := h.wingetUserScopeStatus(); present {
			t.Fatal("want absent")
		}
	})

	t.Run("winget provider reports its last user pass", func(t *testing.T) {
		p := patching.NewSystemWingetProviderWithUserScan(`C:\wg\winget.exe`,
			func(string, []string, time.Duration) (string, string, int, error) {
				return "Name    Id               Version  Available Source\n" +
					strings.Repeat("-", 50) + "\n" +
					"Firefox Mozilla.Firefox   1.0      2.0       winget\n", "", 0, nil
			},
			func(string, []string, time.Duration) (string, string, int, error) {
				return "", "", -1, errors.New("no user helper session connected")
			})
		h := &Heartbeat{patchMgr: patching.NewPatchManager(p)}
		if _, err := p.Scan(); err != nil {
			t.Fatal(err)
		}
		status, present := h.wingetUserScopeStatus()
		if !present {
			t.Fatal("want present")
		}
		if status.Scanned {
			t.Fatal("user pass failed; must not report scanned")
		}
		if !strings.Contains(status.Reason, "no user helper session") {
			t.Fatalf("Reason = %q", status.Reason)
		}
	})
}

// TestPendingPayloadCarriesUserScopeCoverage asserts the second coverage axis
// reaches the API. Without it the server cannot tell a device with no per-user
// updates from one where nobody was logged in, and would sweep user-scope
// pending rows a scan never looked at (#2727, the #2217 failure mode one axis
// down).
func TestPendingPayloadCarriesUserScopeCoverage(t *testing.T) {
	tests := []struct {
		name       string
		userExec   patching.UserExecFunc
		wantScoped any
	}{
		{
			name: "user pass ran",
			userExec: func(string, []string, time.Duration) (string, string, int, error) {
				return "No installed package found matching input criteria.\n", "", 0, nil
			},
			wantScoped: true,
		},
		{
			name: "nobody logged in",
			userExec: func(string, []string, time.Duration) (string, string, int, error) {
				return "", "", -1, errors.New("no user helper session connected")
			},
			wantScoped: false,
		},
		{
			name:       "no winget provider at all",
			userExec:   nil,
			wantScoped: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var body []byte
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, err := io.ReadAll(r.Body)
				if err != nil {
					t.Fatal(err)
				}
				body = b
				w.WriteHeader(http.StatusOK)
			}))
			defer ts.Close()

			h := New(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"})
			h.retryCfg = httputil.RetryConfig{MaxRetries: 0}
			if tt.name != "no winget provider at all" {
				p := patching.NewSystemWingetProviderWithUserScan(`C:\wg\winget.exe`,
					func(string, []string, time.Duration) (string, string, int, error) {
						return "No installed package found matching input criteria.\n", "", 0, nil
					}, tt.userExec)
				if _, err := p.Scan(); err != nil {
					t.Fatal(err)
				}
				h.patchMgr = patching.NewPatchManager(p)
			} else {
				h.patchMgr = patching.NewPatchManager()
			}

			pendingErr, _ := h.sendPatchInventoryData(
				[]map[string]any{{"name": "Chrome", "source": "third_party"}},
				nil, "", true, []string{"third_party"},
			)
			if pendingErr != nil {
				t.Fatal(pendingErr)
			}

			var payload map[string]any
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Fatal(err)
			}
			got, present := payload["userScopeScanned"]
			if tt.wantScoped == nil {
				if present {
					t.Fatalf("userScopeScanned = %#v, want omitted", got)
				}
				return
			}
			if !present || got != tt.wantScoped {
				t.Fatalf("userScopeScanned = %#v (present=%v), want %#v", got, present, tt.wantScoped)
			}
		})
	}
}
