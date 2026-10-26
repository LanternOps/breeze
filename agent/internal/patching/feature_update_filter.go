package patching

// FeatureUpdatePolicySetter is implemented by providers that filter Windows
// feature releases by the ring's policy (today: WindowsUpdateProvider). The
// heartbeat hands the server's decision to PatchManager.SetFeatureUpdatePolicy,
// which fans it out to every provider that implements this.
type FeatureUpdatePolicySetter interface {
	SetFeatureUpdatePolicy(policy FeatureUpdatePolicy)
}

// excludeFeatureUpdate is the scan-filter decision for one patch: true drops
// it. killSwitch is the operator's local patch_exclude_feature_updates config
// (default false): when set it always excludes feature releases regardless of
// what the ring says, so a self-hoster can keep a fleet off feature releases
// without touching every ring. Non-feature patches are never affected.
func excludeFeatureUpdate(killSwitch bool, policy FeatureUpdatePolicy, patch AvailablePatch) bool {
	if patch.UpdateType != "feature" {
		return false
	}
	if killSwitch {
		return true
	}
	return !policy.Allows(patch)
}
