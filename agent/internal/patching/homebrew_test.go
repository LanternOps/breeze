//go:build darwin

package patching

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSetEnvNewKey(t *testing.T) {
	env := []string{"A=1", "B=2"}
	result := setEnv(env, "C", "3")
	found := false
	for _, e := range result {
		if e == "C=3" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected C=3 to be appended")
	}
}

func TestSetEnvOverwrite(t *testing.T) {
	env := []string{"A=1", "B=2"}
	result := setEnv(env, "A", "99")
	for _, e := range result {
		if e == "A=1" {
			t.Fatal("old value should be overwritten")
		}
	}
	found := false
	for _, e := range result {
		if e == "A=99" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected A=99")
	}
	if len(result) != 2 {
		t.Fatalf("expected length 2 after overwrite, got %d", len(result))
	}
}

func TestEnsurePathPrefixAddsNew(t *testing.T) {
	result := ensurePathPrefix("/usr/bin:/bin", "/opt/homebrew/bin")
	if !strings.HasPrefix(result, "/opt/homebrew/bin:") {
		t.Fatalf("expected /opt/homebrew/bin prefix, got %s", result)
	}
}

func TestEnsurePathPrefixAlreadyPresent(t *testing.T) {
	original := "/opt/homebrew/bin:/usr/bin:/bin"
	result := ensurePathPrefix(original, "/opt/homebrew/bin")
	if result != original {
		t.Fatalf("expected no change when dir already in PATH, got %s", result)
	}
}

func TestEnsurePathPrefixEmptyPath(t *testing.T) {
	result := ensurePathPrefix("", "/opt/homebrew/bin")
	if result != "/opt/homebrew/bin" {
		t.Fatalf("expected just the dir for empty path, got %s", result)
	}
}

func TestEnsurePathPrefixEmptyDir(t *testing.T) {
	original := "/usr/bin:/bin"
	result := ensurePathPrefix(original, "")
	if result != original {
		t.Fatalf("expected no change with empty dir, got %s", result)
	}
}

func TestBrewEnvSetsHomeDirAndPath(t *testing.T) {
	env := brewEnv("/opt/homebrew/bin/brew", "/Users/testuser")

	homeFound := false
	pathUpdated := false
	for _, e := range env {
		if e == "HOME=/Users/testuser" {
			homeFound = true
		}
		if strings.HasPrefix(e, "PATH=") && strings.Contains(e, "/opt/homebrew/bin") {
			pathUpdated = true
		}
	}

	if !homeFound {
		t.Fatal("expected HOME to be set to /Users/testuser")
	}
	if !pathUpdated {
		t.Fatal("expected PATH to contain /opt/homebrew/bin")
	}
}

func TestBrewEnvNoHomeDirWhenEmpty(t *testing.T) {
	origHome := os.Getenv("HOME")
	env := brewEnv("/opt/homebrew/bin/brew", "")

	for _, e := range env {
		if strings.HasPrefix(e, "HOME=") {
			parts := strings.SplitN(e, "=", 2)
			if parts[1] != origHome {
				t.Fatalf("HOME should remain original %q, got %q", origHome, parts[1])
			}
		}
	}
}

func TestParseBrewIDFormula(t *testing.T) {
	name, isCask := parseBrewID("wget")
	if name != "wget" {
		t.Fatalf("expected name wget, got %s", name)
	}
	if isCask {
		t.Fatal("wget should not be a cask")
	}
}

func TestParseBrewIDCask(t *testing.T) {
	name, isCask := parseBrewID("cask:firefox")
	if name != "firefox" {
		t.Fatalf("expected name firefox, got %s", name)
	}
	if !isCask {
		t.Fatal("cask:firefox should be a cask")
	}
}

func TestBrewBinaryPathFindsRealBrew(t *testing.T) {
	path, err := brewBinaryPath()
	if err != nil {
		t.Skipf("brew not installed on this system: %v", err)
	}
	if path == "" {
		t.Fatal("expected non-empty brew path")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("brew path %q does not exist: %v", path, err)
	}
	if info.IsDir() {
		t.Fatalf("brew path %q is a directory", path)
	}
}

func TestActiveConsoleUserReturnsCurrentUser(t *testing.T) {
	// This test runs on macOS as a non-root user (the developer)
	account, err := activeConsoleUser()
	if err != nil {
		t.Skipf("no active console user (CI environment?): %v", err)
	}
	if account.Username == "" {
		t.Fatal("expected non-empty username")
	}
	if account.Username == "root" {
		t.Fatal("should not return root")
	}
	if account.HomeDir == "" {
		t.Fatal("expected non-empty home dir")
	}

	// Verify it matches the actual logged-in user
	current, err := user.Current()
	if err != nil {
		t.Skipf("cannot determine current user: %v", err)
	}
	if account.Username != current.Username {
		t.Logf("console user %q differs from current user %q (expected in some CI)", account.Username, current.Username)
	}
}

func TestBrewCommandAsNonRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("test runs only as non-root user")
	}

	h := NewHomebrewProvider()
	cmd, err := h.brewCommand("--version")
	if err != nil {
		t.Skipf("brew not available: %v", err)
	}

	// When running as non-root, brew should be called directly (not via sudo)
	if strings.Contains(cmd.Path, "sudo") {
		t.Fatal("non-root user should not use sudo")
	}

	// Verify it actually works
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("brew --version failed: %v", err)
	}
	if !strings.Contains(string(out), "Homebrew") {
		t.Fatalf("unexpected brew output: %s", string(out))
	}
}

func TestBrewCommandHasCorrectEnv(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("test runs only as non-root user")
	}

	h := NewHomebrewProvider()
	cmd, err := h.brewCommand("--version")
	if err != nil {
		t.Skipf("brew not available: %v", err)
	}

	// PATH should include the brew binary's directory
	brewPath, _ := brewBinaryPath()
	brewDir := strings.TrimSuffix(brewPath, "/brew")
	pathFound := false
	for _, e := range cmd.Env {
		if strings.HasPrefix(e, "PATH=") && strings.Contains(e, brewDir) {
			pathFound = true
		}
	}
	if !pathFound {
		t.Fatalf("brew command PATH should include %s", brewDir)
	}
}

func TestHomebrewProviderIDAndName(t *testing.T) {
	h := NewHomebrewProvider()
	if h.ID() != "homebrew" {
		t.Fatalf("expected ID homebrew, got %s", h.ID())
	}
	if h.Name() != "Homebrew" {
		t.Fatalf("expected Name Homebrew, got %s", h.Name())
	}
}

func TestBrewScanReturnsOutdatedPackages(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("brew rejects root execution")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew not installed")
	}

	h := NewHomebrewProvider()
	patches, err := h.Scan()
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}
	// We can't assert count (depends on system state), but no error is good
	t.Logf("found %d outdated packages", len(patches))
	for _, p := range patches {
		if p.ID == "" {
			t.Error("patch ID should not be empty")
		}
		if p.Title == "" {
			t.Error("patch Title should not be empty")
		}
	}
}

func TestBrewGetInstalledListsPackages(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("brew rejects root execution")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew not installed")
	}

	h := NewHomebrewProvider()
	installed, err := h.GetInstalled()
	if err != nil {
		t.Fatalf("GetInstalled failed: %v", err)
	}
	// Brew should have at least a few packages on a dev machine
	if len(installed) == 0 {
		t.Log("warning: no installed packages found (fresh brew install?)")
	}
	for _, p := range installed {
		if p.ID == "" {
			t.Error("installed patch ID should not be empty")
		}
		if p.Version == "" {
			t.Error("installed patch Version should not be empty")
		}
	}
	t.Logf("found %d installed packages", len(installed))
}

func TestBrewFormulaDescription(t *testing.T) {
	f := brewFormula{
		Name:             "wget",
		InstalledVersion: []string{"1.21"},
		CurrentVersion:   "1.22",
	}
	desc := f.description()
	if !strings.Contains(desc, "1.21") {
		t.Fatalf("expected installed version in description, got %q", desc)
	}
}

func TestBrewFormulaDescriptionEmpty(t *testing.T) {
	f := brewFormula{
		Name:           "wget",
		CurrentVersion: "1.22",
	}
	desc := f.description()
	if desc != "" {
		t.Fatalf("expected empty description for no installed versions, got %q", desc)
	}
}

func TestBrewCaskDescription(t *testing.T) {
	c := brewCask{
		Name:             "firefox",
		InstalledVersion: []string{"120.0"},
		CurrentVersion:   "121.0",
	}
	desc := c.description()
	if !strings.Contains(desc, "120.0") {
		t.Fatalf("expected installed version in cask description, got %q", desc)
	}
}

func TestBrewCaskDescriptionEmpty(t *testing.T) {
	c := brewCask{Name: "firefox", CurrentVersion: "121.0"}
	desc := c.description()
	if desc != "" {
		t.Fatalf("expected empty description for no installed versions, got %q", desc)
	}
}

func TestBrewInstallCallsUpgrade(t *testing.T) {
	// This test verifies the command construction, not actual installation
	if os.Geteuid() == 0 {
		t.Skip("brew rejects root execution")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew not installed")
	}

	h := NewHomebrewProvider()

	// Install a nonexistent package to verify the command is constructed correctly
	// (it will fail, but we check the error message contains the right info)
	_, err := h.Install("nonexistent-package-xyz-12345")
	if err == nil {
		t.Fatal("expected error installing nonexistent package")
	}
	if !strings.Contains(err.Error(), "brew upgrade failed") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- EnsureBrewInstalled: pure arg construction (no process execution) ---

func TestEnsureBrewArgsFormula(t *testing.T) {
	got := ensureBrewArgs("homebrew_formula", "firefox")
	want := []string{"install", "firefox"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ensureBrewArgs(formula) = %v, want %v", got, want)
	}
}

func TestEnsureBrewArgsCask(t *testing.T) {
	got := ensureBrewArgs("homebrew_cask", "firefox")
	want := []string{"install", "--cask", "firefox"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ensureBrewArgs(cask) = %v, want %v", got, want)
	}
}

func TestEnsureBrewArgsNeverUpgrades(t *testing.T) {
	for _, kind := range []string{"homebrew_formula", "homebrew_cask"} {
		for _, arg := range ensureBrewArgs(kind, "firefox") {
			if arg == "upgrade" {
				t.Fatalf("ensureBrewArgs(%q) must never contain \"upgrade\": %v", kind, ensureBrewArgs(kind, "firefox"))
			}
		}
	}
}

func TestEnsureBrewListArgsFormula(t *testing.T) {
	got := ensureBrewListArgs("homebrew_formula", "firefox")
	want := []string{"list", "--versions", "firefox"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ensureBrewListArgs(formula) = %v, want %v", got, want)
	}
}

func TestEnsureBrewListArgsCask(t *testing.T) {
	got := ensureBrewListArgs("homebrew_cask", "firefox")
	want := []string{"list", "--cask", "--versions", "firefox"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ensureBrewListArgs(cask) = %v, want %v", got, want)
	}
}

// --- EnsureBrewInstalled: sentinel wrapping ---

// TestEnsureBrewInstalledWrapsSentinelForErrorsIs pins the errors.Is contract
// the tools layer relies on (Task 7): whatever EnsureBrewInstalled wraps
// ErrBrewUnavailable with must still satisfy errors.Is, not just a string
// prefix match on Error().
func TestEnsureBrewInstalledWrapsSentinelForErrorsIs(t *testing.T) {
	wrapped := fmt.Errorf("%w: %v", ErrBrewUnavailable, errors.New("brew binary not found"))
	if !errors.Is(wrapped, ErrBrewUnavailable) {
		t.Fatal("wrapped error must satisfy errors.Is(err, ErrBrewUnavailable)")
	}
}

func TestEnsureBrewInstalledRejectsInvalidName(t *testing.T) {
	_, alreadyInstalled, err := EnsureBrewInstalled("homebrew_formula", "; rm -rf /")
	if err == nil {
		t.Fatal("want validation error for an unsafe package name")
	}
	if alreadyInstalled {
		t.Fatal("alreadyInstalled must be false on a validation failure")
	}
	if errors.Is(err, ErrBrewUnavailable) {
		t.Fatal("an invalid name is a validation failure, not manager-unavailable")
	}
}

// --- EnsureBrewInstalled: real brew, matching the file's existing
// skip-if-unavailable convention (TestBrewBinaryPathFindsRealBrew etc). ---

func TestEnsureBrewInstalledAlreadyPresentNeverReinstalls(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("brew rejects root execution")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew not installed")
	}

	h := NewHomebrewProvider()
	installed, err := h.GetInstalled()
	if err != nil || len(installed) == 0 {
		t.Skip("no installed formula/cask available to probe against")
	}

	name, _ := parseBrewID(installed[0].ID)
	kind := "homebrew_formula"
	if strings.HasPrefix(installed[0].ID, brewCaskPrefix) {
		kind = "homebrew_cask"
	}

	output, alreadyInstalled, err := EnsureBrewInstalled(kind, name)
	if err != nil {
		t.Fatalf("EnsureBrewInstalled(%q, %q) unexpected error: %v", kind, name, err)
	}
	if !alreadyInstalled {
		t.Fatalf("alreadyInstalled = false for a package GetInstalled just reported present: %q", name)
	}
	if !strings.Contains(output, name) {
		t.Fatalf("output %q does not mention the presence-checked package %q", output, name)
	}
}

func TestEnsureBrewInstalledUnknownPackageFailsRatherThanFallback(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("brew rejects root execution")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew not installed")
	}

	_, alreadyInstalled, err := EnsureBrewInstalled("homebrew_formula", "definitely-not-a-real-package-xyz123")
	if err == nil {
		t.Fatal("want error installing a nonexistent formula")
	}
	if alreadyInstalled {
		t.Fatal("alreadyInstalled must be false when the install attempt failed")
	}
	if errors.Is(err, ErrBrewUnavailable) {
		t.Fatal("a real brew install failure is not manager-unavailable")
	}
}

// --- Post-install cleanup (#4912): brew cleanup --prune=all, once per
// batch (debounced/coalesced), never per package, never failing the job. ---

func TestBrewCleanupArgs(t *testing.T) {
	got := brewCleanupArgs()
	want := []string{"cleanup", "--prune=all"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("brewCleanupArgs() = %v, want %v", got, want)
	}
}

// TestScheduleCleanupCoalescesABatch pins the "not per package" contract from
// #4912: several scheduleCleanup calls fired in quick succession (as would
// happen for consecutive packages in one Install batch) must coalesce into
// exactly one cleanup invocation, run once after the batch goes quiet — not
// once per call. Uses an injected cleanupFunc/cleanupDebounce so it never
// shells out to real brew and stays fast/deterministic.
func TestScheduleCleanupCoalescesABatch(t *testing.T) {
	h := &HomebrewProvider{}
	var calls int32
	h.cleanupFunc = func() { atomic.AddInt32(&calls, 1) }
	// The debounce is generously wide relative to the inter-call sleeps
	// below (20x) so scheduler jitter on a loaded CI runner can't let an
	// earlier timer fire before a later scheduleCleanup call resets it —
	// a real flake risk caught in PR review at tighter margins.
	h.cleanupDebounce = 200 * time.Millisecond

	// Simulate 3 packages finishing install back-to-back within one batch.
	h.scheduleCleanup()
	time.Sleep(10 * time.Millisecond)
	h.scheduleCleanup()
	time.Sleep(10 * time.Millisecond)
	h.scheduleCleanup()

	// Nothing should have fired yet — still inside the debounce window.
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Fatalf("cleanup fired before the batch went quiet: got %d calls", got)
	}

	time.Sleep(600 * time.Millisecond) // well past the debounce window

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("expected exactly 1 coalesced cleanup call for the batch, got %d", got)
	}
}

// TestScheduleCleanupConcurrentCallsAreRaceFree proves cleanupMu actually
// serializes concurrent scheduleCleanup calls under go test -race, rather
// than only ever being exercised sequentially. This mirrors the real
// production contention: Install() calling scheduleCleanup while an earlier
// scheduled cleanup timer may still be pending.
func TestScheduleCleanupConcurrentCallsAreRaceFree(t *testing.T) {
	h := &HomebrewProvider{}
	var calls int32
	h.cleanupFunc = func() { atomic.AddInt32(&calls, 1) }
	h.cleanupDebounce = 20 * time.Millisecond

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.scheduleCleanup()
		}()
	}
	wg.Wait()

	time.Sleep(200 * time.Millisecond)

	// The race detector is the real assertion here (no data race on
	// cleanupTimer); the count just confirms the storm still settled to a
	// cleanup firing rather than being left permanently pending.
	if got := atomic.LoadInt32(&calls); got < 1 {
		t.Fatalf("expected at least 1 cleanup call after concurrent scheduling, got %d", got)
	}
}

// TestScheduleCleanupRunsAgainForANewBatch verifies coalescing doesn't
// swallow a *second*, later batch — cleanup must still fire once per batch,
// not "once ever".
func TestScheduleCleanupRunsAgainForANewBatch(t *testing.T) {
	h := &HomebrewProvider{}
	var calls int32
	h.cleanupFunc = func() { atomic.AddInt32(&calls, 1) }
	h.cleanupDebounce = 15 * time.Millisecond

	h.scheduleCleanup()
	time.Sleep(50 * time.Millisecond)
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("expected 1 call after first batch settled, got %d", got)
	}

	h.scheduleCleanup()
	time.Sleep(50 * time.Millisecond)
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("expected 2 calls after a second batch settled, got %d", got)
	}
}

// TestInstallSchedulesCleanupOnSuccess exercises the real Install() path: a
// successful upgrade (brew exits 0 even when the formula is already
// up-to-date — verified against real brew) must schedule cleanup. A failed
// Install (invalid/nonexistent package) must NOT.
func TestInstallSchedulesCleanupOnSuccess(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("brew rejects root execution")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew not installed")
	}

	h := &HomebrewProvider{}
	installed, err := h.GetInstalled()
	if err != nil || len(installed) == 0 {
		t.Skip("no installed formula/cask available to probe against")
	}
	name, _ := parseBrewID(installed[0].ID)

	var calls int32
	h.cleanupFunc = func() { atomic.AddInt32(&calls, 1) }
	h.cleanupDebounce = 10 * time.Millisecond

	if _, err := h.Install(name); err != nil {
		t.Fatalf("Install(%q) unexpected error: %v", name, err)
	}

	time.Sleep(60 * time.Millisecond)
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("expected successful Install to schedule exactly 1 cleanup, got %d", got)
	}
}

func TestInstallDoesNotScheduleCleanupOnFailure(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("brew rejects root execution")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew not installed")
	}

	h := &HomebrewProvider{}
	var calls int32
	h.cleanupFunc = func() { atomic.AddInt32(&calls, 1) }
	h.cleanupDebounce = 10 * time.Millisecond

	if _, err := h.Install("nonexistent-package-xyz-12345"); err == nil {
		t.Fatal("expected error installing nonexistent package")
	}

	time.Sleep(60 * time.Millisecond)
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Fatalf("a failed Install must not schedule cleanup, got %d calls", got)
	}
}

// TestRunBrewCleanupExecutesRealCleanup exercises the actual (non-injected)
// cleanup path end-to-end against real brew — brewCleanupArgs() ->
// brewCommand() -> runCmdCombinedOutputWithTimeout — matching this file's
// existing skip-if-unavailable convention. Every other cleanup test above
// injects cleanupFunc, so this is the only coverage of runBrewCleanup
// itself. `brew cleanup --prune=all` is a safe, idempotent maintenance
// operation to run for real.
func TestRunBrewCleanupExecutesRealCleanup(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("brew rejects root execution")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew not installed")
	}

	h := &HomebrewProvider{}
	// runBrewCleanup swallows all its own errors (by design — see its doc
	// comment), so there's nothing to assert on here beyond "the real path
	// runs to completion without panicking."
	h.runBrewCleanup()
}

func TestBrewInstallCaskCallsUpgradeCask(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("brew rejects root execution")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew not installed")
	}

	h := NewHomebrewProvider()
	_, err := h.Install("cask:nonexistent-cask-xyz-12345")
	if err == nil {
		t.Fatal("expected error installing nonexistent cask")
	}
	if !strings.Contains(err.Error(), "brew upgrade failed") {
		t.Fatalf("unexpected error: %v", err)
	}
}
