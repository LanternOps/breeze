//go:build !darwin

package sessionbroker

import "errors"

// errIPCGroupUnsupported is returned by the non-darwin EnsureIPCGroupMember
// stub. Linux establishes breeze-group membership in
// scripts/install/install-linux.sh instead.
var errIPCGroupUnsupported = errors.New("sessionbroker: breeze group membership management is not supported on this platform")

// EnsureIPCGroup is a no-op off macOS.
//
// Linux creates the breeze group in scripts/install/install-linux.sh
// (groupadd --system breeze) and the socket chown in setupSocket picks it up
// from there via os/user, which reads /etc/group correctly without cgo. Windows
// uses a named pipe with its own SDDL, not a filesystem group.
func EnsureIPCGroup() error { return nil }

// EnsureIPCGroupMember is unsupported off macOS.
//
// It returns errIPCGroupUnsupported rather than silently reporting success so a
// caller that reaches it on the wrong platform learns about it. The only caller
// is macOS-gated; Linux establishes membership in install-linux.sh, which adds
// every logged-in user to the breeze group.
func EnsureIPCGroupMember(username string) (bool, error) {
	return false, errIPCGroupUnsupported
}
