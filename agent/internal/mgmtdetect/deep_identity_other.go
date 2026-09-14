//go:build !windows && !darwin

package mgmtdetect

// collectIdentityStatus is a stub on platforms with no directory/join
// detection implementation. It reports IdentitySourceUnsupported so consumers
// can distinguish "never checked" from a real "not joined" result (#5626).
func collectIdentityStatus() IdentityStatus {
	return IdentityStatus{JoinType: JoinTypeNone, Source: IdentitySourceUnsupported}
}
