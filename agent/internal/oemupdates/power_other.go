//go:build !windows

package oemupdates

import "errors"

type systemPower struct{}

// Status has no reading off Windows, so every firmware gate refuses.
func (systemPower) Status() (PowerStatus, error) {
	return PowerStatus{}, errors.New("power status is only read on windows")
}
