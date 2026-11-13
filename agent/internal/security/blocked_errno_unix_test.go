//go:build !windows

package security

import "syscall"

// perFileBlockedErrno stands in for an open the system refuses for this file
// only (a busy or locked file).
var perFileBlockedErrno error = syscall.EBUSY
