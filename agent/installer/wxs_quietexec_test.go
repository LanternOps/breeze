package installer

import (
	"regexp"
	"strings"
	"testing"
)

// #8877: Windows Installer starts an EXE custom action (ExeCommand) with no
// CREATE_NO_WINDOW, so a console-subsystem child (cmd.exe, powershell.exe,
// breeze-agent.exe) can get a console window. #3624 fixed only the immediate
// KillBreezeProcesses CA; windows were still reported during install and
// upgrade, and the deferred Impersonate="no" CAs were the remaining EXE CAs.
// Any custom action that starts a process therefore goes through the WiX
// Util extension's WixQuietExec (or WixSilentExec), which starts the command
// with CREATE_NO_WINDOW and its output on pipes, so neither the child nor any
// console grandchild it starts gets a window.

// quietExecCAs lists every deferred/rollback custom action that starts a
// process, with the execution settings each one had as an EXE CA. Execute,
// Impersonate and Return are load-bearing (LocalSystem rights, rollback
// semantics, whether a failure rolls back the install) and must not drift
// in the conversion.
var quietExecCAs = []struct {
	id, execute, ret, entry string
}{
	{"PrepareServiceShutdown", "deferred", "ignore", "WixQuietExec"},
	{"RollbackServiceRecovery", "rollback", "ignore", "WixQuietExec"},
	{"RecoverBreezeAfterUpgrade", "deferred", "ignore", "WixQuietExec"},
	{"ReRegisterUserHelperTaskAfterUpgrade", "deferred", "ignore", "WixQuietExec"},
	{"HardenProgramDataAcl", "deferred", "ignore", "WixQuietExec"},
	{"ConfigureBreezeFailureActions", "deferred", "ignore", "WixQuietExec"},
	{"RegisterUserHelperTask", "deferred", "check", "WixQuietExec"},
	{"RollbackRegisterUserHelperTask", "rollback", "ignore", "WixQuietExec"},
	{"UnregisterUserHelperTask", "deferred", "ignore", "WixQuietExec"},
	// WixSilentExec: the command line carries the bootstrap token (see
	// TestBootstrapEnrollKeepsTokenOutOfLog).
	{"BootstrapEnroll", "deferred", "check", "WixSilentExec"},
	{"UninstallNotify", "deferred", "ignore", "WixQuietExec"},
}

// quietExecCmd returns the (still XML-escaped) command line a deferred
// quiet-exec CA runs: the Value of the SetProperty named after the CA, which
// MSI hands the CA as its CustomActionData.
func quietExecCmd(t *testing.T, wxs, id string) string {
	t.Helper()
	re := regexp.MustCompile(`<SetProperty\s+Id="` + regexp.QuoteMeta(id) + `"\s+Value="([^"]*)"\s+Before="` + regexp.QuoteMeta(id) + `"\s+Sequence="execute"\s*/>`)
	m := re.FindStringSubmatch(wxs)
	if m == nil {
		t.Fatalf(`expected <SetProperty Id=%q Value="..." Before=%q Sequence="execute" /> carrying the CA's command line`, id, id)
	}
	return m[1]
}

func TestNoCustomActionFlashesConsoleWindow(t *testing.T) {
	wxs := readWxs(t)
	listed := map[string]bool{"KillBreezeProcesses": true} // immediate; TestKillBreezeProcessesRunsWithoutConsoleWindow
	for _, want := range quietExecCAs {
		listed[want.id] = true
	}
	elRe := regexp.MustCompile(`(?s)<CustomAction\s+Id="([^"]+)"(.*?)/>`)
	for _, m := range elRe.FindAllStringSubmatch(wxs, -1) {
		ca := customActionAttrs(wxs, m[1])
		if _, isExe := ca["ExeCommand"]; isExe {
			t.Errorf("custom action %s is an EXE custom action (ExeCommand); Windows Installer starts it with a visible console window. Run it through WixQuietExec", m[1])
		}
		// A new quiet-exec CA must be added to quietExecCAs so its
		// execution settings and SetProperty are checked below.
		if e := ca["DllEntry"]; strings.Contains(e, "QuietExec") || strings.Contains(e, "SilentExec") {
			if !listed[m[1]] {
				t.Errorf("custom action %s uses %s but is not listed in quietExecCAs; add it so its settings and command are checked", m[1], e)
			}
		}
	}

	scheduled := customConditions(t, wxs)
	for _, want := range quietExecCAs {
		if _, ok := scheduled[want.id]; !ok {
			t.Errorf("%s has no <Custom Action=%q> entry in InstallExecuteSequence; it would never run", want.id, want.id)
		}
		ca := customActionAttrs(wxs, want.id)
		if ca == nil {
			t.Errorf("no <CustomAction Id=%q>", want.id)
			continue
		}
		if ca["DllEntry"] != want.entry {
			t.Errorf("%s DllEntry = %q, want %s (starts the command with no console window)", want.id, ca["DllEntry"], want.entry)
		}
		if !strings.HasPrefix(ca["BinaryRef"], "Wix4UtilCA_") {
			t.Errorf("%s BinaryRef = %q, want the WiX Util extension CA DLL (Wix4UtilCA_*)", want.id, ca["BinaryRef"])
		}
		if ca["Execute"] != want.execute {
			t.Errorf("%s Execute = %q, want %q", want.id, ca["Execute"], want.execute)
		}
		if ca["Impersonate"] != "no" {
			t.Errorf("%s Impersonate = %q, want no (runs as LocalSystem)", want.id, ca["Impersonate"])
		}
		if ca["Return"] != want.ret {
			t.Errorf("%s Return = %q, want %q", want.id, ca["Return"], want.ret)
		}
		// QuietExec rejects a command that does not start with a quoted
		// application path ("Command string must begin with quoted
		// application name"); with Return="ignore" that is only a log line.
		cmd := quietExecCmd(t, wxs, want.id)
		if !strings.HasPrefix(cmd, "&quot;") {
			t.Errorf("%s command must begin with a quoted application path; got %q", want.id, cmd)
		}
		// powershell.exe reads stdin when it is redirected, and QuietExec
		// hands the child a stdin pipe it never closes: without
		// -InputFormat None the script can hang the install.
		if strings.Contains(strings.ToLower(cmd), "powershell.exe") && !strings.Contains(cmd, "-InputFormat None") {
			t.Errorf("%s runs powershell.exe without -InputFormat None; got %q", want.id, cmd)
		}
	}

	// The per-CA SetProperty replaces these application-path properties.
	for _, dead := range []string{"POWERSHELL_EXE", "BREEZE_SVC_CMD", "BREEZE_ACL_CMD", "BREEZE_SC_FAILURE_CMD", "SetPowerShellPath"} {
		if strings.Contains(wxs, dead) {
			t.Errorf("%s is dead once every CA runs through WixQuietExec; remove it", dead)
		}
	}
}

// BootstrapEnroll's command line carries the bootstrap token (inside
// [OriginalDatabase] and [BOOTSTRAP_TOKEN]). MsiLogging is always on
// (voicewarmupx), so the token must stay out of the verbose log at each place
// it could appear: the property change when SetProperty formats it (Hidden
// property), the deferred action's CustomActionData (HideTarget), and the
// command line and output QuietExec would log (WixSilentExec logs neither).
func TestBootstrapEnrollKeepsTokenOutOfLog(t *testing.T) {
	wxs := readWxs(t)
	cmd := quietExecCmd(t, wxs, "BootstrapEnroll")
	for _, want := range []string{
		"&quot;[#filBreezeAgentExe]&quot; bootstrap --install-data",
		"&quot;[OriginalDatabase]|[BOOTSTRAP_TOKEN]|[SERVER_URL]&quot;",
		"--quiet",
	} {
		if !strings.Contains(cmd, want) {
			t.Errorf("BootstrapEnroll command lost %q; got %q", want, cmd)
		}
	}
	if strings.Contains(cmd, "CustomActionData") {
		t.Error("BootstrapEnroll must reference [OriginalDatabase] directly (see the CA comment), not CustomActionData")
	}
	ca := customActionAttrs(wxs, "BootstrapEnroll")
	if ca["HideTarget"] != "yes" {
		t.Errorf("BootstrapEnroll HideTarget = %q, want yes", ca["HideTarget"])
	}
	if !regexp.MustCompile(`<Property\s+Id="BootstrapEnroll"[^>]*Hidden="yes"`).MatchString(wxs) {
		t.Error(`expected <Property Id="BootstrapEnroll" ... Hidden="yes" /> so the formatted command (with the token) is masked in the MSI log`)
	}
}

// The uninstall-time CA must keep its command after the conversion.
func TestUninstallNotifyCommand(t *testing.T) {
	wxs := readWxs(t)
	if got, want := quietExecCmd(t, wxs, "UninstallNotify"), "&quot;[#filBreezeAgentExe]&quot; uninstall-notify"; got != want {
		t.Errorf("UninstallNotify command = %q, want %q", got, want)
	}
}

// The PowerShell CAs must still run the same scripts.
func TestUserHelperTaskCommands(t *testing.T) {
	wxs := readWxs(t)
	for id, script := range map[string]string{
		"RegisterUserHelperTask":               "[#filInstallWindowsPs1]",
		"ReRegisterUserHelperTaskAfterUpgrade": "[#filInstallWindowsPs1]",
		"RollbackRegisterUserHelperTask":       "[#filRemoveWindowsTaskPs1]",
		"UnregisterUserHelperTask":             "[#filRemoveWindowsTaskPs1]",
	} {
		cmd := quietExecCmd(t, wxs, id)
		for _, want := range []string{
			"&quot;[System64Folder]WindowsPowerShell\\v1.0\\powershell.exe&quot;",
			"-NoProfile -NonInteractive",
			"-ExecutionPolicy Bypass",
			"-File &quot;" + script + "&quot;",
		} {
			if !strings.Contains(cmd, want) {
				t.Errorf("%s command lost %q; got %q", id, want, cmd)
			}
		}
	}
}
