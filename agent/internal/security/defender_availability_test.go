package security

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeDefenderHost stands in for a Windows host's Defender surface (#10908).
// Every PowerShell spawn the Defender status path makes goes through
// runDefenderPowerShell, so spawns records exactly what a real host would
// have launched.
type fakeDefenderHost struct {
	moduleInstalled bool
	getCommandOut   string
	getCommandErr   error
	statusOut       string
	statusErr       error

	spawns []string
}

func (f *fakeDefenderHost) count(script string) int {
	n := 0
	for _, s := range f.spawns {
		if s == script {
			n++
		}
	}
	return n
}

// installFakeDefenderHost swaps in a fresh availability probe on a fake clock
// and a fake PowerShell.
func installFakeDefenderHost(t *testing.T, host *fakeDefenderHost) *time.Time {
	t.Helper()
	now := time.Unix(1_700_000_000, 0)

	prevProbe, prevRun := defenderAvailability, runDefenderPowerShell
	probe := newDefenderAvailabilityProbe()
	probe.now = func() time.Time { return now }
	probe.moduleInstalled = func() bool { return host.moduleInstalled }
	defenderAvailability = probe
	runDefenderPowerShell = func(_ time.Duration, script string) (string, error) {
		host.spawns = append(host.spawns, script)
		switch script {
		case defenderGetCommandPS:
			return host.getCommandOut, host.getCommandErr
		case defenderStatusPS:
			return host.statusOut, host.statusErr
		default:
			return "", fmt.Errorf("unexpected PowerShell script: %s", script)
		}
	}
	t.Cleanup(func() { defenderAvailability, runDefenderPowerShell = prevProbe, prevRun })
	return &now
}

const healthyDefenderJSON = `{"AMServiceEnabled":true,"AntispywareEnabled":true,"AntivirusEnabled":true,"RealTimeProtectionEnabled":true,"AntivirusSignatureVersion":" 1.421.123.0 ","AntivirusSignatureLastUpdated":"2026-11-03T08:00:00Z","QuickScanEndTime":"2026-11-02T09:30:00Z","FullScanEndTime":""}`

// Get-MpComputerStatus against a host whose Defender service is disabled by
// policy or by a third-party AV. PowerShell writes the CIM error to stderr
// (merged into the captured output); the HRESULT id is not localized.
const defenderServiceDisabledOutput = "Get-MpComputerStatus : The service cannot be started, either because it is disabled or because it has no enabled devices associated with it.\r\n" +
	"At line:1 char:1\r\n" +
	"+ Get-MpComputerStatus | Select-Object AMServiceEnabled,AntispywareEnab ...\r\n" +
	"    + CategoryInfo          : NotSpecified: (MSFT_MpComputerStatus:ROOT\\Microsoft\\...pComputerStatus) [Get-MpComputerStatus], CimException\r\n" +
	"    + FullyQualifiedErrorId : HRESULT 0x800106ba,Get-MpComputerStatus"

// Windows Server with the Windows-Defender feature removed has neither the
// Defender module nor the Get-MpComputerStatus cmdlet. Every tick must report
// ErrNotSupported (which CollectStatus skips silently) and, after the one
// confirming Get-Command, spawn nothing.
func TestDefenderCmdletAbsentSkipsStatusSpawn(t *testing.T) {
	host := &fakeDefenderHost{moduleInstalled: false, getCommandOut: "unavailable\r\n"}
	installFakeDefenderHost(t, host)

	for range 3 { // three security ticks
		status, err := collectDefenderStatus()
		if !errors.Is(err, ErrNotSupported) {
			t.Fatalf("err = %v, want ErrNotSupported", err)
		}
		if status != (DefenderStatus{}) {
			t.Fatalf("status = %+v, want zero value", status)
		}
	}
	if len(host.spawns) != 1 || host.spawns[0] != defenderGetCommandPS {
		t.Fatalf("spawns = %q, want exactly one availability check", host.spawns)
	}
}

// Defender disabled by policy or a third-party AV: the module and cmdlet are
// present, so the cheap check passes, but the status call fails with
// HRESULT 0x800106ba. That is a permanent property of the host: report
// ErrNotSupported and do not spawn again until the TTL expires.
func TestDefenderServiceDisabledIsNotSupportedAndCached(t *testing.T) {
	for _, tc := range []struct {
		name string
		out  string
		err  error
	}{
		// PowerShell exits non-zero when the pipeline's last command failed...
		{name: "non-zero exit", err: errors.New("exit status 1")},
		// ...but ConvertTo-Json of an empty pipeline can still exit 0.
		{name: "zero exit", err: nil},
		// The hex digits' case is not something to rely on.
		{name: "upper-case HRESULT", out: strings.ToUpper(defenderServiceDisabledOutput), err: errors.New("exit status 1")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := tc.out
			if out == "" {
				out = defenderServiceDisabledOutput
			}
			host := &fakeDefenderHost{moduleInstalled: true, statusOut: out, statusErr: tc.err}
			now := installFakeDefenderHost(t, host)

			for range 3 {
				if _, err := collectDefenderStatus(); !errors.Is(err, ErrNotSupported) {
					t.Fatalf("err = %v, want ErrNotSupported", err)
				}
				*now = now.Add(5 * time.Minute)
			}
			if n := host.count(defenderStatusPS); n != 1 {
				t.Fatalf("status spawns = %d, want 1 (0x800106ba must be cached)", n)
			}
			if n := host.count(defenderGetCommandPS); n != 0 {
				t.Fatalf("availability spawns = %d, want 0 when the module is installed", n)
			}
		})
	}
}

func TestDefenderHealthyBehavesAsBefore(t *testing.T) {
	host := &fakeDefenderHost{moduleInstalled: true, statusOut: "WARNING: banner {\r\n" + healthyDefenderJSON}
	installFakeDefenderHost(t, host)

	for range 2 {
		status, err := collectDefenderStatus()
		if err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
		want := DefenderStatus{
			Enabled:              true,
			RealTimeProtection:   true,
			DefinitionsVersion:   "1.421.123.0",
			DefinitionsUpdatedAt: "2026-11-03T08:00:00Z",
			LastQuickScan:        "2026-11-02T09:30:00Z",
		}
		if status != want {
			t.Fatalf("status = %+v, want %+v", status, want)
		}
	}
	// The module is on disk, so availability costs no spawn, and a healthy
	// read is not cached: every tick queries Defender as it did before.
	if n := host.count(defenderGetCommandPS); n != 0 {
		t.Fatalf("availability spawns = %d, want 0", n)
	}
	if n := host.count(defenderStatusPS); n != 2 {
		t.Fatalf("status spawns = %d, want 2", n)
	}
}

// On a host that has Defender, a failing status call is a real failure: it
// must surface as an error, never be masked as ErrNotSupported, and must not
// close the gate.
func TestDefenderRealFailureStillSurfaces(t *testing.T) {
	for _, tc := range []struct {
		name string
		out  string
		err  error
	}{
		{name: "timeout", err: errDefenderStatusTimeout},
		{name: "other HRESULT", out: "Get-MpComputerStatus : Access denied\r\n    + FullyQualifiedErrorId : HRESULT 0x80070005,Get-MpComputerStatus", err: errors.New("exit status 1")},
		{name: "empty output", out: ""},
		{name: "unparseable output", out: "{not json"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host := &fakeDefenderHost{moduleInstalled: true, statusOut: tc.out, statusErr: tc.err}
			installFakeDefenderHost(t, host)

			for range 2 {
				_, err := collectDefenderStatus()
				if err == nil || errors.Is(err, ErrNotSupported) {
					t.Fatalf("err = %v, want a real (non-ErrNotSupported) failure", err)
				}
				if tc.err == errDefenderStatusTimeout && !errors.Is(err, errDefenderStatusTimeout) {
					t.Fatalf("err = %v, want errDefenderStatusTimeout", err)
				}
				if tc.name == "other HRESULT" {
					// The PowerShell error record is what an operator needs;
					// "exit status 1" alone says nothing.
					for _, want := range []string{"defender status command failed", "0x80070005"} {
						if !strings.Contains(err.Error(), want) {
							t.Fatalf("err = %q, want it to contain %q", err, want)
						}
					}
				}
			}
			if n := host.count(defenderStatusPS); n != 2 {
				t.Fatalf("status spawns = %d, want 2 (a real failure must not close the gate)", n)
			}
		})
	}
}

// Defender installed (or re-enabled) after the agent cached "unavailable" is
// picked up when the long TTL expires.
func TestDefenderAvailabilityReDetectsAfterTTL(t *testing.T) {
	host := &fakeDefenderHost{moduleInstalled: false, getCommandOut: "unavailable", statusOut: healthyDefenderJSON}
	now := installFakeDefenderHost(t, host)

	if _, err := collectDefenderStatus(); !errors.Is(err, ErrNotSupported) {
		t.Fatalf("err = %v, want ErrNotSupported", err)
	}
	host.moduleInstalled = true // feature installed + rebooted

	*now = now.Add(defenderAvailabilityTTL - time.Second)
	if _, err := collectDefenderStatus(); !errors.Is(err, ErrNotSupported) {
		t.Fatalf("err before TTL = %v, want cached ErrNotSupported", err)
	}
	*now = now.Add(time.Second)
	if _, err := collectDefenderStatus(); err != nil {
		t.Fatalf("err after TTL = %v, want re-detected as available", err)
	}
	if n := host.count(defenderStatusPS); n != 1 {
		t.Fatalf("status spawns = %d, want 1 after re-detect", n)
	}
	if defenderAvailabilityTTL < 12*time.Hour {
		t.Fatalf("defenderAvailabilityTTL = %s; a permanent condition needs a long TTL", defenderAvailabilityTTL)
	}
}

// A third-party AV removed (or a WinDefend that was not yet running at boot)
// after 0x800106ba was cached: Defender is seen again once the shorter
// service-disabled TTL expires. 0x800106ba is "service not running", which is
// not always permanent, so it must not hide a Defender-only host for a day.
func TestDefenderServiceDisabledReDetectsAfterTTL(t *testing.T) {
	host := &fakeDefenderHost{moduleInstalled: true, statusOut: defenderServiceDisabledOutput, statusErr: errors.New("exit status 1")}
	now := installFakeDefenderHost(t, host)

	if _, err := collectDefenderStatus(); !errors.Is(err, ErrNotSupported) {
		t.Fatalf("err = %v, want ErrNotSupported", err)
	}
	host.statusOut, host.statusErr = healthyDefenderJSON, nil

	*now = now.Add(defenderServiceDisabledTTL - time.Second)
	if _, err := collectDefenderStatus(); !errors.Is(err, ErrNotSupported) {
		t.Fatalf("err before TTL = %v, want cached ErrNotSupported", err)
	}
	*now = now.Add(time.Second)
	if status, err := collectDefenderStatus(); err != nil || !status.RealTimeProtection {
		t.Fatalf("after TTL = %+v, %v; want healthy Defender", status, err)
	}
	if n := host.count(defenderStatusPS); n != 2 {
		t.Fatalf("status spawns = %d, want 2", n)
	}
	if defenderServiceDisabledTTL > 2*time.Hour || defenderServiceDisabledTTL < slowProbeErrorTTL {
		t.Fatalf("defenderServiceDisabledTTL = %s; want between slowProbeErrorTTL and 2h", defenderServiceDisabledTTL)
	}
}

// If the availability check itself fails (PowerShell cold start timing out),
// nothing is assumed: the status call runs as it did before the gate, and the
// check is retried after slowProbeErrorTTL rather than the long TTL.
func TestDefenderAvailabilityIndeterminateFallsThrough(t *testing.T) {
	host := &fakeDefenderHost{
		moduleInstalled: false,
		getCommandErr:   errors.New("command timed out: powershell"),
		statusOut:       healthyDefenderJSON,
	}
	now := installFakeDefenderHost(t, host)

	if _, err := collectDefenderStatus(); err != nil {
		t.Fatalf("err = %v, want the status call to run", err)
	}
	if n := host.count(defenderStatusPS); n != 1 {
		t.Fatalf("status spawns = %d, want 1 (indeterminate must not skip)", n)
	}
	_, _ = collectDefenderStatus()
	if n := host.count(defenderGetCommandPS); n != 1 {
		t.Fatalf("availability spawns = %d, want 1 within the error TTL", n)
	}
	*now = now.Add(slowProbeErrorTTL)
	_, _ = collectDefenderStatus()
	if n := host.count(defenderGetCommandPS); n != 2 {
		t.Fatalf("availability spawns after error TTL = %d, want 2", n)
	}
}

// Output that is neither "available" nor "unavailable" (a profile banner, a
// localized warning) must never close the gate.
func TestDefenderAvailabilityUnexpectedOutputIsIndeterminate(t *testing.T) {
	for _, out := range []string{"", "WARNING: something\r\nunavailable", "Available", "UNAVAILABLE"} {
		host := &fakeDefenderHost{moduleInstalled: false, getCommandOut: out, statusOut: healthyDefenderJSON}
		installFakeDefenderHost(t, host)
		if _, err := collectDefenderStatus(); err != nil {
			t.Fatalf("output %q: err = %v, want status call to run", out, err)
		}
		if n := host.count(defenderStatusPS); n != 1 {
			t.Fatalf("output %q: status spawns = %d, want 1", out, n)
		}
	}
}

// Cheap check says absent but Get-Command finds the cmdlet (module installed
// somewhere other than the inbox path): Defender is queried normally and the
// confirming spawn is not repeated within the TTL.
func TestDefenderModuleElsewhereStillQueried(t *testing.T) {
	host := &fakeDefenderHost{moduleInstalled: false, getCommandOut: "available", statusOut: healthyDefenderJSON}
	installFakeDefenderHost(t, host)

	for range 3 {
		if _, err := collectDefenderStatus(); err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
	}
	if n := host.count(defenderGetCommandPS); n != 1 {
		t.Fatalf("availability spawns = %d, want 1 per TTL", n)
	}
	if n := host.count(defenderStatusPS); n != 3 {
		t.Fatalf("status spawns = %d, want 3", n)
	}
}

func TestDefenderModuleInstalled(t *testing.T) {
	root := t.TempDir()
	t.Setenv("SystemRoot", root)
	modules := filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "Modules")
	if err := os.MkdirAll(modules, 0o755); err != nil {
		t.Fatal(err)
	}
	if defenderModuleInstalled() {
		t.Fatal("module dir absent: want false")
	}
	if err := os.WriteFile(filepath.Join(modules, "Defender"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if defenderModuleInstalled() {
		t.Fatal("Defender is a file, not a module dir: want false")
	}
	if err := os.Remove(filepath.Join(modules, "Defender")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(modules, "Defender"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !defenderModuleInstalled() {
		t.Fatal("module dir present: want true")
	}
}

// The cheap check passed (module directory present) but the cmdlet is gone:
// a leftover directory after the feature was removed. PowerShell reports
// CommandNotFoundException (not localized); that is the absent-cmdlet case
// and closes the gate for the long TTL.
func TestDefenderCmdletNotFoundDespiteModuleDir(t *testing.T) {
	host := &fakeDefenderHost{
		moduleInstalled: true,
		statusOut: "Get-MpComputerStatus : The term 'Get-MpComputerStatus' is not recognized as the name of a cmdlet, function, script file, or operable program.\r\n" +
			"    + CategoryInfo          : ObjectNotFound: (Get-MpComputerStatus:String) [], CommandNotFoundException\r\n" +
			"    + FullyQualifiedErrorId : CommandNotFoundException",
		statusErr: errors.New("exit status 1"),
	}
	now := installFakeDefenderHost(t, host)

	if _, err := collectDefenderStatus(); !errors.Is(err, ErrNotSupported) {
		t.Fatalf("err = %v, want ErrNotSupported", err)
	}
	*now = now.Add(defenderAvailabilityTTL - time.Second)
	if _, err := collectDefenderStatus(); !errors.Is(err, ErrNotSupported) {
		t.Fatalf("err = %v, want cached ErrNotSupported", err)
	}
	if n := host.count(defenderStatusPS); n != 1 {
		t.Fatalf("status spawns = %d, want 1 within the long TTL", n)
	}
}

// A CommandNotFoundException for some other command (a profile or module
// script referencing a missing helper) is not proof Defender is absent.
func TestDefenderOtherCommandNotFoundStillSurfaces(t *testing.T) {
	host := &fakeDefenderHost{
		moduleInstalled: true,
		// PowerShell echoes the whole command line, so the Defender cmdlet's
		// name appears even though another command is the missing one.
		statusOut: "Some-Helper : The term 'Some-Helper' is not recognized\r\n" +
			"+ Get-MpComputerStatus | Select-Object AMServiceEnabled | Some-Helper\r\n" +
			"    + CategoryInfo          : ObjectNotFound: (Some-Helper:String) [], CommandNotFoundException\r\n" +
			"    + FullyQualifiedErrorId : CommandNotFoundException",
		statusErr: errors.New("exit status 1"),
	}
	installFakeDefenderHost(t, host)
	if _, err := collectDefenderStatus(); err == nil || errors.Is(err, ErrNotSupported) {
		t.Fatalf("err = %v, want a real failure", err)
	}
}

func TestParseDefenderStatusFields(t *testing.T) {
	for _, tc := range []struct {
		name string
		json string
		want DefenderStatus
	}{
		{
			name: "only AM service enabled",
			json: `{"AMServiceEnabled":true,"AntispywareEnabled":false,"AntivirusEnabled":false,"RealTimeProtectionEnabled":false,"FullScanEndTime":"1/2/2026 3:04:05 PM"}`,
			want: DefenderStatus{Enabled: true, LastFullScan: "2026-01-02T15:04:05Z"},
		},
		{
			name: "only antispyware enabled",
			json: `{"AntispywareEnabled":true,"AntivirusSignatureLastUpdated":"2026-01-02 03:04:05"}`,
			want: DefenderStatus{Enabled: true, DefinitionsUpdatedAt: "2026-01-02T03:04:05Z"},
		},
		{
			name: "everything off",
			json: `{"AMServiceEnabled":false,"AntispywareEnabled":false,"AntivirusEnabled":false,"QuickScanEndTime":"not a date"}`,
			want: DefenderStatus{LastQuickScan: "not a date"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseDefenderStatus(tc.json)
			if err != nil || got != tc.want {
				t.Fatalf("parse = %+v, %v; want %+v", got, err, tc.want)
			}
		})
	}
}
