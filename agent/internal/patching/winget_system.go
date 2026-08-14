package patching

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// machinePassFailedReason is reported when the SYSTEM machine-scope pass could
// not complete: the provider is skipped wholesale, so the user-context pass is
// never attempted and per-user apps are unscanned for a different reason than a
// missing helper session.
const machinePassFailedReason = "machine-scope pass failed; user-context pass not attempted"

const (
	systemWingetScanTimeout    = 120 * time.Second
	systemWingetInstallTimeout = 600 * time.Second
)

// SystemWingetProvider implements PatchProvider by running the resolved
// winget.exe directly from the SYSTEM agent process against MACHINE scope,
// optionally followed by a best-effort user-context pass through the user
// helper for per-user installs (#2727).
//
// Both passes live behind ONE provider ID on purpose. Coverage is computed per
// source BUCKET and a bucket only counts as scanned when every provider feeding
// it succeeded (heartbeat.coveredPatchSources), so a separate `winget-user`
// provider would leave the shared third_party bucket permanently uncovered on
// any machine with nobody logged in — the API would then never sweep stale
// third-party pending rows for the whole fleet of unattended devices. Keeping
// the user pass internal makes coverage semantics byte-identical to before:
// winget is covered iff the SYSTEM machine-scope pass parsed.
type SystemWingetProvider struct {
	wingetPath string
	run        cmdRunner
	// userExec, when non-nil, runs winget inside the interactive user's
	// session. nil on non-Windows and whenever no helper transport exists.
	userExec UserExecFunc

	mu sync.RWMutex
	// userScan records the outcome of the last user-context pass so callers
	// can report that per-user apps were not scanned.
	userScan UserScanStatus
	// userScopeIDs holds the lowercased package IDs the last scan saw ONLY at
	// user scope, so Install/Uninstall can refuse them explicitly.
	userScopeIDs map[string]struct{}
}

// NewSystemWingetProvider constructs a SystemWingetProvider that invokes the
// given winget executable via run.
func NewSystemWingetProvider(wingetPath string, run cmdRunner) *SystemWingetProvider {
	return &SystemWingetProvider{wingetPath: wingetPath, run: run}
}

// NewSystemWingetProviderWithUserScan constructs a SystemWingetProvider that
// also attempts a user-context scan via userExec. A nil userExec is equivalent
// to NewSystemWingetProvider.
func NewSystemWingetProviderWithUserScan(wingetPath string, run cmdRunner, userExec UserExecFunc) *SystemWingetProvider {
	p := NewSystemWingetProvider(wingetPath, run)
	p.userExec = userExec
	return p
}

var _ PatchProvider = (*SystemWingetProvider)(nil)
var _ UserScopeScanner = (*SystemWingetProvider)(nil)

func (p *SystemWingetProvider) ID() string { return "winget" }
func (p *SystemWingetProvider) Name() string {
	return "winget (Windows Package Manager, machine scope)"
}

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
		p.recordUserScanStatus(UserScanStatus{Reason: machinePassFailedReason})
		return nil, fmt.Errorf("winget upgrade failed: %w", err)
	}
	if code != 0 && stdout == "" {
		p.recordUserScanStatus(UserScanStatus{Reason: machinePassFailedReason})
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
		p.recordUserScanStatus(UserScanStatus{Reason: machinePassFailedReason})
		return nil, fmt.Errorf("%w: %v (exit %d, stdout: %q, stderr: %q)",
			ErrScanSkipped, parseErr, code,
			truncatePatchField(stdout), truncatePatchField(stderr))
	}
	return p.withUserScope(patches), nil
}

// withUserScope labels the machine-scope results and appends whatever the
// best-effort user-context pass found. The user pass NEVER changes the outcome
// of the machine pass: any failure (no helper configured, no session, IPC
// error, winget error, unparsable output) is recorded in the status and the
// machine results are returned unchanged, exactly as before #2727.
func (p *SystemWingetProvider) withUserScope(machine []AvailablePatch) []AvailablePatch {
	if p.userExec == nil {
		merged := mergeWingetScopes(machine, nil)
		p.recordUserScan(UserScanStatus{
			Reason: "no user-context executor configured",
		}, merged)
		return merged
	}

	userPatches, err := userWingetScan(p.userExec)
	if err != nil {
		merged := mergeWingetScopes(machine, nil)
		p.recordUserScan(UserScanStatus{
			Attempted: true,
			Reason:    truncatePatchDescription(err.Error()),
		}, merged)
		return merged
	}

	merged := mergeWingetScopes(machine, userPatches)
	p.recordUserScan(UserScanStatus{Attempted: true, Scanned: true}, merged)
	return merged
}

func (p *SystemWingetProvider) recordUserScan(status UserScanStatus, merged []AvailablePatch) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.userScan = status
	p.userScopeIDs = userScopeIDSet(merged)
}

// recordUserScanStatus updates only the reported status, leaving the remembered
// user-scope package IDs intact. Used when the machine pass failed and the
// provider is skipped entirely: the install guard should keep refusing packages
// the last successful scan proved to be user-scope rather than reverting to a
// machine-scope install just because one scan failed.
func (p *SystemWingetProvider) recordUserScanStatus(status UserScanStatus) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.userScan = status
}

// LastUserScan reports whether the most recent scan covered per-user installs.
func (p *SystemWingetProvider) LastUserScan() UserScanStatus {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.userScan
}

// errUserScopeInstallUnsupported guards the detection-only scope of #2727: a
// package the last scan saw only at user scope cannot be remediated by this
// SYSTEM process. Running the machine-scope install anyway would either fail
// with a confusing winget error or install a SECOND, machine-wide copy
// alongside the user's, so it is refused with an explicit message instead.
func (p *SystemWingetProvider) errUserScopeInstallUnsupported(action, patchID string) error {
	return fmt.Errorf("%s %q: package is installed per-user (user scope) and cannot be %sed from the SYSTEM agent context; per-user remediation is not supported yet",
		action, patchID, action)
}

// isUserScopeOnly reports whether the last scan saw patchID only at user scope.
func (p *SystemWingetProvider) isUserScopeOnly(patchID string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	_, ok := p.userScopeIDs[strings.ToLower(patchID)]
	return ok
}

func (p *SystemWingetProvider) Install(patchID string) (InstallResult, error) {
	if !validWingetPkgID.MatchString(patchID) {
		return InstallResult{}, fmt.Errorf("invalid winget package ID: %q", patchID)
	}
	if p.isUserScopeOnly(patchID) {
		return InstallResult{}, p.errUserScopeInstallUnsupported("install", patchID)
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
	if p.isUserScopeOnly(patchID) {
		return p.errUserScopeInstallUnsupported("uninstall", patchID)
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
