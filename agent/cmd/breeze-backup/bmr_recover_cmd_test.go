package main

import (
	"context"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
)

func TestBMRRecoverCommandParsesFlags(t *testing.T) {
	origRunner := runBMRRecovery
	defer func() { runBMRRecovery = origRunner }()

	var gotCfg bmr.RecoveryConfig
	runBMRRecovery = func(ctx context.Context, cfg bmr.RecoveryConfig) (*bmr.RecoveryResult, error) {
		gotCfg = cfg
		if ctx == nil {
			t.Fatal("expected context to be provided")
		}
		return &bmr.RecoveryResult{Status: "completed"}, nil
	}

	cmd := newBMRRecoverCommand()
	cmd.SetArgs([]string{
		"--token", "brz_rec_test",
		"--server", "https://api.example.com",
		"--target-path", "/src/data=/dst/data",
	})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if gotCfg.RecoveryToken != "brz_rec_test" {
		t.Fatalf("RecoveryToken = %q, want brz_rec_test", gotCfg.RecoveryToken)
	}
	if gotCfg.ServerURL != "https://api.example.com" {
		t.Fatalf("ServerURL = %q, want https://api.example.com", gotCfg.ServerURL)
	}
	if gotCfg.TargetPaths["/src/data"] != "/dst/data" {
		t.Fatalf("TargetPaths = %#v, want override", gotCfg.TargetPaths)
	}
}

func TestBMRRecoverCommandRejectsBadTargetPath(t *testing.T) {
	cmd := newBMRRecoverCommand()
	cmd.SetArgs([]string{
		"--token", "brz_rec_test",
		"--server", "https://api.example.com",
		"--target-path", "missing-separator",
	})

	if err := cmd.Execute(); err == nil {
		t.Fatal("expected Execute to fail for malformed target-path")
	}
}

// TestDefaultRecoveryContext_NotDoneUntilCancelled proves the seam behind
// the CLI's signal wiring (signal.NotifyContext bound to os.Interrupt and
// syscall.SIGTERM) returns a live context — not already done — and that
// its own cancel func genuinely cancels it. We never send a real signal to
// the test process; we only exercise the cancel func directly, which is
// exactly what signal.NotifyContext wires a delivered signal to internally.
func TestDefaultRecoveryContext_NotDoneUntilCancelled(t *testing.T) {
	ctx, cancel := defaultRecoveryContext()
	defer cancel()

	select {
	case <-ctx.Done():
		t.Fatal("expected a freshly constructed recovery context to not be done yet")
	default:
	}
	if ctx.Err() != nil {
		t.Fatalf("ctx.Err() = %v, want nil before cancellation", ctx.Err())
	}

	cancel()

	select {
	case <-ctx.Done():
	default:
		t.Fatal("expected ctx to be done after calling its cancel func")
	}
	if ctx.Err() == nil {
		t.Fatal("expected ctx.Err() to be non-nil after cancellation")
	}
}

// TestBMRRecoverCommand_InterruptedContextSurfacesClearError proves that
// when the recovery context is already cancelled (simulating a signal
// having fired), the CLI surfaces a clear "recovery interrupted by signal"
// error instead of whatever generic error runBMRRecovery happened to
// return (e.g. the raw context.Canceled bubbling up from an in-flight HTTP
// call) — regardless of what runBMRRecovery itself reports. This does not
// send a real OS signal; it overrides the injectable recoveryContext seam
// to return an already-cancelled context.
func TestBMRRecoverCommand_InterruptedContextSurfacesClearError(t *testing.T) {
	origRunner := runBMRRecovery
	origCtxFn := recoveryContext
	defer func() {
		runBMRRecovery = origRunner
		recoveryContext = origCtxFn
	}()

	recoveryContext = func() (context.Context, context.CancelFunc) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel() // simulate a signal having already fired before recovery finished
		return ctx, cancel
	}
	runBMRRecovery = func(ctx context.Context, cfg bmr.RecoveryConfig) (*bmr.RecoveryResult, error) {
		// Mirrors what RunRecoveryWithTokenContext actually does against an
		// already-cancelled context: it fails early (e.g. authenticating)
		// with a generic context-cancellation error, not the CLI's clearer
		// message.
		return nil, context.Canceled
	}

	cmd := newBMRRecoverCommand()
	cmd.SetArgs([]string{
		"--token", "brz_rec_test",
		"--server", "https://api.example.com",
	})

	err := cmd.Execute()
	if err == nil {
		t.Fatal("expected Execute to return an error for an interrupted recovery")
	}
	if !strings.Contains(err.Error(), "recovery interrupted by signal") {
		t.Fatalf("err = %q, want it to mention 'recovery interrupted by signal'", err.Error())
	}
}
