//go:build windows

package oemupdates

import (
	"errors"
	"os"
	"strings"

	"github.com/breeze-rmm/agent/internal/security"
)

type systemProtectors struct{}

// Live reads the OS volume's BitLocker state and its recovery-password
// protector ids, fresh. A failed read is an error, which the runner treats as
// "no current key": a firmware install never proceeds on an unknown.
func (systemProtectors) Live() (LiveProtectors, error) {
	state, err := security.SystemDriveBitLockerState()
	if errors.Is(err, security.ErrBitLockerUnavailable) {
		return LiveProtectors{BitLockerOn: false}, nil
	}
	if err != nil {
		return LiveProtectors{}, err
	}
	if state == security.BitLockerStateOff {
		return LiveProtectors{BitLockerOn: false}, nil
	}
	keys, err := security.CollectRecoveryKeys()
	if err != nil {
		return LiveProtectors{}, err
	}
	drive := strings.ToUpper(strings.TrimSpace(os.Getenv("SystemDrive")))
	if drive == "" {
		drive = "C:"
	}
	ids := make([]string, 0, len(keys))
	for _, k := range keys {
		if k.KeyType == security.KeyTypeBitLocker && strings.EqualFold(strings.TrimRight(k.Mount, `\`), drive) {
			ids = append(ids, k.ProtectorID)
		}
	}
	return LiveProtectors{BitLockerOn: true, RecoveryPasswordIDs: ids}, nil
}

// State is the post-reboot reading.
func (systemProtectors) State() string {
	state, err := security.SystemDriveBitLockerState()
	if err != nil && !errors.Is(err, security.ErrBitLockerUnavailable) {
		return BitLockerUnknown
	}
	return state
}
