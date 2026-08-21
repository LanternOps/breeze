package tools

import (
	"fmt"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/collectors"
)

// fakeUninstallEnv swaps every seam runUninstallAttempts uses and restores them
// on cleanup. `available` is the set of commands exec.LookPath should find;
// `responses` maps a command name to the output/error one run produces.
type fakeUninstallEnv struct {
	available map[string]bool
	responses map[string]struct {
		output string
		err    error
	}
	ran []string
}

func (f *fakeUninstallEnv) install(t *testing.T, stillPresent bool, verifyErr error) {
	t.Helper()

	origLookPath := uninstallLookPath
	origRun := runUninstallCommand
	origVerify := uninstallVerifyStillPresent
	t.Cleanup(func() {
		uninstallLookPath = origLookPath
		runUninstallCommand = origRun
		uninstallVerifyStillPresent = origVerify
	})

	uninstallLookPath = func(cmd string) (string, error) {
		if f.available[cmd] {
			return "/usr/bin/" + cmd, nil
		}
		return "", fmt.Errorf("not found")
	}
	runUninstallCommand = func(attempt uninstallAttempt) ([]byte, error) {
		f.ran = append(f.ran, attempt.command)
		resp := f.responses[attempt.command]
		return []byte(resp.output), resp.err
	}
	uninstallVerifyStillPresent = func(string) (bool, error) {
		return stillPresent, verifyErr
	}
}

// The #3592 regression. winget is the first Windows attempt and answers
// "No installed package found matching input criteria." for anything it does not
// index — which under the SYSTEM service account is a great deal of real
// software. Before the fix that message short-circuited the whole operation as
// success, so Breeze reported {"action":"uninstall","success":true} exit 0
// without ever running the wmic fallback and without touching the machine.
func TestRunUninstallAttemptsWingetNotFoundDoesNotShortCircuitSuccess(t *testing.T) {
	env := &fakeUninstallEnv{
		available: map[string]bool{"winget": true, "wmic": true},
		responses: map[string]struct {
			output string
			err    error
		}{
			"winget": {output: "No installed package found matching input criteria.", err: fmt.Errorf("exit status 1")},
			"wmic":   {output: "No Instance(s) Available.", err: nil}, // wmic exits 0 on no match — bug #2
		},
	}
	env.install(t, true, nil)

	err := runUninstallAttempts("Microsoft Teams Meeting Add-in for Microsoft Office", []uninstallAttempt{
		{command: "winget"},
		{command: "wmic"},
	})

	if err == nil {
		t.Fatal("expected an error: the software is still installed, but the uninstall reported success")
	}
	if !strings.Contains(err.Error(), "still present") {
		t.Fatalf("error should name the failed post-condition, got: %v", err)
	}
	// A provider that cannot see the package must fall through, not end the run.
	if len(env.ran) != 2 {
		t.Fatalf("expected both providers to be attempted, got %v", env.ran)
	}
}

// A provider that "not found"s while the software really is gone is the
// legitimate idempotent re-run, and must still succeed.
func TestRunUninstallAttemptsNotFoundSucceedsWhenVerifiedAbsent(t *testing.T) {
	env := &fakeUninstallEnv{
		available: map[string]bool{"winget": true, "wmic": true},
		responses: map[string]struct {
			output string
			err    error
		}{
			"winget": {output: "No installed package found matching input criteria.", err: fmt.Errorf("exit status 1")},
			"wmic":   {output: "No Instance(s) Available.", err: nil}, // wmic exits 0 on no match — bug #2
		},
	}
	env.install(t, false, nil)

	if err := runUninstallAttempts("Already Gone", []uninstallAttempt{
		{command: "winget"},
		{command: "wmic"},
	}); err != nil {
		t.Fatalf("expected success when the software is verified absent, got: %v", err)
	}
}

// `wmic product where name='X' call uninstall` exits 0 even when the WHERE
// clause matches nothing, so an exit-0 provider is not evidence of removal.
func TestRunUninstallAttemptsExitZeroStillFailsWhenSoftwareRemains(t *testing.T) {
	env := &fakeUninstallEnv{
		available: map[string]bool{"wmic": true},
		responses: map[string]struct {
			output string
			err    error
		}{
			"wmic": {output: "No Instance(s) Available.", err: nil},
		},
	}
	env.install(t, true, nil)

	err := runUninstallAttempts("Some App", []uninstallAttempt{{command: "wmic"}})
	if err == nil {
		t.Fatal("exit code 0 from wmic must not be accepted as proof of removal")
	}
	// Exit 0 + a no-match message is classified as "this provider cannot see
	// it", not as a removal claim.
	if !strings.Contains(err.Error(), "could locate") {
		t.Fatalf("wmic's exit-0 no-match must not read as a removal claim, got: %v", err)
	}
}

// The counterpart: a genuine exit-0 removal that verification contradicts.
func TestRunUninstallAttemptsClaimedRemovalStillFailsWhenSoftwareRemains(t *testing.T) {
	env := &fakeUninstallEnv{
		available: map[string]bool{"winget": true},
		responses: map[string]struct {
			output string
			err    error
		}{
			"winget": {output: "Successfully uninstalled", err: nil},
		},
	}
	env.install(t, true, nil)

	err := runUninstallAttempts("Some App", []uninstallAttempt{{command: "winget"}})
	if err == nil {
		t.Fatal("a provider claiming success must not override a verified-still-present result")
	}
	if !strings.Contains(err.Error(), "reported success") {
		t.Fatalf("error should distinguish the lying-provider case, got: %v", err)
	}
}

// wmic's exit-0 no-match must not be the one signal still trusted when
// verification is unavailable — that was the remaining route back to a silent
// success.
func TestRunUninstallAttemptsWmicExitZeroPlusUnverifiableIsAFailure(t *testing.T) {
	env := &fakeUninstallEnv{
		available: map[string]bool{"wmic": true},
		responses: map[string]struct {
			output string
			err    error
		}{
			"wmic": {output: "No Instance(s) Available.", err: nil},
		},
	}
	env.install(t, false, fmt.Errorf("registry unreadable"))

	if err := runUninstallAttempts("Some App", []uninstallAttempt{{command: "wmic"}}); err == nil {
		t.Fatal("wmic exit-0 no-match with verification unavailable must not report success")
	}
}

func TestRunUninstallAttemptsExitZeroSucceedsWhenVerifiedAbsent(t *testing.T) {
	env := &fakeUninstallEnv{
		available: map[string]bool{"winget": true, "wmic": true},
		responses: map[string]struct {
			output string
			err    error
		}{
			"winget": {output: "Successfully uninstalled", err: nil},
		},
	}
	env.install(t, false, nil)

	if err := runUninstallAttempts("Some App", []uninstallAttempt{
		{command: "winget"},
		{command: "wmic"},
	}); err != nil {
		t.Fatalf("expected success, got: %v", err)
	}
	// A provider that genuinely removed the software ends the run — no point
	// asking the next one to uninstall something that is already gone.
	if len(env.ran) != 1 {
		t.Fatalf("expected the run to stop after the successful provider, got %v", env.ran)
	}
}

// "Cannot verify" is not "verified gone" and is not "verified present" — it
// falls back to the provider signals rather than inventing a verdict.
func TestRunUninstallAttemptsFallsBackWhenVerificationUnavailable(t *testing.T) {
	env := &fakeUninstallEnv{
		available: map[string]bool{"winget": true},
		responses: map[string]struct {
			output string
			err    error
		}{
			"winget": {output: "Successfully uninstalled", err: nil},
		},
	}
	env.install(t, false, fmt.Errorf("collector unavailable"))

	if err := runUninstallAttempts("Some App", []uninstallAttempt{{command: "winget"}}); err != nil {
		t.Fatalf("a provider success with verification unavailable should still succeed, got: %v", err)
	}
}

func TestRunUninstallAttemptsFallsBackToErrorWhenVerificationUnavailable(t *testing.T) {
	env := &fakeUninstallEnv{
		available: map[string]bool{"winget": true},
		responses: map[string]struct {
			output string
			err    error
		}{
			"winget": {output: "access is denied", err: fmt.Errorf("exit status 5")},
		},
	}
	env.install(t, false, fmt.Errorf("collector unavailable"))

	if err := runUninstallAttempts("Some App", []uninstallAttempt{{command: "winget"}}); err == nil {
		t.Fatal("a hard provider failure with verification unavailable must remain a failure")
	}
}

// Verification must not upgrade a hard provider failure into a success. The
// uninstall name does not always appear verbatim in the collector's output (a
// brew cask token is "google-chrome" while system_profiler reports
// "Google Chrome"), so "absent" can mean "the collector cannot see this name" —
// which would otherwise swallow a genuine apt/brew/msiexec error.
func TestRunUninstallAttemptsHardErrorSurvivesVerifiedAbsent(t *testing.T) {
	env := &fakeUninstallEnv{
		available: map[string]bool{"brew": true},
		responses: map[string]struct {
			output string
			err    error
		}{
			"brew": {output: "Error: Permission denied @ rb_sysopen", err: fmt.Errorf("exit status 1")},
		},
	}
	env.install(t, false, nil)

	err := runUninstallAttempts("google-chrome", []uninstallAttempt{{command: "brew"}})
	if err == nil {
		t.Fatal("a hard provider error must remain a failure even when verification cannot see the name")
	}
	if !strings.Contains(err.Error(), "Permission denied") {
		t.Fatalf("error should carry the provider's failure detail, got: %v", err)
	}
}

// "Every provider says it does not know this package" is not evidence of
// removal. If verification is also unavailable, there is nothing left to stand
// on and the operation must fail loudly rather than resurrect the #3592 silent
// success behind a transient collector failure.
func TestRunUninstallAttemptsNotFoundPlusUnverifiableIsAFailure(t *testing.T) {
	env := &fakeUninstallEnv{
		available: map[string]bool{"brew": true},
		responses: map[string]struct {
			output string
			err    error
		}{
			"brew": {output: "Error: Cask 'foo' is not installed.", err: fmt.Errorf("exit status 1")},
		},
	}
	env.install(t, false, fmt.Errorf("system_profiler timed out"))

	err := runUninstallAttempts("foo", []uninstallAttempt{{command: "brew"}})
	if err == nil {
		t.Fatal("not-found-only with verification unavailable must not report success")
	}
	if !strings.Contains(err.Error(), "could not confirm") {
		t.Fatalf("error should name the unverifiable post-condition, got: %v", err)
	}
}

func TestRunUninstallAttemptsNoProviderAvailable(t *testing.T) {
	env := &fakeUninstallEnv{available: map[string]bool{}}
	env.install(t, false, nil)

	err := runUninstallAttempts("Some App", []uninstallAttempt{{command: "winget"}})
	if err == nil || !strings.Contains(err.Error(), "no supported uninstall command") {
		t.Fatalf("expected the no-provider error, got: %v", err)
	}
}

func TestSoftwareStillInstalledMatchesExactNameOnly(t *testing.T) {
	orig := softwareInventoryFn
	t.Cleanup(func() { softwareInventoryFn = orig })

	softwareInventoryFn = func() ([]collectors.SoftwareItem, error) {
		return []collectors.SoftwareItem{
			{Name: "Microsoft Teams Meeting Add-in for Microsoft Office"},
			{Name: "Google Chrome"},
		}, nil
	}

	cases := []struct {
		name string
		want bool
	}{
		{"Microsoft Teams Meeting Add-in for Microsoft Office", true},
		{"  microsoft teams meeting add-in for microsoft office  ", true},
		// Substring matching would wrongly report Teams as still installed
		// because the add-in remains.
		{"Microsoft Teams", false},
		{"Chrome", false},
		{"Google Chrome", true},
		{"", false},
	}
	for _, tc := range cases {
		got, err := softwareStillInstalled(tc.name)
		if err != nil {
			t.Fatalf("%q: unexpected error %v", tc.name, err)
		}
		if got != tc.want {
			t.Errorf("softwareStillInstalled(%q) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// macOS uninstall targets arrive with or without the .app suffix while
// system_profiler reports the bare name.
func TestSoftwareStillInstalledNormalizesDotApp(t *testing.T) {
	orig := softwareInventoryFn
	t.Cleanup(func() { softwareInventoryFn = orig })

	softwareInventoryFn = func() ([]collectors.SoftwareItem, error) {
		return []collectors.SoftwareItem{{Name: "Slack"}}, nil
	}

	got, err := softwareStillInstalled("Slack.app")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got {
		t.Error(`softwareStillInstalled("Slack.app") = false, want true`)
	}
}

// An empty inventory means the enumeration did not work, not that the endpoint
// has no software. It must read as "cannot verify", not "verified absent".
func TestSoftwareStillInstalledTreatsEmptyInventoryAsUnverifiable(t *testing.T) {
	orig := softwareInventoryFn
	t.Cleanup(func() { softwareInventoryFn = orig })

	softwareInventoryFn = func() ([]collectors.SoftwareItem, error) {
		return []collectors.SoftwareItem{}, nil
	}

	if _, err := softwareStillInstalled("Anything"); err == nil {
		t.Fatal("an empty inventory must not be reported as verified-absent")
	}
}

// A collector failure must surface as an error, never be flattened to
// "not installed" — that would resurrect the silent-success bug through the
// verification path itself.
func TestSoftwareStillInstalledPropagatesCollectorError(t *testing.T) {
	orig := softwareInventoryFn
	t.Cleanup(func() { softwareInventoryFn = orig })

	softwareInventoryFn = func() ([]collectors.SoftwareItem, error) {
		return nil, fmt.Errorf("registry unavailable")
	}

	if _, err := softwareStillInstalled("Anything"); err == nil {
		t.Fatal("expected the collector error to propagate")
	}
}
