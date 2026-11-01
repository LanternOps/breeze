//go:build windows || linux || darwin

package isolation

// NewPlatformIsolator returns this platform's isolator. The real ones land
// per OS (Windows WFP, then Linux nftables, then macOS pf); each wave narrows
// this file's build tag and adds isolator_<os>.go. Until then every OS
// reports capability 0 and nothing can be applied.
func NewPlatformIsolator() Isolator { return unsupportedIsolator{} }

// NewPlatformScheduler returns this platform's recovery scheduler; like the
// isolator it is a never-ready stub until the OS's scheduler_<os>.go lands.
func NewPlatformScheduler(dataDir string) RecoveryScheduler {
	_ = dataDir
	return unsupportedScheduler{}
}
