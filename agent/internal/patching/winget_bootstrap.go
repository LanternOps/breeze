package patching

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// bootstrapAction describes what the SYSTEM-context bootstrapper should do
// about winget on this host.
type bootstrapAction int

const (
	actionUseExisting bootstrapAction = iota
	actionProvision
	actionUnavailable
)

// minWingetVersion is the oldest winget release considered fully functional
// for our patching workflows.
const minWingetVersion = "1.6.0.0"

// bootstrapInputs captures the detection results decideBootstrap needs to
// pick an action: whether winget was located (and at what version), the
// minimum acceptable version, and whether the Appx provisioning stack
// (needed to install/repair the DesktopAppInstaller package) is available.
type bootstrapInputs struct {
	locatedVersion   string
	located          bool
	minVersion       string
	appxStackPresent bool
}

// decideBootstrap is pure decision logic over detection results: given what
// was found on disk plus whether the Appx stack can provision a fresh
// winget, decide whether to use the existing install, provision one, or
// report winget as unavailable.
func decideBootstrap(in bootstrapInputs) bootstrapAction {
	upToDate := in.located && compareVersions(in.locatedVersion, in.minVersion) >= 0
	if upToDate {
		return actionUseExisting
	}
	if in.appxStackPresent {
		return actionProvision
	}
	if in.located {
		return actionUseExisting // old winget beats nothing
	}
	return actionUnavailable
}

// artifactRef identifies a single pinned bootstrap artifact: its logical
// name (for error messages), the expected SHA-256 hex digest, and the path
// to GET it from relative to the Breeze API base URL.
type artifactRef struct {
	Name   string
	SHA256 string
	Path   string
}

// verifySHA256 checks data against the expected hex-encoded SHA-256 digest.
func verifySHA256(data []byte, wantHex string) error {
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(got, wantHex) {
		return fmt.Errorf("sha256 mismatch: got %s want %s", got, wantHex)
	}
	return nil
}

// fetchArtifact GETs baseURL+ref.Path and verifies the response body's
// SHA-256 against ref.SHA256 before returning it.
func fetchArtifact(client *http.Client, baseURL string, ref artifactRef) ([]byte, error) {
	resp, err := client.Get(strings.TrimRight(baseURL, "/") + ref.Path)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", ref.Name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch %s: status %d", ref.Name, resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", ref.Name, err)
	}
	if err := verifySHA256(data, ref.SHA256); err != nil {
		return nil, fmt.Errorf("verify %s: %w", ref.Name, err)
	}
	return data, nil
}

// cmdRunner abstracts external process execution so PowerShell-driving code
// (provisioning, Appx-stack probing, and later the winget provider /
// orchestrator) can be exercised in unit tests without spawning a real
// process. name/args mirror exec.Command; timeout bounds how long the caller
// waits before treating the command as hung.
type cmdRunner func(name string, args []string, timeout time.Duration) (string, string, int, error)

// buildProvisionArgs assembles the PowerShell argument list for
// Add-AppxProvisionedPackage -Online, installing bundlePath with its
// license and any dependency packages (e.g. VCLibs, UI.Xaml) required by
// the DesktopAppInstaller (winget) package.
func buildProvisionArgs(bundlePath, licensePath string, depPaths []string) []string {
	ps := "Add-AppxProvisionedPackage -Online -PackagePath '" + bundlePath +
		"' -LicensePath '" + licensePath + "' -DependencyPackagePath "
	quoted := make([]string, 0, len(depPaths))
	for _, d := range depPaths {
		quoted = append(quoted, "'"+d+"'")
	}
	ps += strings.Join(quoted, ",")
	return []string{"-NoProfile", "-NonInteractive", "-Command", ps}
}

// appxStackAvailable probes, via the injected runner, whether the
// Add-AppxProvisionedPackage cmdlet exists on this host (it ships with the
// Deployment Image Servicing and Management module and can be absent on
// stripped-down Windows images).
func appxStackAvailable(run cmdRunner) bool {
	_, _, code, err := run("powershell.exe",
		[]string{"-NoProfile", "-NonInteractive", "-Command", "Get-Command Add-AppxProvisionedPackage -ErrorAction Stop"},
		30*time.Second)
	return err == nil && code == 0
}

// EnsureResult reports the outcome of EnsureWinget: either a usable winget
// binary (Available with WingetPath/Version populated) or an unavailability
// Reason suitable for surfacing to the patching job / UI. Reason may also be
// set on a degraded-but-available result (Available true) when provisioning a
// newer winget failed and an older install is being used as a fallback — the
// caller should log that at Warn so a fleet stuck on stale winget stays
// visible.
type EnsureResult struct {
	WingetPath string
	Version    string
	Available  bool
	Reason     string
}

// EnsureDeps are the injected side effects EnsureWinget orchestrates: Locate
// probes for an existing winget install, AppxAvailable reports whether the
// Appx provisioning stack can install one, and Provision attempts to install
// winget via that stack. Keeping these as plain funcs makes EnsureWinget
// pure and testable without spawning real processes.
type EnsureDeps struct {
	Locate        func() (string, string, error)
	AppxAvailable func() bool
	Provision     func() error
}

// EnsureWinget ties detection, decision, provisioning, and re-detection into
// a single entry point: locate winget, decide whether the existing install
// (if any) is usable, provision a fresh one via the Appx stack when needed,
// and re-locate afterward to confirm success.
func EnsureWinget(deps EnsureDeps) EnsureResult {
	path, ver, err := deps.Locate()
	action := decideBootstrap(bootstrapInputs{
		locatedVersion:   ver,
		located:          err == nil,
		minVersion:       minWingetVersion,
		appxStackPresent: deps.AppxAvailable(),
	})
	switch action {
	case actionUseExisting:
		return EnsureResult{WingetPath: path, Version: ver, Available: true}
	case actionUnavailable:
		return EnsureResult{Available: false, Reason: "winget absent and Appx provisioning unavailable"}
	case actionProvision:
		if perr := deps.Provision(); perr != nil {
			if err == nil && path != "" {
				// Provisioning a newer winget failed, but an older install was
				// located — old winget beats nothing, mirroring decideBootstrap's
				// no-Appx-stack fallback. Record the provisioning failure on
				// Reason (even though Available stays true) so the caller can
				// surface a fleet silently stuck on stale winget instead of
				// logging "provider registered" as if all is well.
				return EnsureResult{
					WingetPath: path,
					Version:    ver,
					Available:  true,
					Reason:     "using existing winget " + ver + " after provisioning failed: " + perr.Error(),
				}
			}
			return EnsureResult{Available: false, Reason: "winget provisioning failed: " + perr.Error()}
		}
		path, ver, err = deps.Locate()
		if err != nil {
			return EnsureResult{Available: false, Reason: "winget still absent after provisioning"}
		}
		return EnsureResult{WingetPath: path, Version: ver, Available: true}
	}
	return EnsureResult{Available: false, Reason: "unknown bootstrap action"}
}
