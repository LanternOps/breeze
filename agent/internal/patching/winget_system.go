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

func (p *SystemWingetProvider) Scan() ([]AvailablePatch, error) {
	stdout, stderr, code, err := p.run(p.wingetPath, systemScanArgs(), systemWingetScanTimeout)
	if err != nil {
		return nil, fmt.Errorf("winget upgrade failed: %w", err)
	}
	if code != 0 && stdout == "" {
		return nil, fmt.Errorf("winget upgrade failed (exit %d): %s", code, strings.TrimSpace(stderr))
	}
	return parseWingetUpgradeOutput(stdout), nil
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
