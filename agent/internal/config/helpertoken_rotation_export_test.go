package config

// resetHelperTokenRotationStateForTest clears the process-wide rotation flags
// so one test's leftover state cannot leak into the next.
func resetHelperTokenRotationStateForTest() {
	helperTokenRotationOwedInProcess.Store(false)
	helperTokenRotationClearedInProcess.Store(false)
}
