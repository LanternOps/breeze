package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/winupdate"
)

// applyTargetRelease is the seam to the Windows-only registry policy, a
// package var so the dispatch + parse path is unit-tested on every platform
// (the same reason applyWinUpdate is one).
var applyTargetRelease = winupdate.ApplyTargetRelease

// productVersionFor maps the API's product id to the WUfB ProductVersion
// string. Empty for an unknown product (ParseFeatureUpdatePolicy already
// rejects those, so this is belt-and-braces).
func productVersionFor(product string) string {
	switch product {
	case patching.FeatureUpdateProductWindows11:
		return "Windows 11"
	case patching.FeatureUpdateProductWindows10:
		return "Windows 10"
	default:
		return ""
	}
}

// applyFeatureUpdateConfig handles the feature_update_settings block: the
// device's update ring decided whether Windows feature releases are blocked,
// allowed, or pinned to one release. Two effects:
//
//  1. the Windows Update provider filters its scans by the policy
//     (PatchManager.SetFeatureUpdatePolicy);
//  2. in pin mode the WUfB TargetReleaseVersion policy is written so Windows
//     Update offers and holds at that release; block/allow revert any pin
//     Breeze wrote earlier (an admin's own policy is left as-found).
//
// A malformed block applies nothing, so the last good policy stays in force
// (the default before any heartbeat is block).
func (h *Heartbeat) applyFeatureUpdateConfig(raw any) {
	policy, err := patching.ParseFeatureUpdatePolicy(raw)
	if err != nil {
		log.Warn("ignoring feature_update_settings", "error", err.Error())
		return
	}

	if h.patchMgr != nil {
		h.patchMgr.SetFeatureUpdatePolicy(policy)
	}

	var pin *winupdate.TargetRelease
	if policy.Mode == patching.FeatureUpdatePin {
		productVersion := productVersionFor(policy.Product)
		if productVersion == "" {
			log.Warn("feature_update_settings pin names an unknown product; not writing a target-release policy", "product", policy.Product)
			return
		}
		pin = &winupdate.TargetRelease{ProductVersion: productVersion, TargetVersion: policy.TargetVersion}
	}

	res, err := applyTargetRelease(pin)
	if err != nil {
		log.Error("failed to apply Windows Update target-release policy",
			"mode", string(policy.Mode), "error", err.Error())
		return
	}
	if !res.Supported {
		log.Debug("Windows Update target-release policy not supported on this platform", "mode", string(policy.Mode))
		return
	}
	log.Info("applied Windows feature-update policy",
		"mode", string(policy.Mode),
		"product", policy.Product,
		"targetVersion", policy.TargetVersion,
		"managed", res.Managed,
		"enforced", res.Enforced,
		"reverted", res.Reverted,
		"reason", res.Reason)
}
