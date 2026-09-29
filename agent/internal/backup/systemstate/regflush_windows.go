//go:build windows

package systemstate

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// RegFlushKey is not wrapped by x/sys.
var (
	regflushAdvapi32 = windows.NewLazySystemDLL("advapi32.dll")
	procRegFlushKey  = regflushAdvapi32.NewProc("RegFlushKey")
)

// hklmFlushTargets are the HKLM hives flushed before a snapshot: the four a
// bootable rebuild requires (registryHives) and the other on-disk hives in
// System32\config that the whole-machine walk captures when they are loaded.
var hklmFlushTargets = []hiveFlushTarget{
	{Root: "HKLM", Path: "SYSTEM", Required: true},
	{Root: "HKLM", Path: "SOFTWARE", Required: true},
	{Root: "HKLM", Path: "SAM", Required: true},
	{Root: "HKLM", Path: "SECURITY", Required: true},
	{Root: "HKLM", Path: "COMPONENTS"},
	{Root: "HKLM", Path: "DRIVERS"},
}

// flushLoadedHives flushes the HKLM hives above plus every hive loaded under
// HKEY_USERS (.DEFAULT, each signed-in user's NTUSER.DAT and UsrClass.dat,
// which the whole-machine walk captures from the same snapshot).
func flushLoadedHives() (int, error) {
	targets := append([]hiveFlushTarget(nil), hklmFlushTargets...)
	var enumErr error
	if names, err := loadedUserHives(); err != nil {
		enumErr = fmt.Errorf(`HKU: list loaded hives: %w`, err)
	} else {
		for _, name := range names {
			targets = append(targets, hiveFlushTarget{Root: "HKU", Path: name})
		}
	}
	flushed, err := flushHiveTargets(targets, flushHiveKey)
	return flushed, errors.Join(enumErr, err)
}

func loadedUserHives() ([]string, error) {
	k, err := registry.OpenKey(registry.USERS, "", registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return nil, err
	}
	defer k.Close()
	return k.ReadSubKeyNames(-1)
}

// flushHiveKey opens the hive's root key and calls RegFlushKey on it, which
// writes that hive's dirty data to disk before returning. The agent runs as
// LocalSystem, whose token may open SAM and SECURITY; QUERY_VALUE is the
// smallest access that opens a key for a flush.
func flushHiveKey(t hiveFlushTarget) error {
	root := registry.LOCAL_MACHINE
	if t.Root == "HKU" {
		root = registry.USERS
	}
	k, err := registry.OpenKey(root, t.Path, registry.QUERY_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return errHiveNotLoaded
		}
		return fmt.Errorf("open: %w", err)
	}
	defer k.Close()
	if r1, _, _ := procRegFlushKey.Call(uintptr(k)); r1 != 0 {
		return fmt.Errorf("RegFlushKey: %w", windows.Errno(r1))
	}
	return nil
}
