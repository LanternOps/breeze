package patching

import (
	"fmt"
	"regexp"
	"strings"
)

// FeatureUpdateMode is what an update ring decided about Windows feature
// releases (the "Windows 11, version 25H2" upgrades). The server resolves a
// device's ring and pushes the decision in the heartbeat's
// feature_update_settings block; see FeatureUpdatePolicy.
type FeatureUpdateMode string

const (
	// FeatureUpdateBlock never reports a feature release. The default, and
	// what the agent assumes until the server has said otherwise.
	FeatureUpdateBlock FeatureUpdateMode = "block"
	// FeatureUpdateAllow reports every feature release Windows Update offers.
	FeatureUpdateAllow FeatureUpdateMode = "allow"
	// FeatureUpdatePin reports only the release named by Product +
	// TargetVersion. The heartbeat also writes the matching Windows Update for
	// Business TargetReleaseVersion policy (winupdate.ApplyTargetRelease) so
	// Windows itself offers and holds at that release.
	FeatureUpdatePin FeatureUpdateMode = "pin"
)

// Products a pin can name. Values match the API's ringFeatureUpdatesSchema.
const (
	FeatureUpdateProductWindows11 = "windows-11"
	FeatureUpdateProductWindows10 = "windows-10"
)

// FeatureUpdatePolicy is the ring's feature-release decision as the agent
// applies it. The zero value has an empty Mode and fails closed in Allows.
type FeatureUpdatePolicy struct {
	Mode FeatureUpdateMode
	// Product and TargetVersion are set only for FeatureUpdatePin, e.g.
	// "windows-11" and "25H2" (upper-cased).
	Product       string
	TargetVersion string
}

// DefaultFeatureUpdatePolicy blocks feature releases: identical to the agent's
// behaviour before the ring control existed, so a scan that runs before the
// first heartbeat config arrives changes nothing.
func DefaultFeatureUpdatePolicy() FeatureUpdatePolicy {
	return FeatureUpdatePolicy{Mode: FeatureUpdateBlock}
}

// Allows reports whether the policy lets this patch through the scan filter.
// Only patches typed "feature" (WUA BrowseOnly or the Upgrades classification)
// are subject to it; everything else always passes.
func (p FeatureUpdatePolicy) Allows(patch AvailablePatch) bool {
	if patch.UpdateType != "feature" {
		return true
	}
	switch p.Mode {
	case FeatureUpdateAllow:
		return true
	case FeatureUpdatePin:
		product, version, ok := ParseWindowsFeatureUpdateTitle(patch.Title)
		return ok && product == p.Product && version == strings.ToUpper(p.TargetVersion)
	default:
		// block, or an unknown/empty mode: fail closed.
		return false
	}
}

// featureUpdateVersionPattern is a Windows release token: two digits, H, 1 or 2.
var featureUpdateVersionPattern = regexp.MustCompile(`^\d{2}H[12]$`)

// ParseFeatureUpdatePolicy reads the heartbeat's feature_update_settings block.
// Keys are accepted in camelCase and snake_case like every other config block.
// A pin needs a known product and a well-formed release; the release is
// returned upper-cased so comparisons never depend on the server's casing.
func ParseFeatureUpdatePolicy(raw any) (FeatureUpdatePolicy, error) {
	m, ok := raw.(map[string]any)
	if !ok {
		return FeatureUpdatePolicy{}, fmt.Errorf("feature_update_settings is not an object")
	}
	str := func(keys ...string) (string, bool) {
		for _, k := range keys {
			if v, present := m[k]; present {
				s, isStr := v.(string)
				return strings.TrimSpace(s), isStr
			}
		}
		return "", false
	}

	modeStr, isStr := str("mode")
	if !isStr || modeStr == "" {
		return FeatureUpdatePolicy{}, fmt.Errorf("feature_update_settings.mode is missing")
	}
	switch FeatureUpdateMode(modeStr) {
	case FeatureUpdateBlock, FeatureUpdateAllow:
		return FeatureUpdatePolicy{Mode: FeatureUpdateMode(modeStr)}, nil
	case FeatureUpdatePin:
		product, _ := str("product")
		if product != FeatureUpdateProductWindows11 && product != FeatureUpdateProductWindows10 {
			return FeatureUpdatePolicy{}, fmt.Errorf("feature_update_settings.product %q is not a known Windows product", product)
		}
		version, _ := str("targetVersion", "target_version")
		version = strings.ToUpper(version)
		if !featureUpdateVersionPattern.MatchString(version) {
			return FeatureUpdatePolicy{}, fmt.Errorf("feature_update_settings.targetVersion %q is not a release like 25H2", version)
		}
		return FeatureUpdatePolicy{Mode: FeatureUpdatePin, Product: product, TargetVersion: version}, nil
	default:
		return FeatureUpdatePolicy{}, fmt.Errorf("feature_update_settings.mode %q is unknown", modeStr)
	}
}

// windowsFeatureUpdateTitlePattern matches how Windows Update titles a feature
// release: the title STARTS with the product (optionally after "Feature update
// to" / "Upgrade to"), then "version <release>" — "Windows 11, version 24H2",
// "Feature update to Windows 10, version 22H2 via Enablement Package
// (KB5015684)". Anchoring at the start is what keeps everything that merely
// names a release out: "2026-10 Cumulative Update for Windows 11 Version 24H2
// …", ".NET Framework 4.8.1 for Windows 11, version 24H2 …". The server-side
// parser (@breeze/shared parseWindowsFeatureUpdateTitle) uses the same
// expression; keep them identical.
var windowsFeatureUpdateTitlePattern = regexp.MustCompile(`(?i)^\s*(?:feature update to |upgrade to )?windows (10|11)\b[^\d]*?\bversion (\d{2}H[12])\b`)

// ParseWindowsFeatureUpdateTitle extracts the product ("windows-11" /
// "windows-10") and the upper-cased release ("24H2") from a feature-update
// title. ok is false for any title that is not a Windows feature release.
func ParseWindowsFeatureUpdateTitle(title string) (product, version string, ok bool) {
	m := windowsFeatureUpdateTitlePattern.FindStringSubmatch(title)
	if m == nil {
		return "", "", false
	}
	return "windows-" + m[1], strings.ToUpper(m[2]), true
}

// isWindowsUpgradeClassification reports whether any WUA category name is the
// Upgrades classification, which is where Windows Update files feature
// releases (BrowseOnly is not reliable once the release is being pushed). An
// exact match: product categories such as "Windows 10 and later upgrade &
// servicing drivers" contain the word and are drivers, not upgrades.
func isWindowsUpgradeClassification(names []string) bool {
	for _, n := range names {
		if strings.EqualFold(strings.TrimSpace(n), "upgrades") {
			return true
		}
	}
	return false
}

// Update types reported in AvailablePatch.UpdateType.
const (
	UpdateTypeSoftware = "software"
	UpdateTypeDriver   = "driver"
	// UpdateTypeFeature is a Windows feature release, governed by the ring's
	// FeatureUpdatePolicy.
	UpdateTypeFeature = "feature"
	// UpdateTypeOptional is any other BrowseOnly ("optional") update — optional
	// drivers, cumulative-update previews, .NET previews. Never reported, as
	// before this typing existed (they used to be typed "feature" and excluded
	// by the then-default patch_exclude_feature_updates).
	UpdateTypeOptional = "optional"
)

// windowsUpdateType classifies one WUA update. wuaType is IUpdate.Type (2 =
// driver), browseOnly is IUpdate.BrowseOnly, names are the category names.
func windowsUpdateType(wuaType int, browseOnly bool, names []string, title string) string {
	if isWindowsUpgradeClassification(names) {
		return UpdateTypeFeature
	}
	if browseOnly {
		if _, _, ok := ParseWindowsFeatureUpdateTitle(title); ok {
			return UpdateTypeFeature
		}
		return UpdateTypeOptional
	}
	if wuaType == 2 {
		return UpdateTypeDriver
	}
	return UpdateTypeSoftware
}
