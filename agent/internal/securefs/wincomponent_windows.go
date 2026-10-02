//go:build windows

package securefs

// checkPlatformComponents applies the Windows name rule to every component of
// a cleaned relative path (CleanRelative).
func checkPlatformComponents(clean string) error {
	return ValidateWindowsComponents(clean)
}
