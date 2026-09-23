//go:build !windows

package helper

// listHelperInstances has no implementation outside Windows yet: macOS and
// Linux run one helper per user through the platform spawn paths, and the
// duplicate accumulation in #6251 is Windows-specific. Returning none turns
// the duplicate sweep and the session-wide stop into no-ops here.
func listHelperInstances(string) ([]helperInstance, error) {
	return nil, nil
}
