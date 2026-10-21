package security

import (
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// CylancePROTECT / Aurora Endpoint Defense detection on macOS (#9390).
//
// macOS has no Security Center registry, so providerFromName (which maps the
// Windows Security Center name "CylancePROTECT" to "cylance", #9389) never
// runs there; third-party AV must be probed directly, as Elastic Defend is on
// Linux (status_elastic.go, #2018).
//
// Install layout keyed on, from the vendor's macOS install/uninstall guidance
// (detection requires the bundle or the daemon plist; the service only
// decides real-time protection):
//   - /Applications/Cylance/CylanceUI.app — the agent UI bundle. Arctic Wolf's
//     Aurora-branded macOS agent (Aurora Protect Desktop) still ships CylanceUI.
//   - /Library/LaunchDaemons/com.cylance.agent_service.plist — the protection
//     service's launch daemon; its job label is com.cylance.agent_service.
//   - CylanceSvc — the protection service process (root-owned).
//
// Branding is read from the bundle's own Info.plist rather than guessed from a
// path: the #9178 reporter's Macs still say CylancePROTECT after the Windows
// rebrand, and no Aurora-specific macOS bundle path is documented. A bundle
// that names itself "Aurora …" is reported as Aurora Endpoint Defense.
const (
	macCylanceAppPath        = "/Applications/Cylance/CylanceUI.app"
	macCylanceDaemonPlist    = "/Library/LaunchDaemons/com.cylance.agent_service.plist"
	macCylanceDaemonLabel    = "com.cylance.agent_service"
	macCylanceServiceProcess = "CylanceSvc"

	macCylanceDisplayName = "CylancePROTECT"
	macAuroraDisplayName  = "Aurora Endpoint Defense"
)

// macCylanceProbes injects the host probes so detection is unit-testable on
// any OS.
type macCylanceProbes struct {
	fileExists func(path string) bool
	// bundleString reads one key from <appPath>/Contents/Info.plist.
	bundleString  func(appPath, key string) (string, error)
	daemonRunning func(label string) bool
	// processRunning must only match root-owned processes.
	processRunning func(name string) bool
}

func defaultMacCylanceProbes() macCylanceProbes {
	return macCylanceProbes{
		fileExists:     fileExists,
		bundleString:   macBundleInfoString,
		daemonRunning:  macLaunchDaemonRunning,
		processRunning: macRootProcessRunning,
	}
}

// getMacCylanceProduct reports CylancePROTECT / Aurora Endpoint Defense as an
// AV product on macOS. Returns ErrNotSupported when it is absent (or off
// macOS), mirroring getLinuxElasticDefendProduct.
func getMacCylanceProduct() (*AVProduct, string, error) {
	if runtime.GOOS != "darwin" {
		return nil, "", ErrNotSupported
	}
	return detectMacCylance(defaultMacCylanceProbes())
}

// detectMacCylance holds the platform-independent detection logic. The
// returned string is the agent version ("" when unavailable).
func detectMacCylance(probes macCylanceProbes) (*AVProduct, string, error) {
	appInstalled := probes.fileExists(macCylanceAppPath)
	daemonInstalled := probes.fileExists(macCylanceDaemonPlist)

	// An install artifact is required. A running process or job alone is not
	// evidence: any local user can start a binary named CylanceSvc, and
	// attributing on that would let them spoof the device's AV posture.
	// /Library/LaunchDaemons is root-writable only; /Applications needs admin.
	if !appInstalled && !daemonInstalled {
		return nil, "", ErrNotSupported
	}

	// Real-time protection: the launchd job is running, or a root-owned
	// CylanceSvc process is (covers a relabelled job). A probe failure
	// (launchctl/pgrep timeout) is indistinguishable from "not running" here
	// and reads as off for that cycle, as in linuxUnitStateRunning; before
	// #9390 a Cylance-only Mac always reported false, so this is no regression.
	running := probes.daemonRunning(macCylanceDaemonLabel) || probes.processRunning(macCylanceServiceProcess)

	displayName := macCylanceDisplayName
	version := ""
	if appInstalled {
		// Version and branding are cosmetic: a failed Info.plist read leaves
		// them at their defaults and never blocks attribution.
		version = macBundleKey(probes, "CFBundleShortVersionString")
		if isAuroraBranded(macBundleKey(probes, "CFBundleDisplayName"), macBundleKey(probes, "CFBundleName")) {
			displayName = macAuroraDisplayName
		}
	}

	product := &AVProduct{
		DisplayName:        displayName,
		Provider:           "cylance",
		Registered:         true,
		RealTimeProtection: running,
		// Cylance's model-based engine has no signature definitions whose
		// freshness is locally observable (same stance as Elastic Defend).
		DefinitionsUpToDate: false,
	}
	if appInstalled {
		product.PathToSignedProduct = macCylanceAppPath
	}
	return product, version, nil
}

func macBundleKey(probes macCylanceProbes, key string) string {
	value, err := probes.bundleString(macCylanceAppPath, key)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

func isAuroraBranded(names ...string) bool {
	for _, name := range names {
		if strings.Contains(strings.ToLower(name), "aurora") {
			return true
		}
	}
	return false
}

// macDefenderClaimsProvider decides whether Microsoft Defender for Endpoint on
// macOS takes the provider label. Cylance is probed first; Defender then
// follows the Windows fallback rule (defenderOwnsProvider, #3593): it claims
// the label when nothing else was identified, or when it is the only source
// with active real-time protection.
func macDefenderClaimsProvider(providerIdentified, currentRealTime bool, defender DefenderStatus) bool {
	return defender.Enabled && defenderOwnsProvider(providerIdentified, currentRealTime, defender.RealTimeProtection)
}

// macAVSources holds the raw results of the macOS AV probes, so the merge in
// applyMacAVSources is testable without a Mac.
type macAVSources struct {
	cylance         *AVProduct
	cylanceVersion  string
	cylanceErr      error
	defender        DefenderStatus
	defenderProduct *AVProduct
	defenderErr     error
}

func collectMacAVSources() macAVSources {
	var src macAVSources
	src.cylance, src.cylanceVersion, src.cylanceErr = getMacCylanceProduct()
	src.defender, src.defenderProduct, src.defenderErr = getMacDefenderStatus()
	return src
}

// avTally carries CollectStatus's cross-source AV accumulators.
type avTally struct {
	providerIdentified bool
	realTime           bool
	collected          bool
	failed             bool
	errs               []error
}

// applyMacAVSources merges the macOS AV probes into status, in attribution
// order: Cylance first, then Microsoft Defender for Endpoint, which takes the
// label only per macDefenderClaimsProvider. Both products are always listed
// in AVProducts.
func applyMacAVSources(status *SecurityStatus, tally *avTally, src macAVSources) {
	if src.cylanceErr != nil {
		if !errors.Is(src.cylanceErr, ErrNotSupported) {
			tally.errs = append(tally.errs, src.cylanceErr)
			tally.failed = true
		}
	} else if src.cylance != nil {
		tally.collected = true
		status.AVProducts = append(status.AVProducts, *src.cylance)
		if !tally.providerIdentified {
			status.Provider = src.cylance.Provider
			status.ProviderVersion = src.cylanceVersion
			tally.providerIdentified = true
		}
		if src.cylance.RealTimeProtection {
			tally.realTime = true
		}
	}

	if src.defenderErr != nil {
		if !errors.Is(src.defenderErr, ErrNotSupported) {
			tally.errs = append(tally.errs, src.defenderErr)
			tally.failed = true
		}
		return
	}
	defender := src.defender
	tally.collected = true
	if macDefenderClaimsProvider(tally.providerIdentified, tally.realTime, defender) {
		status.Provider = "windows_defender"
		// The version must describe the product that owns the label,
		// not a Cylance version recorded above.
		status.ProviderVersion = defender.ProviderVersion
		tally.providerIdentified = true
	}
	if src.defenderProduct != nil {
		status.AVProducts = append(status.AVProducts, *src.defenderProduct)
	}
	// No product owns the label (Defender present but not enabled): keep the
	// pre-#9390 behaviour of reporting Defender's version. Never fill the gap
	// under another product's label — a Cylance with no readable version must
	// not show Defender's.
	if !tally.providerIdentified && status.ProviderVersion == "" {
		status.ProviderVersion = defender.ProviderVersion
	}
	if defender.RealTimeProtection {
		tally.realTime = true
	}
	if status.DefinitionsVersion == "" {
		status.DefinitionsVersion = defender.DefinitionsVersion
	}
	if status.DefinitionsUpdatedAt == "" {
		status.DefinitionsUpdatedAt = defender.DefinitionsUpdatedAt
	}
	status.LastScanAt = latestScanTime(defender)
	if defender.LastFullScan != "" {
		status.LastScanType = "full"
	} else if defender.LastQuickScan != "" {
		status.LastScanType = "quick"
	}
}

// macBundleInfoString reads one Info.plist key from an app bundle.
func macBundleInfoString(appPath, key string) (string, error) {
	infoPath := filepath.Join(appPath, "Contents", "Info")
	return runCommand(4*time.Second, "defaults", "read", infoPath, key)
}

// macLaunchDaemonRunning reports whether a system launchd job is running.
// `launchctl print` exits non-zero for an unloaded job, which reads as false.
func macLaunchDaemonRunning(label string) bool {
	output, err := runCommand(5*time.Second, "launchctl", "print", "system/"+label)
	if err != nil {
		return false
	}
	return launchctlPrintRunning(output)
}

// launchctlPrintRunning parses `launchctl print system/<label>` output. Only
// the job's own top-level "state = running" counts; nested blocks (endpoints,
// event triggers) carry state lines of their own that must not be read as the
// job's.
func launchctlPrintRunning(output string) bool {
	depth := 0
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if depth == 1 && trimmed == "state = running" {
			return true
		}
		depth += strings.Count(trimmed, "{") - strings.Count(trimmed, "}")
	}
	return false
}

// macRootProcessRunning reports whether a root-owned process with exactly
// this name runs. Restricting to root keeps an unprivileged user's look-alike
// process from reading as the protection service. pgrep exits non-zero when
// nothing matches.
func macRootProcessRunning(name string) bool {
	_, err := runCommand(5*time.Second, "pgrep", "-x", "-u", "root", name)
	return err == nil
}
