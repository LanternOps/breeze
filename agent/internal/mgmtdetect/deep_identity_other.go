//go:build !windows && !darwin

package mgmtdetect

func collectIdentityStatus() IdentityStatus {
	return IdentityStatus{JoinType: "none", Source: "unsupported"}
}
