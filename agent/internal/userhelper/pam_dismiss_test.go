package userhelper

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamactuator"
)

type stubPamDismissActuator struct {
	dismissResult pamactuator.Result
	dismissFunc   func(context.Context) pamactuator.Result
	panicValue    any
	dismissCalls  atomic.Int32
}

func (s *stubPamDismissActuator) Trigger(context.Context, pamactuator.Request) pamactuator.Result {
	return pamactuator.Result{}
}

func (s *stubPamDismissActuator) Dismiss(ctx context.Context) pamactuator.Result {
	s.dismissCalls.Add(1)
	if s.panicValue != nil {
		panic(s.panicValue)
	}
	if s.dismissFunc != nil {
		return s.dismissFunc(ctx)
	}
	return s.dismissResult
}

func newPamDismissPipe(t *testing.T, role string, scopes ...string) (*Client, *ipc.Conn) {
	t.Helper()

	helperConn, peerConn := net.Pipe()
	client := New("/unused", role)
	client.scopes = scopes
	client.conn = ipc.NewConn(helperConn)
	peer := ipc.NewConn(peerConn)
	t.Cleanup(func() {
		_ = client.conn.Close()
		_ = peer.Close()
	})
	return client, peer
}

func pamDismissPayload(t *testing.T) json.RawMessage {
	t.Helper()
	payload, err := json.Marshal(ipc.PamDismissConsentRequest{
		DeadlineUnixMs: time.Now().Add(2 * time.Second).UnixMilli(),
	})
	if err != nil {
		t.Fatalf("marshal PAM dismiss request: %v", err)
	}
	return payload
}

func callPamDismissHandler(t *testing.T, client *Client, peer *ipc.Conn, payload json.RawMessage) *ipc.Envelope {
	t.Helper()

	done := make(chan struct{})
	go func() {
		client.handlePamDismissConsent(&ipc.Envelope{
			ID:      "pam-dismiss-1",
			Type:    ipc.TypePamDismissConsent,
			Payload: payload,
		})
		close(done)
	}()

	if err := peer.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	env, err := peer.Recv()
	if err != nil {
		t.Fatalf("receive PAM dismiss response: %v", err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("PAM dismiss handler did not return promptly")
	}
	return env
}

func swapPamDismissActuator(t *testing.T, actuator pamactuator.Actuator) {
	t.Helper()
	original := newPamActuator
	newPamActuator = func() pamactuator.Actuator { return actuator }
	t.Cleanup(func() { newPamActuator = original })
}

func assertPamDismissEnvelope(t *testing.T, env *ipc.Envelope) {
	t.Helper()
	if env.ID != "pam-dismiss-1" {
		t.Fatalf("response id = %q, want pam-dismiss-1", env.ID)
	}
	if env.Type != ipc.TypePamDismissConsentResult {
		t.Fatalf("response type = %q, want %q", env.Type, ipc.TypePamDismissConsentResult)
	}
}

func TestHandlePamDismissConsentInvokesActuatorAndReplies(t *testing.T) {
	actuator := &stubPamDismissActuator{dismissResult: pamactuator.Result{
		Success:       true,
		Reason:        "ok",
		DetailMessage: "consent window dismissed",
	}}
	swapPamDismissActuator(t, actuator)
	client, peer := newPamDismissPipe(t, ipc.HelperRoleSystem, ipc.ScopePam)

	env := callPamDismissHandler(t, client, peer, pamDismissPayload(t))

	assertPamDismissEnvelope(t, env)
	if env.Error != "" {
		t.Fatalf("unexpected response error: %q", env.Error)
	}
	if got := actuator.dismissCalls.Load(); got != 1 {
		t.Fatalf("Dismiss calls = %d, want 1", got)
	}
	var result ipc.PamDismissConsentResult
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		t.Fatalf("unmarshal PAM dismiss result: %v", err)
	}
	if !result.Success || result.Reason != "ok" || result.DetailMessage != "consent window dismissed" {
		t.Fatalf("unexpected PAM dismiss result: %+v", result)
	}
}

func TestHandlePamDismissConsentPreservesNonSuccessResult(t *testing.T) {
	actuator := &stubPamDismissActuator{dismissResult: pamactuator.Result{
		Success:       false,
		Reason:        "send_input_failed",
		DetailMessage: "SendInput returned zero",
	}}
	swapPamDismissActuator(t, actuator)
	client, peer := newPamDismissPipe(t, ipc.HelperRoleSystem, ipc.ScopePam)

	env := callPamDismissHandler(t, client, peer, pamDismissPayload(t))

	assertPamDismissEnvelope(t, env)
	var result ipc.PamDismissConsentResult
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		t.Fatalf("unmarshal PAM dismiss result: %v", err)
	}
	if result.Success || result.Reason != "send_input_failed" || result.DetailMessage != "SendInput returned zero" {
		t.Fatalf("unexpected PAM dismiss result: %+v", result)
	}
}

func TestHandlePamDismissConsentRejectsUnauthorizedHelpers(t *testing.T) {
	tests := []struct {
		name   string
		role   string
		scopes []string
	}{
		{name: "wrong role", role: ipc.HelperRoleUser, scopes: []string{ipc.ScopePam}},
		{name: "missing PAM scope", role: ipc.HelperRoleSystem, scopes: []string{"desktop"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actuator := &stubPamDismissActuator{}
			swapPamDismissActuator(t, actuator)
			client, peer := newPamDismissPipe(t, tt.role, tt.scopes...)

			env := callPamDismissHandler(t, client, peer, pamDismissPayload(t))

			assertPamDismissEnvelope(t, env)
			if env.Error == "" {
				t.Fatal("expected unauthorized helper error response")
			}
			if got := actuator.dismissCalls.Load(); got != 0 {
				t.Fatalf("Dismiss calls = %d, want 0", got)
			}
		})
	}
}

func TestHandlePamDismissConsentRejectsInvalidPayload(t *testing.T) {
	actuator := &stubPamDismissActuator{}
	swapPamDismissActuator(t, actuator)
	client, peer := newPamDismissPipe(t, ipc.HelperRoleSystem, ipc.ScopePam)

	env := callPamDismissHandler(t, client, peer, json.RawMessage(`{"unexpected"`))

	assertPamDismissEnvelope(t, env)
	if !strings.Contains(env.Error, "invalid payload") {
		t.Fatalf("response error = %q, want invalid payload error", env.Error)
	}
	if got := actuator.dismissCalls.Load(); got != 0 {
		t.Fatalf("Dismiss calls = %d, want 0", got)
	}
}

func TestHandlePamDismissConsentRejectsInvalidDeadline(t *testing.T) {
	tests := []struct {
		name    string
		request ipc.PamDismissConsentRequest
	}{
		{name: "missing deadline", request: ipc.PamDismissConsentRequest{}},
		{
			name: "expired deadline",
			request: ipc.PamDismissConsentRequest{
				DeadlineUnixMs: time.Now().Add(-time.Second).UnixMilli(),
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actuator := &stubPamDismissActuator{}
			swapPamDismissActuator(t, actuator)
			client, peer := newPamDismissPipe(t, ipc.HelperRoleSystem, ipc.ScopePam)
			payload, err := json.Marshal(tt.request)
			if err != nil {
				t.Fatalf("marshal request: %v", err)
			}

			env := callPamDismissHandler(t, client, peer, payload)

			assertPamDismissEnvelope(t, env)
			if !strings.Contains(env.Error, "deadline") {
				t.Fatalf("response error = %q, want deadline error", env.Error)
			}
			if got := actuator.dismissCalls.Load(); got != 0 {
				t.Fatalf("Dismiss calls = %d, want 0", got)
			}
		})
	}
}

func TestHandlePamDismissConsentPropagatesDeadlineCancellation(t *testing.T) {
	type observedDeadline struct {
		value time.Time
		ok    bool
	}

	deadline := time.Now().Add(500 * time.Millisecond).Truncate(time.Millisecond)
	deadlineSeen := make(chan observedDeadline, 1)
	var inputAfterDeadline atomic.Bool
	actuator := &stubPamDismissActuator{dismissFunc: func(ctx context.Context) pamactuator.Result {
		got, ok := ctx.Deadline()
		deadlineSeen <- observedDeadline{value: got, ok: ok}
		select {
		case <-ctx.Done():
			return pamactuator.Result{
				Success:       false,
				Reason:        "dismiss_cancelled",
				DetailMessage: ctx.Err().Error(),
			}
		case <-time.After(2 * time.Second):
			inputAfterDeadline.Store(true)
			return pamactuator.Result{Success: true, Reason: "dismissed"}
		}
	}}
	swapPamDismissActuator(t, actuator)
	client, peer := newPamDismissPipe(t, ipc.HelperRoleSystem, ipc.ScopePam)
	payload, err := json.Marshal(ipc.PamDismissConsentRequest{DeadlineUnixMs: deadline.UnixMilli()})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	env := callPamDismissHandler(t, client, peer, payload)

	assertPamDismissEnvelope(t, env)
	var seen observedDeadline
	select {
	case seen = <-deadlineSeen:
	case <-time.After(2 * time.Second):
		t.Fatal("actuator did not observe the request deadline")
	}
	if !seen.ok {
		t.Fatal("actuator context had no deadline")
	}
	if delta := seen.value.Sub(deadline); delta < -time.Millisecond || delta > time.Millisecond {
		t.Fatalf("actuator deadline = %v, want %v", seen.value, deadline)
	}
	if inputAfterDeadline.Load() {
		t.Fatal("actuator continued to simulated input after the request deadline")
	}
	var result ipc.PamDismissConsentResult
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		t.Fatalf("unmarshal PAM dismiss result: %v", err)
	}
	if result.Success || result.Reason != "dismiss_cancelled" {
		t.Fatalf("unexpected PAM dismiss result: %+v", result)
	}
}

func TestCommandLoopPamDismissConsentPanicReturnsError(t *testing.T) {
	actuator := &stubPamDismissActuator{panicValue: "simulated actuator panic"}
	swapPamDismissActuator(t, actuator)
	client, peer := newPamDismissPipe(t, ipc.HelperRoleSystem, ipc.ScopePam)
	loopDone := make(chan error, 1)
	go func() { loopDone <- client.commandLoop() }()

	if err := peer.SendTyped("pam-dismiss-1", ipc.TypePamDismissConsent, ipc.PamDismissConsentRequest{
		DeadlineUnixMs: time.Now().Add(2 * time.Second).UnixMilli(),
	}); err != nil {
		t.Fatalf("send PAM dismiss request: %v", err)
	}
	if err := peer.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	env, err := peer.Recv()
	if err != nil {
		t.Fatalf("receive panic response: %v", err)
	}
	assertPamDismissEnvelope(t, env)
	if env.Error == "" {
		t.Fatal("expected actuator panic error response")
	}
	if got := actuator.dismissCalls.Load(); got != 1 {
		t.Fatalf("Dismiss calls = %d, want 1", got)
	}

	if err := peer.SendTyped("disconnect", ipc.TypeDisconnect, nil); err != nil {
		t.Fatalf("send disconnect: %v", err)
	}
	select {
	case err := <-loopDone:
		if err != nil {
			t.Fatalf("command loop returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("command loop did not return promptly")
	}
}
