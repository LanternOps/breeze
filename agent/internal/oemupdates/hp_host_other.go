//go:build !windows

package oemupdates

import "errors"

// hpSMBIOSIdentity off Windows answers nothing: the handler refuses before any lane
// runs, and this keeps a stray call failing closed.
func hpSMBIOSIdentity() (string, string, error) {
	return "", "", errors.New("the HP lane only runs on windows")
}
