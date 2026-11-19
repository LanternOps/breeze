package oemupdates

import (
	"errors"
	"fmt"
	"strings"

	"github.com/breeze-rmm/agent/internal/security"
)

var errBitLockerUnreadable = errors.New("bitlocker state cannot be read; firmware installs need it read")

// liveProtectors reads the OS volume's BitLocker state and its recovery-password
// protector ids, fresh. Any failure is an error, which the runner treats as "no
// current key": a firmware install never proceeds on an unknown.
//
// That includes security.ErrBitLockerUnavailable. A host without the BitLocker
// PowerShell module (Windows Home) can still be encrypted by device encryption,
// so a missing cmdlet is not proof the volume is unencrypted. Such hosts get no
// firmware categories until a reader that works there is confirmed in the lab.
func liveProtectors(readState func() (string, error), readKeys func() ([]security.RecoveryKey, error), drive string) (LiveProtectors, error) {
	state, err := readState()
	if err != nil {
		return LiveProtectors{}, fmt.Errorf("%w: %v", errBitLockerUnreadable, err)
	}
	switch state {
	case security.BitLockerStateOff:
		return LiveProtectors{BitLockerOn: false}, nil
	case security.BitLockerStateOn, security.BitLockerStateSuspended:
	default:
		return LiveProtectors{}, fmt.Errorf("%w: state %q", errBitLockerUnreadable, state)
	}
	keys, err := readKeys()
	if err != nil {
		return LiveProtectors{}, fmt.Errorf("read recovery-password protectors: %w", err)
	}
	drive = strings.ToUpper(strings.TrimSpace(drive))
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

// protectorState is the post-reboot reading; anything unreadable is "unknown".
func protectorState(readState func() (string, error)) string {
	state, err := readState()
	if err != nil {
		return BitLockerUnknown
	}
	switch state {
	case security.BitLockerStateOn, security.BitLockerStateSuspended, security.BitLockerStateOff:
		return state
	}
	return BitLockerUnknown
}
