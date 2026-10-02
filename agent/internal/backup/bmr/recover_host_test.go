package bmr

// Every test in this package runs RunRecoveryContext as a non-Windows host
// unless it says otherwise: the live system-state apply those tests exercise
// is not reachable from a Windows bmr_recover, and the package's tests also
// run on the Windows CI job. Tests of the Windows files-only path set
// recoverHostGOOS to "windows" themselves (withRecoverHost).
func init() { recoverHostGOOS = "linux" }
