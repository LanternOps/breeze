//go:build !darwin && !linux

package securefs

// VerifyTrustedExecutableOwner is a no-op on platforms other than macOS and
// Linux. Windows binary/directory trust is enforced separately by the
// explicit DACLs applied at install and startup (see internal/config's
// Windows permission helpers) rather than by a uid/mode check, which has no
// equivalent on this platform.
func VerifyTrustedExecutableOwner(string) error { return nil }
