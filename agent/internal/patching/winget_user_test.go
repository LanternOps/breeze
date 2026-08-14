package patching

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

const (
	machineTable = "Name    Id               Version  Available Source\n" +
		"-----------------------------------------------------\n" +
		"Firefox Mozilla.Firefox   1.0      2.0       winget\n"
	userTable = "Name    Id               Version  Available Source\n" +
		"-----------------------------------------------------\n" +
		"Chrome  Google.Chrome     1.0      2.0       winget\n"
)

func machineRunner(t *testing.T) cmdRunner {
	t.Helper()
	return func(_ string, args []string, _ time.Duration) (string, string, int, error) {
		if !contains(args, "machine") {
			t.Fatalf("SYSTEM pass must stay machine scope, got %v", args)
		}
		return machineTable, "", 0, nil
	}
}

func contains(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func scopeOf(t *testing.T, patches []AvailablePatch, id string) string {
	t.Helper()
	for _, p := range patches {
		if p.ID == id {
			return p.Scope
		}
	}
	t.Fatalf("package %q not in results %+v", id, patches)
	return ""
}

func TestUserScanArgsAreUserScopeWingetSource(t *testing.T) {
	j := strings.Join(userScanArgs(), " ")
	for _, want := range []string{"upgrade", "--include-unknown", "--scope user", "--source winget", "--disable-interactivity"} {
		if !strings.Contains(j, want) {
			t.Fatalf("user scan args missing %q: %s", want, j)
		}
	}
	if strings.Contains(j, "machine") {
		t.Fatalf("user pass must not request machine scope: %s", j)
	}
	if strings.Contains(j, "msstore") {
		t.Fatal("user scan must not use msstore source")
	}
}

// TestScanMergesUserScopePackages is the core #2727 behaviour: a per-user app
// invisible to the SYSTEM machine-scope pass appears in the merged result,
// labelled as user scope.
func TestScanMergesUserScopePackages(t *testing.T) {
	p := NewSystemWingetProviderWithUserScan(`C:\wg\winget.exe`, machineRunner(t),
		func(name string, args []string, _ time.Duration) (string, string, int, error) {
			if name != "winget" {
				t.Fatalf("user pass must invoke winget by name, got %q", name)
			}
			if !contains(args, "user") {
				t.Fatalf("user pass must request user scope, got %v", args)
			}
			return userTable, "", 0, nil
		})

	patches, err := p.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(patches) != 2 {
		t.Fatalf("want machine + user package, got %+v", patches)
	}
	if got := scopeOf(t, patches, "Mozilla.Firefox"); got != PatchScopeMachine {
		t.Fatalf("Firefox scope = %q, want machine", got)
	}
	if got := scopeOf(t, patches, "Google.Chrome"); got != PatchScopeUser {
		t.Fatalf("Chrome scope = %q, want user", got)
	}
	if status := p.LastUserScan(); !status.Attempted || !status.Scanned {
		t.Fatalf("LastUserScan = %+v, want attempted+scanned", status)
	}
}

// TestScanDegradesToMachineScopeOnly covers every way the user pass can fail.
// In all of them the machine-scope results must flow exactly as they did before
// #2727, and the status must record that per-user apps were NOT scanned so the
// server can report the gap instead of under-reporting silently.
func TestScanDegradesToMachineScopeOnly(t *testing.T) {
	tests := []struct {
		name          string
		userExec      UserExecFunc
		wantAttempted bool
		wantReason    string
	}{
		{
			name:       "no user executor configured",
			userExec:   nil,
			wantReason: "no user-context executor configured",
		},
		{
			name: "no logged-in user helper session",
			userExec: func(string, []string, time.Duration) (string, string, int, error) {
				return "", "", -1, errors.New("no user helper session connected")
			},
			wantAttempted: true,
			wantReason:    "no user helper session connected",
		},
		{
			name: "helper IPC failure",
			userExec: func(string, []string, time.Duration) (string, string, int, error) {
				return "", "", -1, errors.New("user helper exec: session closed")
			},
			wantAttempted: true,
			wantReason:    "session closed",
		},
		{
			name: "winget error with no output",
			userExec: func(string, []string, time.Duration) (string, string, int, error) {
				return "", "winget: access denied", 1, nil
			},
			wantAttempted: true,
			wantReason:    "access denied",
		},
		{
			name: "unparsable output is not an empty user scope",
			userExec: func(string, []string, time.Duration) (string, string, int, error) {
				return "\x1b[2J??? not a table\n", "", 0, nil
			},
			wantAttempted: true,
			wantReason:    "no parsable table header",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := NewSystemWingetProviderWithUserScan(`C:\wg\winget.exe`, machineRunner(t), tt.userExec)

			patches, err := p.Scan()
			if err != nil {
				t.Fatalf("machine-scope scan must still succeed: %v", err)
			}
			if len(patches) != 1 || patches[0].ID != "Mozilla.Firefox" {
				t.Fatalf("machine results changed: %+v", patches)
			}
			if patches[0].Scope != PatchScopeMachine {
				t.Fatalf("scope = %q, want machine", patches[0].Scope)
			}

			status := p.LastUserScan()
			if status.Scanned {
				t.Fatal("user pass must not be reported as scanned")
			}
			if status.Attempted != tt.wantAttempted {
				t.Fatalf("Attempted = %v, want %v", status.Attempted, tt.wantAttempted)
			}
			if !strings.Contains(status.Reason, tt.wantReason) {
				t.Fatalf("Reason = %q, want it to mention %q", status.Reason, tt.wantReason)
			}
		})
	}
}

// TestScanUserPassNotAttemptedWhenMachinePassFails asserts the ordering
// guarantee: a skipped provider never claims the user pass ran.
func TestScanUserPassNotAttemptedWhenMachinePassFails(t *testing.T) {
	p := NewSystemWingetProviderWithUserScan(`C:\wg\winget.exe`,
		func(string, []string, time.Duration) (string, string, int, error) {
			return "\x1b[2J??? not a table\n", "", 0, nil
		},
		func(string, []string, time.Duration) (string, string, int, error) {
			t.Fatal("user pass must not run when the machine pass was skipped")
			return "", "", 0, nil
		})

	if _, err := p.Scan(); !errors.Is(err, ErrScanSkipped) {
		t.Fatalf("err = %v, want ErrScanSkipped", err)
	}
	status := p.LastUserScan()
	if status.Attempted || status.Scanned {
		t.Fatalf("LastUserScan = %+v, want neither attempted nor scanned", status)
	}
	if !strings.Contains(status.Reason, "machine-scope pass failed") {
		t.Fatalf("Reason = %q, want it to name the machine-pass failure", status.Reason)
	}
}

func TestMergeWingetScopes(t *testing.T) {
	tests := []struct {
		name       string
		machine    []AvailablePatch
		user       []AvailablePatch
		wantIDs    []string
		wantScopes []string
	}{
		{
			name:       "disjoint scopes both reported",
			machine:    []AvailablePatch{{ID: "Mozilla.Firefox"}},
			user:       []AvailablePatch{{ID: "Google.Chrome"}},
			wantIDs:    []string{"Mozilla.Firefox", "Google.Chrome"},
			wantScopes: []string{PatchScopeMachine, PatchScopeUser},
		},
		{
			name:       "package at both scopes keeps the machine entry once",
			machine:    []AvailablePatch{{ID: "Google.Chrome", Version: "1.0"}},
			user:       []AvailablePatch{{ID: "Google.Chrome", Version: "0.9"}},
			wantIDs:    []string{"Google.Chrome"},
			wantScopes: []string{PatchScopeMachine},
		},
		{
			name:       "duplicate ID differing only in case is still one row",
			machine:    []AvailablePatch{{ID: "Google.Chrome"}},
			user:       []AvailablePatch{{ID: "google.chrome"}},
			wantIDs:    []string{"Google.Chrome"},
			wantScopes: []string{PatchScopeMachine},
		},
		{
			name:       "duplicates within the user pass collapse",
			user:       []AvailablePatch{{ID: "Zoom.Zoom"}, {ID: "Zoom.Zoom"}},
			wantIDs:    []string{"Zoom.Zoom"},
			wantScopes: []string{PatchScopeUser},
		},
		{
			name:       "no user results leaves machine scope labelled",
			machine:    []AvailablePatch{{ID: "Mozilla.Firefox"}},
			wantIDs:    []string{"Mozilla.Firefox"},
			wantScopes: []string{PatchScopeMachine},
		},
		{
			name:    "both empty",
			wantIDs: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := mergeWingetScopes(tt.machine, tt.user)
			if len(got) != len(tt.wantIDs) {
				t.Fatalf("got %+v, want ids %v", got, tt.wantIDs)
			}
			for i, p := range got {
				if p.ID != tt.wantIDs[i] {
					t.Fatalf("result[%d].ID = %q, want %q", i, p.ID, tt.wantIDs[i])
				}
				if p.Scope != tt.wantScopes[i] {
					t.Fatalf("result[%d].Scope = %q, want %q", i, p.Scope, tt.wantScopes[i])
				}
			}
		})
	}
}

// TestUserScopeOnlyPackagesRefuseInstall pins the detection-only scope of this
// change: a package that exists only in the user's profile cannot be remediated
// from SYSTEM, and a machine-scope install would either fail confusingly or
// install a second machine-wide copy. It must be refused with a clear message.
func TestUserScopeOnlyPackagesRefuseInstall(t *testing.T) {
	p := NewSystemWingetProviderWithUserScan(`C:\wg\winget.exe`, machineRunner(t),
		func(string, []string, time.Duration) (string, string, int, error) {
			return userTable, "", 0, nil
		})
	if _, err := p.Scan(); err != nil {
		t.Fatal(err)
	}

	if _, err := p.Install("Google.Chrome"); err == nil {
		t.Fatal("want an explicit refusal for a user-scope package")
	} else if !strings.Contains(err.Error(), "per-user") {
		t.Fatalf("refusal must explain the scope, got %v", err)
	}
	if err := p.Uninstall("Google.Chrome"); err == nil {
		t.Fatal("want an explicit refusal for a user-scope uninstall")
	}

	// Case-insensitivity: winget IDs are matched case-insensitively, so the
	// guard must not be bypassable by casing.
	if _, err := p.Install("google.chrome"); err == nil {
		t.Fatal("refusal must be case-insensitive")
	}
}

// TestMachineScopePackagesStillInstall guards against the refusal above
// over-reaching: machine-scope packages, and packages from before any scan ran,
// must keep the pre-#2727 install path.
func TestMachineScopePackagesStillInstall(t *testing.T) {
	var installed []string
	run := func(_ string, args []string, _ time.Duration) (string, string, int, error) {
		if len(args) > 0 && args[0] == "install" {
			installed = append(installed, strings.Join(args, " "))
			return "Successfully installed", "", 0, nil
		}
		return machineTable, "", 0, nil
	}
	p := NewSystemWingetProviderWithUserScan(`C:\wg\winget.exe`, run,
		func(string, []string, time.Duration) (string, string, int, error) {
			return userTable, "", 0, nil
		})

	// Before any scan: no remembered scopes, behaviour is exactly as before.
	if _, err := p.Install("Mozilla.Firefox"); err != nil {
		t.Fatalf("install before first scan must work: %v", err)
	}
	if _, err := p.Scan(); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Install("Mozilla.Firefox"); err != nil {
		t.Fatalf("machine-scope install must still work: %v", err)
	}
	if len(installed) != 2 {
		t.Fatalf("expected 2 installs, got %v", installed)
	}
	for _, args := range installed {
		if !strings.Contains(args, "--scope machine") {
			t.Fatalf("machine install lost its scope flag: %s", args)
		}
	}
}

// TestUserScanTimeoutIsBounded asserts the user pass hands the executor a
// bounded deadline, so a hung winget in the user session cannot stall the patch
// cycle indefinitely.
func TestUserScanTimeoutIsBounded(t *testing.T) {
	var got time.Duration
	_, _ = userWingetScan(func(_ string, _ []string, timeout time.Duration) (string, string, int, error) {
		got = timeout
		return userTable, "", 0, nil
	})
	if got <= 0 || got > 5*time.Minute {
		t.Fatalf("user scan timeout = %v, want a bounded non-zero budget", got)
	}
	if got != userWingetScanTimeout {
		t.Fatalf("user scan timeout = %v, want %v", got, userWingetScanTimeout)
	}
}

func TestUserWingetScanNilExecutor(t *testing.T) {
	if _, err := userWingetScan(nil); err == nil {
		t.Fatal("nil executor must be an error, not an empty result")
	}
}

func TestUserScopeIDSet(t *testing.T) {
	ids := userScopeIDSet([]AvailablePatch{
		{ID: "Mozilla.Firefox", Scope: PatchScopeMachine},
		{ID: "Google.Chrome", Scope: PatchScopeUser},
		{ID: "NoScope.Pkg"},
	})
	if len(ids) != 1 {
		t.Fatalf("got %v, want only the user-scope package", ids)
	}
	if _, ok := ids["google.chrome"]; !ok {
		t.Fatalf("got %v, want lowercased google.chrome", ids)
	}
}

// TestRegisterSystemWingetWithUserScanKeepsSingleProvider is the regression
// guard for the coverage trap: the user pass must NOT become a second provider.
// A second provider mapping to the shared third_party bucket would leave that
// bucket permanently uncovered on machines with nobody logged in, so the API
// would stop reconciling third-party patches there entirely.
func TestRegisterSystemWingetWithUserScanKeepsSingleProvider(t *testing.T) {
	m := NewPatchManager()
	ok := RegisterSystemWingetWithUserScan(m, EnsureResult{Available: true, WingetPath: `C:\wg\winget.exe`},
		func(string, []string, time.Duration) (string, string, int, error) { return "", "", 0, nil },
		func(string, []string, time.Duration) (string, string, int, error) { return "", "", 0, nil })
	if !ok {
		t.Fatal("expected registration")
	}
	if ids := m.ProviderIDs(); len(ids) != 1 || ids[0] != "winget" {
		t.Fatalf("ProviderIDs = %v, want exactly [winget]", ids)
	}
}

func TestRegisterSystemWingetWithUserScanSkipsUnavailable(t *testing.T) {
	m := NewPatchManager()
	if RegisterSystemWingetWithUserScan(m, EnsureResult{Available: false}, nil, nil) {
		t.Fatal("must not register when winget is unavailable")
	}
	if len(m.ProviderIDs()) != 0 {
		t.Fatalf("ProviderIDs = %v, want none", m.ProviderIDs())
	}
}

// TestScanCoverageUnchangedByUserPass asserts the whole reason the user pass is
// internal: whether winget counts as "covered" depends only on the SYSTEM pass.
func TestScanCoverageUnchangedByUserPass(t *testing.T) {
	for _, tt := range []struct {
		name        string
		userExec    UserExecFunc
		wantCovered bool
	}{
		{
			name: "user pass fails",
			userExec: func(string, []string, time.Duration) (string, string, int, error) {
				return "", "", -1, fmt.Errorf("no user helper session connected")
			},
			wantCovered: true,
		},
		{
			name: "user pass succeeds",
			userExec: func(string, []string, time.Duration) (string, string, int, error) {
				return userTable, "", 0, nil
			},
			wantCovered: true,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			m := NewPatchManager(NewSystemWingetProviderWithUserScan(`C:\wg\winget.exe`, machineRunner(t), tt.userExec))
			_, covered, err := m.ScanWithCoverage()
			if err != nil {
				t.Fatal(err)
			}
			gotCovered := len(covered) == 1 && covered[0] == "winget"
			if gotCovered != tt.wantCovered {
				t.Fatalf("covered = %v, want winget covered = %v", covered, tt.wantCovered)
			}
		})
	}
}
