//go:build !darwin

package security

func hostMacOSMajorVersion() (int, bool) { return 0, false }
