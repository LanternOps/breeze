//go:build !windows

package tools

// evaluateRegistryRule is not supported on non-Windows platforms.
// Returns (false, false) to signal "unsupported" to EvaluateDetectionRules.
func evaluateRegistryRule(_ DetectionRule) (matched bool, supported bool) {
	return false, false
}

// evaluateMsiProductCodeRule is not supported on non-Windows platforms.
// Returns (false, false) to signal "unsupported" to EvaluateDetectionRules.
func evaluateMsiProductCodeRule(_ DetectionRule) (matched bool, supported bool) {
	return false, false
}
