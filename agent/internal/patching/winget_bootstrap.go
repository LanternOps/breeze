package patching

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
