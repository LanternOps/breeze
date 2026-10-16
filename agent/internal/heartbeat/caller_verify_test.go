package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func callerRequest() ipc.CallerVerifyRequest {
	return ipc.CallerVerifyRequest{
		VerificationID: "11111111-1111-4111-8111-111111111111", Username: "alex",
		TechnicianName: "Sam", OrgName: "Acme", ActionLabel: "reset the password",
		TargetLabel: "alex@example.com", ReverseCode: "7319",
		Choices: []string{"42", "17", "86"}, TimeoutMs: 30000,
	}
}

func callerPayload(t *testing.T, req ipc.CallerVerifyRequest) map[string]any {
	t.Helper()
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func uidPrincipal(_ *sessionbroker.Session, username string) *callerPrincipal {
	uid := uint32(501)
	return &callerPrincipal{UID: &uid, Username: username}
}

func TestRunCallerVerifyDecisions(t *testing.T) {
	helper := sessionbroker.NewSession(nil, 501, "501", "untrusted-helper-name", "", "s", nil)
	resolve := func(string) (*sessionbroker.Session, sessionbroker.DetectedSession, string) {
		return helper, sessionbroker.DetectedSession{Username: "alex", UID: 501}, ""
	}
	for _, tc := range []struct {
		name       string
		answer     string
		sendErr    error
		envErr     string
		badPayload bool
		want       string
		principal  bool
	}{
		{name: "matching number", answer: "42", want: "42", principal: true},
		{name: "decoy number", answer: "17", want: "17", principal: true},
		{name: "not me", answer: "not_me", want: "not_me", principal: true},
		{name: "helper timeout", answer: "timeout", want: "timeout"},
		{name: "ipc timeout", sendErr: sessionbroker.ErrCommandTimeout, want: "timeout"},
		{name: "helper disconnected", sendErr: errors.New("session closed while waiting for response"), want: "timeout"},
		{name: "helper error envelope", envErr: "window closed", want: "timeout"},
		{name: "unoffered answer", answer: "allow", want: "timeout"},
		{name: "unknown number", answer: "99", want: "timeout"},
		{name: "malformed payload", badPayload: true, want: "timeout"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := callerRequest()
			send := func(s *sessionbroker.Session, id, typ string, payload any, timeout time.Duration) (*ipc.Envelope, error) {
				if s != helper || id != "caller-verify-"+req.VerificationID || typ != ipc.TypeCallerVerifyRequest {
					t.Fatalf("bad correlation: %s %s", id, typ)
				}
				if timeout != time.Duration(req.TimeoutMs)*time.Millisecond+callerVerifyIPCGrace {
					t.Fatalf("deadline = %s", timeout)
				}
				if _, ok := payload.(ipc.CallerVerifyRequest); !ok {
					t.Fatalf("payload type %T", payload)
				}
				if tc.sendErr != nil {
					return nil, tc.sendErr
				}
				if tc.envErr != "" {
					return &ipc.Envelope{Error: tc.envErr}, nil
				}
				if tc.badPayload {
					return &ipc.Envelope{Payload: json.RawMessage(`{"choice":`)}, nil
				}
				raw, _ := json.Marshal(ipc.CallerVerifyResponse{Choice: tc.answer, HelperVersion: "9.9.9"})
				return &ipc.Envelope{Payload: raw}, nil
			}
			got := runCallerVerify(req, resolve, send, uidPrincipal)
			if !got.Delivered || got.Error != "" {
				t.Fatalf("expected a delivered result, got %+v", got)
			}
			if got.Choice != tc.want {
				t.Fatalf("choice = %q want %q", got.Choice, tc.want)
			}
			if tc.principal {
				// The principal is the detector's login identity, never the
				// helper's self-reported username.
				if got.Principal == nil || got.Principal.Username != "alex" || got.Principal.UID == nil || *got.Principal.UID != 501 {
					t.Fatalf("principal = %+v", got.Principal)
				}
			} else if got.Principal != nil {
				t.Fatalf("a timeout must not carry a principal: %+v", got.Principal)
			}
		})
	}
}

func TestRunCallerVerifyRefusals(t *testing.T) {
	for _, reason := range []string{"no_session_for_user", "session_not_console", "helper_outdated"} {
		t.Run(reason, func(t *testing.T) {
			sent := false
			got := runCallerVerify(callerRequest(),
				func(string) (*sessionbroker.Session, sessionbroker.DetectedSession, string) {
					return nil, sessionbroker.DetectedSession{}, reason
				},
				func(*sessionbroker.Session, string, string, any, time.Duration) (*ipc.Envelope, error) {
					sent = true
					return nil, nil
				}, uidPrincipal)
			if sent {
				t.Fatal("nothing may be sent when no helper qualifies")
			}
			if got.Delivered || got.Error != reason || got.Choice != "" {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

// #8668: a late-delivered command clamps the IPC wait to the absolute
// deadline and forwards it to the helper; one already past is never shown.
func TestRunCallerVerifyHonoursAbsoluteDeadline(t *testing.T) {
	helper := sessionbroker.NewSession(nil, 501, "501", "x", "", "s", nil)
	resolve := func(string) (*sessionbroker.Session, sessionbroker.DetectedSession, string) {
		return helper, sessionbroker.DetectedSession{Username: "alex", UID: 501}, ""
	}

	t.Run("late delivery clamps the wait and forwards the deadline", func(t *testing.T) {
		req := callerRequest()
		req.DeadlineAt = time.Now().Add(10 * time.Second).UTC().Format(time.RFC3339Nano)
		var waited time.Duration
		var forwarded ipc.CallerVerifyRequest
		got := runCallerVerify(req, resolve,
			func(_ *sessionbroker.Session, _, _ string, payload any, timeout time.Duration) (*ipc.Envelope, error) {
				waited = timeout
				forwarded = payload.(ipc.CallerVerifyRequest)
				raw, _ := json.Marshal(ipc.CallerVerifyResponse{Choice: "42"})
				return &ipc.Envelope{Payload: raw}, nil
			}, uidPrincipal)
		if got.Choice != "42" {
			t.Fatalf("got %+v", got)
		}
		// 10 s left + 5 s skew allowance + IPC grace, never the full 30 s.
		max := 10*time.Second + ipc.CallerVerifyDeadlineSkew + callerVerifyIPCGrace
		if waited > max || waited < max-2*time.Second {
			t.Fatalf("IPC wait = %s, want ~%s", waited, max)
		}
		if forwarded.DeadlineAt != req.DeadlineAt || forwarded.TimeoutMs != req.TimeoutMs {
			t.Fatalf("helper must get the original timeoutMs and deadlineAt: %+v", forwarded)
		}
	})

	t.Run("deadline already past is refused as a timeout without rendering", func(t *testing.T) {
		req := callerRequest()
		req.DeadlineAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
		sent := false
		got := runCallerVerify(req, resolve,
			func(*sessionbroker.Session, string, string, any, time.Duration) (*ipc.Envelope, error) {
				sent = true
				return nil, nil
			}, uidPrincipal)
		if sent {
			t.Fatal("an expired verification must not reach the helper")
		}
		if !got.Delivered || got.Choice != ipc.CallerVerifyChoiceTimeout || got.Principal != nil || got.Error != "" {
			t.Fatalf("got %+v", got)
		}
	})
}

func TestRunCallerVerifyUnresolvablePrincipal(t *testing.T) {
	helper := sessionbroker.NewSession(nil, 501, "501", "x", "", "s", nil)
	run := func(choice string) callerVerifyResult {
		return runCallerVerify(callerRequest(),
			func(string) (*sessionbroker.Session, sessionbroker.DetectedSession, string) {
				return helper, sessionbroker.DetectedSession{Username: "alex"}, ""
			},
			func(*sessionbroker.Session, string, string, any, time.Duration) (*ipc.Envelope, error) {
				raw, _ := json.Marshal(ipc.CallerVerifyResponse{Choice: choice})
				return &ipc.Envelope{Payload: raw}, nil
			},
			func(*sessionbroker.Session, string) *callerPrincipal { return nil })
	}
	if got := run("42"); got.Delivered || got.Choice != "" || got.Error != "no_session_for_user" {
		t.Fatalf("a number without a verified principal must not be reported: %+v", got)
	}
	// A rejection never depends on identity: it must always get through.
	if got := run("not_me"); !got.Delivered || got.Choice != "not_me" || got.Principal != nil {
		t.Fatalf("not_me must be reported without a principal: %+v", got)
	}
}

func TestRunCallerVerifyDuplicateInFlight(t *testing.T) {
	helper := sessionbroker.NewSession(nil, 501, "501", "x", "", "s", nil)
	got := runCallerVerify(callerRequest(),
		func(string) (*sessionbroker.Session, sessionbroker.DetectedSession, string) {
			return helper, sessionbroker.DetectedSession{Username: "alex"}, ""
		},
		func(*sessionbroker.Session, string, string, any, time.Duration) (*ipc.Envelope, error) {
			return nil, fmt.Errorf("wrap: %w", sessionbroker.ErrDuplicateCommand)
		}, uidPrincipal)
	if !got.duplicate {
		t.Fatalf("an in-flight duplicate must not report a timeout: %+v", got)
	}
}

func TestHandleCallerVerifyRejectsInvalidPayload(t *testing.T) {
	h := &Heartbeat{}
	for name, mutate := range map[string]func(map[string]any){
		"missing user":  func(m map[string]any) { delete(m, "username") },
		"two choices":   func(m map[string]any) { m["choices"] = []any{"42", "17"} },
		"short timeout": func(m map[string]any) { m["timeoutMs"] = 1000 },
		"bad code":      func(m map[string]any) { m["reverseCode"] = "1" },
		"bad deadline":  func(m map[string]any) { m["deadlineAt"] = "soon" },
	} {
		t.Run(name, func(t *testing.T) {
			payload := callerPayload(t, callerRequest())
			mutate(payload)
			res := handleCallerVerify(h, Command{ID: "c", Type: "caller_verify", Payload: payload})
			if res.Status != "failed" || res.Stdout != "" {
				t.Fatalf("invalid payload must fail without a choice: %+v", res)
			}
		})
	}
}

func TestHandleCallerVerifyWithoutBrokerIsUndeliverable(t *testing.T) {
	res := handleCallerVerify(&Heartbeat{}, Command{ID: "c", Type: "caller_verify", Payload: callerPayload(t, callerRequest())})
	if res.Status != "completed" {
		t.Fatalf("status = %q", res.Status)
	}
	var out callerVerifyResult
	if err := json.Unmarshal([]byte(res.Stdout), &out); err != nil {
		t.Fatal(err)
	}
	if out.Delivered || out.Error != "helper_outdated" || out.Choice != "" {
		t.Fatalf("got %+v", out)
	}
}

func TestCallerVerifyResultWire(t *testing.T) {
	zero := uint32(0)
	raw, err := json.Marshal(callerVerifyResult{Delivered: true, Choice: "42", Principal: &callerPrincipal{UID: &zero, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	// UID zero must survive (pointer), and no internal field may leak.
	if string(raw) != `{"delivered":true,"choice":"42","principal":{"uid":0,"username":"root"}}` {
		t.Fatalf("wire = %s", raw)
	}
	raw, _ = json.Marshal(callerVerifyResult{Error: "helper_outdated"})
	if string(raw) != `{"delivered":false,"error":"helper_outdated"}` {
		t.Fatalf("wire = %s", raw)
	}
}

func TestCallerVerifyIsRegistered(t *testing.T) {
	if _, ok := handlerRegistry["caller_verify"]; !ok {
		t.Fatal("caller_verify handler not registered")
	}
}

func TestCallerHelperCapabilitiesWithoutBroker(t *testing.T) {
	got := (&Heartbeat{}).callerHelperCapabilities()
	if got.CallerVerify || got.Usernames == nil || len(got.Usernames) != 0 {
		t.Fatalf("got %+v", got)
	}
	raw, _ := json.Marshal(got)
	if string(raw) != `{"callerVerify":false,"usernames":[]}` {
		t.Fatalf("wire = %s", raw)
	}
}

func TestHeartbeatPayloadCarriesCallerReadiness(t *testing.T) {
	raw, err := json.Marshal(HeartbeatPayload{HelperCapabilities: callerHelperCapabilities{Usernames: []string{}}})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["helperCapabilities"]; !ok {
		t.Fatalf("helperCapabilities must always be sent: %s", raw)
	}
}
