package tools

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Registry-driven Windows uninstall fallback (#7037).
//
// On Windows 11 24H2+ wmic.exe is gone, which left winget as the only uninstall
// provider. When winget cannot run (0xc0000135 as SYSTEM on some builds) or
// cannot match the package, nothing else was tried — even though the program
// itself registers how to remove it under
// HKLM\SOFTWARE\[WOW6432Node\]Microsoft\Windows\CurrentVersion\Uninstall.
//
// This fallback runs, in order of preference, for each machine-wide Uninstall
// entry whose DisplayName matches exactly:
//
//  1. `%SystemRoot%\System32\msiexec.exe /x {ProductCode} /qn /norestart` for
//     Windows Installer entries. Only the validated GUID is taken from the
//     registry; nothing else from the entry is executed.
//  2. The entry's own QuietUninstallString, parsed into an absolute .exe path
//     and a verbatim argument tail, launched directly (never through a shell).
//
// An entry with neither is refused: silent switches are never guessed.
//
// Trust boundary: the agent runs as SYSTEM, so every string executed here must
// be one only an administrator could have written. HKLM Uninstall keys are
// admin-writable only; per-user hives (HKEY_USERS\<SID>) are writable by that
// user, so running their strings as SYSTEM would be a privilege escalation and
// they are deliberately not enumerated. The executable path is additionally
// rejected when it sits in a location a standard user can typically write to
// (a user profile, AppData, a Temp directory), and generic script/command hosts
// are refused outright.
//
// Completion is judged by the Uninstall key disappearing, not by the launched
// process: Inno Setup's unins000.exe relaunches itself from %TEMP% and exits
// immediately, and some uninstallers leave a child running.

const (
	registryUninstallKindMSI   = "msi"
	registryUninstallKindQuiet = "quiet"

	// maxRegistryUninstallEntries caps how many same-named entries one uninstall
	// command will act on. Real duplicates are an x64/x86 pair or a stale
	// leftover; more than this means the name is not specific enough to act on
	// unattended.
	maxRegistryUninstallEntries = 4
)

// windowsUninstallEntry is one subkey of a machine-wide Uninstall key.
type windowsUninstallEntry struct {
	// KeyPath is the full subkey path under HKLM, used for the presence check.
	KeyPath              string
	KeyName              string
	DisplayName          string
	DisplayVersion       string
	UninstallString      string
	QuietUninstallString string
	WindowsInstaller     bool
	SystemComponent      bool
}

func (e windowsUninstallEntry) label() string {
	if e.KeyPath != "" {
		return `HKLM\` + e.KeyPath
	}
	return e.KeyName
}

type registryUninstallPlan struct {
	Entry       windowsUninstallEntry
	Kind        string // registryUninstallKindMSI | registryUninstallKindQuiet
	ProductCode string // MSI: normalised upper-case braced GUID
	Exe         string // quiet: absolute path of the registered uninstaller
	Args        string // quiet: argument tail, passed through verbatim
}

// uninstallerProcess is the slice of *exec.Cmd the wait loop needs.
type uninstallerProcess interface {
	Wait() error
	Kill() error
}

// Seams; the OS implementations live in software_uninstall_registry_{windows,other}.go.
var (
	listWindowsUninstallEntries = listWindowsUninstallEntriesOS
	startRegistryUninstaller    = startRegistryUninstallerOS
	uninstallEntryPresent       = uninstallEntryPresentOS

	registryUninstallTimeout       = 10 * time.Minute
	registryUninstallPostExitGrace = 3 * time.Minute
	registryUninstallPollInterval  = 2 * time.Second
)

var (
	msiProductCodePattern = regexp.MustCompile(`^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$`)
	// msiexecCommandPattern recognises an msiexec invocation (bare or fully
	// qualified, quoted or not) whose first switch is /I or /X followed by a
	// product code. Only the captured GUID is ever used.
	msiexecCommandPattern    = regexp.MustCompile(`(?i)^\s*"?(?:[a-z]:\\[^"]*\\)?msiexec(?:\.exe)?"?\s+/[ix]\s*(\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\})`)
	driveAbsolutePathPattern = regexp.MustCompile(`^[A-Za-z]:\\`)

	// Executables that turn their arguments into arbitrary code. A registered
	// uninstall string that routes through one of these is refused.
	refusedUninstallerHosts = map[string]struct{}{
		"cmd.exe":        {},
		"powershell.exe": {},
		"pwsh.exe":       {},
		"wscript.exe":    {},
		"cscript.exe":    {},
		"mshta.exe":      {},
		"rundll32.exe":   {},
		"regsvr32.exe":   {},
	}
)

// splitUninstallCommandLine splits a registered uninstall command line into the
// executable path and the (verbatim) argument tail, the way CreateProcess would
// resolve it, and rejects anything unsafe to launch as SYSTEM.
func splitUninstallCommandLine(raw string) (exe string, rest string, err error) {
	if strings.ContainsAny(raw, "\x00\r\n") {
		return "", "", fmt.Errorf("uninstall string contains control characters")
	}
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", "", fmt.Errorf("uninstall string is empty")
	}

	if strings.HasPrefix(s, `"`) {
		end := strings.IndexByte(s[1:], '"')
		if end < 0 {
			return "", "", fmt.Errorf("uninstall string has an unterminated quote")
		}
		exe = s[1 : 1+end]
		tail := s[1+end+1:]
		if tail != "" && tail[0] != ' ' && tail[0] != '\t' {
			return "", "", fmt.Errorf("uninstall string's quoted executable is not separated from its arguments")
		}
		rest = strings.TrimSpace(tail)
	} else {
		// Unquoted: the executable ends at the first ".exe" followed by
		// whitespace or end of string (paths may contain spaces).
		lower := strings.ToLower(s)
		cut := -1
		for from := 0; ; {
			idx := strings.Index(lower[from:], ".exe")
			if idx < 0 {
				break
			}
			end := from + idx + len(".exe")
			if end == len(s) || s[end] == ' ' || s[end] == '\t' {
				cut = end
				break
			}
			from = end
		}
		if cut < 0 {
			return "", "", fmt.Errorf("uninstall string does not name an .exe")
		}
		exe = s[:cut]
		rest = strings.TrimSpace(s[cut:])
	}

	if err := validateUninstallerPath(exe); err != nil {
		return "", "", err
	}
	return exe, rest, nil
}

func validateUninstallerPath(exe string) error {
	if !driveAbsolutePathPattern.MatchString(exe) {
		return fmt.Errorf("uninstaller path %q is not an absolute local path", exe)
	}
	if strings.ContainsAny(exe, `"/`) {
		return fmt.Errorf("uninstaller path %q contains invalid characters", exe)
	}
	lower := strings.ToLower(exe)
	if !strings.HasSuffix(lower, ".exe") {
		return fmt.Errorf("uninstaller path %q is not an .exe", exe)
	}
	segments := strings.Split(lower, `\`)
	for _, seg := range segments {
		if seg == ".." || seg == "." {
			return fmt.Errorf("uninstaller path %q contains a traversal segment", exe)
		}
	}
	// Locations a standard user can usually write to. An HKLM entry pointing
	// into one would let that user swap the binary SYSTEM is about to run.
	if len(segments) > 1 && segments[1] == "users" {
		return fmt.Errorf("uninstaller path %q is in a user-writable location", exe)
	}
	for _, seg := range segments[1:] {
		if seg == "appdata" || seg == "temp" || seg == "tmp" {
			return fmt.Errorf("uninstaller path %q is in a user-writable location", exe)
		}
	}
	if _, refused := refusedUninstallerHosts[segments[len(segments)-1]]; refused {
		return fmt.Errorf("uninstaller %q is a script host; refusing to run it as SYSTEM", exe)
	}
	return nil
}

// msiProductCodeFromEntry returns the entry's Windows Installer product code in
// upper-case braced form, or "" when the entry is not a usable MSI entry.
func msiProductCodeFromEntry(e windowsUninstallEntry) string {
	if e.WindowsInstaller && msiProductCodePattern.MatchString(strings.TrimSpace(e.KeyName)) {
		return strings.ToUpper(strings.TrimSpace(e.KeyName))
	}
	for _, s := range []string{e.QuietUninstallString, e.UninstallString} {
		if m := msiexecCommandPattern.FindStringSubmatch(s); m != nil {
			return strings.ToUpper(m[1])
		}
	}
	return ""
}

// planRegistryUninstall decides how one Uninstall entry would be removed,
// without running anything.
func planRegistryUninstall(e windowsUninstallEntry) (registryUninstallPlan, error) {
	if code := msiProductCodeFromEntry(e); code != "" {
		return registryUninstallPlan{Entry: e, Kind: registryUninstallKindMSI, ProductCode: code}, nil
	}
	quiet := strings.TrimSpace(e.QuietUninstallString)
	if quiet == "" {
		return registryUninstallPlan{}, fmt.Errorf("%s is not a Windows Installer entry and declares no QuietUninstallString; refusing to guess silent switches", e.label())
	}
	exe, args, err := splitUninstallCommandLine(quiet)
	if err != nil {
		return registryUninstallPlan{}, fmt.Errorf("%s QuietUninstallString rejected: %w", e.label(), err)
	}
	return registryUninstallPlan{Entry: e, Kind: registryUninstallKindQuiet, Exe: exe, Args: args}, nil
}

// registryUninstallCmdLine returns the application path and the exact
// CreateProcess command line for a plan. The application path is always
// absolute, so no search-path resolution happens; the command line is handed to
// CreateProcess as-is (no shell).
func registryUninstallCmdLine(plan registryUninstallPlan, msiexecPath string) (exePath string, cmdLine string) {
	if plan.Kind == registryUninstallKindMSI {
		return msiexecPath, `"` + msiexecPath + `" /x ` + plan.ProductCode + ` /qn /norestart`
	}
	line := `"` + plan.Exe + `"`
	if plan.Args != "" {
		line += " " + plan.Args
	}
	return plan.Exe, line
}

// matchWindowsUninstallEntries returns the user-visible entries whose
// DisplayName equals name (case-insensitive, trimmed). When version is given
// and at least one entry carries it, only those are returned; otherwise the
// version is treated as stale inventory data and ignored. SystemComponent
// entries are skipped because the inventory never lists them.
func matchWindowsUninstallEntries(entries []windowsUninstallEntry, name, version string) []windowsUninstallEntry {
	target := strings.ToLower(strings.TrimSpace(name))
	if target == "" {
		return nil
	}
	var byName []windowsUninstallEntry
	for _, e := range entries {
		if e.SystemComponent {
			continue
		}
		if strings.ToLower(strings.TrimSpace(e.DisplayName)) == target {
			byName = append(byName, e)
		}
	}
	wantVersion := strings.TrimSpace(version)
	if wantVersion == "" {
		return byName
	}
	var byVersion []windowsUninstallEntry
	for _, e := range byName {
		if strings.EqualFold(strings.TrimSpace(e.DisplayVersion), wantVersion) {
			byVersion = append(byVersion, e)
		}
	}
	if len(byVersion) > 0 {
		return byVersion
	}
	return byName
}

// uninstallViaRegistryEntries removes every machine-wide Uninstall entry named
// `name` using what the entry itself registers. Every matched entry is planned
// before any is run, so an unplannable duplicate cannot leave the program
// half-removed.
func uninstallViaRegistryEntries(name, version string) error {
	entries, err := listWindowsUninstallEntries()
	if err != nil {
		return fmt.Errorf("could not read the machine-wide Uninstall registry keys: %w", err)
	}
	matches := matchWindowsUninstallEntries(entries, name, version)
	if len(matches) == 0 {
		return fmt.Errorf("no machine-wide Uninstall registry entry is named %q", name)
	}
	if len(matches) > maxRegistryUninstallEntries {
		return fmt.Errorf("%d machine-wide Uninstall registry entries are named %q; refusing to remove more than %d unattended", len(matches), name, maxRegistryUninstallEntries)
	}

	plans := make([]registryUninstallPlan, 0, len(matches))
	for _, e := range matches {
		plan, err := planRegistryUninstall(e)
		if err != nil {
			return err
		}
		plans = append(plans, plan)
	}

	for _, plan := range plans {
		proc, err := startRegistryUninstaller(plan)
		if err != nil {
			return fmt.Errorf("could not start the registered uninstaller for %s: %w", plan.Entry.label(), err)
		}
		if err := waitForRegistryUninstall(plan, proc); err != nil {
			return err
		}
	}
	return nil
}

// exitCodeOf extracts a process exit code from a Wait error. nil → 0; an error
// that carries no code → -1.
func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	var coded interface{ ExitCode() int }
	if errors.As(err, &coded) {
		return coded.ExitCode()
	}
	return -1
}

// registryUninstallExitSucceeded reports whether an uninstaller exit code means
// "done or finishing": 0, ERROR_SUCCESS_REBOOT_REQUIRED (3010) and
// ERROR_SUCCESS_REBOOT_INITIATED (1641).
func registryUninstallExitSucceeded(code int) bool {
	return code == 0 || code == 3010 || code == 1641
}

// waitForRegistryUninstall polls until the plan's Uninstall key is gone.
//
//   - Key gone at any point → success, even if the process is still running.
//   - Process exits with a success code → keep polling for the post-exit grace
//     (Inno Setup relaunches itself and returns at once).
//   - Process exits with a failure code → one last check, then fail.
//   - Overall timeout → kill the process and fail.
//
// A presence-check error is never read as "gone".
func waitForRegistryUninstall(plan registryUninstallPlan, proc uninstallerProcess) error {
	done := make(chan error, 1)
	go func() { done <- proc.Wait() }()

	deadline := time.NewTimer(registryUninstallTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(registryUninstallPollInterval)
	defer ticker.Stop()

	var (
		graceC    <-chan time.Time
		exited    bool
		exitCode  int
		lastCheck error
	)
	describe := func() string {
		if plan.Kind == registryUninstallKindMSI {
			return fmt.Sprintf("msiexec /x %s (%s)", plan.ProductCode, plan.Entry.label())
		}
		return fmt.Sprintf("registered QuietUninstallString of %s", plan.Entry.label())
	}
	checkGone := func() bool {
		present, err := uninstallEntryPresent(plan.Entry)
		if err != nil {
			lastCheck = err
			return false
		}
		lastCheck = nil
		return !present
	}
	notGone := func(reason string) error {
		if lastCheck != nil {
			return fmt.Errorf("%s %s, and whether its Uninstall entry was removed could not be checked: %v", describe(), reason, lastCheck)
		}
		return fmt.Errorf("%s %s, but its Uninstall entry is still present", describe(), reason)
	}

	for {
		select {
		case err := <-done:
			exited = true
			exitCode = exitCodeOf(err)
			if checkGone() {
				return nil
			}
			if !registryUninstallExitSucceeded(exitCode) {
				return notGone(fmt.Sprintf("exited with code %d", exitCode))
			}
			timer := time.NewTimer(registryUninstallPostExitGrace)
			defer timer.Stop()
			graceC = timer.C
			done = nil
		case <-ticker.C:
			if checkGone() {
				return nil
			}
		case <-graceC:
			if checkGone() {
				return nil
			}
			return notGone(fmt.Sprintf("exited with code %d and %s passed", exitCode, registryUninstallPostExitGrace))
		case <-deadline.C:
			if checkGone() {
				return nil
			}
			if !exited {
				_ = proc.Kill()
				return notGone(fmt.Sprintf("timed out after %s and was killed", registryUninstallTimeout))
			}
			return notGone(fmt.Sprintf("timed out after %s", registryUninstallTimeout))
		}
	}
}
