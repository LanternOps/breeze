package userhelper

import "fmt"

func systemSettingsURLForPermission(permission string) (string, error) {
	switch permission {
	case "Screen Recording":
		return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture", nil
	case "Accessibility":
		return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", nil
	case "Full Disk Access":
		return "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles", nil
	default:
		return "", fmt.Errorf("unknown permission %q", permission)
	}
}
