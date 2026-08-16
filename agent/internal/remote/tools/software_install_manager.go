package tools

import (
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/patching"
)

// managerDeps bundles the OS-facing dependencies installViaManager needs, so
// tests can inject a fake process runner, a fake winget locator, and a fake
// brew-ensure function without spawning anything real.
type managerDeps struct {
	goos         string
	locateWinget func() (string, string, error)
	run          patching.CmdRunner
	brewEnsure   func(kind, name, softwareName string) (string, bool, error)
}

// defaultManagerDeps builds the production managerDeps for a live agent
// process.
func defaultManagerDeps() managerDeps {
	return managerDeps{
		goos:         runtime.GOOS,
		locateWinget: patching.LocateSystemWinget,
		run:          patching.DefaultRunner,
		brewEnsure:   liveBrewEnsure,
	}
}

// liveBrewEnsure adapts patching.EnsureBrewInstalled to the brewEnsure seam.
// softwareName carries no meaning for brew (Homebrew addresses packages by
// formula/cask name only) so it is intentionally unused here.
func liveBrewEnsure(kind, name, softwareName string) (string, bool, error) {
	return patching.EnsureBrewInstalled(kind, name)
}

// installViaManager handles a software_install command whose payload carries
// an `installMethod` (winget / homebrew_cask / homebrew_formula) instead of a
// downloadUrl — the package-manager deploy path introduced by Task 4.
//
// It is install-only: an already-present package is reported as such and
// left alone (never upgraded), and the underlying package manager is invoked
// with an install verb, never its upgrade verb. An exact-version miss is
// always a failure, never a silent fallback to latest.
func installViaManager(payload map[string]any, deps managerDeps) (result CommandResult) {
	startTime := time.Now()
	defer func() {
		result.StartedAt = startTime.UTC().Format(time.RFC3339Nano)
	}()

	installMethod, _ := payload["installMethod"].(map[string]any)
	kind := strings.TrimSpace(GetPayloadString(installMethod, "kind", ""))
	packageID := strings.TrimSpace(GetPayloadString(installMethod, "packageId", ""))
	versionMode := GetPayloadString(payload, "versionMode", "latest")
	requestedVersion := strings.TrimSpace(GetPayloadString(payload, "requestedVersion", ""))
	softwareName := GetPayloadString(payload, "softwareName", "")
	forceReinstall := GetPayloadBool(payload, "forceReinstall", false)

	if packageID == "" {
		return NewErrorResult(fmt.Errorf("installMethod.packageId is required"), time.Since(startTime).Milliseconds())
	}

	switch kind {
	case "winget":
		if err := validateSoftwarePackageID(packageID); err != nil {
			return NewErrorResult(err, time.Since(startTime).Milliseconds())
		}
		return installWingetManaged(packageID, versionMode, requestedVersion, forceReinstall, deps, startTime)
	case "homebrew_cask", "homebrew_formula":
		if err := patching.ValidateBrewPackageName(packageID); err != nil {
			return NewErrorResult(err, time.Since(startTime).Milliseconds())
		}
		output, alreadyInstalled, err := deps.brewEnsure(kind, packageID, softwareName)
		if err != nil {
			// errors.Is, not a string prefix check: patching.EnsureBrewInstalled
			// wraps ErrBrewUnavailable with fmt.Errorf's %w, so this must survive
			// however deep the wrapping goes. Every other brewEnsure failure
			// (including "cannot execute brew as root: no active non-root
			// console user") is a real, actionable error and surfaces verbatim —
			// the manager_unavailable: prefix is reserved for "brew genuinely
			// isn't installed / reachable on this platform" (Task 7 contract).
			if errors.Is(err, patching.ErrBrewUnavailable) {
				return NewErrorResult(fmt.Errorf("manager_unavailable: %s", err.Error()), time.Since(startTime).Milliseconds())
			}
			return NewErrorResult(err, time.Since(startTime).Milliseconds())
		}
		return NewSuccessResult(map[string]any{
			"action":           "install",
			"success":          true,
			"alreadyInstalled": alreadyInstalled,
			"packageId":        packageID,
			"output":           output,
		}, time.Since(startTime).Milliseconds())
	default:
		return NewErrorResult(fmt.Errorf("unsupported installMethod.kind %q", kind), time.Since(startTime).Milliseconds())
	}
}

// installWingetManaged runs the winget ensure-present path: resolve winget,
// short-circuit on an already-installed package (unless forceReinstall),
// otherwise install (never upgrade) at MACHINE scope.
func installWingetManaged(packageID, versionMode, requestedVersion string, forceReinstall bool, deps managerDeps, startTime time.Time) CommandResult {
	if deps.goos != "windows" {
		return NewErrorResult(fmt.Errorf("manager_unavailable: winget is Windows-only"), time.Since(startTime).Milliseconds())
	}

	wingetPath, err := resolveManagerWingetCommand(deps)
	if err != nil {
		return NewErrorResult(fmt.Errorf("manager_unavailable: %s", err.Error()), time.Since(startTime).Milliseconds())
	}

	provider := patching.NewSystemWingetProvider(wingetPath, deps.run)

	if !forceReinstall {
		installed, err := provider.IsInstalled(packageID)
		if err != nil {
			return NewErrorResult(err, time.Since(startTime).Milliseconds())
		}
		if installed {
			return NewSuccessResult(map[string]any{
				"action":           "install",
				"success":          true,
				"alreadyInstalled": true,
				"packageId":        packageID,
			}, time.Since(startTime).Milliseconds())
		}
	}

	version := ""
	if versionMode == "exact" {
		version = requestedVersion
	}

	installResult, err := provider.InstallExact(packageID, version)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	output, outputTruncated := sanitizeInstallerOutput(installResult.Message)
	successPayload := map[string]any{
		"action":    "install",
		"success":   true,
		"packageId": packageID,
		"output":    output,
	}
	if outputTruncated {
		successPayload["outputTruncated"] = true
	}
	if installResult.RebootRequired {
		successPayload["rebootRequired"] = true
	}
	return NewSuccessResult(successPayload, time.Since(startTime).Milliseconds())
}

// resolveManagerWingetCommand mirrors resolveWingetCommand's PATH-then-locate
// resolution (software_update.go), but — unlike that helper, which silently
// falls back to the bare "winget" string so the downstream attempt runner can
// report its own "no supported update command" error — this returns an error
// when neither source resolves. A software_install manager deploy has no
// fallback attempt runner to report a nicer error, so an unresolved winget
// must surface as manager_unavailable here.
func resolveManagerWingetCommand(deps managerDeps) (string, error) {
	if _, err := exec.LookPath("winget"); err == nil {
		return "winget", nil
	}
	path, _, err := deps.locateWinget()
	if err != nil {
		return "", fmt.Errorf("winget not found: %w", err)
	}
	return path, nil
}
