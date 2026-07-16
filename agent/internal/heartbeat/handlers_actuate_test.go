package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
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
	dismiss func(context.Context) pamactuator.Result
}

func (a fakeActuator) Trigger(ctx context.Context, req pamactuator.Request) pamactuator.Result {
	return a.trigger(ctx, req)
}

func (a fakeActuator) Dismiss(ctx context.Context) pamactuator.Result {
	if a.dismiss == nil {
		// Fail-safe default matching the production non-windows stub, so a
		// deny-path test that forgets to wire `dismiss` fails loud instead of
		// silently reporting a successful dismissal.
		return pamactuator.Result{Success: false, Reason: "unsupported_platform"}
	}
	return a.dismiss(ctx)
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
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{trigger: func(_ context.Context, req pamactuator.Request) pamactuator.Result {
			gotReq = req
			return pamactuator.Result{Success: true, Reason: "ok", DetailMessage: "typed"}
		}}
	})

	result := handleActuateElevation(&Heartbeat{}, Command{
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
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
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

	_ = handleActuateElevation(&Heartbeat{}, Command{
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
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
			t.Fatal("actuator should not run when Promote fails")
			return pamactuator.Result{}
		}}
	})

	result := handleActuateElevation(&Heartbeat{}, Command{
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

func TestActuateUsesConfiguredStrategy(t *testing.T) {
	var gotStrategy pamactuator.Strategy
	swapActuatorForTest(t, func(s pamactuator.Strategy) pamactuator.Actuator {
		gotStrategy = s
		return fakeActuator{trigger: func(_ context.Context, r pamactuator.Request) pamactuator.Result {
			return pamactuator.Result{Success: true, Reason: "ok"}
		}}
	})
	h := newTestHeartbeatWithPAMStrategy(t, "token_launch") // helper in this test file
	h.actuateElevation(context.Background(), "req-1", 8000, pamTarget{})
	if gotStrategy != pamactuator.StrategyTokenLaunch {
		t.Fatalf("actuator built with strategy %q, want token_launch", gotStrategy)
	}
}

// TestActuateElevationPassesTargetToActuator proves the pamTarget passed into
// actuateElevation (Task 5: Path B needs to know what to launch) flows
// through to the pamactuator.Request unmodified — the same code path serves
// both the remote (server-echoed) and local (ETW-discovered) callers.
func TestActuateElevationPassesTargetToActuator(t *testing.T) {
	manager := &fakeElevationManager{
		cred: elevaccount.Credential{Username: "~breeze_elev", Password: "x"},
	}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })

	var gotReq pamactuator.Request
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{trigger: func(_ context.Context, req pamactuator.Request) pamactuator.Result {
			gotReq = req
			return pamactuator.Result{Success: true, Reason: "ok"}
		}}
	})

	h := &Heartbeat{}
	h.actuateElevation(context.Background(), "req-target", 8000, pamTarget{
		Path:        `C:\Windows\System32\mmc.exe`,
		CommandLine: `mmc.exe devmgmt.msc`,
	})

	if gotReq.TargetPath != `C:\Windows\System32\mmc.exe` {
		t.Fatalf("actuator Request.TargetPath = %q, want mmc.exe path", gotReq.TargetPath)
	}
	if gotReq.CommandLine != `mmc.exe devmgmt.msc` {
		t.Fatalf("actuator Request.CommandLine = %q, want devmgmt.msc command line", gotReq.CommandLine)
	}
}

// TestTokenLaunchFailureStillDemotes proves the guaranteed-demote defer in
// actuateElevation covers Path B (token_launch) failures for free: a Trigger
// that reports Success:false (any Reason) must still Demote ~breeze_elev,
// exactly like the sendinput path already covered by
// TestHandleActuateElevationDemotesWhenActuatorPanics. newTestHeartbeatWithPAMStrategy
// installs its own fakeElevationManager, so the manager swap here must happen
// AFTER it to actually take effect (newElevationAccountManager is a single
// package-level var, last writer wins at actuateElevation call time).
func TestTokenLaunchFailureStillDemotes(t *testing.T) {
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
			return pamactuator.Result{Success: false, Reason: "create_process_failed"}
		}}
	})
	h := newTestHeartbeatWithPAMStrategy(t, "token_launch")
	manager := &fakeElevationManager{cred: elevaccount.Credential{Username: "~breeze_elev", Password: "x"}}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })

	h.actuateElevation(context.Background(), "req-1", 8000, pamTarget{Path: `C:\a.exe`, CommandLine: `a.exe`})

	if manager.demoteSeen != 1 {
		t.Fatalf("Demote called %d times after token_launch failure, want 1", manager.demoteSeen)
	}
}

func swapActuatorForTest(t *testing.T, fn func(pamactuator.Strategy) pamactuator.Actuator) {
	t.Helper()
	orig := newActuator
	newActuator = fn
	t.Cleanup(func() { newActuator = orig })
}

// newTestHeartbeatWithPAMStrategy mirrors newTestHeartbeat (handlers_script_test.go)
// but wires the config strategy field under test and a fake elevation manager
// so actuateElevation actually reaches the actuator instead of short-circuiting
// on the non-Windows Promote stub (elevaccount.ErrUnsupportedPlatform).
func newTestHeartbeatWithPAMStrategy(t *testing.T, strategy string) *Heartbeat {
	t.Helper()
	swapElevationManagerForTest(t, func() elevaccount.AccountManager {
		return &fakeElevationManager{cred: elevaccount.Credential{Username: "~breeze_elev", Password: "x"}}
	})
	return &Heartbeat{
		config: &config.Config{PAMActuatorStrategy: strategy},
	}
}

func swapElevationManagerForTest(t *testing.T, fn func() elevaccount.AccountManager) {
	t.Helper()
	orig := newElevationAccountManager
	newElevationAccountManager = fn
	t.Cleanup(func() { newElevationAccountManager = orig })
}
