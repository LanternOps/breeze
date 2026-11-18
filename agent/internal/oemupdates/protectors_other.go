//go:build !windows

package oemupdates

import "errors"

type systemProtectors struct{}

// Live has no reading off Windows, so every firmware gate refuses.
func (systemProtectors) Live() (LiveProtectors, error) {
	return LiveProtectors{}, errors.New("bitlocker is only read on windows")
}

func (systemProtectors) State() string { return BitLockerUnknown }
