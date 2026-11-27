//go:build windows

package oemupdates

import (
	"errors"
	"fmt"
	"slices"

	"golang.org/x/sys/windows/registry"
)

var errKeyNotOnReadList = errors.New("registry key is not on the vendor schedule read list")

// readHKLMValue reads one value under HKLM. The key is opened in the 64-bit
// view with query rights only, so this cannot change anything, and only keys
// on dellRegistryKeys are opened. A missing key or value is not an error; a
// value that is not REG_SZ is reported as present with String false. The value
// is read as raw bytes and decoded whole by decodeRegSZ: GetStringValue stops
// at the first NUL, which would read "ManualUpdates\x00Auto" as manual.
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
	buf := make([]byte, maxRegSZBytes)
	n, valType, err := k.GetValue(name, buf)
	switch {
	case errors.Is(err, registry.ErrNotExist):
		return regRead{KeyExists: true}, nil
	case errors.Is(err, registry.ErrShortBuffer):
		return regRead{KeyExists: true, ValueExists: true}, fmt.Errorf("value %s is %d bytes, longer than any schedule mode", name, n)
	case err != nil:
		return regRead{KeyExists: true}, err
	case valType != registry.SZ:
		// REG_EXPAND_SZ, DWORD and the rest. The captured type is REG_SZ, so no
		// other type is read as a mode.
		return regRead{KeyExists: true, ValueExists: true}, nil
	case n > len(buf):
		return regRead{KeyExists: true, ValueExists: true}, fmt.Errorf("value %s reported %d bytes for a %d-byte buffer", name, n, len(buf))
	}
	v, ok := decodeRegSZ(buf[:n])
	if !ok {
		// An odd byte count is not a REG_SZ string.
		return regRead{KeyExists: true, ValueExists: true}, nil
	}
	return regRead{KeyExists: true, ValueExists: true, String: true, Value: v}, nil
}
