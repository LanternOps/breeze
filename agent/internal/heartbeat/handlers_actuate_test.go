package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/breeze-rmm/agent/internal/elevaccount"
	"github.com/breeze-rmm/agent/internal/pamactuator"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

type fakeElevationManager struct {
	cred        elevaccount.Credential
	promoteErr  error
	promoteSeen int
	demoteSeen  int
}

func (m *fakeElevationManager) EnsureProvisioned() error { return nil }

func (m *fakeElevationManager) Promote(context.Context) (elevaccount.Credential, error) {
	m.promoteSeen++
	if m.promoteErr != nil {
		return elevaccount.Credential{}, m.promoteErr
	}
	return m.cred, nil
}

func (m *fakeElevationManager) Demote(context.Context) error {
	m.demoteSeen++
	return nil
}

type fakeActuator struct {
	trigger func(context.Context, pamactuator.Request) pamactuator.Result
}

func (a fakeActuator) Trigger(ctx context.Context, req pamactuator.Request) pamactuator.Result {
	return a.trigger(ctx, req)
}

func TestParseActuatePayloadAcceptsSlimGoSignal(t *testing.T) {
	payload, err := parseActuatePayload(map[string]any{
		"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		"timeoutMs":          float64(5000),
	})
	if err != nil {
		t.Fatalf("parseActuatePayload returned error: %v", err)
	}
	if payload.ElevationRequestID != "cccccccc-cccc-4ccc-8ccc-cccccccccccc" {
		t.Fatalf("ElevationRequestID = %q", payload.ElevationRequestID)
	}
	if payload.Username != "" || payload.Password != "" {
		t.Fatalf("deprecated credential fields should be empty, got %+v", payload)
	}
	if payload.TimeoutMs != 5000 {
		t.Fatalf("TimeoutMs = %d, want 5000", payload.TimeoutMs)
	}
}

func TestParseActuatePayloadIgnoresDeprecatedCredentials(t *testing.T) {
	payload, err := parseActuatePayload(map[string]any{
		"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		"username":           "server-user",
		"password":           "server-password",
	})
	if err != nil {
		t.Fatalf("parseActuatePayload returned error: %v", err)
	}
	if payload.Username != "server-user" || payload.Password != "server-password" {
		t.Fatalf("expected deprecated fields to parse but be ignored later, got %+v", payload)
	}
}

func TestHandleActuateElevationUsesLocalCredentialAndDemotes(t *testing.T) {
	manager := &fakeElevationManager{
		cred: elevaccount.Credential{Username: "~breeze_elev", Password: "minted-local-secret"},
	}
	var gotReq pamactuator.Request
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })
	swapActuatorForTest(t, func() pamactuator.Actuator {
		return fakeActuator{trigger: func(_ context.Context, req pamactuator.Request) pamactuator.Result {
			gotReq = req
			return pamactuator.Result{Success: true, Reason: "ok", DetailMessage: "typed"}
		}}
	})

	result := handleActuateElevation(nil, Command{
		ID:   "cmd-1",
		Type: tools.CmdActuateElevation,
		Payload: map[string]any{
			"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			"username":           "payload-user",
			"password":           "payload-password",
			"timeoutMs":          float64(5000),
		},
	})

	if result.Status != "completed" {
		t.Fatalf("Status = %q, want completed: %+v", result.Status, result)
	}
	if gotReq.Username != "~breeze_elev" {
		t.Fatalf("actuator username = %q, want local credential", gotReq.Username)
	}
	if gotReq.Password != "minted-local-secret" {
		t.Fatalf("actuator password = %q, want minted local secret", gotReq.Password)
	}
	if manager.promoteSeen != 1 {
		t.Fatalf("Promote called %d times, want 1", manager.promoteSeen)
	}
	if manager.demoteSeen != 1 {
		t.Fatalf("Demote called %d times, want 1", manager.demoteSeen)
	}

	var out actuateResult
	if err := json.Unmarshal([]byte(result.Stdout), &out); err != nil {
		t.Fatalf("stdout is not actuateResult JSON: %v", err)
	}
	if !out.Success || out.Reason != "ok" {
		t.Fatalf("unexpected actuate result: %+v", out)
	}
}

func TestHandleActuateElevationDemotesWhenActuatorPanics(t *testing.T) {
	manager := &fakeElevationManager{
		cred: elevaccount.Credential{Username: "~breeze_elev", Password: "minted-local-secret"},
	}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })
	swapActuatorForTest(t, func() pamactuator.Actuator {
		return fakeActuator{trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
			panic("actuator panic")
		}}
	})

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected actuator panic to propagate")
		}
		if manager.demoteSeen != 1 {
			t.Fatalf("Demote called %d times after panic, want 1", manager.demoteSeen)
		}
	}()

	_ = handleActuateElevation(nil, Command{
		ID:   "cmd-1",
		Type: tools.CmdActuateElevation,
		Payload: map[string]any{
			"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			"timeoutMs":          float64(5000),
		},
	})
}

func TestHandleActuateElevationPromoteFailureReturnsStructuredResult(t *testing.T) {
	manager := &fakeElevationManager{promoteErr: elevaccount.ErrUnsupportedPlatform}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })
	swapActuatorForTest(t, func() pamactuator.Actuator {
		return fakeActuator{trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
			t.Fatal("actuator should not run when Promote fails")
			return pamactuator.Result{}
		}}
	})

	result := handleActuateElevation(nil, Command{
		ID:   "cmd-1",
		Type: tools.CmdActuateElevation,
		Payload: map[string]any{
			"elevationRequestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		},
	})

	if result.Status != "completed" {
		t.Fatalf("Status = %q, want completed", result.Status)
	}
	var out actuateResult
	if err := json.Unmarshal([]byte(result.Stdout), &out); err != nil {
		t.Fatalf("stdout is not actuateResult JSON: %v", err)
	}
	if out.Success {
		t.Fatalf("Success = true, want false")
	}
	if out.Reason != "unsupported_platform" {
		t.Fatalf("Reason = %q, want unsupported_platform", out.Reason)
	}
	if manager.demoteSeen != 0 {
		t.Fatalf("Demote called %d times without successful Promote, want 0", manager.demoteSeen)
	}
}

func TestPromoteFailureReason(t *testing.T) {
	if got := promoteFailureReason(elevaccount.ErrUnsupportedPlatform); got != "unsupported_platform" {
		t.Fatalf("unsupported reason = %q", got)
	}
	if got := promoteFailureReason(errors.New("boom")); got != "credential_promote_failed" {
		t.Fatalf("generic reason = %q", got)
	}
}

func swapActuatorForTest(t *testing.T, fn func() pamactuator.Actuator) {
	t.Helper()
	orig := newActuator
	newActuator = fn
	t.Cleanup(func() { newActuator = orig })
}

func swapElevationManagerForTest(t *testing.T, fn func() elevaccount.AccountManager) {
	t.Helper()
	orig := newElevationAccountManager
	newElevationAccountManager = fn
	t.Cleanup(func() { newElevationAccountManager = orig })
}
