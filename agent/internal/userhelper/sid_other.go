//go:build !windows

package userhelper

import "errors"

// lookupSIDWithRetry only exists on Windows. The non-Windows stub returns
// an explicit error so any accidental cross-platform call fails loudly
// rather than silently returning an empty SID. client.go gates the call
// behind runtime.GOOS == "windows".
func lookupSIDWithRetry() (string, error) {
	return "", errors.New("lookupSIDWithRetry: not supported on non-Windows")
}

// lookupUsernameDirect only exists on Windows. See lookupSIDWithRetry.
func lookupUsernameDirect() (string, error) {
	return "", errors.New("lookupUsernameDirect: not supported on non-Windows")
}
