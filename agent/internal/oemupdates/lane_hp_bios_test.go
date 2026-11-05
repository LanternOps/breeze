package oemupdates

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	testPowerShell  = `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
	testModulesDir  = `C:\Program Files\WindowsPowerShell\Modules`
	testCmslDir     = testModulesDir + `\HPCMSL`
	testFirmwareDir = testModulesDir + `\HP.Firmware`
	testCmslPsd1    = testCmslDir + `\1.8.5\HPCMSL.psd1`
	testFirmwarePsm = testFirmwareDir + `\1.9.1\HP.Firmware.psm1`
)

func (f *hpFixture) installCmsl() {
	f.dirs[testCmslDir] = []string{"1.7.0", "1.8.5", "notes"}
	f.dirs[testFirmwareDir] = []string{"1.9.1"}
}

// biosExec answers PowerShell with biosCode and HPIA with hpiaCode.
func biosExec(biosCode, hpiaCode int64) *fakeExec {
	return &fakeExec{run: func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		if spec.Path == testPowerShell {
			return ExecResult{ExitCode: biosCode}, nil
		}
		for _, a := range spec.Args {
			if dir, ok := strings.CutPrefix(a, "/ReportFolder:"); ok {
				if err := os.WriteFile(filepath.Join(dir, "report.xml"), []byte(`<HPIA><Recommendations/></HPIA>`), 0o600); err != nil {
					return ExecResult{}, err
				}
			}
		}
		return ExecResult{ExitCode: hpiaCode}, nil
	}}
}

func powerShellCalls(ex *fakeExec) []ExecSpec {
	var out []ExecSpec
	for _, c := range ex.Calls() {
		if c.Path == testPowerShell {
			out = append(out, c)
		}
	}
	return out
}

func skipOf(r RunResult, category string) (SkippedCategory, bool) {
	for _, s := range r.SkippedCategories {
		if s.Category == category {
			return s, true
		}
	}
	return SkippedCategory{}, false
}

func TestHpBiosSkippedWithoutCmsl(t *testing.T) {
	buf := captureLogs(t)

	t.Run("beside other categories", func(t *testing.T) {
		f := newHpFixture(t)
		ex := biosExec(3010, 0)
		r := f.apply(t, []string{CategoryBIOS, CategoryDriver}, nil, ex)
		if s, ok := skipOf(r, CategoryBIOS); !ok || s.Reason != SkipGate {
			t.Fatalf("skips = %+v", r.SkippedCategories)
		}
		if len(powerShellCalls(ex)) != 0 {
			t.Fatal("PowerShell ran without CMSL")
		}
		if len(ex.Calls()) != 1 || r.Outcome != OutcomeSuccess || hpCode(r) != "hp_cmsl_absent" {
			t.Fatalf("the driver run must still go: %+v code=%q", r, hpCode(r))
		}
	})

	t.Run("alone", func(t *testing.T) {
		f := newHpFixture(t)
		ex := biosExec(3010, 0)
		r := f.apply(t, []string{CategoryBIOS}, nil, ex)
		if len(ex.Calls()) != 0 || r.Outcome != OutcomeToolUnavailable || hpCode(r) != "hp_cmsl_absent" || r.RebootRequired {
			t.Fatalf("%+v code=%q calls=%d", r, hpCode(r), len(ex.Calls()))
		}
		if _, ok := skipOf(r, CategoryBIOS); !ok {
			t.Fatalf("skips = %+v", r.SkippedCategories)
		}
	})

	t.Run("the gate is cached and spawns nothing", func(t *testing.T) {
		f := newHpFixture(t)
		ex := biosExec(0, 0)
		for i := 0; i < 3; i++ {
			f.apply(t, []string{CategoryBIOS}, nil, ex)
		}
		if f.dirChecks != 1 {
			t.Fatalf("the module directory was checked %d times, want 1", f.dirChecks)
		}
		if len(ex.Calls()) != 0 {
			t.Fatal("spawned a process to look for CMSL")
		}
	})

	if s := buf.String(); strings.Contains(s, "level=WARN") || strings.Contains(s, "level=INFO") {
		t.Fatalf("a machine without CMSL logged above DEBUG:\n%s", s)
	}
}

func TestHpBiosGateLooksOnlyAtTheModuleDirectory(t *testing.T) {
	f := newHpFixture(t)
	f.dirs[`C:\Users\someone\Documents\WindowsPowerShell\Modules\HPCMSL`] = []string{"1.8.5"}
	f.dirs[`C:\Program Files\WindowsPowerShell\Modules\HP.Firmware`] = []string{"1.9.1"}
	if f.lane.cmsl.Get().Present {
		t.Fatal("found CMSL without the HPCMSL module under Program Files")
	}
	f.lane.cmsl.Invalidate()
	f.installCmsl()
	state := f.lane.cmsl.Get()
	if !state.Present || state.Path != testModulesDir {
		t.Fatalf("state = %+v", state)
	}
}

func TestHpBiosArgv(t *testing.T) {
	f := newHpFixture(t)
	f.installCmsl()
	ex := biosExec(3010, 0)
	f.apply(t, []string{CategoryBIOS}, nil, ex)
	calls := powerShellCalls(ex)
	if len(calls) != 1 || len(ex.Calls()) != 1 {
		t.Fatalf("calls = %+v", ex.Calls())
	}
	args := calls[0].Args
	want := []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command"}
	if len(args) != len(want)+1 || strings.Join(args[:len(want)], " ") != strings.Join(want, " ") {
		t.Fatalf("args = %q", args)
	}
	script := args[len(want)]
	for _, must := range []string{
		"Get-HPBIOSUpdates -Flash -Yes -BitLocker suspend",
		"Get-HPBIOSUpdates -Check",
		"Import-Module -Name '" + testCmslPsd1 + "'",
	} {
		if !strings.Contains(script, must) {
			t.Errorf("script lacks %q:\n%s", must, script)
		}
	}
	// Nothing that decides what runs comes from the machine's own search path.
	if strings.Contains(script, "Import-Module HPCMSL") || strings.Contains(script, "-Password") {
		t.Errorf("script = %s", script)
	}
}

func TestHpBiosNeverInstallsCmsl(t *testing.T) {
	forbidden := []string{"Install-Module", "Install-Package", "Save-Module", "Install-HP", "winget", "Update-Module", "Set-PSRepository", "Invoke-WebRequest"}
	check := func(t *testing.T, ex *fakeExec) {
		t.Helper()
		for _, c := range ex.Calls() {
			joined := strings.Join(c.Args, " ")
			for _, word := range forbidden {
				if strings.Contains(joined, word) {
					t.Errorf("%q in %s", word, joined)
				}
			}
		}
	}
	t.Run("present", func(t *testing.T) {
		f := newHpFixture(t)
		f.installCmsl()
		ex := biosExec(3010, 0)
		f.apply(t, []string{CategoryBIOS, CategoryDriver}, nil, ex)
		if len(powerShellCalls(ex)) != 1 {
			t.Fatalf("calls = %+v", ex.Calls())
		}
		check(t, ex)
	})
	t.Run("absent, through the runner, with a tool to fetch", func(t *testing.T) {
		rf := newRunFixture(t)
		f := newHpFixture(t)
		f.installTool(t)
		rf.ver.publisher = "HP Inc."
		rf.req.Lane = LaneHP
		rf.req.Categories = []string{CategoryBIOS}
		rf.req.Tool = &ToolSpec{
			Version: "5.3.7", MinSafeVersion: "5.3.3", SupportedRange: VersionRange{Min: "5.3.3", MaxExclusive: "6.0.0"},
			URL: "https://hpia.hpcloud.hp.com/t.exe", SHA256: strings.Repeat("a", 64), Prerequisites: []Prerequisite{},
		}
		fetch := &fakeFetcher{}
		rf.deps.Fetcher = fetch
		r := Run(context.Background(), rf.req, f.lane, rf.deps)
		if r.Outcome != OutcomeToolUnavailable || hpCode(r) != "hp_cmsl_absent" {
			t.Fatalf("%+v code=%q", r, hpCode(r))
		}
		if len(rf.exec.Calls()) != 0 || len(fetch.Fetched()) != 0 {
			t.Fatalf("calls=%+v fetched=%v", rf.exec.Calls(), fetch.Fetched())
		}
	})
	t.Run("a payload cannot name it as a prerequisite", func(t *testing.T) {
		f := newHpFixture(t)
		for _, name := range []string{"hpcmsl", "HPCMSL", "hp_cmsl", dotnetDesktopRuntime} {
			if _, ok := f.lane.Prerequisite(name); ok {
				t.Errorf("prerequisite %q is known", name)
			}
		}
		if _, ok := prerequisiteAllowlist(LaneHP, "hpcmsl"); ok {
			t.Error("the allowlist names CMSL as something to fetch")
		}
	})
}

func TestHpBiosHoldsFlashGuard(t *testing.T) {
	rf := newRunFixture(t)
	f := newHpFixture(t)
	f.installTool(t)
	f.installCmsl()
	rf.ver.publisher = "HP Inc."
	rf.req.Lane = LaneHP
	rf.req.Categories = []string{CategoryBIOS}

	var during, pendingDuring, markerDuring bool
	rf.exec.run = func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		if spec.Path != testPowerShell {
			t.Errorf("ran %s", spec.Path)
		}
		_, during = rf.guard.Active()
		list, err := readPendingVerifications(rf.store)
		pendingDuring = err == nil && len(list) == 1
		m, err := ReadMarker(rf.store)
		markerDuring = err == nil && m.FlashStarted
		return ExecResult{ExitCode: 3010}, nil
	}
	r := Run(context.Background(), rf.req, f.lane, rf.deps)
	if !during {
		t.Fatal("the flash ran outside the guard")
	}
	if !pendingDuring || !markerDuring {
		t.Fatalf("not durable before the flash: pending=%v marker=%v", pendingDuring, markerDuring)
	}
	if _, active := rf.guard.Active(); active {
		t.Fatal("section still open after the run")
	}
	if r.Outcome != OutcomeSuccessRebootRequired || !r.RebootRequired {
		t.Fatalf("%+v", r)
	}
	if list, _ := readPendingVerifications(rf.store); len(list) != 1 {
		t.Fatalf("a post-reboot verification is owed: %+v", list)
	}
}

func TestHpBiosRespectsAnOpenSection(t *testing.T) {
	rf := newRunFixture(t)
	f := newHpFixture(t)
	f.installTool(t)
	f.installCmsl()
	rf.ver.publisher = "HP Inc."
	rf.req.Lane = LaneHP
	rf.req.Categories = []string{CategoryBIOS}
	release, err := rf.guard.Enter(flashSectionKind, "other", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = release() }()
	r := Run(context.Background(), rf.req, f.lane, rf.deps)
	if len(rf.exec.Calls()) != 0 || r.Outcome != OutcomeRetryLater {
		t.Fatalf("%+v calls=%d", r, len(rf.exec.Calls()))
	}
}

func TestHpBiosRunnerGatesStopTheFlash(t *testing.T) {
	onBattery := PowerStatus{ACLineStatus: 0, BatteryFlag: 1, BatteryLifePercent: 90}
	for name, tc := range map[string]struct {
		setup func(rf *runFixture)
		want  Outcome
	}{
		"on battery":           {func(rf *runFixture) { rf.deps.Power = fakePower{status: onBattery} }, OutcomeBlockedOnBattery},
		"no escrowed key":      {func(rf *runFixture) { rf.req.EscrowedProtectorIDs = []string{} }, OutcomeBlockedNoRecoveryKey},
		"bitlocker unreadable": {func(rf *runFixture) { rf.prot.err = errors.New("no module") }, OutcomeBlockedNoRecoveryKey},
		"no reboot control":    {func(rf *runFixture) { rf.req.RebootControlled = false }, OutcomeFailed},
	} {
		t.Run(name, func(t *testing.T) {
			rf := newRunFixture(t)
			f := newHpFixture(t)
			f.installTool(t)
			f.installCmsl()
			rf.ver.publisher = "HP Inc."
			rf.req.Lane = LaneHP
			rf.req.Categories = []string{CategoryBIOS}
			tc.setup(rf)
			r := Run(context.Background(), rf.req, f.lane, rf.deps)
			if len(rf.exec.Calls()) != 0 || r.Outcome != tc.want {
				t.Fatalf("%+v code=%q calls=%d", r, hpCode(r), len(rf.exec.Calls()))
			}
		})
	}
}

func TestHpBiosExitMap(t *testing.T) {
	for _, tc := range []struct {
		name   string
		code   int64
		want   Outcome
		reboot bool
		err    string
		items  int
		owed   bool
	}{
		{"up to date", hpBiosExitUpToDate, OutcomeNoUpdates, false, "", 0, false},
		{"staged", hpBiosExitStaged, OutcomeSuccessRebootRequired, true, "", 1, true},
		// Not "failed": nothing flashed, and a failed run keeps a pending verification.
		{"failed before the flash", hpBiosExitNoFlash, OutcomeRetryLater, false, "bios_check_failed", 0, false},
		{"failed in the flash", hpBiosExitFlashError, OutcomeFailed, true, "bios_flash_uncertain", 1, true},
		{"PowerShell's own failure", 1, OutcomeFailed, true, "bios_flash_uncertain", 1, true},
		{"anything else", 77, OutcomeFailed, true, "bios_flash_uncertain", 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newHpFixture(t)
			f.installCmsl()
			r := f.apply(t, []string{CategoryBIOS}, nil, biosExec(tc.code, 0))
			if r.Outcome != tc.want || r.RebootRequired != tc.reboot || hpCode(r) != tc.err || len(r.Items) != tc.items {
				t.Fatalf("%+v code=%q", r, hpCode(r))
			}
			if err := r.Validate(); err != nil {
				t.Fatal(err)
			}
			if _, err := f.store.ReadFile(hpRebootOwedFile); (err == nil) != tc.owed {
				t.Fatalf("owed record present = %v, want %v", err == nil, tc.owed)
			}
		})
	}
}

func TestHpBiosSpawnFailureIsTreatedAsUncertain(t *testing.T) {
	f := newHpFixture(t)
	f.installCmsl()
	ex := &fakeExec{run: func(context.Context, ExecSpec) (ExecResult, error) { return ExecResult{}, errors.New("killed") }}
	r := f.apply(t, []string{CategoryBIOS}, nil, ex)
	if r.Outcome != OutcomeFailed || !r.RebootRequired || hpCode(r) != "bios_flash_uncertain" {
		t.Fatalf("%+v code=%q", r, hpCode(r))
	}
	if r.RawExitCode != nil {
		t.Fatalf("an exit code was made up: %d", *r.RawExitCode)
	}
}

func TestHpBiosRebootSurvivesAnHpiaThatCouldNotPrepare(t *testing.T) {
	f := newHpFixture(t)
	f.installCmsl()
	notADir := filepath.Join(realTempDir(t), "file")
	if err := os.WriteFile(notADir, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	plan := f.plan(t, []string{CategoryBIOS, CategoryDriver}, nil)
	plan.WorkDir = notADir
	r, err := f.lane.Apply(context.Background(), f.tool(), plan, biosExec(hpBiosExitStaged, 0))
	if err == nil {
		t.Fatal("no error")
	}
	if r.Outcome != OutcomePartial || !r.RebootRequired || hpCode(r) != "stale_report" {
		t.Fatalf("the flash's reboot was lost: %+v code=%q", r, hpCode(r))
	}
}

func TestHpBiosRunsBeforeHpia(t *testing.T) {
	// The runner read power and the recovery key immediately before Apply. HPIA can
	// take an hour, and the lane cannot read the key again.
	f := newHpFixture(t)
	f.installCmsl()
	ex := biosExec(hpBiosExitStaged, 0)
	f.apply(t, []string{CategoryDriver, CategoryBIOS}, nil, ex)
	calls := ex.Calls()
	if len(calls) != 2 || calls[0].Path != testPowerShell {
		t.Fatalf("calls = %+v", calls)
	}
	for _, a := range calls[1].Args {
		if strings.HasPrefix(a, "/Category:") && strings.Contains(a, "BIOS") {
			t.Fatalf("HPIA was asked for BIOS: %v", calls[1].Args)
		}
	}
}

func TestHpBiosMerge(t *testing.T) {
	for _, tc := range []struct {
		name       string
		bios, hpia int64
		want       Outcome
		reboot     bool
		err        string
	}{
		{"both clean", hpBiosExitStaged, 0, OutcomeSuccessRebootRequired, true, ""},
		{"staged, no drivers", hpBiosExitStaged, 256, OutcomeSuccessRebootRequired, true, ""},
		{"staged, drivers want a reboot", hpBiosExitStaged, 3010, OutcomeSuccessRebootRequired, true, ""},
		{"staged, drivers failed", hpBiosExitStaged, 3020, OutcomePartial, true, "install_failed"},
		{"staged, drivers partial", hpBiosExitStaged, 3011, OutcomePartial, true, "non_ssm_softpaqs"},
		{"staged, model refused", hpBiosExitStaged, 4096, OutcomePartial, true, "hpia_not_supported"},
		{"up to date, drivers clean", hpBiosExitUpToDate, 0, OutcomeSuccess, false, ""},
		{"up to date, no drivers", hpBiosExitUpToDate, 256, OutcomeNoUpdates, false, ""},
		{"check failed, drivers clean", hpBiosExitNoFlash, 0, OutcomePartial, false, "bios_check_failed"},
		{"check failed, no drivers", hpBiosExitNoFlash, 256, OutcomeRetryLater, false, "bios_check_failed"},
		{"check failed, drivers want a reboot", hpBiosExitNoFlash, 3010, OutcomePartial, true, "bios_check_failed"},
		{"check failed, drivers failed", hpBiosExitNoFlash, 3020, OutcomeFailed, true, "install_failed"},
		{"up to date, drivers want a reboot", hpBiosExitUpToDate, 3010, OutcomeSuccessRebootRequired, true, ""},
		{"staged, unmapped exit", hpBiosExitStaged, 4097, OutcomePartial, true, "unmapped_exit_code"},
		{"flash uncertain, drivers clean", hpBiosExitFlashError, 0, OutcomePartial, true, "bios_flash_uncertain"},
		{"flash uncertain, no drivers", hpBiosExitFlashError, 256, OutcomeFailed, true, "bios_flash_uncertain"},
		{"flash uncertain, drivers failed", hpBiosExitFlashError, 3020, OutcomeFailed, true, "bios_flash_uncertain"},
		{"flash uncertain, model refused", hpBiosExitFlashError, 4096, OutcomePartial, true, "bios_flash_uncertain"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newHpFixture(t)
			f.installCmsl()
			r := f.apply(t, []string{CategoryBIOS, CategoryDriver}, nil, biosExec(tc.bios, tc.hpia))
			if r.Outcome != tc.want || r.RebootRequired != tc.reboot || hpCode(r) != tc.err {
				t.Fatalf("outcome=%s reboot=%v code=%q, want %s %v %q", r.Outcome, r.RebootRequired, hpCode(r), tc.want, tc.reboot, tc.err)
			}
			if r.RawExitCode == nil || *r.RawExitCode != tc.hpia {
				t.Fatalf("raw = %v, want HPIA's", r.RawExitCode)
			}
			if err := r.Validate(); err != nil {
				t.Fatal(err)
			}
			// Every reboot asked for is remembered, whichever step asked.
			if _, err := f.store.ReadFile(hpRebootOwedFile); (err == nil) != tc.reboot {
				t.Fatalf("owed record present = %v, reboot = %v", err == nil, tc.reboot)
			}
			biosItems := 0
			for _, it := range r.Items {
				if it.Category == CategoryBIOS {
					biosItems++
				}
			}
			flashed := tc.bios == hpBiosExitStaged || tc.bios == hpBiosExitFlashError
			if (biosItems == 1) != flashed || biosItems > 1 {
				t.Fatalf("BIOS items = %d, flash may have started = %v", biosItems, flashed)
			}
			if _, skipped := skipOf(r, CategoryBIOS); skipped {
				t.Fatalf("BIOS ran and was also reported skipped: %+v", r.SkippedCategories)
			}
		})
	}
}

func TestHpBiosSkippedKeepsHpiasOwnAnswer(t *testing.T) {
	f := newHpFixture(t)
	r := f.apply(t, []string{CategoryBIOS, CategoryDriver}, nil, biosExec(0, 3020))
	if r.Outcome != OutcomeFailed || hpCode(r) != "install_failed" {
		t.Fatalf("%+v code=%q", r, hpCode(r))
	}
	if _, ok := skipOf(r, CategoryBIOS); !ok {
		t.Fatalf("skips = %+v", r.SkippedCategories)
	}
}

func TestHpBiosUncertainSurvivesAnHpiaFailureToStart(t *testing.T) {
	f := newHpFixture(t)
	f.installCmsl()
	ex := &fakeExec{run: func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		if spec.Path == testPowerShell {
			return ExecResult{ExitCode: hpBiosExitFlashError}, nil
		}
		return ExecResult{}, errors.New("spawn")
	}}
	r := f.apply(t, []string{CategoryBIOS, CategoryDriver}, nil, ex)
	if r.Outcome != OutcomeFailed || !r.RebootRequired || hpCode(r) != "bios_flash_uncertain" {
		t.Fatalf("%+v code=%q", r, hpCode(r))
	}
}

func TestHpBiosStagedSurvivesAnHpiaFailureToStart(t *testing.T) {
	f := newHpFixture(t)
	f.installCmsl()
	ex := &fakeExec{run: func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		if spec.Path == testPowerShell {
			return ExecResult{ExitCode: hpBiosExitStaged}, nil
		}
		return ExecResult{}, errors.New("spawn")
	}}
	r, err := f.lane.Apply(context.Background(), f.tool(), f.plan(t, []string{CategoryBIOS, CategoryDriver}, nil), ex)
	if err != nil {
		t.Fatal(err)
	}
	if r.Outcome != OutcomePartial || !r.RebootRequired || hpCode(r) != "tool_exec_failed" {
		t.Fatalf("the flash's reboot was lost: %+v code=%q", r, hpCode(r))
	}
}

func TestHpBiosSkippedWhenAnIdIsBlocked(t *testing.T) {
	// Get-HPBIOSUpdates installs the latest and takes no list, so a blocked BIOS
	// could not be honoured.
	f := newHpFixture(t)
	f.installCmsl()
	ex := biosExec(hpBiosExitStaged, 0)
	r := f.apply(t, []string{CategoryBIOS}, []string{"sp100002"}, ex)
	if len(ex.Calls()) != 0 || r.Outcome != OutcomeRetryLater || hpCode(r) != "bios_blocklist_unenforceable" {
		t.Fatalf("%+v code=%q calls=%d", r, hpCode(r), len(ex.Calls()))
	}
	if s, ok := skipOf(r, CategoryBIOS); !ok || s.Reason != SkipGate {
		t.Fatalf("skips = %+v", r.SkippedCategories)
	}
}

func TestHpBiosVerifiesCmslFreshBeforeEveryRun(t *testing.T) {
	f := newHpFixture(t)
	f.installCmsl()
	f.apply(t, []string{CategoryBIOS}, nil, biosExec(hpBiosExitUpToDate, 0))
	f.apply(t, []string{CategoryBIOS}, nil, biosExec(hpBiosExitUpToDate, 0))
	got := f.cmslVerifier.Verified()
	want := []string{testCmslPsd1, testFirmwarePsm, testCmslPsd1, testFirmwarePsm}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("verified %q, want %q", got, want)
	}
}

func TestHpBiosRefusesWhatItCannotVerify(t *testing.T) {
	for name, tc := range map[string]struct {
		setup func(f *hpFixture)
		code  string
	}{
		"signed by HPE":    {func(f *hpFixture) { f.cmslVerifier.publisher = "Hewlett Packard Enterprise" }, "hp_cmsl_publisher_mismatch"},
		"signed by nobody": {func(f *hpFixture) { f.cmslVerifier.err = errors.New("no signature") }, "hp_cmsl_signature_invalid"},
		"HP.Firmware by another signer": {func(f *hpFixture) {
			f.cmslVerifier.byPath = map[string]string{testFirmwarePsm: "Someone Else"}
		}, "hp_cmsl_publisher_mismatch"},
		"no version directory":  {func(f *hpFixture) { f.dirs[testCmslDir] = []string{"notes"} }, "hp_cmsl_unverified"},
		"no HP.Firmware module": {func(f *hpFixture) { delete(f.dirs, testFirmwareDir) }, "hp_cmsl_unverified"},
		"a version dir that could escape": {func(f *hpFixture) {
			f.dirs[testCmslDir] = []string{`1.8.5'; Remove-Item C:\; '`}
		}, "hp_cmsl_unverified"},
		"a quote in Program Files": {func(f *hpFixture) {
			f.programFiles = `C:\Pro'gram Files`
			f.dirs[`C:\Pro'gram Files\WindowsPowerShell\Modules\HPCMSL`] = []string{"1.8.5"}
			f.dirs[`C:\Pro'gram Files\WindowsPowerShell\Modules\HP.Firmware`] = []string{"1.9.1"}
		}, "hp_cmsl_unverified"},
		"a curly quote in Program Files": {func(f *hpFixture) {
			f.programFiles = "C:\\Pro\u2019gram Files"
			f.dirs["C:\\Pro\u2019gram Files\\WindowsPowerShell\\Modules\\HPCMSL"] = []string{"1.8.5"}
			f.dirs["C:\\Pro\u2019gram Files\\WindowsPowerShell\\Modules\\HP.Firmware"] = []string{"1.9.1"}
		}, "hp_cmsl_unverified"},
	} {
		t.Run(name, func(t *testing.T) {
			f := newHpFixture(t)
			f.installCmsl()
			tc.setup(f)
			ex := biosExec(hpBiosExitStaged, 0)
			r := f.apply(t, []string{CategoryBIOS}, nil, ex)
			if len(ex.Calls()) != 0 || r.Outcome != OutcomeToolUnavailable || hpCode(r) != tc.code || r.RebootRequired {
				t.Fatalf("%+v code=%q calls=%+v", r, hpCode(r), ex.Calls())
			}
			if err := r.Validate(); err != nil {
				t.Fatal(err)
			}
			if _, err := f.store.ReadFile(hpRebootOwedFile); err == nil {
				t.Fatal("recorded a reboot for a flash that never ran")
			}
		})
	}
}

func TestHpBiosFailedVerificationInvalidatesTheGate(t *testing.T) {
	f := newHpFixture(t)
	f.installCmsl()
	f.cmslVerifier.err = errors.New("no signature")
	f.apply(t, []string{CategoryBIOS}, nil, biosExec(0, 0))
	checks := f.dirChecks
	f.apply(t, []string{CategoryBIOS}, nil, biosExec(0, 0))
	if f.dirChecks != checks+1 {
		t.Fatalf("a failed verification left the gate cached: %d then %d", checks, f.dirChecks)
	}
}

func TestHpBiosNoVerifierRefuses(t *testing.T) {
	f := newHpFixture(t)
	f.installCmsl()
	f.lane.host.verifier = nil
	ex := biosExec(hpBiosExitStaged, 0)
	r := f.apply(t, []string{CategoryBIOS}, nil, ex)
	if len(ex.Calls()) != 0 || hpCode(r) != "hp_cmsl_publisher_unverified" || r.Outcome != OutcomeToolUnavailable {
		t.Fatalf("%+v calls=%d", r, len(ex.Calls()))
	}
}

func TestHpBiosRecordsTheRebootBeforeTheFlash(t *testing.T) {
	// A process that dies mid-flash must still leave the reboot owed.
	f := newHpFixture(t)
	f.installCmsl()
	var recorded bool
	ex := &fakeExec{run: func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		_, err := f.store.ReadFile(hpRebootOwedFile)
		recorded = err == nil
		return ExecResult{ExitCode: hpBiosExitStaged}, nil
	}}
	f.apply(t, []string{CategoryBIOS}, nil, ex)
	if !recorded {
		t.Fatal("the flash started with no record of the reboot it needs")
	}
}

func TestHpBiosUnwritableRecordRefusesTheFlash(t *testing.T) {
	f := newHpFixture(t)
	f.installCmsl()
	f.store.failWrite = errors.New("disk full")
	ex := biosExec(hpBiosExitStaged, 0)
	r := f.apply(t, []string{CategoryBIOS}, nil, ex)
	if len(ex.Calls()) != 0 || r.Outcome != OutcomeRetryLater || hpCode(r) != "bios_record_unwritable" {
		t.Fatalf("%+v code=%q calls=%d", r, hpCode(r), len(ex.Calls()))
	}
}

func TestHpBiosStagedBlocksTheNextRunUntilTheReboot(t *testing.T) {
	f := newHpFixture(t)
	f.installCmsl()
	f.apply(t, []string{CategoryBIOS}, nil, biosExec(hpBiosExitStaged, 0))
	f.now = f.now.Add(time.Hour)
	ex := biosExec(hpBiosExitUpToDate, 256)
	r := f.apply(t, []string{CategoryDriver}, nil, ex)
	if r.Outcome != OutcomeBlockedRebootPending || !r.RebootRequired || len(ex.Calls()) != 0 {
		t.Fatalf("%+v calls=%d", r, len(ex.Calls()))
	}
}

func TestHpBiosNoPowerShellPathRefuses(t *testing.T) {
	f := newHpFixture(t)
	f.installCmsl()
	f.lane.host.powershell = func() string { return "" }
	ex := biosExec(hpBiosExitStaged, 0)
	r := f.apply(t, []string{CategoryBIOS}, nil, ex)
	if len(ex.Calls()) != 0 || hpCode(r) != "hp_cmsl_unverified" {
		t.Fatalf("%+v calls=%d", r, len(ex.Calls()))
	}
}
