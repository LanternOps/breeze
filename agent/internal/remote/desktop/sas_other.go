//go:build !windows

package desktop

import "errors"

var errSASNotSupported = errors.New("SAS not supported on this platform")

// InvokeSAS is a no-op on non-Windows platforms.
func InvokeSAS() error {
	return errSASNotSupported
}

// SASPolicyStatus represents the SoftwareSASGeneration registry value.
type SASPolicyStatus int

const (
	SASPolicyDisabled     SASPolicyStatus = 0
	SASPolicyServices     SASPolicyStatus = 1
	SASPolicyApps         SASPolicyStatus = 2
	SASPolicyServicesApps SASPolicyStatus = 3
)

// CheckSASPolicy always returns disabled on non-Windows platforms.
func CheckSASPolicy() SASPolicyStatus {
	return SASPolicyDisabled
}

// SetSASPolicy is a no-op on non-Windows platforms.
func SetSASPolicy(value uint32) error {
	return errSASNotSupported
}
