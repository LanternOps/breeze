//go:build windows

package pamactuator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

type fakeLauncher struct {
	gotParams launchParams
	outcome   launchOutcome
}

func (f *fakeLauncher) Launch(_ context.Context, p launchParams) launchOutcome {
	f.gotParams = p
	return f.outcome
}

// passthroughVerifyTarget is a fake verifyTarget seam that returns path
// unchanged with a no-op release, so launcher-outcome tests don't need a real
// file on disk at the fixture's TargetPath. Target-verification behavior
// itself is covered separately below against real files.
func passthroughVerifyTarget(path, _ string) (string, func(), error) {
	return path, func() {}, nil
}

func newTestActuator(o launchOutcome) (*tokenLaunchActuator, *fakeLauncher) {
	fl := &fakeLauncher{outcome: o}
	return &tokenLaunchActuator{
		launcher:        fl,
		sessionResolver: func(Request) (uint32, error) { return 2, nil },
		suppress:        func(context.Context) Result { return Result{Success: true, Reason: "ok"} },
		verifyTarget:    passthroughVerifyTarget,
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
		verifyTarget: passthroughVerifyTarget,
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
		verifyTarget:    passthroughVerifyTarget,
	}
	res := act.Trigger(context.Background(), Request{
		Username: "~breeze_elev", Password: "x", TargetPath: `C:\a.exe`, CommandLine: `a.exe`,
	})
	if !res.Success || res.Reason != "ok" {
		t.Fatalf("got success=%v reason=%q, want true/ok", res.Success, res.Reason)
	}
}

// writeTestTargetFile creates a small regular file under t.TempDir() and
// returns its path and SHA-256, for exercising pinAndVerifyTokenLaunchTarget
// / Trigger's real target-verification path against a real file.
func writeTestTargetFile(t *testing.T, contents []byte) (path, sha256Hex string) {
	t.Helper()
	dir := t.TempDir()
	path = dir + `\target.exe`
	if err := os.WriteFile(path, contents, 0o644); err != nil {
		t.Fatalf("write test target file: %v", err)
	}
	sum := sha256.Sum256(contents)
	return path, hex.EncodeToString(sum[:])
}

func TestPinAndVerifyTokenLaunchTargetAcceptsMatchingHash(t *testing.T) {
	path, hash := writeTestTargetFile(t, []byte("legitimate build"))
	canonical, release, err := pinAndVerifyTokenLaunchTarget(path, hash)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer release()
	if canonical == "" {
		t.Fatal("expected a resolved canonical path")
	}
}

func TestPinAndVerifyTokenLaunchTargetRefusesOnHashMismatch(t *testing.T) {
	path, _ := writeTestTargetFile(t, []byte("legitimate build"))
	// Simulate a file swapped after approval: the hash on record no longer
	// matches what is on disk.
	_, _, err := pinAndVerifyTokenLaunchTarget(path, strings.Repeat("0", 64))
	if err == nil {
		t.Fatal("expected verification to fail closed on a hash mismatch")
	}
}

func TestPinAndVerifyTokenLaunchTargetRefusesMissingFile(t *testing.T) {
	dir := t.TempDir()
	_, _, err := pinAndVerifyTokenLaunchTarget(dir+`\does-not-exist.exe`, "")
	if err == nil {
		t.Fatal("expected verification to fail closed when the target does not exist")
	}
}

// TestPinAndVerifyTokenLaunchTargetHoldsExclusiveHandle proves the held
// handle denies a concurrent write/delete-intent open on the same path —
// the property that closes the swap-after-verification window.
func TestPinAndVerifyTokenLaunchTargetHoldsExclusiveHandle(t *testing.T) {
	path, hash := writeTestTargetFile(t, []byte("legitimate build"))
	_, release, err := pinAndVerifyTokenLaunchTarget(path, hash)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer release()

	pathPtr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatalf("encode path: %v", err)
	}
	_, err = windows.CreateFile(pathPtr, windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err == nil {
		t.Fatal("expected a concurrent write-intent open to be denied while the target is pinned")
	}
}

// TestTokenLaunchRefusesOnHashMismatchEndToEnd proves Trigger itself refuses
// and never reaches the launcher when the approval-time hash no longer
// matches the file on disk.
func TestTokenLaunchRefusesOnHashMismatchEndToEnd(t *testing.T) {
	path, _ := writeTestTargetFile(t, []byte("legitimate build"))
	fl := &fakeLauncher{outcome: launchOutcome{PID: 1}}
	act := &tokenLaunchActuator{
		launcher:        fl,
		sessionResolver: func(Request) (uint32, error) { return 2, nil },
		suppress:        func(context.Context) Result { return Result{Success: true, Reason: "ok"} },
		verifyTarget:    pinAndVerifyTokenLaunchTarget,
	}
	res := act.Trigger(context.Background(), Request{
		Username: "~breeze_elev", Password: "x",
		TargetPath: path, TargetPathHash: strings.Repeat("0", 64), CommandLine: "target.exe",
	})
	if res.Success || res.Reason != "target_verification_failed" {
		t.Fatalf("got success=%v reason=%q, want false/target_verification_failed", res.Success, res.Reason)
	}
	if fl.gotParams != (launchParams{}) {
		t.Fatalf("launcher must not be invoked on a failed verification, got %+v", fl.gotParams)
	}
}

func TestSuspendedTokenLaunchTransfersBothHandlesAndOmitsBreakaway(t *testing.T) {
	request := SuspendedLaunchRequest{
		ActuationID:     "10000000-0000-4000-8000-000000000001",
		Username:        "~breeze_elev",
		Password:        "ephemeral",
		TargetPath:      `C:\Windows\System32\mmc.exe`,
		SubjectUsername: `CORP\alice`,
	}
	if request.CreationFlags()&windows.CREATE_SUSPENDED == 0 {
		t.Fatal("v2 token launch must create the primary thread suspended")
	}
	if request.CreationFlags()&windows.CREATE_BREAKAWAY_FROM_JOB != 0 {
		t.Fatal("v2 token launch must not permit job breakaway")
	}
	var _ interface {
		PID() uint32
		ProcessCreationTime() time.Time
		ProcessHandle() windows.Handle
		PrimaryThreadHandle() windows.Handle
		Close()
	} = (*SuspendedProcess)(nil)
}
