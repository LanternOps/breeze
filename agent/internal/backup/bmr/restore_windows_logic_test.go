package bmr

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// windowsCommand is one runCommand invocation captured by fakeWindowsRunner.
type windowsCommand struct {
	name string
	args []string
}

// fakeWindowsRunner swaps runCommand for the test and records every call.
// failOn maps a command name to the error it returns; every other command
// succeeds with no output.
func fakeWindowsRunner(t *testing.T, failOn map[string]error) *[]windowsCommand {
	t.Helper()
	var calls []windowsCommand
	restore := SetRunCommandForTest(func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, windowsCommand{name: name, args: append([]string(nil), args...)})
		if err, ok := failOn[name]; ok {
			return []byte("simulated " + name + " output"), err
		}
		return nil, nil
	})
	t.Cleanup(restore)
	return &calls
}

// stageWindowsArtifacts lays out a staging dir exactly the way
// applySystemState stages a Windows collector's artifacts
// (<stagingDir>/<artifact.Path>, see systemstate/state_windows.go).
func stageWindowsArtifacts(t *testing.T, paths ...string) string {
	t.Helper()
	staging := t.TempDir()
	for _, p := range paths {
		full := filepath.Join(staging, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", p, err)
		}
		if err := os.WriteFile(full, []byte("artifact "+p), 0o644); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
	}
	return staging
}

var fullWindowsCapture = []string{
	"registry/SYSTEM", "registry/SYSTEM.LOG1", "registry/SYSTEM.LOG2",
	"registry/SOFTWARE", "registry/SAM", "registry/SECURITY", "registry/DEFAULT",
	"boot/bcd_export",
	"drivers/inventory.csv",
	"certs/DataBase/lab-CA.edb",
	"services/services.txt",
	"tasks/tasks.csv",
	"firewall/rules.wfw",
	"features/features.txt",
}

// TestRestoreWindowsLiveState_NeverAppliesHivesOrBCD is the Option B
// contract (#5470): the reinstall-then-recover restorer never touches the
// running OS's registry or boot store, and applies exactly the certificate
// database and the firewall policy, from the paths the collector writes.
func TestRestoreWindowsLiveState_NeverAppliesHivesOrBCD(t *testing.T) {
	staging := stageWindowsArtifacts(t, fullWindowsCapture...)
	calls := fakeWindowsRunner(t, nil)

	report, err := restoreWindowsLiveState(staging)
	if err != nil {
		t.Fatalf("restoreWindowsLiveState: %v", err)
	}

	for _, c := range *calls {
		switch strings.ToLower(c.name) {
		case "reg", "reg.exe", "bcdedit", "bcdedit.exe":
			t.Fatalf("live restorer ran %s %v; registry hives and BCD must never be applied to the running OS", c.name, c.args)
		}
	}
	want := []windowsCommand{
		{name: "certutil", args: []string{"-restoreDB", filepath.Join(staging, "certs")}},
		{name: "netsh", args: []string{"advfirewall", "import", filepath.Join(staging, "firewall", "rules.wfw")}},
	}
	if len(*calls) != len(want) {
		t.Fatalf("commands = %+v, want %+v", *calls, want)
	}
	for i, w := range want {
		got := (*calls)[i]
		if got.name != w.name || strings.Join(got.args, "\x00") != strings.Join(w.args, "\x00") {
			t.Fatalf("command %d = %s %v, want %s %v", i, got.name, got.args, w.name, w.args)
		}
	}
	if report.NothingApplied != "" {
		t.Fatalf("NothingApplied = %q, want empty (certs and firewall were applied)", report.NothingApplied)
	}
}

// TestRestoreWindowsLiveState_WarnsWhatWasCollectedButNotApplied: the
// artifacts left unapplied are named in a warning so the recovery result
// never implies they landed. Transaction logs are not listed as hives.
func TestRestoreWindowsLiveState_WarnsWhatWasCollectedButNotApplied(t *testing.T) {
	staging := stageWindowsArtifacts(t, fullWindowsCapture...)
	fakeWindowsRunner(t, nil)

	report, err := restoreWindowsLiveState(staging)
	if err != nil {
		t.Fatalf("restoreWindowsLiveState: %v", err)
	}
	joined := strings.Join(report.Warnings, "\n")
	for _, want := range []string{
		"registry hives (DEFAULT, SAM, SECURITY, SOFTWARE, SYSTEM)",
		"boot configuration (BCD)",
		"driver inventory",
		"service list",
		"scheduled tasks",
		"Windows features list",
		"reference only",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("warnings %q do not mention %q", joined, want)
		}
	}
	if strings.Contains(joined, "LOG1") || strings.Contains(joined, "LOG2") {
		t.Errorf("warnings %q list hive transaction logs as hives", joined)
	}
	for _, applied := range []string{"certs", "firewall"} {
		if strings.Contains(joined, applied) {
			t.Errorf("warnings %q list the applied %s artifact as reference-only", joined, applied)
		}
	}
}

// TestRestoreWindowsLiveState_OnlyReferenceArtifacts_NothingApplied: a
// snapshot with no certificate database and no firewall policy gives the
// restorer nothing to apply, so it must say so instead of succeeding
// silently (which would read as stateApplied: true).
func TestRestoreWindowsLiveState_OnlyReferenceArtifacts_NothingApplied(t *testing.T) {
	staging := stageWindowsArtifacts(t, "registry/SYSTEM", "registry/SOFTWARE", "boot/bcd_export")
	calls := fakeWindowsRunner(t, nil)

	report, err := restoreWindowsLiveState(staging)
	if err != nil {
		t.Fatalf("restoreWindowsLiveState: %v", err)
	}
	if len(*calls) != 0 {
		t.Fatalf("commands = %+v, want none", *calls)
	}
	if report.NothingApplied == "" {
		t.Fatal("NothingApplied is empty; a run that applied nothing must say so")
	}
	if !strings.Contains(strings.Join(report.Warnings, "\n"), "registry hives (SOFTWARE, SYSTEM)") {
		t.Fatalf("warnings %q do not name the reference-only hives", report.Warnings)
	}
}

// TestRestoreWindowsLiveState_NoCertDatabase_AppliesFirewallOnly: most
// machines have no AD CS role, so the collector writes no certs directory;
// that is not a failure.
func TestRestoreWindowsLiveState_NoCertDatabase_AppliesFirewallOnly(t *testing.T) {
	staging := stageWindowsArtifacts(t, "registry/SYSTEM", "firewall/rules.wfw")
	calls := fakeWindowsRunner(t, nil)

	report, err := restoreWindowsLiveState(staging)
	if err != nil {
		t.Fatalf("restoreWindowsLiveState: %v", err)
	}
	if len(*calls) != 1 || (*calls)[0].name != "netsh" {
		t.Fatalf("commands = %+v, want only the netsh firewall import", *calls)
	}
	if report.NothingApplied != "" {
		t.Fatalf("NothingApplied = %q, want empty", report.NothingApplied)
	}
}

// TestRestoreWindowsLiveState_FirewallImportFails_ReturnsError: a failed
// apply of an artifact the restorer does apply is a real failure, returned
// as an error (so stateApplied is false) rather than only logged. The
// certificate step still runs.
func TestRestoreWindowsLiveState_FirewallImportFails_ReturnsError(t *testing.T) {
	staging := stageWindowsArtifacts(t, fullWindowsCapture...)
	calls := fakeWindowsRunner(t, map[string]error{"netsh": errors.New("exit status 1")})

	report, err := restoreWindowsLiveState(staging)
	if err == nil {
		t.Fatal("want an error when the firewall import fails")
	}
	if !strings.Contains(err.Error(), "firewall") || !strings.Contains(err.Error(), "simulated netsh output") {
		t.Fatalf("error %q does not name the firewall step and its output", err.Error())
	}
	if len(*calls) != 2 {
		t.Fatalf("commands = %+v, want certutil then netsh", *calls)
	}
	if len(report.Warnings) == 0 {
		t.Fatal("the reference-only warning must survive a failed apply")
	}
}

// TestRestoreWindowsLiveState_CertRestoreFails_ReturnsError mirrors the
// firewall case for the certificate database; the firewall step still runs.
func TestRestoreWindowsLiveState_CertRestoreFails_ReturnsError(t *testing.T) {
	staging := stageWindowsArtifacts(t, fullWindowsCapture...)
	calls := fakeWindowsRunner(t, map[string]error{"certutil": errors.New("exit status 1")})

	_, err := restoreWindowsLiveState(staging)
	if err == nil || !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("err = %v, want a certificate-step error", err)
	}
	if len(*calls) != 2 || (*calls)[1].name != "netsh" {
		t.Fatalf("commands = %+v, want the firewall import to run after the failed certificate restore", *calls)
	}
}

// TestRestoreWindowsLiveState_UnreadableStagedArtifact_ReturnsError: a staged
// artifact the restorer cannot even inspect (permission or I/O error, as
// opposed to simply not being there) is a failure, never a silent skip that
// lets the other step's success read as stateApplied: true.
func TestRestoreWindowsLiveState_UnreadableStagedArtifact_ReturnsError(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs POSIX directory permissions enforced for the test user")
	}
	for _, tc := range []struct{ name, lockDir, wantStep string }{
		{"firewall", "firewall", "firewall"},
		{"certs", "certs", "certificates"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			staging := stageWindowsArtifacts(t, fullWindowsCapture...)
			locked := filepath.Join(staging, tc.lockDir)
			if err := os.Chmod(locked, 0); err != nil {
				t.Fatalf("chmod: %v", err)
			}
			t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })
			fakeWindowsRunner(t, nil)

			_, err := restoreWindowsLiveState(staging)
			if err == nil || !strings.Contains(err.Error(), tc.wantStep) {
				t.Fatalf("err = %v, want a %s-step error for an unreadable staged artifact", err, tc.wantStep)
			}
		})
	}
}
