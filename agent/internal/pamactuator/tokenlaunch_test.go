//go:build windows

package pamactuator

import (
	"context"
	"errors"
	"testing"
)

type fakeLauncher struct {
	gotParams launchParams
	outcome   launchOutcome
}

func (f *fakeLauncher) Launch(_ context.Context, p launchParams) launchOutcome {
	f.gotParams = p
	return f.outcome
}

func newTestActuator(o launchOutcome) (*tokenLaunchActuator, *fakeLauncher) {
	fl := &fakeLauncher{outcome: o}
	return &tokenLaunchActuator{
		launcher:        fl,
		sessionResolver: func(Request) (uint32, error) { return 2, nil },
		suppress:        func(context.Context) Result { return Result{Success: true, Reason: "ok"} },
	}, fl
}

func TestTokenLaunchSuccess(t *testing.T) {
	act, fl := newTestActuator(launchOutcome{PID: 4321})
	res := act.Trigger(context.Background(), Request{
		Username:    "~breeze_elev",
		Password:    "s3cret",
		TargetPath:  `C:\Windows\System32\mmc.exe`,
		CommandLine: `mmc.exe devmgmt.msc`,
	})
	if !res.Success || res.Reason != "ok" {
		t.Fatalf("got success=%v reason=%q, want true/ok", res.Success, res.Reason)
	}
	if fl.gotParams.TargetPath == "" || fl.gotParams.SessionID != 2 {
		t.Fatalf("launcher got wrong params: %+v", fl.gotParams)
	}
	if fl.gotParams.Password == "" {
		t.Fatal("password not forwarded to launcher")
	}
}

func TestTokenLaunchEmptyTarget(t *testing.T) {
	act, _ := newTestActuator(launchOutcome{PID: 1})
	res := act.Trigger(context.Background(), Request{Username: "~breeze_elev", Password: "x"})
	if res.Success || res.Reason != "empty_target" {
		t.Fatalf("got success=%v reason=%q, want false/empty_target", res.Success, res.Reason)
	}
}

func TestTokenLaunchLauncherFailureMapsReason(t *testing.T) {
	act, _ := newTestActuator(launchOutcome{Reason: "logon_failed", Err: errors.New("bad creds")})
	res := act.Trigger(context.Background(), Request{
		Username: "~breeze_elev", Password: "x", TargetPath: `C:\a.exe`, CommandLine: `a.exe`,
	})
	if res.Success || res.Reason != "logon_failed" {
		t.Fatalf("got success=%v reason=%q, want false/logon_failed", res.Success, res.Reason)
	}
}

// orderedFakeLauncher records "launch" into a shared order slice so tests can
// assert Trigger calls suppress before Launch.
type orderedFakeLauncher struct {
	order   *[]string
	outcome launchOutcome
}

func (o *orderedFakeLauncher) Launch(_ context.Context, _ launchParams) launchOutcome {
	*o.order = append(*o.order, "launch")
	return o.outcome
}

// TestTokenLaunchSuppressesConsentBeforeLaunch proves (a) Trigger invokes the
// suppress seam BEFORE launcher.Launch, and (b) a failed/no-consent-window
// suppress result does NOT prevent the launch — Trigger still returns success
// when Launch succeeds. This matches the design's "Dismiss() the pending
// consent.exe, THEN launch" contract and the best-effort requirement (the
// remote approve path may find consent.exe already gone).
func TestTokenLaunchSuppressesConsentBeforeLaunch(t *testing.T) {
	var order []string
	fl := &orderedFakeLauncher{order: &order, outcome: launchOutcome{PID: 42}}
	act := &tokenLaunchActuator{
		launcher:        fl,
		sessionResolver: func(Request) (uint32, error) { return 2, nil },
		suppress: func(context.Context) Result {
			order = append(order, "suppress")
			// Best-effort failure: consent.exe was already gone by the time
			// the remote approve path landed. Must not block the launch.
			return Result{Success: false, Reason: "no_consent_window"}
		},
	}

	res := act.Trigger(context.Background(), Request{
		Username: "~breeze_elev", Password: "x", TargetPath: `C:\a.exe`, CommandLine: `a.exe`,
	})

	if !res.Success || res.Reason != "ok" {
		t.Fatalf("got success=%v reason=%q, want true/ok despite suppress failure", res.Success, res.Reason)
	}
	if len(order) != 2 || order[0] != "suppress" || order[1] != "launch" {
		t.Fatalf("wrong call order: %v, want [suppress launch]", order)
	}
}

// TestTokenLaunchSuppressNilIsSafe proves Trigger does not panic when
// suppress is left unset (nil) — e.g. actuators built directly in tests
// without going through newTokenLaunchActuator.
func TestTokenLaunchSuppressNilIsSafe(t *testing.T) {
	fl := &fakeLauncher{outcome: launchOutcome{PID: 7}}
	act := &tokenLaunchActuator{
		launcher:        fl,
		sessionResolver: func(Request) (uint32, error) { return 2, nil },
	}
	res := act.Trigger(context.Background(), Request{
		Username: "~breeze_elev", Password: "x", TargetPath: `C:\a.exe`, CommandLine: `a.exe`,
	})
	if !res.Success || res.Reason != "ok" {
		t.Fatalf("got success=%v reason=%q, want true/ok", res.Success, res.Reason)
	}
}
