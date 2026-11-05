package oemupdates

import (
	"errors"
	"testing"

	"github.com/breeze-rmm/agent/internal/security"
)

func keysOf(keys ...security.RecoveryKey) func() ([]security.RecoveryKey, error) {
	return func() ([]security.RecoveryKey, error) { return keys, nil }
}

func TestLiveProtectorsFiltersToTheOSVolume(t *testing.T) {
	read := keysOf(
		security.RecoveryKey{Mount: "C:", ProtectorID: "a", KeyType: security.KeyTypeBitLocker},
		security.RecoveryKey{Mount: "D:", ProtectorID: "b", KeyType: security.KeyTypeBitLocker},
		security.RecoveryKey{Mount: `C:\`, ProtectorID: "c", KeyType: security.KeyTypeBitLocker},
	)
	live, err := liveProtectors(func() (string, error) { return security.BitLockerStateOn, nil }, read, "c:")
	if err != nil || !live.BitLockerOn || len(live.RecoveryPasswordIDs) != 2 || live.RecoveryPasswordIDs[0] != "a" || live.RecoveryPasswordIDs[1] != "c" {
		t.Fatalf("live = %+v, %v", live, err)
	}
}

func TestLiveProtectorsSuspendedCountsAsOn(t *testing.T) {
	live, err := liveProtectors(func() (string, error) { return security.BitLockerStateSuspended, nil }, keysOf(), "C:")
	if err != nil || !live.BitLockerOn {
		t.Fatalf("live = %+v, %v", live, err)
	}
}

func TestLiveProtectorsOffReadsNoKeys(t *testing.T) {
	read := func() ([]security.RecoveryKey, error) {
		t.Fatal("read keys for an unencrypted volume")
		return nil, nil
	}
	live, err := liveProtectors(func() (string, error) { return security.BitLockerStateOff, nil }, read, "C:")
	if err != nil || live.BitLockerOn {
		t.Fatalf("live = %+v, %v", live, err)
	}
}

// A host without the BitLocker module can still be encrypted (Windows Home
// device encryption), so "unavailable" is not proof of "off" for a flash gate.
func TestLiveProtectorsFailClosedWhenBitLockerUnreadable(t *testing.T) {
	for name, readErr := range map[string]error{
		"module unavailable": security.ErrBitLockerUnavailable,
		"query failed":       errors.New("powershell timed out"),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := liveProtectors(func() (string, error) { return security.BitLockerStateOff, readErr }, keysOf(), "C:")
			if err == nil {
				t.Fatal("an unreadable BitLocker state let a firmware gate pass")
			}
		})
	}
	_, err := liveProtectors(func() (string, error) { return security.BitLockerStateOn, nil },
		func() ([]security.RecoveryKey, error) { return nil, errors.New("denied") }, "C:")
	if err == nil {
		t.Fatal("a failed key read let a firmware gate pass")
	}
}

func TestProtectorStateUnreadableIsUnknown(t *testing.T) {
	if got := protectorState(func() (string, error) { return security.BitLockerStateOff, security.ErrBitLockerUnavailable }); got != BitLockerUnknown {
		t.Fatalf("got %q", got)
	}
	if got := protectorState(func() (string, error) { return security.BitLockerStateSuspended, nil }); got != BitLockerSuspended {
		t.Fatalf("got %q", got)
	}
}
