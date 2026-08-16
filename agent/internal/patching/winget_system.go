package patching

import (
	"fmt"
	"strings"
	"time"
)

const (
	systemWingetScanTimeout    = 120 * time.Second
	systemWingetInstallTimeout = 600 * time.Second
)

// SystemWingetProvider implements PatchProvider by running the resolved
// winget.exe directly from the SYSTEM agent process against MACHINE scope.
type SystemWingetProvider struct {
	wingetPath string
	run        cmdRunner
}

// NewSystemWingetProvider constructs a SystemWingetProvider that invokes the
// given winget executable via run.
func NewSystemWingetProvider(wingetPath string, run cmdRunner) *SystemWingetProvider {
	return &SystemWingetProvider{wingetPath: wingetPath, run: run}
}

var _ PatchProvider = (*SystemWingetProvider)(nil)

func (p *SystemWingetProvider) ID() string   { return "winget" }
func (p *SystemWingetProvider) Name() string { return "winget (Windows Package Manager, machine scope)" }

func systemScanArgs() []string {
	return []string{"upgrade", "--include-unknown", "--scope", "machine",
		"--source", "winget", "--accept-source-agreements", "--disable-interactivity"}
}

func systemInstallArgs(id string) []string {
	return []string{"install", "--exact", "--id", id, "--scope", "machine", "--silent",
		"--accept-package-agreements", "--accept-source-agreements", "--source", "winget", "--disable-interactivity"}
}

func systemUninstallArgs(id string) []string {
	return []string{"uninstall", "--exact", "--id", id, "--scope", "machine", "--silent", "--disable-interactivity"}
}

func systemListArgs() []string {
	return []string{"list", "--scope", "machine", "--source", "winget",
		"--accept-source-agreements", "--disable-interactivity"}
}

func systemIsInstalledArgs(id string) []string {
	return []string{"list", "--exact", "--id", id, "--scope", "machine",
		"--source", "winget", "--accept-source-agreements", "--disable-interactivity"}
}

func (p *SystemWingetProvider) Scan() ([]AvailablePatch, error) {
	stdout, stderr, code, err := p.run(p.wingetPath, systemScanArgs(), systemWingetScanTimeout)
	if err != nil {
		return nil, fmt.Errorf("winget upgrade failed: %w", err)
	}
	if code != 0 && stdout == "" {
		return nil, fmt.Errorf("winget upgrade failed (exit %d): %s", code, strings.TrimSpace(stderr))
	}
	patches, parseErr := parseWingetUpgradeOutput(stdout)
	if parseErr != nil {
		// winget exited without a table we could read and without saying it
		// matched nothing (localized column headers, garbled or truncated
		// console-less output, empty stdout on exit 0). We cannot claim to have
		// enumerated this device's third-party packages, so report a skip. A
		// skipped provider is excluded from scan coverage, which stops the
		// server sweeping existing third_party pending rows to "missing" on the
		// strength of a scan that never inspected them (#2726).
		//
		// Both streams are bounded and stdout is included deliberately: on the
		// most common real trigger (localized column headers) stderr is empty,
		// and the unparsable stdout head is the only clue a tech has for why
		// this device keeps reporting a skipped winget scan.
		return nil, fmt.Errorf("%w: %v (exit %d, stdout: %q, stderr: %q)",
			ErrScanSkipped, parseErr, code,
			truncatePatchField(stdout), truncatePatchField(stderr))
	}
	return patches, nil
}

func (p *SystemWingetProvider) Install(patchID string) (InstallResult, error) {
	if !validWingetPkgID.MatchString(patchID) {
		return InstallResult{}, fmt.Errorf("invalid winget package ID: %q", patchID)
	}
	stdout, stderr, code, err := p.run(p.wingetPath, systemInstallArgs(patchID), systemWingetInstallTimeout)
	if err != nil {
		return InstallResult{}, fmt.Errorf("winget install failed: %w", err)
	}
	combined := strings.TrimSpace(stdout + "\n" + stderr)
	if code != 0 {
		return InstallResult{}, fmt.Errorf("winget install failed (exit %d): %s", code, combined)
	}
	res := InstallResult{PatchID: patchID, Provider: "winget", Message: combined}
	low := strings.ToLower(combined)
	if strings.Contains(low, "restart") || strings.Contains(low, "reboot") {
		res.RebootRequired = true
	}
	return res, nil
}

func (p *SystemWingetProvider) Uninstall(patchID string) error {
	if !validWingetPkgID.MatchString(patchID) {
		return fmt.Errorf("invalid winget package ID: %q", patchID)
	}
	_, stderr, code, err := p.run(p.wingetPath, systemUninstallArgs(patchID), systemWingetInstallTimeout)
	if err != nil {
		return fmt.Errorf("winget uninstall failed: %w", err)
	}
	if code != 0 {
		return fmt.Errorf("winget uninstall failed (exit %d): %s", code, strings.TrimSpace(stderr))
	}
	return nil
}

// IsInstalled reports whether id is present on this machine, scoped to
// MACHINE (matching the install/uninstall scope) so it agrees with what
// Install/Uninstall actually act on. Install-only callers use this to decide
// whether to skip a redundant install, never to decide whether to upgrade.
//
// winget exits non-zero when `list --exact --id` finds no match — that is a
// normal "not installed" outcome, not a runner failure, so it is reported as
// (false, nil) rather than an error. Only a failure to invoke the process at
// all (run returning a non-nil err) is treated as an error here.
func (p *SystemWingetProvider) IsInstalled(id string) (bool, error) {
	if !validWingetPkgID.MatchString(id) {
		return false, fmt.Errorf("invalid winget package ID: %q", id)
	}
	stdout, _, code, err := p.run(p.wingetPath, systemIsInstalledArgs(id), systemWingetScanTimeout)
	if err != nil {
		return false, fmt.Errorf("winget list failed: %w", err)
	}
	if code != 0 {
		return false, nil
	}
	return strings.Contains(stdout, id), nil
}

// InstallExact installs (never upgrades) id at MACHINE scope. When version is
// non-empty, --version <v> is appended so winget installs exactly that
// build; an exact-version miss (winget reports "No package found matching
// input criteria" or exits non-zero) is a failure, never a silent fallback to
// latest.
func (p *SystemWingetProvider) InstallExact(id, version string) (InstallResult, error) {
	if !validWingetPkgID.MatchString(id) {
		return InstallResult{}, fmt.Errorf("invalid winget package ID: %q", id)
	}
	args := systemInstallArgs(id)
	if version != "" {
		args = append(args, "--version", version)
	}
	stdout, stderr, code, err := p.run(p.wingetPath, args, systemWingetInstallTimeout)
	if err != nil {
		return InstallResult{}, fmt.Errorf("winget install failed: %w", err)
	}
	combined := strings.TrimSpace(stdout + "\n" + stderr)
	if code != 0 || strings.Contains(combined, "No package found matching input criteria") {
		return InstallResult{}, fmt.Errorf("winget install failed (exit %d): %s", code, combined)
	}
	res := InstallResult{PatchID: id, Provider: "winget", Message: combined}
	low := strings.ToLower(combined)
	if strings.Contains(low, "restart") || strings.Contains(low, "reboot") {
		res.RebootRequired = true
	}
	return res, nil
}

func (p *SystemWingetProvider) GetInstalled() ([]InstalledPatch, error) {
	stdout, stderr, code, err := p.run(p.wingetPath, systemListArgs(), systemWingetScanTimeout)
	if err != nil {
		return nil, fmt.Errorf("winget list failed: %w", err)
	}
	if code != 0 && stdout == "" {
		return nil, fmt.Errorf("winget list failed (exit %d): %s", code, strings.TrimSpace(stderr))
	}
	return parseWingetListOutput(stdout), nil
}
