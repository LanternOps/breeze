//go:build !windows && !darwin

package mgmtdetect

func collectIdentityStatus() IdentityStatus {
	return IdentityStatus{JoinType: JoinTypeNone, Source: "unsupported"}
}
