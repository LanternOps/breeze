//go:build windows

package security

import "syscall"

// perFileBlockedErrno is ERROR_VIRUS_INFECTED: the open an antivirus product
// blocks.
var perFileBlockedErrno error = syscall.Errno(225)
