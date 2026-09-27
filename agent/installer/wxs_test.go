// Package installer holds the WiX sources for the Windows MSI plus this
// test, which exists so `go test ./...` guards structural invariants of
// breeze.wxs that would otherwise only surface on a real Windows box.
package installer

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func readWxs(t *testing.T) string {
	t.Helper()
	path := os.Getenv("BREEZE_WXS_PATH")
	if path == "" {
		path = "breeze.wxs"
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// launchConditions returns the Condition attribute of every <Launch> element.
func launchConditions(wxs string) []string {
	re := regexp.MustCompile(`<Launch\s+Condition="([^"]*)"`)
	var out []string
	for _, m := range re.FindAllStringSubmatch(wxs, -1) {
		out = append(out, m[1])
	}
	return out
}

// Windows Installer reports VersionNT = 603 / WindowsBuild = 9600 (the
// Windows 8.1 values) on every Windows 10+ install by design: msiexec.exe is
// manifested only up to Windows 8.1 (Microsoft KB 3202260). A
// VersionNT/WindowsBuild floor therefore cannot express "Windows 10 or
// later" and refused every fresh install on Windows 10/11 (v0.110.0 to
// v0.111.1). The floor must come from the registry, which the version shim
// does not touch, and the property the RegistrySearch fills must be the one
// the Launch condition reads.
func TestOsFloorDoesNotUseShimmedVersionProperties(t *testing.T) {
	wxs := readWxs(t)
	conds := launchConditions(wxs)
	if len(conds) == 0 {
		t.Fatal("no <Launch> conditions found")
	}
	for _, c := range conds {
		// VersionNT64 (the bitness check) is the only allowed use; any other
		// VersionNT or WindowsBuild reference, however escaped, is banned.
		stripped := strings.ReplaceAll(c, "VersionNT64", "")
		if strings.Contains(stripped, "VersionNT") || strings.Contains(stripped, "WindowsBuild") {
			t.Errorf("launch condition %q derives the OS floor from a shimmed Windows Installer property", c)
		}
	}
	// The RegistrySearch must sit directly under a <Property>, and that
	// property's Id must be what the Launch condition reads; otherwise the
	// condition evaluates an always-empty property and refuses every install.
	propRe := regexp.MustCompile(`(?s)<Property\s+Id="([A-Z_0-9]+)"[^>]*>\s*<RegistrySearch\s+[^>]*Key="SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"[^>]*Name="CurrentMajorVersionNumber"`)
	pm := propRe.FindStringSubmatch(wxs)
	if pm == nil {
		t.Fatal("expected a <Property> wrapping a RegistrySearch on HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\CurrentMajorVersionNumber to provide the Windows 10 / Server 2016 floor")
	}
	prop := pm[1]
	// WiX (WIX0012) requires a search property to be public, i.e. all
	// uppercase; a mixed-case id fails the release build (v0.112.0 tag).
	if strings.ToUpper(prop) != prop {
		t.Errorf("property %q must be all uppercase: AppSearch can only populate public properties (WIX0012)", prop)
	}
	found := false
	for _, c := range conds {
		if c == "Installed OR "+prop {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a <Launch> condition exactly %q (Installed OR keeps repair/uninstall unblocked)", "Installed OR "+prop)
	}
}

// In the stock InstallExecuteSequence AppSearch (400) runs after
// LaunchConditions (100), so a silent install would evaluate an empty
// property. InstallUISequence already orders them correctly (50 vs 100);
// we schedule explicitly in both so the ordering is never implicit.
func TestAppSearchRunsBeforeLaunchConditionsInBothSequences(t *testing.T) {
	wxs := readWxs(t)
	for _, seq := range []string{"InstallUISequence", "InstallExecuteSequence"} {
		re := regexp.MustCompile(`(?s)<` + seq + `>(.*?)</` + seq + `>`)
		m := re.FindStringSubmatch(wxs)
		if m == nil {
			t.Fatalf("no <%s> block", seq)
		}
		if !regexp.MustCompile(`<AppSearch\s+Before="LaunchConditions"\s*/>`).MatchString(m[1]) {
			t.Errorf("<%s> must schedule AppSearch before LaunchConditions", seq)
		}
	}
}

// customConditions maps each <Custom Action="..."> in InstallExecuteSequence
// to its Condition attribute ("" when unconditioned).
func customConditions(t *testing.T, wxs string) map[string]string {
	t.Helper()
	tagRe := regexp.MustCompile(`<Custom\s+Action="([^"]+)"[^>]*/>`)
	condRe := regexp.MustCompile(`\sCondition="([^"]*)"`)
	out := map[string]string{}
	for _, m := range tagRe.FindAllStringSubmatch(wxs, -1) {
		cond := ""
		if cm := condRe.FindStringSubmatch(m[0]); cm != nil {
			cond = cm[1]
		}
		out[m[1]] = cond
	}
	return out
}

// #4127: re-running the SAME MSI file (same ProductCode) enters Windows
// Installer maintenance mode, where Installed is true. A `NOT Installed` gate on
// the enrollment CAs made that retry a silent no-op on a box whose agent never
// enrolled. The agent itself is idempotent (both `enroll` and `bootstrap` exit 0
// without contacting the server when agent_id is already set), so the CAs must
// run on every non-uninstall path.
func TestEnrollmentActionsRunInMaintenanceMode(t *testing.T) {
	conds := customConditions(t, readWxs(t))
	for _, ca := range []string{"EnrollAgent", "BootstrapEnroll"} {
		c, ok := conds[ca]
		if !ok {
			t.Fatalf("no <Custom Action=%q> scheduled", ca)
		}
		if strings.Contains(c, "NOT Installed") {
			t.Errorf("%s condition %q skips maintenance-mode reruns (same-file retry can never enroll)", ca, c)
		}
		if !strings.Contains(c, "NOT REMOVE") {
			t.Errorf("%s condition %q must exclude uninstall (NOT REMOVE)", ca, c)
		}
	}
}

// KillBreezeProcesses stops both services on every non-uninstall run, but in
// maintenance mode no component changes state, so ServiceControl never starts
// them again. Without a restart a maintenance rerun (including one that just
// enrolled the agent) leaves the device offline until reboot.
func TestMaintenanceRunRestartsServices(t *testing.T) {
	conds := customConditions(t, readWxs(t))
	c, ok := conds["RecoverBreezeAfterUpgrade"]
	if !ok {
		t.Fatal("no <Custom Action=\"RecoverBreezeAfterUpgrade\"> scheduled")
	}
	if !strings.Contains(c, "WIX_UPGRADE_DETECTED") || !strings.Contains(c, "Installed AND NOT REMOVE") {
		t.Errorf("RecoverBreezeAfterUpgrade condition %q must cover both upgrades and maintenance runs", c)
	}
}

// The "already installed" blocks are the dead end an operator hits on retry;
// the messages must say what to do next, not just what is wrong.
func TestAlreadyInstalledMessagesGiveNextStep(t *testing.T) {
	wxs := readWxs(t)
	dm := regexp.MustCompile(`DowngradeErrorMessage="([^"]*)"`).FindStringSubmatch(wxs)
	if dm == nil {
		t.Fatal("no DowngradeErrorMessage")
	}
	em := regexp.MustCompile(`<Launch\s+Condition="NOT OTHEREDITIONFOUND"\s+Message="([^"]*)"`).FindStringSubmatch(wxs)
	if em == nil {
		t.Fatal("no cross-edition launch condition")
	}
	for name, msg := range map[string]string{"downgrade": dm[1], "cross-edition": em[1]} {
		if !strings.Contains(msg, "Uninstall") || !strings.Contains(msg, "installer") {
			t.Errorf("%s message %q must tell the operator to uninstall first or get the right installer", name, msg)
		}
	}
	if !strings.Contains(dm[1], "current installer") {
		t.Errorf("downgrade message %q must point at the current installer", dm[1])
	}
}

// customActionAttrs returns the attributes of the <CustomAction Id="id" .../>
// element as a map, or nil when no such element exists.
func customActionAttrs(wxs, id string) map[string]string {
	elRe := regexp.MustCompile(`(?s)<CustomAction\s+Id="` + regexp.QuoteMeta(id) + `"(.*?)/>`)
	m := elRe.FindStringSubmatch(wxs)
	if m == nil {
		return nil
	}
	out := map[string]string{"Id": id}
	for _, a := range regexp.MustCompile(`(\w+)="([^"]*)"`).FindAllStringSubmatch(m[1], -1) {
		out[a[1]] = a[2]
	}
	return out
}

// #3624: an immediate EXE custom action runs impersonated on the installing
// user's desktop, and Windows Installer launches it with no CREATE_NO_WINDOW,
// so a console-subsystem cmd.exe got a visible black window. KillBreezeProcesses
// includes a conditional ~3s wait for the graceful `sc stop`, so the window sat
// on screen through every upgrade over a running agent. It must stay immediate
// and before InstallValidate (files-in-use check, #944), so the fix is to launch
// the same command through WixQuietExec, which spawns it with no window.
func TestKillBreezeProcessesRunsWithoutConsoleWindow(t *testing.T) {
	wxs := readWxs(t)
	ca := customActionAttrs(wxs, "KillBreezeProcesses")
	if ca == nil {
		t.Fatal("no <CustomAction Id=\"KillBreezeProcesses\">")
	}
	if _, ok := ca["ExeCommand"]; ok {
		t.Errorf("KillBreezeProcesses is an EXE custom action (ExeCommand); an immediate EXE CA flashes a console window on the user's desktop")
	}
	if ca["DllEntry"] != "WixQuietExec" {
		t.Errorf("KillBreezeProcesses DllEntry = %q, want WixQuietExec (runs the command with no console window)", ca["DllEntry"])
	}
	if !strings.HasPrefix(ca["BinaryRef"], "Wix4UtilCA_") {
		t.Errorf("KillBreezeProcesses BinaryRef = %q, want the WiX Util extension CA DLL (Wix4UtilCA_*)", ca["BinaryRef"])
	}
	// Timing is load-bearing: the processes must be dead before
	// InstallValidate's files-in-use check, which a deferred CA cannot do.
	if ca["Execute"] != "immediate" {
		t.Errorf("KillBreezeProcesses Execute = %q, want immediate (a deferred CA runs after InstallValidate, reintroducing #944)", ca["Execute"])
	}
	if ca["Return"] != "ignore" {
		t.Errorf("KillBreezeProcesses Return = %q, want ignore (best-effort; a fresh box has nothing to stop)", ca["Return"])
	}
	if !regexp.MustCompile(`<Custom\s+Action="KillBreezeProcesses"\s+Before="InstallValidate"\s+Condition="NOT REMOVE"\s*/>`).MatchString(wxs) {
		t.Error(`KillBreezeProcesses must stay scheduled Before="InstallValidate" with Condition="NOT REMOVE"`)
	}

	// Immediate-mode WixQuietExec reads its command line from the
	// WixQuietExecCmdLine property, which must be set before the CA runs.
	setRe := regexp.MustCompile(`(?s)<SetProperty\s+Id="WixQuietExecCmdLine"\s+Value="([^"]*)"\s+Before="KillBreezeProcesses"\s+Sequence="execute"\s*/>`)
	sm := setRe.FindStringSubmatch(wxs)
	if sm == nil {
		t.Fatal(`expected <SetProperty Id="WixQuietExecCmdLine" Value="..." Before="KillBreezeProcesses" Sequence="execute" />`)
	}
	cmd := sm[1]
	for _, want := range []string{
		`[System64Folder]cmd.exe`,
		// disarm SCM recovery before anything dies (no resurrection race)
		`sc failure BreezeWatchdog reset= 0 actions=`,
		`sc failure BreezeAgent reset= 0 actions=`,
		// graceful stops, watchdog first
		`sc stop BreezeWatchdog`,
		`sc stop BreezeAgent`,
		// the conditional wait must survive: dropping it force-kills a live agent
		`findstr &quot;PENDING RUNNING&quot;`,
		`ping -n 4 127.0.0.1`,
		`taskkill /F /IM breeze-agent.exe`,
		`exit /b 0`,
	} {
		if !strings.Contains(cmd, want) {
			t.Errorf("WixQuietExecCmdLine lost %q; got %q", want, cmd)
		}
	}
	if strings.Contains(cmd, "taskkill /F /T") || strings.Contains(cmd, " /T ") {
		t.Errorf("taskkill must not use /T (kills the msiexec performing the install when deployed via Breeze scripts); got %q", cmd)
	}
	if strings.Contains(wxs, "BREEZE_KILL_CMD") {
		t.Error("BREEZE_KILL_CMD is dead once KillBreezeProcesses runs through WixQuietExec; remove it")
	}
}

// No immediate custom action may launch an EXE: it would run on the
// installing user's desktop and show a console window (#3624). Deferred and
// rollback EXE CAs with Impersonate="no" run as LocalSystem in session 0 and
// are invisible.
func TestNoImmediateExeCustomActions(t *testing.T) {
	wxs := readWxs(t)
	elRe := regexp.MustCompile(`(?s)<CustomAction\s+Id="([^"]+)"(.*?)/>`)
	for _, m := range elRe.FindAllStringSubmatch(wxs, -1) {
		ca := customActionAttrs(wxs, m[1])
		if _, isExe := ca["ExeCommand"]; !isExe {
			continue
		}
		exec := ca["Execute"]
		if exec == "" || exec == "immediate" || exec == "firstSequence" || exec == "oncePerProcess" || exec == "secondSequence" {
			t.Errorf("custom action %s is an immediate EXE CA (Execute=%q); it will flash a console window. Use WixQuietExec or make it deferred with Impersonate=\"no\"", m[1], exec)
		}
	}
}

// The Util extension supplies the WixQuietExec CA DLL (Wix4UtilCA_*). Every
// MSI build (this repo's release.yml, the hosted and self-host signing repos)
// goes through build-msi.ps1, so that script must load the extension or the
// link fails with an unresolved BinaryRef.
func TestBuildScriptLoadsUtilExtension(t *testing.T) {
	b, err := os.ReadFile("build-msi.ps1")
	if err != nil {
		t.Fatalf("read build-msi.ps1: %v", err)
	}
	s := string(b)
	if !strings.Contains(s, `"-ext"`) || !strings.Contains(s, "WixToolset.Util.wixext") {
		t.Error("build-msi.ps1 must pass -ext WixToolset.Util.wixext to wix build")
	}
	if !strings.Contains(s, "extension add") {
		t.Error("build-msi.ps1 must install WixToolset.Util.wixext (wix extension add) so callers need no extra setup step")
	}
}
