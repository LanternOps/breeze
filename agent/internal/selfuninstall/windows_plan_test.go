package selfuninstall

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fakeOps records every side effect, plus the report, in one ordered log so a
// test can assert the report came after the last teardown step. Each knob
// injects one failure mode.
type fakeOps struct {
	log []string

	releaseErr      error
	reconfirmErr    error // the second (post-stop) release
	releases        int
	stopErr         map[string]error
	deleteErr       map[string]error
	products        []string // related products before the uninstall
	productsErr     error
	msiExits        []int // exit codes returned by successive UninstallProduct calls
	removeErr       map[string]error
	stillRegistered map[string]bool // services that survive teardown
	productsAfter   []string        // related products left after the uninstall
	running         []string
	restoreErr      error
	taskDeleteErr   error
	taskRemains     bool

	uninstalled bool
}

func (f *fakeOps) add(format string, args ...any) {
	f.log = append(f.log, fmt.Sprintf(format, args...))
}

func (f *fakeOps) ReleaseIsolation(_ context.Context, bin string) error {
	f.releases++
	if f.releases == 1 {
		f.add("release %s", bin)
		return f.releaseErr
	}
	f.add("reconfirm-release %s", bin)
	return f.reconfirmErr
}
func (f *fakeOps) Sleep(_ context.Context, d time.Duration) error {
	f.add("sleep %s", d)
	return nil
}
func (f *fakeOps) StopService(_ context.Context, name string) error {
	f.add("stop %s", name)
	return f.stopErr[name]
}
func (f *fakeOps) DeleteService(name string) error {
	f.add("delete-service %s", name)
	return f.deleteErr[name]
}
func (f *fakeOps) ServiceExists(name string) (bool, error) {
	f.add("service-exists %s", name)
	return f.stillRegistered[name], nil
}
func (f *fakeOps) KillProcesses(names []string) {
	f.add("kill %s", strings.Join(names, ","))
}
func (f *fakeOps) RelatedProducts(codes []string) ([]string, error) {
	f.add("related-products")
	if f.uninstalled {
		return f.productsAfter, nil
	}
	return f.products, f.productsErr
}
func (f *fakeOps) UninstallProduct(_ context.Context, code, logPath string) (int, error) {
	f.add("msiexec /x %s", code)
	exit := 0
	if len(f.msiExits) > 0 {
		exit, f.msiExits = f.msiExits[0], f.msiExits[1:]
	}
	if exit == 0 || exit == 3010 || exit == 1641 {
		f.uninstalled = true
	}
	return exit, nil
}
func (f *fakeOps) DeleteScheduledTask(name string) error {
	f.add("delete-task %s", name)
	return f.taskDeleteErr
}
func (f *fakeOps) ScheduledTaskExists(name string) (bool, error) {
	f.add("task-exists %s", name)
	return f.taskRemains, nil
}
func (f *fakeOps) RemoveFile(path string) error {
	f.add("rm %s", path)
	return f.removeErr[path]
}
func (f *fakeOps) RemoveFileAtReboot(path string) error {
	f.add("rm-at-reboot %s", path)
	return nil
}
func (f *fakeOps) RemoveAll(path string) error {
	f.add("rm -r %s", path)
	return nil
}
func (f *fakeOps) ProcessesRunning(names []string) ([]string, error) {
	f.add("running?")
	return f.running, nil
}
func (f *fakeOps) RestoreService(_ context.Context, name string) error {
	f.add("restore %s", name)
	return f.restoreErr
}

const (
	testAgentBin    = `C:\Program Files\Breeze\breeze-agent.exe`
	testWatchdogBin = `C:\Program Files\Breeze\breeze-watchdog.exe`
	testTask        = `\Breeze\AgentUserHelper`
)

func testOptions() WindowsOptions {
	return WindowsOptions{
		AgentService:      "BreezeAgent",
		WatchdogService:   "BreezeWatchdog",
		AgentBinary:       testAgentBin,
		Binaries:          []string{testWatchdogBin, testAgentBin},
		UserHelperTask:    testTask,
		ConfigDir:         `C:\ProgramData\Breeze`,
		RemoveConfig:      true,
		UpgradeCodes:      []string{"{UPGRADE}"},
		MSILogPath:        `C:\ProgramData\Breeze\logs\self-uninstall-msi.log`,
		HandoffDelay:      5 * time.Second,
		HelperProcesses:   []string{"breeze-user-helper.exe"},
		AgentProcesses:    []string{"breeze-agent.exe", "breeze-watchdog.exe"},
		MSIBusyRetries:    2,
		MSIBusyRetryDelay: time.Second,
	}
}

// run builds the plan over ops, reports into the same log, and returns the
// reported outcome.
func run(t *testing.T, opts WindowsOptions, ops *fakeOps) Outcome {
	t.Helper()
	p := BuildWindowsPlan(opts, ops)
	var reported []Outcome
	p.Report = func(_ context.Context, o Outcome) error {
		ops.add("REPORT %s", o.Status)
		reported = append(reported, o)
		return nil
	}
	if _, err := Run(context.Background(), p); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(reported) != 1 {
		t.Fatalf("reported %d times, want once; log:\n%s", len(reported), strings.Join(ops.log, "\n"))
	}
	return reported[0]
}

func indexOf(t *testing.T, log []string, entry string) int {
	t.Helper()
	for i, e := range log {
		if e == entry {
			return i
		}
	}
	t.Fatalf("log has no %q:\n%s", entry, strings.Join(log, "\n"))
	return -1
}

func assertNotLogged(t *testing.T, log []string, prefix string) {
	t.Helper()
	for _, e := range log {
		if strings.HasPrefix(e, prefix) {
			t.Fatalf("log unexpectedly has %q:\n%s", e, strings.Join(log, "\n"))
		}
	}
}

// assertInOrder requires each entry to appear after the previous one (an
// entry logged twice matches its first occurrence past the previous match).
func assertInOrder(t *testing.T, log []string, entries ...string) {
	t.Helper()
	next := 0
	for _, e := range entries {
		found := -1
		for i := next; i < len(log); i++ {
			if log[i] == e {
				found = i
				break
			}
		}
		if found < 0 {
			t.Fatalf("%q missing or out of order:\n%s", e, strings.Join(log, "\n"))
		}
		next = found + 1
	}
}

// The MSI path (#11154): release, wait, stop the watchdog and the agent,
// re-confirm the release once the agent is down, msiexec /x the product the
// UpgradeCode resolves to, sweep what an older cached MSI may not know about,
// verify — and only then report completed. Nothing follows the report.
func TestWindowsPlanMSIPathReportsCompletedAfterVerifiedTeardown(t *testing.T) {
	ops := &fakeOps{products: []string{"{PRODUCT}"}}
	out := run(t, testOptions(), ops)

	if out.Status != StatusCompleted {
		t.Fatalf("status = %s (%v), want completed; log:\n%s", out.Status, out.Err, strings.Join(ops.log, "\n"))
	}
	assertInOrder(t, ops.log,
		"release "+testAgentBin,
		"sleep 5s",
		"stop BreezeWatchdog",
		"stop BreezeAgent",
		"kill breeze-user-helper.exe",
		"reconfirm-release "+testAgentBin,
		"msiexec /x {PRODUCT}",
		"delete-service BreezeWatchdog",
		"delete-service BreezeAgent",
		"delete-task "+testTask,
		"rm "+testWatchdogBin,
		"rm "+testAgentBin,
		`rm -r C:\ProgramData\Breeze`,
		"service-exists BreezeAgent",
		"service-exists BreezeWatchdog",
		"task-exists "+testTask,
		"related-products",
		"running?",
		"REPORT completed",
	)
	if last := ops.log[len(ops.log)-1]; last != "REPORT completed" {
		t.Fatalf("last entry = %q, want the report", last)
	}
	assertNotLogged(t, ops.log, "restore")
	if out.Details["method"] != "msi" || !reflect.DeepEqual(out.Details["productCodes"], []string{"{PRODUCT}"}) {
		t.Fatalf("details = %v", out.Details)
	}
}

// A release that cannot be confirmed stops everything before teardown and is
// reported failed; the agent is restored only after the report.
func TestWindowsPlanReleaseFailureReportsFailedAndRestores(t *testing.T) {
	ops := &fakeOps{products: []string{"{PRODUCT}"}, releaseErr: errors.New("exit status 1")}
	out := run(t, testOptions(), ops)

	if out.Status != StatusFailed || out.FailedStep != StepReleaseIsolation {
		t.Fatalf("outcome = %+v, want failed at %s", out, StepReleaseIsolation)
	}
	assertNotLogged(t, ops.log, "stop ")
	assertNotLogged(t, ops.log, "msiexec")
	assertNotLogged(t, ops.log, "rm")
	assertInOrder(t, ops.log, "REPORT failed", "restore BreezeAgent")
}

// Once the agent is down nothing can re-isolate the device, so the release is
// confirmed again; if that fails nothing is removed and the agent comes back.
func TestWindowsPlanReconfirmFailureStopsBeforeRemoval(t *testing.T) {
	ops := &fakeOps{products: []string{"{PRODUCT}"}, reconfirmErr: errors.New("exit status 1")}
	out := run(t, testOptions(), ops)

	if out.Status != StatusFailed || out.FailedStep != StepReconfirmRelease {
		t.Fatalf("outcome = %+v, want failed at %s", out, StepReconfirmRelease)
	}
	assertNotLogged(t, ops.log, "msiexec")
	assertNotLogged(t, ops.log, "delete-service")
	assertNotLogged(t, ops.log, "rm")
	assertInOrder(t, ops.log, "stop BreezeAgent", "REPORT failed", "restore BreezeAgent")
}

// msiexec failing (1603: the package rolled back) is reported failed — never
// completed — no removal runs behind it, and the agent is restored after the
// report.
func TestWindowsPlanMSIFailureReportsFailedAndRestores(t *testing.T) {
	ops := &fakeOps{products: []string{"{PRODUCT}"}, msiExits: []int{1603}}
	out := run(t, testOptions(), ops)

	if out.Status != StatusFailed || out.FailedStep != StepMSIUninstall {
		t.Fatalf("outcome = %+v, want failed at %s", out, StepMSIUninstall)
	}
	if !strings.Contains(out.Err.Error(), "1603") || !strings.Contains(out.Err.Error(), "self-uninstall-msi.log") {
		t.Fatalf("error %q should name the exit code and the msiexec log", out.Err)
	}
	assertNotLogged(t, ops.log, "delete-service")
	assertNotLogged(t, ops.log, "rm")
	assertInOrder(t, ops.log, "msiexec /x {PRODUCT}", "REPORT failed", "restore BreezeAgent")
}

func TestWindowsPlanMSIRebootRequiredIsCompleted(t *testing.T) {
	ops := &fakeOps{products: []string{"{PRODUCT}"}, msiExits: []int{3010}}
	out := run(t, testOptions(), ops)
	if out.Status != StatusCompleted || out.Details["rebootRequired"] != true {
		t.Fatalf("outcome = %+v, want completed with rebootRequired", out)
	}
}

// 1618: another installation is in progress. Retried, bounded.
func TestWindowsPlanMSIBusyIsRetried(t *testing.T) {
	ops := &fakeOps{products: []string{"{PRODUCT}"}, msiExits: []int{1618, 0}}
	out := run(t, testOptions(), ops)
	if out.Status != StatusCompleted {
		t.Fatalf("status = %s (%v), want completed after a retry", out.Status, out.Err)
	}
	assertInOrder(t, ops.log, "msiexec /x {PRODUCT}", "sleep 1s")

	ops = &fakeOps{products: []string{"{PRODUCT}"}, msiExits: []int{1618, 1618, 1618, 0}}
	out = run(t, testOptions(), ops)
	if out.Status != StatusFailed || !strings.Contains(out.Err.Error(), "1618") {
		t.Fatalf("outcome = %+v, want failed after the bounded retries", out)
	}
}

// No MSI registration (a non-MSI install): today's manual removal, then the
// same verification before the report.
func TestWindowsPlanManualPathWhenNoProductIsRegistered(t *testing.T) {
	ops := &fakeOps{}
	out := run(t, testOptions(), ops)
	if out.Status != StatusCompleted {
		t.Fatalf("status = %s (%v), want completed; log:\n%s", out.Status, out.Err, strings.Join(ops.log, "\n"))
	}
	assertInOrder(t, ops.log,
		"stop BreezeAgent",
		"reconfirm-release "+testAgentBin,
		"delete-service BreezeWatchdog",
		"delete-service BreezeAgent",
		"delete-task "+testTask,
		"rm "+testWatchdogBin,
		"rm "+testAgentBin,
		`rm -r C:\ProgramData\Breeze`,
		"service-exists BreezeAgent",
		"REPORT completed",
	)
	assertNotLogged(t, ops.log, "msiexec")
	if out.Details["method"] != "manual" {
		t.Fatalf("details = %v", out.Details)
	}
}

// 1605: the registered product is not actually installed. Fall back to the
// manual removal rather than failing.
func TestWindowsPlanUnknownProductFallsBackToManual(t *testing.T) {
	ops := &fakeOps{products: []string{"{PRODUCT}"}, msiExits: []int{1605}}
	out := run(t, testOptions(), ops)
	if out.Status != StatusCompleted || out.Details["method"] != "manual" {
		t.Fatalf("outcome = %+v, want completed by manual removal", out)
	}
	if !strings.Contains(strings.Join(out.Warnings, " "), "1605") {
		t.Fatalf("warnings = %v, want the stale registration named", out.Warnings)
	}
	assertInOrder(t, ops.log, "msiexec /x {PRODUCT}", "delete-service BreezeAgent", "REPORT completed")
}

// A binary that cannot be removed (still locked) is scheduled for removal at
// reboot: a warning, not a failed uninstall — the services are gone.
func TestWindowsPlanLockedBinaryIsAWarning(t *testing.T) {
	ops := &fakeOps{removeErr: map[string]error{testAgentBin: errors.New("access denied")}}
	out := run(t, testOptions(), ops)
	if out.Status != StatusCompleted {
		t.Fatalf("status = %s (%v)", out.Status, out.Err)
	}
	indexOf(t, ops.log, "rm-at-reboot "+testAgentBin)
	if len(out.Warnings) != 1 || !strings.Contains(out.Warnings[0], testAgentBin) {
		t.Fatalf("warnings = %v, want one naming %s", out.Warnings, testAgentBin)
	}
}

// A service that cannot be deleted fails the run: the agent would still be
// registered to start.
func TestWindowsPlanServiceDeleteFailureReportsFailed(t *testing.T) {
	ops := &fakeOps{deleteErr: map[string]error{"BreezeAgent": errors.New("access denied")}}
	out := run(t, testOptions(), ops)
	if out.Status != StatusFailed || out.FailedStep != StepRemoveServices {
		t.Fatalf("outcome = %+v, want failed at %s", out, StepRemoveServices)
	}
	assertNotLogged(t, ops.log, "rm")
}

// Verification is what makes `completed` true: a service still registered, a
// product still registered, or an agent process still running fails the run.
func TestWindowsPlanVerificationFailuresReportFailed(t *testing.T) {
	cases := map[string]*fakeOps{
		"agent service still registered": {stillRegistered: map[string]bool{"BreezeAgent": true}},
		"watchdog still registered":      {stillRegistered: map[string]bool{"BreezeWatchdog": true}},
		"product still registered":       {products: []string{"{PRODUCT}"}, productsAfter: []string{"{PRODUCT}"}},
		"agent process still running":    {running: []string{"breeze-agent.exe"}},
	}
	for name, ops := range cases {
		t.Run(name, func(t *testing.T) {
			out := run(t, testOptions(), ops)
			if out.Status != StatusFailed || !strings.HasPrefix(out.FailedStep, "verify") {
				t.Fatalf("outcome = %+v, want failed at a verify step", out)
			}
			assertInOrder(t, ops.log, "REPORT failed", "restore BreezeAgent")
		})
	}
}

// A user-helper task that survives is cruft (it points at a removed binary),
// not a running agent: the result says so without failing the uninstall.
func TestWindowsPlanLeftoverUserHelperTaskIsAWarning(t *testing.T) {
	ops := &fakeOps{taskDeleteErr: errors.New("access denied"), taskRemains: true}
	out := run(t, testOptions(), ops)
	if out.Status != StatusCompleted {
		t.Fatalf("status = %s (%v)", out.Status, out.Err)
	}
	if !strings.Contains(strings.Join(out.Warnings, " "), testTask) {
		t.Fatalf("warnings = %v, want one naming the task", out.Warnings)
	}
}

func TestWindowsPlanAgentStopFailureReportsFailed(t *testing.T) {
	ops := &fakeOps{products: []string{"{PRODUCT}"}, stopErr: map[string]error{"BreezeAgent": errors.New("still STOP_PENDING after 60s")}}
	out := run(t, testOptions(), ops)
	if out.Status != StatusFailed || out.FailedStep != StepStopAgent {
		t.Fatalf("outcome = %+v, want failed at %s", out, StepStopAgent)
	}
	assertNotLogged(t, ops.log, "reconfirm")
	assertNotLogged(t, ops.log, "msiexec")
}

// The watchdog was already stopped and deleted in-process; failing to stop it
// again is not a reason to abandon the uninstall (verification still checks
// that its service is gone).
func TestWindowsPlanWatchdogStopFailureIsAWarning(t *testing.T) {
	ops := &fakeOps{stopErr: map[string]error{"BreezeWatchdog": errors.New("access denied")}}
	out := run(t, testOptions(), ops)
	if out.Status != StatusCompleted || len(out.Warnings) == 0 {
		t.Fatalf("outcome = %+v, want completed with a warning", out)
	}
}

func TestWindowsPlanKeepsConfigWhenAsked(t *testing.T) {
	opts := testOptions()
	opts.RemoveConfig = false
	ops := &fakeOps{products: []string{"{PRODUCT}"}}
	if out := run(t, opts, ops); out.Status != StatusCompleted {
		t.Fatalf("status = %s (%v)", out.Status, out.Err)
	}
	assertNotLogged(t, ops.log, "rm -r")
}

// A Windows Installer query that fails is not proof there is no product: the
// manual removal runs, and the result says the Programs entry may remain.
func TestWindowsPlanProductLookupErrorFallsBackWithAWarning(t *testing.T) {
	ops := &fakeOps{productsErr: errors.New("msi.dll unavailable")}
	out := run(t, testOptions(), ops)
	if out.Status != StatusCompleted {
		t.Fatalf("status = %s (%v)", out.Status, out.Err)
	}
	if !strings.Contains(strings.Join(out.Warnings, " "), "msi.dll unavailable") {
		t.Fatalf("warnings = %v", out.Warnings)
	}
	indexOf(t, ops.log, "delete-service BreezeAgent")
}

// The credentials are snapshotted again once the agent is down (it can no
// longer rotate them) and before anything deletes secrets.yaml.
func TestWindowsPlanRefreshesCredentialsAfterTheAgentStops(t *testing.T) {
	ops := &fakeOps{products: []string{"{PRODUCT}"}}
	opts := testOptions()
	opts.OnAgentStopped = func() error { ops.add("snapshot-credentials"); return nil }
	if out := run(t, opts, ops); out.Status != StatusCompleted {
		t.Fatalf("status = %s (%v)", out.Status, out.Err)
	}
	assertInOrder(t, ops.log, "stop BreezeAgent", "snapshot-credentials", "msiexec /x {PRODUCT}")

	ops = &fakeOps{}
	opts.OnAgentStopped = func() error { return errors.New("secrets.yaml unreadable") }
	if out := run(t, opts, ops); out.Status != StatusCompleted || len(out.Warnings) == 0 {
		t.Fatalf("a failed re-snapshot keeps the earlier credentials and warns: %+v", out)
	}
}

func TestWindowsPlanStepNamesAreStable(t *testing.T) {
	p := BuildWindowsPlan(testOptions(), &fakeOps{})
	var names []string
	for _, s := range p.Steps {
		names = append(names, s.Name)
	}
	want := []string{
		StepReleaseIsolation, StepHandoffDelay, StepStopWatchdog, StepStopAgent, StepStopHelpers,
		StepReconfirmRelease, StepMSIUninstall, StepRemoveServices, StepRemoveUserHelperTask,
		StepRemoveBinaries, StepRemoveConfig, StepVerifyServices, StepVerifyUserHelperTask,
		StepVerifyProduct, StepVerifyProcesses,
	}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("steps = %v, want %v", names, want)
	}
}
