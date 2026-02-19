//go:build !windows

package desktop

import "errors"

var errNotSupportedOnPlatform = errors.New("not supported on this platform")

// InvokeSAS is a no-op on non-Windows platforms.
func InvokeSAS() error {
	return errNotSupportedOnPlatform
}

// SASPolicyStatus represents the SoftwareSASGeneration registry value.
type SASPolicyStatus int

const (
	SASPolicyDisabled     SASPolicyStatus = 0 // SAS generation disabled (default)
	SASPolicyServices     SASPolicyStatus = 1 // Only services can generate SAS
	SASPolicyApps         SASPolicyStatus = 2 // Only applications with SeTcbPrivilege can generate SAS
	SASPolicyServicesApps SASPolicyStatus = 3 // Both services and applications can generate SAS
)

// AllowsServices reports whether the policy permits service-mode SAS (SendSAS(FALSE)).
func (p SASPolicyStatus) AllowsServices() bool {
	return p == SASPolicyServices || p == SASPolicyServicesApps
}

// AllowsApps reports whether the policy permits application-mode SAS (SendSAS(TRUE)).
func (p SASPolicyStatus) AllowsApps() bool {
	return p == SASPolicyApps || p == SASPolicyServicesApps
}

// CheckSASPolicy always returns disabled on non-Windows platforms.
func CheckSASPolicy() SASPolicyStatus {
	return SASPolicyDisabled
}

// LockWorkstation is a no-op on non-Windows platforms.
func LockWorkstation() error {
	return errNotSupportedOnPlatform
}

// SetSASPolicy is a no-op on non-Windows platforms.
func SetSASPolicy(value uint32) error {
	return errNotSupportedOnPlatform
}
