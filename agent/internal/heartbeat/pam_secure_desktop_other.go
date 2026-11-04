//go:build !windows

package heartbeat

// readPromptOnSecureDesktop: UAC exists only on Windows. Elsewhere the
// answer is the conservative "secure desktop" (elevation prompts never run
// off Windows anyway).
func readPromptOnSecureDesktop() (bool, error) {
	return secureDesktopFromValue(0, errSecureDesktopValueMissing)
}
