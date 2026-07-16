//go:build !windows

package userhelper

// showBannerOS: no native persistent banner without cgo on macOS/Linux. The
// Assist (Tauri) helper provides the banner there; the native fallback covers
// the consent dialog and toasts only.
func showBannerOS(label string, _ int64) bool {
	log.Debug("session banner not supported on this platform", "label", label)
	return false
}

func hideBannerOS() {}
