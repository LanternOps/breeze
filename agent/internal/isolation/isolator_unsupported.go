//go:build !windows && !linux && !darwin

package isolation

// NewPlatformIsolator returns this platform's isolator. No isolator exists
// for this OS: capability 0, forever.
func NewPlatformIsolator() Isolator { return unsupportedIsolator{} }

// NewPlatformScheduler returns this platform's recovery scheduler.
func NewPlatformScheduler(dataDir string) RecoveryScheduler {
	_ = dataDir
	return unsupportedScheduler{}
}
