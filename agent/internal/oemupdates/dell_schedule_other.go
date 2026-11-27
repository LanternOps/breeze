//go:build !windows

package oemupdates

import "errors"

// readHKLMValue: the tool's schedule mode is read only on Windows. Elsewhere
// every read fails, so the lane refuses rather than passes.
func readHKLMValue(key, name string) (regRead, error) {
	return regRead{}, errors.New("the vendor tool's schedule mode is read only on windows")
}
