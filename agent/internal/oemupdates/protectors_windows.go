//go:build windows

package oemupdates

import (
	"os"

	"github.com/breeze-rmm/agent/internal/security"
)

type systemProtectors struct{}

func (systemProtectors) Live() (LiveProtectors, error) {
	return liveProtectors(security.SystemDriveBitLockerState, security.CollectRecoveryKeys, os.Getenv("SystemDrive"))
}

func (systemProtectors) State() string {
	return protectorState(security.SystemDriveBitLockerState)
}
