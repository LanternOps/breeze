package agentapp

import (
	"bytes"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/updater"
	"github.com/breeze-rmm/agent/internal/watchdoginstall"
)

// Decision 6 (option B, #8618 W03): a `service install` that installed the
// agent but could not bootstrap the watchdog exits 0 by default (the enrolled
// agent heals the host), prints one machine-readable marker line, and only
// --strict-watchdog turns the deferral into exit 78.

func transientBootstrapErr() error {
	return fmt.Errorf("verify and stage watchdog: %w",
		&url.Error{Op: "Get", URL: "https://releases.example/x?token=secret", Err: errors.New("connection refused")})
}

func permanentBootstrapErr() error {
	return fmt.Errorf("verify and stage watchdog: %w", updater.ErrChecksumMismatch)
}

func TestReportWatchdogBootstrap_TransientDefaultsToZeroWithMarker(t *testing.T) {
	var out bytes.Buffer
	if err := reportWatchdogBootstrap(transientBootstrapErr(), false, &out); err != nil {
		t.Fatalf("transient bootstrap failure without --strict-watchdog must not fail the install, got %v", err)
	}
	if got, want := out.String(), "BREEZE_WATCHDOG_INSTALL=deferred reason=network\n"; got != want {
		t.Fatalf("marker line = %q, want %q", got, want)
	}
}

func TestReportWatchdogBootstrap_PermanentDefaultsToZeroWithMarker(t *testing.T) {
	var out bytes.Buffer
	if err := reportWatchdogBootstrap(permanentBootstrapErr(), false, &out); err != nil {
		t.Fatalf("permanent bootstrap failure without --strict-watchdog must not fail the install, got %v", err)
	}
	if got, want := out.String(), "BREEZE_WATCHDOG_INSTALL=deferred reason=checksum\n"; got != want {
		t.Fatalf("marker line = %q, want %q", got, want)
	}
}

func TestReportWatchdogBootstrap_StrictPermanentExits78(t *testing.T) {
	var out bytes.Buffer
	err := reportWatchdogBootstrap(permanentBootstrapErr(), true, &out)
	var ece *ExitCodeError
	if !errors.As(err, &ece) || ece.Code != ExitCodeWatchdogDeferred {
		t.Fatalf("strict + permanent failure: got %v, want ExitCodeError{%d}", err, ExitCodeWatchdogDeferred)
	}
	if ExitCodeWatchdogDeferred != 78 {
		t.Fatalf("ExitCodeWatchdogDeferred = %d; 78 is a documented contract", ExitCodeWatchdogDeferred)
	}
	if !strings.Contains(out.String(), "BREEZE_WATCHDOG_INSTALL=deferred reason=checksum") {
		t.Fatalf("strict mode must still print the marker line, got %q", out.String())
	}
}

func TestReportWatchdogBootstrap_StrictTransientExits78(t *testing.T) {
	err := reportWatchdogBootstrap(transientBootstrapErr(), true, &bytes.Buffer{})
	var ece *ExitCodeError
	if !errors.As(err, &ece) || ece.Code != 78 {
		t.Fatalf("strict + transient failure: got %v, want ExitCodeError{78} (Decision 6 B: any failure)", err)
	}
}

func TestReportWatchdogBootstrap_SuccessOrSkipPrintsNothing(t *testing.T) {
	for _, strict := range []bool{false, true} {
		var out bytes.Buffer
		if err := reportWatchdogBootstrap(nil, strict, &out); err != nil {
			t.Fatalf("strict=%v: nil bootstrap error (success, --no-watchdog, or standing opt-out) must exit 0, got %v", strict, err)
		}
		if out.Len() != 0 {
			t.Fatalf("strict=%v: no marker expected on success/skip, got %q", strict, out.String())
		}
	}
}

// The marker and the exit error carry only the closed ErrorClass, never the
// bootstrap error text (download errors can embed URLs with credentials).
func TestReportWatchdogBootstrap_NeverEchoesErrorText(t *testing.T) {
	var out bytes.Buffer
	err := reportWatchdogBootstrap(transientBootstrapErr(), true, &out)
	for _, s := range []string{out.String(), err.Error()} {
		if strings.Contains(s, "secret") || strings.Contains(s, "releases.example") {
			t.Fatalf("leaked bootstrap error text: %q", s)
		}
	}
}

func TestReportWatchdogBootstrap_DevBuildAndInstallCmdClassified(t *testing.T) {
	cases := map[string]struct {
		err  error
		want string
	}{
		"dev build":   {fmt.Errorf("x: %w", watchdoginstall.ErrDevBuild), "reason=dev_build"},
		"install cmd": {fmt.Errorf("x: %w", watchdoginstall.ErrInstallCommand), "reason=install_cmd"},
		"unknown":     {errors.New("boom"), "reason=unknown"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			_ = reportWatchdogBootstrap(tc.err, false, &out)
			if !strings.Contains(out.String(), tc.want) {
				t.Fatalf("got %q, want %s", out.String(), tc.want)
			}
		})
	}
}

// bootstrapWatchdog's own failure modes must reach the marker as a real class,
// not `unknown`: a dev build with no sibling is dev_build, and a staged
// watchdog whose `service install` fails is install_cmd.
func TestBootstrapWatchdog_DevBuildIsClassified(t *testing.T) {
	dir := t.TempDir()
	agent := filepath.Join(dir, "breeze-agent")
	if err := os.WriteFile(agent, []byte("agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	err := bootstrapWatchdog(bootstrapOptions{agentPath: agent, version: "dev", goos: runtime.GOOS, goarch: runtime.GOARCH})
	if c, _ := watchdoginstall.Classify(err); c != watchdoginstall.ClassDevBuild {
		t.Fatalf("dev build without sibling classified %q (err %v), want dev_build", c, err)
	}
}

func TestBootstrapWatchdog_InstallerFailureIsClassified(t *testing.T) {
	dir := t.TempDir()
	agent := filepath.Join(dir, "breeze-agent")
	sibling := filepath.Join(dir, watchdogBinaryName(runtime.GOOS))
	if err := os.WriteFile(agent, []byte("agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sibling, writeLargeBody(37), 0o755); err != nil {
		t.Fatal(err)
	}
	err := bootstrapWatchdog(bootstrapOptions{
		agentPath: agent, version: "1.2.3", goos: runtime.GOOS, goarch: runtime.GOARCH,
		protectedSiblingOverride: func(string, string) bool { return true },
		runInstaller:             func(string) error { return errors.New("exit status 1") },
	})
	if c, _ := watchdoginstall.Classify(err); c != watchdoginstall.ClassInstallCmd {
		t.Fatalf("failed watchdog service install classified %q (err %v), want install_cmd", c, err)
	}
	if err == nil || !strings.Contains(err.Error(), "exit status 1") {
		t.Fatalf("the installer's own error must stay in the operator-facing text, got %v", err)
	}
}

// The agent's own start/install failure always wins over the watchdog outcome:
// a host whose agent is down must never exit 78 (or 0).
func TestInstallExitError_AgentFailureWins(t *testing.T) {
	startErr := errors.New("agent service could not be started")
	if got := installExitError(startErr, &ExitCodeError{Code: 78}); got != startErr {
		t.Fatalf("start failure + strict watchdog deferral: got %v, want the start error", got)
	}
	if got := installExitError(startErr, nil); got != startErr {
		t.Fatalf("start failure alone: got %v, want the start error", got)
	}
	wd := &ExitCodeError{Code: 78}
	if got := installExitError(nil, wd); got != wd {
		t.Fatalf("agent ok + strict deferral: got %v, want the exit-78 error", got)
	}
	if got := installExitError(nil, nil); got != nil {
		t.Fatalf("all ok: got %v, want nil", got)
	}
}

func TestExitCodeFor(t *testing.T) {
	if got := exitCodeFor(errors.New("plain")); got != 1 {
		t.Fatalf("plain error exit = %d, want 1", got)
	}
	if got := exitCodeFor(&ExitCodeError{Code: 78}); got != 78 {
		t.Fatalf("ExitCodeError exit = %d, want 78", got)
	}
	if got := exitCodeFor(fmt.Errorf("wrapped: %w", &ExitCodeError{Code: 78})); got != 78 {
		t.Fatalf("wrapped ExitCodeError exit = %d, want 78", got)
	}
	if got := exitCodeFor(&ExitCodeError{Code: 0}); got != 1 {
		t.Fatalf("ExitCodeError{0} must not exit 0 on an error path, got %d", got)
	}
}

// The cobra main must hand ExitCodeError's code to the process; an
// unconditional os.Exit(1) would make --strict-watchdog's 78 unreachable.
func TestMainMapsExitCodeError(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), "os.Exit(exitCodeFor(err))") {
		t.Fatal("main.go: rootCmd.Execute error path must call os.Exit(exitCodeFor(err))")
	}
}

// The three per-OS install commands are build-tagged; check their source so a
// missing flag registration on one OS is caught on every CI runner.
func TestStrictWatchdogFlagRegisteredOnEveryOS(t *testing.T) {
	for _, file := range []string{"service_cmd_linux.go", "service_cmd_darwin.go", "service_cmd_windows.go"} {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		s := string(src)
		if !strings.Contains(s, `BoolVar(&strictWatchdog, "strict-watchdog"`) {
			t.Errorf("%s: --strict-watchdog is not registered on serviceInstallCmd", file)
		}
		if !strings.Contains(s, "reportWatchdogBootstrap(") {
			t.Errorf("%s: the watchdog bootstrap outcome is not passed through reportWatchdogBootstrap", file)
		}
		if !strings.Contains(s, "serviceInstallCmd.SilenceUsage = true") {
			t.Errorf("%s: an exit-78 from a scripted install must not dump usage text", file)
		}
	}
}
