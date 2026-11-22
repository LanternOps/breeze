package oemupdates

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/oemupdates/bitlockerguard"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/security"
)

const (
	boundManageBde   = "    TPM:\n      ID: {x}\n      PCR Validation Profile:\n        7, 11\n"
	unboundManageBde = "    TPM:\n      ID: {x}\n      PCR Validation Profile:\n        0, 2, 4, 11\n"
	germanManageBde  = "    TPM:\n      ID: {x}\n      PCR-Validierungsprofil:\n        7, 11\n"
)

func fwUpdate(id string) patching.DriverUpdate {
	return patching.DriverUpdate{UpdateID: id, Title: "Surface - Firmware - " + id, DriverManufacturer: "Surface", DriverClass: "Firmware"}
}

func drvUpdate(id string) patching.DriverUpdate {
	return patching.DriverUpdate{UpdateID: id, Title: "Surface - System - " + id, DriverManufacturer: "Surface", DriverClass: "System"}
}

// surfaceRig is a Surface on fakes. events is the order things happened in.
type surfaceRig struct {
	*runFixture
	mu sync.Mutex

	host      surfaceHost
	lane      *surfaceLane
	guardDeps bitlockerguard.Deps

	maker, model string
	identityErr  error
	identities   int
	updates      []patching.DriverUpdate
	searchErr    error
	searches     int
	installFail  map[string]error
	installSkip  map[string]bool
	// installStarted marks a failure past the point WUA began installing.
	installStarted map[string]bool
	reboot         map[string]bool
	wuDisabled     bool
	pending        bool
	pendingErr     error
	power          PowerStatus
	powerErr       error
	blVolume       string
	blStateErr     error
	suspendErr     error
	resumeErr      error
	manageBde      string
	manageBdeErr   error
	bootAt         time.Time
	events         []string
}

func newSurfaceRig(t *testing.T) *surfaceRig {
	t.Helper()
	rig := &surfaceRig{
		runFixture:  newRunFixture(t),
		maker:       "Microsoft Corporation",
		model:       "Surface Laptop 5",
		installFail: map[string]error{},
		installSkip: map[string]bool{},
		reboot:      map[string]bool{},

		installStarted: map[string]bool{},
		power:          PowerStatus{ACLineStatus: 1, BatteryFlag: 1, BatteryLifePercent: 90},
		blVolume:       security.BitLockerStateOn,
		manageBde:      boundManageBde,
	}
	rig.bootAt = rig.clock.Now().Add(-24 * time.Hour)
	rig.deps.Power = fakePower{status: rig.power}
	rig.guardDeps = bitlockerguard.Deps{
		Store:    rig.store,
		Now:      rig.clock.Now,
		BootTime: func() (time.Time, error) { return rig.bootAt, nil },
		State: func() (string, error) {
			rig.mu.Lock()
			defer rig.mu.Unlock()
			return rig.blVolume, rig.blStateErr
		},
		Protectors: func(context.Context) (string, error) {
			rig.event("manage-bde")
			return rig.manageBde, rig.manageBdeErr
		},
		SuspendVolume: func(_ context.Context, count int) error {
			rig.event(fmt.Sprintf("suspend:%d", count))
			if rig.suspendErr != nil {
				return rig.suspendErr
			}
			rig.mu.Lock()
			defer rig.mu.Unlock()
			rig.blVolume = security.BitLockerStateSuspended
			return nil
		},
		ResumeVolume: func(context.Context) error {
			rig.event("resume")
			if rig.resumeErr != nil {
				return rig.resumeErr
			}
			rig.mu.Lock()
			defer rig.mu.Unlock()
			rig.blVolume = security.BitLockerStateOn
			return nil
		},
		RebootPending: func() (bool, error) { return false, nil },
	}
	rig.host = surfaceHost{
		identity: func() (string, string, error) {
			rig.mu.Lock()
			defer rig.mu.Unlock()
			rig.identities++
			return rig.maker, rig.model, rig.identityErr
		},
		updatesDisabled: func() bool { return rig.wuDisabled },
		search: func(context.Context) ([]patching.DriverUpdate, error) {
			rig.searches++
			rig.event("search")
			return rig.updates, rig.searchErr
		},
		install: func(_ context.Context, ids []string) []patching.DriverInstallOutcome {
			out := make([]patching.DriverInstallOutcome, 0, len(ids))
			for _, id := range ids {
				rig.event("install:" + id)
				o := patching.DriverInstallOutcome{UpdateID: id, Err: rig.installFail[id], InstallStarted: rig.installStarted[id]}
				o.Result = patching.InstallResult{PatchID: id, RebootRequired: rig.reboot[id], Skipped: rig.installSkip[id]}
				out = append(out, o)
			}
			return out
		},
		rebootPending: func() (bool, error) { return rig.pending, rig.pendingErr },
		power:         func() (PowerStatus, error) { return rig.power, rig.powerErr },
		guard:         rig.guardDeps,
	}
	rig.lane = newSurfaceLane(rig.host)
	rig.req.Lane = LaneSurface
	rig.req.Categories = []string{CategoryFirmware, CategoryDriver}
	return rig
}

func (r *surfaceRig) event(e string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, e)
}

func (r *surfaceRig) got() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.events...)
}

func (r *surfaceRig) has(prefix string) bool {
	for _, e := range r.got() {
		if strings.HasPrefix(e, prefix) {
			return true
		}
	}
	return false
}

func (r *surfaceRig) runIt(t *testing.T) RunResult {
	t.Helper()
	res := Run(context.Background(), r.req, r.lane, r.deps)
	if err := res.Validate(); err != nil {
		t.Fatalf("a result must always meet the contract: %v (%+v)", err, res)
	}
	if res.Lane != LaneSurface {
		t.Fatalf("lane = %q", res.Lane)
	}
	return res
}

func code(r RunResult) string {
	if r.ErrorCode == nil {
		return ""
	}
	return *r.ErrorCode
}

func skipReason(r RunResult, category string) string {
	for _, s := range r.SkippedCategories {
		if s.Category == category {
			return s.Reason
		}
	}
	return ""
}

func TestSurfaceLaneIsBuilt(t *testing.T) {
	l, ok := LaneFor(LaneSurface)
	if !ok || l.ID() != LaneSurface {
		t.Fatal("no surface lane")
	}
	again, _ := LaneFor(LaneSurface)
	if again.Gate() != l.Gate() {
		t.Fatal("the lane must be a singleton so its gate stays cached")
	}
}

// Even a payload that names a tool cannot reach a fetch, an install or a process.
func TestSurfaceInstallsNoSoftware(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.updates = []patching.DriverUpdate{drvUpdate("d1"), fwUpdate("f1")}
	fetcher := &fakeFetcher{}
	rig.deps.Fetcher = fetcher
	rig.req.Tool = &ToolSpec{
		Version: "1.0.0", MinSafeVersion: "1.0.0", SupportedRange: VersionRange{Min: "1.0.0", MaxExclusive: "2.0.0"},
		URL: "https://evil.example/tool.exe", SHA256: strings.Repeat("a", 64), Prerequisites: []Prerequisite{},
	}
	res := rig.runIt(t)
	if res.Outcome != OutcomeSuccessRebootRequired {
		t.Fatalf("outcome = %s (%s)", res.Outcome, code(res))
	}
	if got := fetcher.Fetched(); len(got) != 0 {
		t.Fatalf("fetched %v", got)
	}
	if calls := rig.exec.Calls(); len(calls) != 0 {
		t.Fatalf("ran processes through Exec: %v", calls)
	}
	if got := rig.ver.Verified(); len(got) != 0 {
		t.Fatalf("verified a tool: %v", got)
	}
	if res.ToolVersion != nil {
		t.Fatalf("toolVersion = %q: there is no tool", *res.ToolVersion)
	}
	if rig.lane.Allow().Hosts != nil || rig.lane.Allow().Publishers != nil {
		t.Fatalf("the lane must allow nothing: %+v", rig.lane.Allow())
	}
	if _, ok := rig.lane.Prerequisite(dotnetDesktopRuntime); ok {
		t.Fatal("the lane must have no prerequisite to install")
	}
	if _, ok := compiledAllowlists[LaneSurface]; ok {
		t.Fatal("allowlist.json must not name surface: it has nothing to download")
	}
}

func TestSurfaceGateQuietOnNonSurface(t *testing.T) {
	logs := captureLogs(t)
	rig := newSurfaceRig(t)
	rig.maker, rig.model = "Dell Inc.", "Latitude 7440"
	for i := 0; i < 3; i++ {
		res := rig.runIt(t)
		if res.Outcome != OutcomeNotSupported || code(res) != "not_surface" {
			t.Fatalf("result = %+v", res)
		}
	}
	if rig.identities != 1 {
		t.Fatalf("identity read %d times, want 1: a negative answer is cached", rig.identities)
	}
	if rig.searches != 0 || len(rig.exec.Calls()) != 0 {
		t.Fatalf("searches=%d exec=%v: the gate must not spawn or search", rig.searches, rig.exec.Calls())
	}
	for _, level := range []string{"level=WARN", "level=ERROR"} {
		if strings.Contains(logs.String(), level) {
			t.Fatalf("logged %s on a machine that is simply not a Surface:\n%s", level, logs.String())
		}
	}
}

// Review Focus 1, on the agent's side of the check.
func TestSurfaceIdentityNearMissesAreNotSurface(t *testing.T) {
	cases := []struct {
		maker, model string
		want         bool
	}{
		{"Microsoft Corporation", "Surface Laptop 5", true},
		{"microsoft corporation", "surface pro 9", true},
		{"  Microsoft Corporation ", " Surface Go 3 ", true},
		{"Microsoft Corporation", "Virtual Machine", false},
		{"Microsoft Corporation", "Surfacebook Clone", false},
		{"Microsoft Corporation", "Not a Surface", false},
		{"Microsoft Corporation", "", false},
		{"Contoso Ltd", "Surface Laptop 5", false},
		{"Microsoft", "Surface Laptop 5", false},
		{"Microsoft Corporation Ltd", "Surface Laptop 5", false},
		{"", "Surface Laptop 5", false},
		{"", "", false},
	}
	for _, c := range cases {
		if got := isSurfaceIdentity(c.maker, c.model); got != c.want {
			t.Errorf("%q / %q: got %v", c.maker, c.model, got)
		}
	}
}

// not_supported is sticky at the API. A failed read must not earn it.
func TestSurfaceUnreadableIdentityIsNotNotSupported(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.identityErr = errors.New("registry denied")
	res := rig.runIt(t)
	if res.Outcome != OutcomeToolUnavailable || code(res) != "smbios_unreadable" {
		t.Fatalf("result = %+v", res)
	}
	rig.identityErr = nil
	rig.updates = nil
	if res := rig.runIt(t); res.Outcome != OutcomeNoUpdates {
		t.Fatalf("after the read works: %+v: a failed read must not be cached", res)
	}
}

func TestSurfaceWithWindowsUpdateDisabled(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.wuDisabled = true
	res := rig.runIt(t)
	if res.Outcome != OutcomeToolUnavailable || code(res) != "windows_update_disabled" || rig.searches != 0 {
		t.Fatalf("result = %+v searches=%d", res, rig.searches)
	}
}

func TestFirmwareRequiresPcr7Binding(t *testing.T) {
	cases := []struct {
		name   string
		output string
		err    error
		code   string
	}{
		{"not bound", unboundManageBde, nil, "pcr7_not_bound"},
		{"localized output", germanManageBde, nil, "pcr7_unknown"},
		{"manage-bde failed", boundManageBde, errors.New("exit status 1"), "pcr7_unknown"},
	}
	for _, c := range cases {
		t.Run(c.name+", firmware only", func(t *testing.T) {
			rig := newSurfaceRig(t)
			rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
			rig.manageBde, rig.manageBdeErr = c.output, c.err
			res := rig.runIt(t)
			// Not "failed": that keeps a pending verification for a flash that
			// never happened (flashMayHaveRun).
			if res.Outcome != OutcomeRetryLater || code(res) != c.code {
				t.Fatalf("result = %+v", res)
			}
			if list, _ := readPendingVerifications(rig.store); len(list) != 0 {
				t.Fatalf("a refused flash owes no verification: %+v", list)
			}
			if skipReason(res, CategoryFirmware) != SkipGate {
				t.Fatalf("skipped = %+v", res.SkippedCategories)
			}
			if rig.has("suspend") || rig.has("install") {
				t.Fatalf("events = %v: no binding, no suspend, no capsule", rig.got())
			}
		})
		t.Run(c.name+", the driver still goes", func(t *testing.T) {
			rig := newSurfaceRig(t)
			rig.updates = []patching.DriverUpdate{drvUpdate("d1"), fwUpdate("f1")}
			rig.manageBde, rig.manageBdeErr = c.output, c.err
			res := rig.runIt(t)
			if res.Outcome != OutcomeSuccess || code(res) != c.code {
				t.Fatalf("result = %+v", res)
			}
			if rig.has("install:f1") || !rig.has("install:d1") {
				t.Fatalf("events = %v", rig.got())
			}
		})
	}
}

func TestFirmwareRunsSuspendThenResume(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.updates = []patching.DriverUpdate{drvUpdate("d1"), fwUpdate("f1")}
	res := rig.runIt(t)
	if res.Outcome != OutcomeSuccessRebootRequired || !res.RebootRequired {
		t.Fatalf("result = %+v", res)
	}
	want := []string{"search", "install:d1", "manage-bde", "suspend:3", "install:f1"}
	if got := rig.got(); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("events = %v, want %v: the volume is suspended only for the capsule", got, want)
	}
	if rig.blVolume != security.BitLockerStateSuspended {
		t.Fatalf("volume = %s: it stays suspended until the reboot applies the capsule", rig.blVolume)
	}
	// Holding: no resume while the reboot has not happened.
	if r, err := ResumeBitLocker(context.Background(), rig.deps, rig.guardDeps); err != nil || r.Action != bitlockerguard.ActionHeld {
		t.Fatalf("before the reboot: %+v err=%v", r, err)
	}
	// The reboot.
	rig.bootAt = rig.clock.Now().Add(time.Hour)
	rig.clock.Set(rig.bootAt.Add(30 * time.Minute))
	r, err := ResumeBitLocker(context.Background(), rig.deps, rig.guardDeps)
	if err != nil || r.Action != bitlockerguard.ActionResumed || r.Reason != bitlockerguard.ReasonRebooted {
		t.Fatalf("after the reboot: %+v err=%v", r, err)
	}
	if rig.blVolume != security.BitLockerStateOn {
		t.Fatalf("volume = %s", rig.blVolume)
	}
}

func TestFirmwareInstallFailureResumesAtOnce(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	rig.installFail["f1"] = errors.New("WUA install: 0x80240022")
	res := rig.runIt(t)
	if res.Outcome != OutcomeFailed || res.RebootRequired {
		t.Fatalf("result = %+v", res)
	}
	if rig.blVolume != security.BitLockerStateOn || !rig.has("resume") {
		t.Fatalf("volume=%s events=%v: nothing staged, so nothing to stay suspended for", rig.blVolume, rig.got())
	}
	if held, _ := bitlockerguard.Held(rig.guardDeps); held {
		t.Fatal("the record must be closed")
	}
}

// An error once WUA began installing says nothing about the capsule. It may be
// staged, and resuming under it risks a recovery prompt, so the volume stays
// suspended and the reboot that settles it is asked for.
func TestFirmwareErrorAfterInstallStartedStaysSuspended(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	rig.installFail["f1"] = errors.New("install failed: missing result")
	rig.installStarted["f1"] = true
	res := rig.runIt(t)
	if res.Outcome != OutcomeFailed || !res.RebootRequired || code(res) != "firmware_install_uncertain" {
		t.Fatalf("result = %+v", res)
	}
	if rig.has("resume") || rig.blVolume != security.BitLockerStateSuspended {
		t.Fatalf("events=%v volume=%s", rig.got(), rig.blVolume)
	}
	if list, _ := readPendingVerifications(rig.store); len(list) != 1 {
		t.Fatalf("the reboot still owes a verification: %+v", list)
	}
}

func TestFirmwareInstallWithAMissingOutcomeStaysSuspended(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	rig.host.install = func(context.Context, []string) []patching.DriverInstallOutcome { return nil }
	rig.lane = newSurfaceLane(rig.host)
	res := rig.runIt(t)
	if res.Outcome != OutcomeFailed || !res.RebootRequired || rig.has("resume") || code(res) != "firmware_install_uncertain" {
		t.Fatalf("result=%+v events=%v", res, rig.got())
	}
	if list, _ := readPendingVerifications(rig.store); len(list) != 1 {
		t.Fatalf("the reboot still owes a verification: %+v", list)
	}
}

// A second run before the reboot must not read as "the device came back": the API
// would disarm its not-returned monitor and clear the reboot clock.
func TestSurfaceRunBeforeTheOwedRebootSaysARebootIsOwed(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	if res := rig.runIt(t); !res.RebootRequired {
		t.Fatalf("first run = %+v", res)
	}
	rig.searches = 0
	rig.pending = false // Windows set no flag; the lane staged on its own judgment
	res := rig.runIt(t)
	if res.Outcome != OutcomeBlockedRebootPending || !res.RebootRequired || code(res) != "bitlocker_guard_open" {
		t.Fatalf("second run = %+v", res)
	}
	if rig.searches != 0 {
		t.Fatal("it must stop before searching")
	}
	// Rebooted, guard still settling: nothing is owed any more, so try again later.
	rig.bootAt = rig.clock.Now().Add(time.Hour)
	res = rig.runIt(t)
	if res.Outcome != OutcomeRetryLater || res.RebootRequired {
		t.Fatalf("after the reboot = %+v", res)
	}
}

func TestSurfaceRefusesOnAnUnreadableGuardRecord(t *testing.T) {
	rig := newSurfaceRig(t)
	if err := rig.store.WriteFile("bitlocker-guard.json", []byte("{not json")); err != nil {
		t.Fatal(err)
	}
	rig.updates = []patching.DriverUpdate{drvUpdate("d1"), fwUpdate("f1")}
	res := rig.runIt(t)
	if res.Outcome != OutcomeRetryLater || code(res) != "bitlocker_guard_open" || rig.has("install") || rig.has("suspend") {
		t.Fatalf("result=%+v events=%v", res, rig.got())
	}
}

func TestToolFreeLaneCannotReportReadyWithAnError(t *testing.T) {
	_, outcome, err := EnsureTool(context.Background(), brokenToolFree{newFakeLane()}, nil, Deps{})
	if err == nil || outcome != OutcomeToolUnavailable {
		t.Fatalf("outcome=%q err=%v", outcome, err)
	}
}

type brokenToolFree struct{ *fakeLane }

func (brokenToolFree) toolFree() {}

func (brokenToolFree) Ready() (ToolState, Outcome, error) {
	return ToolState{}, "", errors.New("could not tell")
}

func TestFirmwareSkippedByWindowsUpdateResumesAtOnce(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	rig.installSkip["f1"] = true
	res := rig.runIt(t)
	if res.Outcome != OutcomeNoUpdates || res.RebootRequired || rig.blVolume != security.BitLockerStateOn {
		t.Fatalf("result=%+v volume=%s", res, rig.blVolume)
	}
}

func TestPartialFirmwareStaysSuspendedForWhatInstalled(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.updates = []patching.DriverUpdate{fwUpdate("f1"), fwUpdate("f2")}
	rig.installFail["f2"] = errors.New("WUA install failed")
	res := rig.runIt(t)
	if res.Outcome != OutcomePartial || !res.RebootRequired {
		t.Fatalf("result = %+v", res)
	}
	if rig.blVolume != security.BitLockerStateSuspended || rig.has("resume") {
		t.Fatalf("volume=%s events=%v: f1 is staged and needs the reboot", rig.blVolume, rig.got())
	}
}

func TestFailedResumeIsNamedAndKeepsTheRecord(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	rig.installFail["f1"] = errors.New("failed")
	rig.resumeErr = errors.New("access denied")
	res := rig.runIt(t)
	if res.Outcome != OutcomeFailed || code(res) != "bitlocker_resume_failed" {
		t.Fatalf("result = %+v", res)
	}
	if held, _ := bitlockerguard.Held(rig.guardDeps); !held {
		t.Fatal("the record must stay so the guard keeps trying")
	}
	// Nothing is staged, so the guard retries now rather than waiting for a reboot.
	rig.resumeErr = nil
	r, err := ResumeBitLocker(context.Background(), rig.deps, rig.guardDeps)
	if err != nil || r.Action != bitlockerguard.ActionResumed || r.Reason != bitlockerguard.ReasonNoInstall {
		t.Fatalf("res=%+v err=%v", r, err)
	}
}

func TestRebootCountAtLeastThree(t *testing.T) {
	if surfaceRebootCount < bitlockerguard.MinRebootCount || surfaceRebootCount < 3 {
		t.Fatalf("surfaceRebootCount = %d", surfaceRebootCount)
	}
	rig := newSurfaceRig(t)
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	rig.runIt(t)
	found := false
	for _, e := range rig.got() {
		if rest, ok := strings.CutPrefix(e, "suspend:"); ok {
			found = true
			var n int
			if _, err := fmt.Sscanf(rest, "%d", &n); err != nil || n < 3 {
				t.Fatalf("suspended with %q", rest)
			}
		}
	}
	if !found {
		t.Fatalf("never suspended: %v", rig.got())
	}
}

func TestBattery25Mandatory(t *testing.T) {
	low := PowerStatus{ACLineStatus: 1, BatteryFlag: 2, BatteryLifePercent: 24}
	exact := PowerStatus{ACLineStatus: 1, BatteryFlag: 8, BatteryLifePercent: 25}

	t.Run("the runner's gate", func(t *testing.T) {
		rig := newSurfaceRig(t)
		rig.deps.Power = fakePower{status: low}
		rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
		rig.req.Categories = []string{CategoryFirmware}
		res := rig.runIt(t)
		if res.Outcome != OutcomeBlockedOnBattery || rig.has("suspend") || rig.searches != 0 {
			t.Fatalf("result=%+v events=%v", res, rig.got())
		}
	})
	t.Run("at the floor", func(t *testing.T) {
		rig := newSurfaceRig(t)
		rig.deps.Power = fakePower{status: exact}
		rig.power = exact
		rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
		res := rig.runIt(t)
		if res.Outcome != OutcomeSuccessRebootRequired || !rig.has("install:f1") {
			t.Fatalf("result=%+v events=%v", res, rig.got())
		}
	})
	// A driver install can take minutes, and a laptop can be unplugged in them.
	t.Run("re-read right before the suspend", func(t *testing.T) {
		rig := newSurfaceRig(t)
		rig.power = low
		rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
		res := rig.runIt(t)
		if res.Outcome != OutcomeBlockedOnBattery || skipReason(res, CategoryFirmware) != SkipPower {
			t.Fatalf("result = %+v", res)
		}
		if rig.has("suspend") || rig.has("install") {
			t.Fatalf("events = %v", rig.got())
		}
	})
	t.Run("unreadable power refuses", func(t *testing.T) {
		rig := newSurfaceRig(t)
		rig.powerErr = errors.New("no reading")
		rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
		res := rig.runIt(t)
		if res.Outcome != OutcomeBlockedOnBattery || code(res) != "power_unreadable" || rig.has("suspend") {
			t.Fatalf("result=%+v events=%v", res, rig.got())
		}
	})
	t.Run("the driver still goes", func(t *testing.T) {
		rig := newSurfaceRig(t)
		rig.power = low
		rig.updates = []patching.DriverUpdate{drvUpdate("d1"), fwUpdate("f1")}
		res := rig.runIt(t)
		if res.Outcome != OutcomeSuccess || !rig.has("install:d1") || rig.has("install:f1") {
			t.Fatalf("result=%+v events=%v", res, rig.got())
		}
	})
}

func TestFirmwareIrreversibleCopyInResult(t *testing.T) {
	rig := newSurfaceRig(t)
	long := fwUpdate("f2")
	long.Title = strings.Repeat("x", 400)
	rig.updates = []patching.DriverUpdate{drvUpdate("d1"), fwUpdate("f1"), long}
	res := rig.runIt(t)
	if len(res.Items) != 3 {
		t.Fatalf("items = %+v", res.Items)
	}
	for _, it := range res.Items {
		has := strings.Contains(it.Title, "cannot be rolled back")
		if it.Category == CategoryFirmware && !has {
			t.Errorf("firmware item without the copy: %q", it.Title)
		}
		if it.Category == CategoryDriver && has {
			t.Errorf("driver item with the copy: %q", it.Title)
		}
		if len([]rune(it.Title)) > maxItemTitle {
			t.Errorf("title too long: %d", len([]rune(it.Title)))
		}
	}
}

func TestSurfaceNoUpdatesMapsToNoUpdates(t *testing.T) {
	intel := patching.DriverUpdate{UpdateID: "i1", Title: "Intel - Display", DriverManufacturer: "Intel", DriverClass: "Display"}
	cases := []struct {
		name    string
		updates []patching.DriverUpdate
		blocked []string
		cats    []string
	}{
		{"nothing pending", nil, nil, nil},
		{"only another vendor's", []patching.DriverUpdate{intel}, nil, nil},
		{"all blocked", []patching.DriverUpdate{drvUpdate("d1"), fwUpdate("f1")}, []string{"D1", "{f1}"}, nil},
		{"driver asked, only firmware pending", []patching.DriverUpdate{fwUpdate("f1")}, nil, []string{CategoryDriver}},
		{"firmware asked, only a driver pending", []patching.DriverUpdate{drvUpdate("d1")}, nil, []string{CategoryFirmware}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rig := newSurfaceRig(t)
			rig.updates = c.updates
			rig.req.BlockedUpdateIDs = append([]string{}, c.blocked...)
			if c.cats != nil {
				rig.req.Categories = c.cats
			}
			res := rig.runIt(t)
			if res.Outcome != OutcomeNoUpdates || res.RebootRequired {
				t.Fatalf("result = %+v", res)
			}
			if rig.has("suspend") || rig.has("install") {
				t.Fatalf("events = %v", rig.got())
			}
			if rig.blVolume != security.BitLockerStateOn {
				t.Fatalf("volume = %s", rig.blVolume)
			}
		})
	}
}

// W03 relies on this: a clean result means an earlier flash's reboot has happened.
func TestSurfaceReportsAnExistingPendingReboot(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.pending = true
	rig.updates = []patching.DriverUpdate{drvUpdate("d1"), fwUpdate("f1")}
	res := rig.runIt(t)
	if res.Outcome != OutcomeBlockedRebootPending || !res.RebootRequired {
		t.Fatalf("result = %+v", res)
	}
	if rig.searches != 0 || rig.has("suspend") || rig.has("install") {
		t.Fatalf("events = %v", rig.got())
	}
}

func TestSurfaceUnreadablePendingRebootRefuses(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.pendingErr = errors.New("registry denied")
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	res := rig.runIt(t)
	if res.Outcome != OutcomeBlockedRebootPending || code(res) != "reboot_state_unreadable" || res.RebootRequired {
		t.Fatalf("result = %+v: unknown must not schedule a reboot", res)
	}
	if rig.has("install") {
		t.Fatalf("events = %v", rig.got())
	}
}

func TestSurfaceRefusesWhileAnEarlierSuspensionIsOpen(t *testing.T) {
	rig := newSurfaceRig(t)
	if _, err := bitlockerguard.Suspend(context.Background(), surfaceRebootCount, rig.guardDeps); err != nil {
		t.Fatal(err)
	}
	rig.updates = []patching.DriverUpdate{drvUpdate("d1")}
	res := rig.runIt(t)
	if res.Outcome != OutcomeRetryLater || code(res) != "bitlocker_guard_open" || rig.has("install") {
		t.Fatalf("result=%+v events=%v", res, rig.got())
	}
}

func TestFirmwareRefusedWhenTheVolumeIsSuspendedBySomeoneElse(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.blVolume = security.BitLockerStateSuspended
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	res := rig.runIt(t)
	if res.Outcome != OutcomeRetryLater || code(res) != "bitlocker_already_suspended" {
		t.Fatalf("result = %+v", res)
	}
	// After the next reboot this would report "suspended" and raise an alert
	// against a run that never touched the volume.
	if list, _ := readPendingVerifications(rig.store); len(list) != 0 {
		t.Fatalf("a refused flash owes no verification: %+v", list)
	}
	if rig.has("install") || rig.has("suspend") || rig.has("resume") || rig.blVolume != security.BitLockerStateSuspended {
		t.Fatalf("events=%v volume=%s: their suspension stays as it was", rig.got(), rig.blVolume)
	}
}

func TestFirmwareOnAVolumeWithBitLockerOffNeedsNoSuspend(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.blVolume = security.BitLockerStateOff
	rig.prot.live = LiveProtectors{BitLockerOn: false}
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	res := rig.runIt(t)
	if res.Outcome != OutcomeSuccessRebootRequired || !rig.has("install:f1") {
		t.Fatalf("result=%+v events=%v", res, rig.got())
	}
	if rig.has("suspend") || rig.has("manage-bde") {
		t.Fatalf("events = %v", rig.got())
	}
}

func TestFirmwareRefusedWhenBitLockerStateIsUnknown(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.blStateErr = errors.New("powershell failed")
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	res := rig.runIt(t)
	if res.Outcome != OutcomeRetryLater || code(res) != "bitlocker_unreadable" || rig.has("install") {
		t.Fatalf("result=%+v events=%v", res, rig.got())
	}
}

func TestFirmwareRefusedWhenSuspendFails(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.suspendErr = errors.New("access denied")
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	res := rig.runIt(t)
	if res.Outcome != OutcomeRetryLater || code(res) != "bitlocker_suspend_failed" || rig.has("install") {
		t.Fatalf("result=%+v events=%v", res, rig.got())
	}
}

// No durable "installing" means a restart could resume under a staged capsule.
func TestFirmwareRefusedWhenItCannotRecordTheInstall(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	inner := rig.guardDeps.SuspendVolume
	rig.host.guard.SuspendVolume = func(ctx context.Context, n int) error {
		err := inner(ctx, n)
		rig.host.guard.Store = readOnlyStore{Store: rig.store}
		rig.lane.host.guard.Store = rig.host.guard.Store
		return err
	}
	rig.lane = newSurfaceLane(rig.host)
	res := rig.runIt(t)
	if rig.has("install") || code(res) != "bitlocker_record_failed" {
		t.Fatalf("result=%+v events=%v", res, rig.got())
	}
	if rig.blVolume != security.BitLockerStateOn {
		t.Fatalf("volume = %s: it goes back when the install will not happen", rig.blVolume)
	}
}

type readOnlyStore struct{ Store }

func (readOnlyStore) WriteFile(string, []byte) error { return errors.New("disk full") }

func TestDriverOnlyRunNeverTouchesBitLocker(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.req.Categories = []string{CategoryDriver}
	rig.req.RebootControlled = false
	rig.updates = []patching.DriverUpdate{drvUpdate("d1"), fwUpdate("f1")}
	rig.reboot["d1"] = true
	res := rig.runIt(t)
	if res.Outcome != OutcomeSuccessRebootRequired || !rig.has("install:d1") {
		t.Fatalf("result=%+v events=%v", res, rig.got())
	}
	if rig.has("manage-bde") || rig.has("suspend") || rig.has("install:f1") {
		t.Fatalf("events = %v", rig.got())
	}
}

func TestDriverRebootOnlyWhenAsked(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.req.Categories = []string{CategoryDriver}
	rig.updates = []patching.DriverUpdate{drvUpdate("d1")}
	res := rig.runIt(t)
	if res.Outcome != OutcomeSuccess || res.RebootRequired {
		t.Fatalf("result = %+v", res)
	}
}

func TestFirmwareNeedsARebootBreezeControls(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.req.RebootControlled = false
	rig.updates = []patching.DriverUpdate{drvUpdate("d1"), fwUpdate("f1")}
	res := rig.runIt(t)
	if skipReason(res, CategoryFirmware) != SkipNoRebootControl || rig.has("install:f1") || rig.has("suspend") {
		t.Fatalf("result=%+v events=%v", res, rig.got())
	}
}

func TestFirmwareNeedsARecoveryKey(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.req.EscrowedProtectorIDs = []string{}
	rig.req.Categories = []string{CategoryFirmware}
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	res := rig.runIt(t)
	if res.Outcome != OutcomeBlockedNoRecoveryKey || rig.has("suspend") || rig.has("install") {
		t.Fatalf("result=%+v events=%v", res, rig.got())
	}
}

// DriverClass is unconfirmed, so a "driver" could write firmware. Until W12, every
// run holds the flash guard, and a reboot waits for it.
func TestSurfaceRunHoldsTheFlashGuard(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.req.Categories = []string{CategoryDriver}
	rig.updates = []patching.DriverUpdate{drvUpdate("d1")}
	held := false
	inner := rig.host.install
	rig.host.install = func(ctx context.Context, ids []string) []patching.DriverInstallOutcome {
		_, held = rig.guard.Active()
		return inner(ctx, ids)
	}
	rig.lane = newSurfaceLane(rig.host)
	rig.runIt(t)
	if !held {
		t.Fatal("the flash guard must be held during the install")
	}
}

func TestSurfaceCategoriesWithNothingBehindThemAreReported(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.req.Categories = []string{CategoryBIOS, CategoryApplication, CategoryDriver}
	rig.updates = []patching.DriverUpdate{drvUpdate("d1"), fwUpdate("f1")}
	res := rig.runIt(t)
	if skipReason(res, CategoryBIOS) != SkipGate || skipReason(res, CategoryApplication) != SkipGate {
		t.Fatalf("skipped = %+v", res.SkippedCategories)
	}
	if rig.has("install:f1") || !rig.has("install:d1") {
		t.Fatalf("events = %v: bios must not be read as firmware", rig.got())
	}
}

func TestSurfaceFilterIsPureAndNeverWidens(t *testing.T) {
	l := newSurfaceRig(t).lane
	plan, err := l.Filter([]string{CategoryDriver, CategoryFirmware}, []string{"any id, even one from another vendor"})
	if err != nil || len(plan.Categories) != 2 || len(plan.BlockedIDs) != 1 {
		t.Fatalf("plan=%+v err=%v", plan, err)
	}
	if plan.Categories[0] != CategoryFirmware {
		t.Fatalf("order = %v", plan.Categories)
	}
	if _, err := l.Filter([]string{"acme"}, nil); err == nil {
		t.Fatal("an unknown category must be refused")
	}
}

func TestSurfaceSearchFailureIsNotNoUpdates(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.searchErr = errors.New("0x8024402c")
	res := rig.runIt(t)
	if res.Outcome != OutcomeRetryLater || code(res) != "wu_search_failed" {
		t.Fatalf("result = %+v", res)
	}
}

func TestSurfaceBlockedIdIsNeverInstalled(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.req.BlockedUpdateIDs = []string{"F1"}
	rig.updates = []patching.DriverUpdate{drvUpdate("d1"), fwUpdate("f1")}
	res := rig.runIt(t)
	if res.Outcome != OutcomeSuccess || rig.has("install:f1") || rig.has("suspend") {
		t.Fatalf("result=%+v events=%v", res, rig.got())
	}
}

func TestSurfaceAllDriversFailed(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.req.Categories = []string{CategoryDriver}
	rig.updates = []patching.DriverUpdate{drvUpdate("d1")}
	rig.installFail["d1"] = errors.New("failed")
	res := rig.runIt(t)
	if res.Outcome != OutcomeFailed || code(res) != "install_failed" || len(res.Items) != 1 || res.Items[0].Result != ItemFailed {
		t.Fatalf("result = %+v", res)
	}
}

// Catalog text is untrusted.
func TestSurfaceTitlesAreSanitized(t *testing.T) {
	rig := newSurfaceRig(t)
	bad := drvUpdate("d1")
	bad.Title = "line\nbreak\x00\x07 title"
	rig.updates = []patching.DriverUpdate{bad}
	res := rig.runIt(t)
	if strings.ContainsAny(res.Items[0].Title, "\n\x00\x07") {
		t.Fatalf("title = %q", res.Items[0].Title)
	}
}

func TestResumeBitLockerWaitsForALiveRun(t *testing.T) {
	rig := newSurfaceRig(t)
	if _, err := bitlockerguard.Suspend(context.Background(), surfaceRebootCount, rig.guardDeps); err != nil {
		t.Fatal(err)
	}
	release, err := AcquireRunLock(rig.store)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	r, err := ResumeBitLocker(context.Background(), rig.deps, rig.guardDeps)
	if err != nil || r.Action != bitlockerguard.ActionHeld || rig.has("resume") {
		t.Fatalf("res=%+v err=%v events=%v: a tick must not resume under a live run", r, err, rig.got())
	}
}

func TestResumeBitLockerWaitsForAnOpenFlashSection(t *testing.T) {
	rig := newSurfaceRig(t)
	if _, err := bitlockerguard.Suspend(context.Background(), surfaceRebootCount, rig.guardDeps); err != nil {
		t.Fatal(err)
	}
	done, err := rig.guard.Enter(flashSectionKind, testCommandID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = done() }()
	r, err := ResumeBitLocker(context.Background(), rig.deps, rig.guardDeps)
	if err != nil || r.Action != bitlockerguard.ActionHeld || rig.has("resume") {
		t.Fatalf("res=%+v err=%v events=%v", r, err, rig.got())
	}
}

// "Reports": WARN and above is what the agent ships to the server.
func TestResumeBitLockerPastTheDeadlineReports(t *testing.T) {
	rig := newSurfaceRig(t)
	rig.updates = []patching.DriverUpdate{fwUpdate("f1")}
	rig.runIt(t)
	logs := captureLogs(t)
	rig.guardDeps.Now = func() time.Time { return rig.clock.Now().Add(bitlockerguard.ResumeDeadline) }
	r, err := ResumeBitLocker(context.Background(), rig.deps, rig.guardDeps)
	if err != nil || r.Reason != bitlockerguard.ReasonDeadline {
		t.Fatalf("res=%+v err=%v", r, err)
	}
	if rig.blVolume != security.BitLockerStateOn {
		t.Fatalf("volume = %s", rig.blVolume)
	}
	if !strings.Contains(logs.String(), "level=WARN") {
		t.Fatalf("no WARN:\n%s", logs.String())
	}
}

// The verification reads BitLocker. Reading it while the guard still holds would
// raise a "left suspended" alert for a volume about to be resumed.
func TestVerificationWaitsForTheGuard(t *testing.T) {
	rig := newSurfaceRig(t)
	if err := addPendingVerification(rig.store, PendingVerification{CommandID: testCommandID, VerifyAfter: rig.clock.Now(), CreatedAt: rig.clock.Now()}); err != nil {
		t.Fatal(err)
	}
	rig.sys.boot = rig.clock.Now().Add(time.Hour)
	reports := 0
	report := func(Verification) error { reports++; return nil }
	held := true
	rig.deps.BitLockerHeld = func() bool { return held }
	if err := VerifyPending(context.Background(), rig.deps, report); err != nil || reports != 0 {
		t.Fatalf("held: err=%v reports=%d", err, reports)
	}
	if list, _ := readPendingVerifications(rig.store); len(list) != 1 {
		t.Fatalf("the entry must wait: %+v", list)
	}
	held = false
	if err := VerifyPending(context.Background(), rig.deps, report); err != nil || reports != 1 {
		t.Fatalf("released: err=%v reports=%d", err, reports)
	}
}
