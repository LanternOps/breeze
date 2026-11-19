package security

import (
	"errors"
	"testing"
	"time"
)

func TestParseSystemDriveBitLockerState(t *testing.T) {
	cases := map[string]string{
		"FullyEncrypted|On":         BitLockerStateOn,
		"FullyEncrypted|Off":        BitLockerStateSuspended,
		"EncryptionInProgress|Off":  BitLockerStateSuspended,
		"EncryptionInProgress|On":   BitLockerStateOn,
		"FullyDecrypted|Off":        BitLockerStateOff,
		"1|1":                       BitLockerStateOn,
		"1|0":                       BitLockerStateSuspended,
		"0|0":                       BitLockerStateOff,
		" FullyEncrypted | On \r\n": BitLockerStateOn,
	}
	for in, want := range cases {
		got, err := parseSystemDriveBitLockerState(in)
		if err != nil || got != want {
			t.Errorf("parse(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "garbage", "FullyEncrypted|Unknown", "FullyEncrypted", "Weird|On", "FullyDecrypted|On"} {
		if got, err := parseSystemDriveBitLockerState(bad); err == nil {
			t.Errorf("parse(%q) = %q, want an error", bad, got)
		}
	}
}

func TestSystemDriveBitLockerStateOffWhenNotInstalled(t *testing.T) {
	host := &fakeBitLockerHost{moduleInstalled: false, getCommandOut: "unavailable"}
	installFakeBitLockerHost(t, host)
	got, err := systemDriveBitLockerStateFor("windows")
	if !errors.Is(err, ErrBitLockerUnavailable) || got != BitLockerStateOff {
		t.Fatalf("got %q, %v", got, err)
	}
	for _, s := range host.spawns {
		if s == bitLockerSystemDriveStatePS {
			t.Fatal("the state query ran on a host without BitLocker")
		}
	}
}

func TestSystemDriveBitLockerStateOffWindows(t *testing.T) {
	got, err := systemDriveBitLockerStateFor("darwin")
	if err == nil || got != BitLockerStateUnknown {
		t.Fatalf("got %q, %v", got, err)
	}
}

var _ = time.Second
