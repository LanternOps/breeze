package selfuninstall

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

// msiexec that cannot be run, or outlives its timeout, is a failed uninstall:
// nothing is removed behind it and the agent is restored after the report.
func TestWindowsPlanMSILaunchErrorReportsFailed(t *testing.T) {
	ops := &fakeOps{products: []string{"{PRODUCT}"}, msiErr: errors.New("context deadline exceeded")}
	out := run(t, testOptions(), ops)
	if out.Status != StatusFailed || out.FailedStep != StepMSIUninstall || !strings.Contains(out.Err.Error(), "deadline") {
		t.Fatalf("outcome = %+v, want failed at %s naming the launch error", out, StepMSIUninstall)
	}
	assertNotLogged(t, ops.log, "delete-service")
	assertNotLogged(t, ops.log, "rm")
	assertInOrder(t, ops.log, "REPORT failed", "restore BreezeAgent")
}

// Two registered products, one stale (1605) and one removed: the result names
// only the removed one, the method is msi, and the stale one is a warning.
func TestWindowsPlanMixedStaleAndRemovedProducts(t *testing.T) {
	ops := &fakeOps{products: []string{"{STALE}", "{LIVE}"}, msiExits: []int{1605, 0}, productsAfter: []string{"{STALE}"}}
	out := run(t, testOptions(), ops)
	if out.Status != StatusCompleted {
		t.Fatalf("status = %s (%v)", out.Status, out.Err)
	}
	if out.Details["method"] != "msi" || !reflect.DeepEqual(out.Details["productCodes"], []string{"{LIVE}"}) {
		t.Fatalf("details = %v", out.Details)
	}
	if !strings.Contains(strings.Join(out.Warnings, " "), "{STALE}") {
		t.Fatalf("warnings = %v, want the stale registration named", out.Warnings)
	}
	assertNotLogged(t, ops.log, "restore")
}

// The kill and verify lists are what make verify-processes meaningful: the
// agent and watchdog must be verified gone, and every lock-holding sibling
// killed before its binary is removed.
func TestWindowsProcessListsCoverTheInstalledBinaries(t *testing.T) {
	has := func(list []string, name string) bool {
		for _, n := range list {
			if strings.EqualFold(n, name) {
				return true
			}
		}
		return false
	}
	for _, name := range []string{"breeze-agent.exe", "breeze-watchdog.exe"} {
		if !has(windowsAgentProcesses, name) {
			t.Fatalf("windowsAgentProcesses %v lacks %s", windowsAgentProcesses, name)
		}
	}
	for _, name := range []string{"breeze-watchdog.exe", "breeze-user-helper.exe", "breeze-desktop-helper.exe", "breeze-backup.exe"} {
		if !has(windowsHelperProcesses, name) {
			t.Fatalf("windowsHelperProcesses %v lacks %s", windowsHelperProcesses, name)
		}
	}
	opts := WindowsHelperOptions(HelperArgs{AgentBinary: `C:\Program Files\Breeze\breeze-agent.exe`, ConfigDir: `C:\ProgramData\Breeze`}, nil)
	for _, bin := range opts.Binaries {
		base := bin[strings.LastIndex(bin, `\`)+1:]
		if !has(windowsHelperProcesses, base) && !has(windowsAgentProcesses, base) {
			t.Fatalf("%s is removed but its process is never killed or verified gone", base)
		}
	}
}

func TestWindowsHelperOptions(t *testing.T) {
	opts := WindowsHelperOptions(HelperArgs{AgentBinary: `C:\Program Files\Breeze\breeze-agent.exe`, ConfigDir: `C:\ProgramData\Breeze`, RemoveConfig: true}, nil)
	if opts.AgentService != AgentServiceName || opts.WatchdogService != WatchdogServiceName || opts.UserHelperTask != UserHelperTaskName {
		t.Fatalf("identity = %+v", opts)
	}
	if opts.Binaries[len(opts.Binaries)-1] != `C:\Program Files\Breeze\breeze-agent.exe` {
		t.Fatalf("the agent binary must be swept last (it runs containment release-all): %v", opts.Binaries)
	}
	if opts.MSILogPath != `C:\ProgramData\Breeze\logs\self-uninstall-msi.log` || !opts.RemoveConfig || opts.HandoffDelay != HandoffDelay {
		t.Fatalf("opts = %+v", opts)
	}
	if !reflect.DeepEqual(opts.UpgradeCodes, AgentUpgradeCodes) {
		t.Fatalf("UpgradeCodes = %v", opts.UpgradeCodes)
	}
	if empty := WindowsHelperOptions(HelperArgs{AgentBinary: `C:\a\breeze-agent.exe`}, nil); empty.MSILogPath != "" {
		t.Fatalf("no config dir: msiexec must not log to a relative path, got %q", empty.MSILogPath)
	}
}

func TestHelperExitCode(t *testing.T) {
	sendErr := errors.New("unreachable")
	for _, tc := range []struct {
		status    string
		reportErr error
		want      int
	}{
		{StatusCompleted, nil, ExitCompleted},
		{StatusCompleted, sendErr, ExitNotReported},
		{StatusFailed, nil, ExitFailed},
		{StatusFailed, sendErr, ExitFailedNotReport},
	} {
		if got := HelperExitCode(Outcome{Status: tc.status}, tc.reportErr); got != tc.want {
			t.Errorf("HelperExitCode(%s, %v) = %d, want %d", tc.status, tc.reportErr, got, tc.want)
		}
	}
}
