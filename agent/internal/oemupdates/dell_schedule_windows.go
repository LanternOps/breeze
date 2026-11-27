//go:build windows

package oemupdates

import (
	"errors"
	"slices"

	"golang.org/x/sys/windows/registry"
)

var errKeyNotOnReadList = errors.New("registry key is not on the vendor schedule read list")

// readHKLMValue reads one value under HKLM. The key is opened in the 64-bit
// view with query rights only, so this cannot change anything, and only keys
// on dellRegistryKeys are opened. A missing key or value is not an error; a
// value that is not REG_SZ is reported as present with String false.
func readHKLMValue(key, name string) (regRead, error) {
	if !slices.Contains(dellRegistryKeys, key) {
		return regRead{}, errKeyNotOnReadList
	}
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, key, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if errors.Is(err, registry.ErrNotExist) {
		return regRead{}, nil
	}
	if err != nil {
		return regRead{}, err
	}
	defer func() { _ = k.Close() }()
	v, valType, err := k.GetStringValue(name)
	switch {
	case errors.Is(err, registry.ErrNotExist):
		return regRead{KeyExists: true}, nil
	case errors.Is(err, registry.ErrUnexpectedType):
		return regRead{KeyExists: true, ValueExists: true}, nil
	case err != nil:
		return regRead{KeyExists: true}, err
	case valType != registry.SZ:
		// REG_EXPAND_SZ. The captured type is REG_SZ, so no other type is read as a mode.
		return regRead{KeyExists: true, ValueExists: true}, nil
	}
	return regRead{KeyExists: true, ValueExists: true, String: true, Value: v}, nil
}
