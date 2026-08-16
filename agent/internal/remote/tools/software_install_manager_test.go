package tools

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/patching"
)

// fakeManagerRunner records every invocation and dispatches canned responses
// keyed by the winget verb (args[0]: "list" or "install"), so table cases can
// script both the IsInstalled probe and the install exec independently.
type fakeManagerRunner struct {
	t         *testing.T
	responses map[string]fakeManagerResponse
	calls     [][]string
}

type fakeManagerResponse struct {
	stdout string
	stderr string
	code   int
	err    error
}

func (f *fakeManagerRunner) run(name string, args []string, _ time.Duration) (string, string, int, error) {
	f.calls = append(f.calls, append([]string{}, args...))
	verb := ""
	if len(args) > 0 {
		verb = args[0]
	}
	resp, ok := f.responses[verb]
	if !ok {
		f.t.Fatalf("unexpected exec for verb %q (args=%v)", verb, args)
	}
	return resp.stdout, resp.stderr, resp.code, resp.err
}

func (f *fakeManagerRunner) installCalls() [][]string {
	var out [][]string
	for _, c := range f.calls {
		if len(c) > 0 && c[0] == "install" {
			out = append(out, c)
		}
	}
	return out
}

func (f *fakeManagerRunner) listCalls() [][]string {
	var out [][]string
	for _, c := range f.calls {
		if len(c) > 0 && c[0] == "list" {
			out = append(out, c)
		}
	}
	return out
}

func testManagerDeps(t *testing.T, responses map[string]fakeManagerResponse, locateErr error) (managerDeps, *fakeManagerRunner) {
	t.Helper()
	runner := &fakeManagerRunner{t: t, responses: responses}
	locate := func() (string, string, error) {
		if locateErr != nil {
			return "", "", locateErr
		}
		return `C:\wg\winget.exe`, "1.0", nil
	}
	return managerDeps{
		goos:         "windows",
		locateWinget: locate,
		run:          patching.CmdRunner(runner.run),
		brewEnsure: func(kind, name, softwareName string) (string, bool, error) {
			return "", false, fmt.Errorf("manager_unavailable: brewEnsure not wired in this test")
		},
	}, runner
}

func mustDecodeSuccess(t *testing.T, res CommandResult) map[string]any {
	t.Helper()
	if res.Status != "completed" {
		t.Fatalf("status = %q, want completed (error=%q)", res.Status, res.Error)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(res.Stdout), &m); err != nil {
		t.Fatalf("decode stdout: %v (stdout=%q)", err, res.Stdout)
	}
	return m
}

func TestInstallViaManagerWingetAlreadyInstalled(t *testing.T) {
	deps, runner := testManagerDeps(t, map[string]fakeManagerResponse{
		"list": {stdout: "Name  Id             Version\nChrome Google.Chrome 1.0\n", code: 0},
	}, nil)

	payload := map[string]any{
		"installMethod": map[string]any{"kind": "winget", "packageId": "Google.Chrome"},
		"versionMode":   "latest",
		"softwareName":  "Chrome",
	}

	res := installViaManager(payload, deps)
	m := mustDecodeSuccess(t, res)
	if m["alreadyInstalled"] != true {
		t.Fatalf("alreadyInstalled = %v, want true (payload=%v)", m["alreadyInstalled"], m)
	}
	if len(runner.installCalls()) != 0 {
		t.Fatalf("install must not exec when already installed, got calls=%v", runner.installCalls())
	}
}

func TestInstallViaManagerWingetInstallsAbsentPackage(t *testing.T) {
	deps, runner := testManagerDeps(t, map[string]fakeManagerResponse{
		"list":    {stdout: "No installed package found matching input criteria.\n", code: 1},
		"install": {stdout: "Successfully installed", code: 0},
	}, nil)

	payload := map[string]any{
		"installMethod": map[string]any{"kind": "winget", "packageId": "Google.Chrome"},
		"versionMode":   "latest",
		"softwareName":  "Chrome",
	}

	res := installViaManager(payload, deps)
	mustDecodeSuccess(t, res)

	calls := runner.installCalls()
	if len(calls) != 1 {
		t.Fatalf("want exactly one install exec, got %d: %v", len(calls), calls)
	}
	want := []string{
		"install", "--exact", "--id", "Google.Chrome", "--scope", "machine", "--silent",
		"--accept-package-agreements", "--accept-source-agreements", "--source", "winget", "--disable-interactivity",
	}
	if !reflect.DeepEqual(calls[0], want) {
		t.Fatalf("install args = %v, want %v", calls[0], want)
	}
}

func TestInstallViaManagerWingetExactVersionAppendsFlag(t *testing.T) {
	deps, runner := testManagerDeps(t, map[string]fakeManagerResponse{
		"list":    {stdout: "No installed package found matching input criteria.\n", code: 1},
		"install": {stdout: "Successfully installed", code: 0},
	}, nil)

	payload := map[string]any{
		"installMethod":    map[string]any{"kind": "winget", "packageId": "Google.Chrome"},
		"versionMode":      "exact",
		"requestedVersion": "1.2.3",
		"softwareName":     "Chrome",
	}

	res := installViaManager(payload, deps)
	mustDecodeSuccess(t, res)

	calls := runner.installCalls()
	if len(calls) != 1 {
		t.Fatalf("want exactly one install exec, got %d: %v", len(calls), calls)
	}
	joined := strings.Join(calls[0], " ")
	if !strings.Contains(joined, "--version 1.2.3") {
		t.Fatalf("install args missing --version 1.2.3: %v", calls[0])
	}
}

func TestInstallViaManagerWingetExactVersionMissNeverFallsBack(t *testing.T) {
	deps, _ := testManagerDeps(t, map[string]fakeManagerResponse{
		"list":    {stdout: "No installed package found matching input criteria.\n", code: 1},
		"install": {stdout: "No package found matching input criteria.", code: 0},
	}, nil)

	payload := map[string]any{
		"installMethod":    map[string]any{"kind": "winget", "packageId": "Google.Chrome"},
		"versionMode":      "exact",
		"requestedVersion": "9.9.9",
		"softwareName":     "Chrome",
	}

	res := installViaManager(payload, deps)
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed on exact-version miss", res.Status)
	}
}

func TestInstallViaManagerWingetUnavailableWhenUnresolvable(t *testing.T) {
	deps, runner := testManagerDeps(t, map[string]fakeManagerResponse{}, fmt.Errorf("not found under WindowsApps"))

	payload := map[string]any{
		"installMethod": map[string]any{"kind": "winget", "packageId": "Google.Chrome"},
		"versionMode":   "latest",
		"softwareName":  "Chrome",
	}

	res := installViaManager(payload, deps)
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if !strings.HasPrefix(res.Error, "manager_unavailable: ") {
		t.Fatalf("error = %q, want manager_unavailable: prefix", res.Error)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("must not exec when winget cannot be resolved, got calls=%v", runner.calls)
	}
}

func TestInstallViaManagerRejectsInvalidPackageID(t *testing.T) {
	deps, runner := testManagerDeps(t, map[string]fakeManagerResponse{}, nil)

	payload := map[string]any{
		"installMethod": map[string]any{"kind": "winget", "packageId": "bad id"},
		"versionMode":   "latest",
		"softwareName":  "Chrome",
	}

	res := installViaManager(payload, deps)
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed for invalid packageId", res.Status)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("must not exec for an invalid packageId, got calls=%v", runner.calls)
	}
}

func TestInstallViaManagerForceReinstallSkipsIsInstalledCheck(t *testing.T) {
	deps, runner := testManagerDeps(t, map[string]fakeManagerResponse{
		"install": {stdout: "Successfully installed", code: 0},
	}, nil)

	payload := map[string]any{
		"installMethod":  map[string]any{"kind": "winget", "packageId": "Google.Chrome"},
		"versionMode":    "latest",
		"softwareName":   "Chrome",
		"forceReinstall": true,
	}

	res := installViaManager(payload, deps)
	mustDecodeSuccess(t, res)

	if len(runner.listCalls()) != 0 {
		t.Fatalf("forceReinstall must skip the IsInstalled short-circuit, got list calls=%v", runner.listCalls())
	}
	if len(runner.installCalls()) != 1 {
		t.Fatalf("want exactly one install exec, got %v", runner.installCalls())
	}
}

func TestInstallViaManagerWingetOnlyOnWindows(t *testing.T) {
	deps, runner := testManagerDeps(t, map[string]fakeManagerResponse{}, nil)
	deps.goos = "darwin"

	payload := map[string]any{
		"installMethod": map[string]any{"kind": "winget", "packageId": "Google.Chrome"},
		"versionMode":   "latest",
		"softwareName":  "Chrome",
	}

	res := installViaManager(payload, deps)
	if res.Status != "failed" || !strings.HasPrefix(res.Error, "manager_unavailable: ") {
		t.Fatalf("got status=%q error=%q, want failed with manager_unavailable: prefix", res.Status, res.Error)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("must not exec winget on a non-windows agent, got calls=%v", runner.calls)
	}
}

func TestInstallViaManagerBrewUnavailableMapsToManagerUnavailablePrefix(t *testing.T) {
	deps, runner := testManagerDeps(t, map[string]fakeManagerResponse{}, nil)
	deps.brewEnsure = func(kind, name, softwareName string) (string, bool, error) {
		return "", false, fmt.Errorf("%w: brew binary not found", patching.ErrBrewUnavailable)
	}

	payload := map[string]any{
		"installMethod": map[string]any{"kind": "homebrew_formula", "packageId": "firefox"},
		"versionMode":   "latest",
		"softwareName":  "Firefox",
	}

	res := installViaManager(payload, deps)
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if !strings.HasPrefix(res.Error, "manager_unavailable: ") {
		t.Fatalf("error = %q, want manager_unavailable: prefix", res.Error)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("brew path must not touch the winget runner, got calls=%v", runner.calls)
	}
}

func TestInstallViaManagerBrewRealFailureSurfacesVerbatim(t *testing.T) {
	deps, _ := testManagerDeps(t, map[string]fakeManagerResponse{}, nil)
	deps.brewEnsure = func(kind, name, softwareName string) (string, bool, error) {
		return "", false, fmt.Errorf("cannot execute brew as root: no active non-root console user")
	}

	payload := map[string]any{
		"installMethod": map[string]any{"kind": "homebrew_cask", "packageId": "firefox"},
		"versionMode":   "latest",
		"softwareName":  "Firefox",
	}

	res := installViaManager(payload, deps)
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if strings.HasPrefix(res.Error, "manager_unavailable: ") {
		t.Fatalf("a real root/console failure must not be reported as manager_unavailable: got %q", res.Error)
	}
	if res.Error != "cannot execute brew as root: no active non-root console user" {
		t.Fatalf("error = %q, want the underlying brewCommand error verbatim", res.Error)
	}
}

func TestInstallViaManagerBrewAlreadyInstalledPassesThrough(t *testing.T) {
	deps, _ := testManagerDeps(t, map[string]fakeManagerResponse{}, nil)
	called := false
	deps.brewEnsure = func(kind, name, softwareName string) (string, bool, error) {
		called = true
		if kind != "homebrew_formula" || name != "git" {
			t.Fatalf("brewEnsure got kind=%q name=%q, want homebrew_formula/git", kind, name)
		}
		return "git 2.55.0", true, nil
	}

	payload := map[string]any{
		"installMethod": map[string]any{"kind": "homebrew_formula", "packageId": "git"},
		"versionMode":   "latest",
		"softwareName":  "Git",
	}

	res := installViaManager(payload, deps)
	if !called {
		t.Fatal("brewEnsure was never invoked")
	}
	m := mustDecodeSuccess(t, res)
	if m["alreadyInstalled"] != true {
		t.Fatalf("alreadyInstalled = %v, want true", m["alreadyInstalled"])
	}
	if m["packageId"] != "git" {
		t.Fatalf("packageId = %v, want git", m["packageId"])
	}
}

// TestInstallViaManagerBrewRejectsInvalidPackageIDBeforeExec pins the
// contract that ValidateBrewPackageName runs before brewEnsure is ever
// invoked — an unsafe brew name must never reach a shell-out.
func TestInstallViaManagerBrewRejectsInvalidPackageIDBeforeExec(t *testing.T) {
	deps, _ := testManagerDeps(t, map[string]fakeManagerResponse{}, nil)
	deps.brewEnsure = func(kind, name, softwareName string) (string, bool, error) {
		t.Fatal("brewEnsure must not be called for an invalid packageId")
		return "", false, nil
	}

	payload := map[string]any{
		"installMethod": map[string]any{"kind": "homebrew_formula", "packageId": "; rm -rf /"},
		"versionMode":   "latest",
		"softwareName":  "Evil",
	}

	res := installViaManager(payload, deps)
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed for an invalid brew packageId", res.Status)
	}
}

func TestSoftwareInstallRoutesInstallMethodPayloadToManager(t *testing.T) {
	// InstallSoftware must branch to the manager path BEFORE requiring
	// downloadUrl, given an installMethod payload with no downloadUrl at all.
	payload := map[string]any{
		"installMethod": map[string]any{"kind": "winget", "packageId": "Google.Chrome"},
		"versionMode":   "latest",
		"softwareName":  "Chrome",
	}

	res := InstallSoftware(payload)
	if res.Error == "missing required field: downloadUrl" {
		t.Fatal("InstallSoftware did not branch to the manager path; fell through to the downloadUrl requirement")
	}
}
