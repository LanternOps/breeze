//go:build windows

package systemstate

import (
	"errors"
	"testing"
)

// Native checks of the RegFlushKey call (#7367). HKLM\SOFTWARE opens for any
// elevated or standard token, unlike SAM/SECURITY, which need LocalSystem.

func TestFlushHiveKey_FlushesALoadedHive(t *testing.T) {
	if err := flushHiveKey(hiveFlushTarget{Root: "HKLM", Path: "SOFTWARE", Required: true}); err != nil {
		t.Fatalf(`flushHiveKey(HKLM\SOFTWARE) = %v, want nil`, err)
	}
}

func TestFlushHiveKey_UnloadedHiveIsErrHiveNotLoaded(t *testing.T) {
	err := flushHiveKey(hiveFlushTarget{Root: "HKU", Path: "S-1-5-21-0-0-0-7367"})
	if !errors.Is(err, errHiveNotLoaded) {
		t.Fatalf("flushHiveKey(unloaded HKU hive) = %v, want errHiveNotLoaded", err)
	}
}

func TestLoadedUserHives_ListsDefault(t *testing.T) {
	names, err := loadedUserHives()
	if err != nil {
		t.Fatalf("loadedUserHives: %v", err)
	}
	for _, n := range names {
		if n == ".DEFAULT" {
			return
		}
	}
	t.Fatalf("loadedUserHives = %v, want it to include .DEFAULT", names)
}
