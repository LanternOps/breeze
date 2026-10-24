package userhelper

import (
	"context"
	"encoding/json"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamactuator"
)

type stubInstanceDismissActuator struct {
	stubPamDismissActuator
	instanceResult pamactuator.Result
	instanceCalls  atomic.Int32
	gotInstance    pamactuator.ConsentInstance
}

func (s *stubInstanceDismissActuator) DismissInstance(_ context.Context, inst pamactuator.ConsentInstance) pamactuator.Result {
	s.instanceCalls.Add(1)
	s.gotInstance = inst
	return s.instanceResult
}

func targetedPamDismissPayload(t *testing.T, inst ipc.PamConsentInstance) json.RawMessage {
	t.Helper()
	payload, err := json.Marshal(ipc.PamDismissConsentRequest{
		DeadlineUnixMs: time.Now().Add(2 * time.Second).UnixMilli(),
		Instance:       &inst,
	})
	if err != nil {
		t.Fatalf("marshal targeted PAM dismiss request: %v", err)
	}
	return payload
}

func decodePamDismissResult(t *testing.T, env *ipc.Envelope) ipc.PamDismissConsentResult {
	t.Helper()
	if env.Error != "" {
		t.Fatalf("unexpected response error: %q", env.Error)
	}
	var result ipc.PamDismissConsentResult
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		t.Fatalf("unmarshal PAM dismiss result: %v", err)
	}
	return result
}

// #8995: a targeted request dismisses only the named consent.exe.
func TestHandlePamDismissConsentTargetedUsesInstanceDismissal(t *testing.T) {
	actuator := &stubInstanceDismissActuator{instanceResult: pamactuator.Result{Success: true, Reason: "ok"}}
	swapPamDismissActuator(t, actuator)
	client, peer := newPamDismissPipe(t, ipc.HelperRoleSystem, ipc.ScopePam)

	created := time.Date(2026, 10, 17, 3, 3, 17, 123456700, time.UTC)
	env := callPamDismissHandler(t, client, peer,
		targetedPamDismissPayload(t, ipc.PamConsentInstance{PID: 5150, CreatedUnixNano: created.UnixNano()}))

	assertPamDismissEnvelope(t, env)
	if result := decodePamDismissResult(t, env); !result.Success || result.Reason != "ok" {
		t.Fatalf("result = %+v, want ok", result)
	}
	if got := actuator.instanceCalls.Load(); got != 1 {
		t.Fatalf("DismissInstance calls = %d, want 1", got)
	}
	if got := actuator.dismissCalls.Load(); got != 0 {
		t.Fatalf("untargeted Dismiss calls = %d, want 0 — it would Escape any prompt", got)
	}
	if actuator.gotInstance.PID != 5150 || !actuator.gotInstance.CreatedAt.Equal(created) {
		t.Fatalf("instance = %+v, want pid 5150 created %v", actuator.gotInstance, created)
	}
}

// A targeted request must never degrade into the untargeted Escape.
func TestHandlePamDismissConsentTargetedNeverFallsBackToUntargeted(t *testing.T) {
	actuator := &stubPamDismissActuator{dismissResult: pamactuator.Result{Success: true, Reason: "ok"}}
	swapPamDismissActuator(t, actuator)
	client, peer := newPamDismissPipe(t, ipc.HelperRoleSystem, ipc.ScopePam)

	env := callPamDismissHandler(t, client, peer,
		targetedPamDismissPayload(t, ipc.PamConsentInstance{PID: 5150, CreatedUnixNano: 1}))

	assertPamDismissEnvelope(t, env)
	result := decodePamDismissResult(t, env)
	if result.Success || result.Reason != reasonTargetedDismissUnsupported {
		t.Fatalf("result = %+v, want %s", result, reasonTargetedDismissUnsupported)
	}
	if got := actuator.dismissCalls.Load(); got != 0 {
		t.Fatalf("untargeted Dismiss calls = %d, want 0", got)
	}
}

func TestHandlePamDismissConsentRejectsInvalidInstance(t *testing.T) {
	actuator := &stubInstanceDismissActuator{instanceResult: pamactuator.Result{Success: true, Reason: "ok"}}
	swapPamDismissActuator(t, actuator)
	client, peer := newPamDismissPipe(t, ipc.HelperRoleSystem, ipc.ScopePam)

	env := callPamDismissHandler(t, client, peer, targetedPamDismissPayload(t, ipc.PamConsentInstance{PID: 5150}))

	assertPamDismissEnvelope(t, env)
	if env.Error == "" {
		t.Fatal("an instance without a creation time was accepted")
	}
	if actuator.instanceCalls.Load() != 0 || actuator.dismissCalls.Load() != 0 {
		t.Fatal("an invalid targeted request reached the actuator")
	}
}

// The pure helper below is only half the contract: the advertised bit must
// actually reach the wire in the auth request, or every real helper is refused
// targeted dismissal and the #8995 fix silently does nothing.
func TestAuthenticateSendsTargetedPamDismissCapability(t *testing.T) {
	for role, want := range map[ipc.HelperRole]bool{ipc.HelperRoleSystem: true, ipc.HelperRoleUser: false} {
		t.Run(string(role), func(t *testing.T) {
			clientConn, serverConn := net.Pipe()
			defer func() { _ = clientConn.Close() }()
			defer func() { _ = serverConn.Close() }()

			got := make(chan map[string]json.RawMessage, 1)
			go func() {
				srv := ipc.NewConn(serverConn)
				env, err := srv.Recv()
				if err != nil {
					got <- nil
					return
				}
				var fields map[string]json.RawMessage
				_ = json.Unmarshal(env.Payload, &fields)
				got <- fields
				payload, _ := json.Marshal(ipc.PreAuthReject{Code: "test_done", Reason: "captured", Permanent: true})
				_ = srv.Send(&ipc.Envelope{Type: ipc.TypePreAuthReject, ID: "0", Payload: payload})
			}()

			c := New("/unused", role)
			c.conn = ipc.NewConn(clientConn)
			_ = c.authenticate()

			fields := <-got
			if fields == nil {
				t.Fatal("no auth request captured")
			}
			raw, present := fields["supportsTargetedPamDismiss"]
			if present != want || (want && string(raw) != "true") {
				t.Fatalf("supportsTargetedPamDismiss on the wire = %q (present=%v), want present=%v", raw, present, want)
			}
		})
	}
}

func TestSystemHelperAdvertisesTargetedPamDismiss(t *testing.T) {
	for role, want := range map[ipc.HelperRole]bool{
		ipc.HelperRoleSystem: true,
		ipc.HelperRoleUser:   false,
		ipc.HelperRoleAssist: false,
	} {
		if got := supportsTargetedPamDismissForAuth(role); got != want {
			t.Fatalf("supportsTargetedPamDismissForAuth(%q) = %v, want %v", role, got, want)
		}
	}
}
