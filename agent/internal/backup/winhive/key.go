// Package winhive is the offline registry-hive editing surface the
// bare-metal rebuild engine (agent/internal/backup/rebuild) and bmr's
// offline system-state apply (W06c) use to read and write a LOADED Windows
// registry hive without ever touching the live registry — see the Global
// Constraint "Hives: file tree first, all-or-nothing artifact fallback,
// never the live registry" in the W06 plan. Key/Handle and the in-memory
// Fake are untagged so the edit logic built on top of them (Part C:
// RewriteMountedDevices, ForceBootStartStorage, SetComputerName, ...) is
// testable on macOS/Linux; load_windows.go is the only
// file that talks to RegLoadKeyW for real.
package winhive

import (
	"errors"
	"fmt"
)

// ErrNotExist is returned by OpenKey/GetString/GetDWORD/GetBinary when the
// key or value does not exist. Callers that treat absence as "unset" check
// errors.Is(err, ErrNotExist) rather than testing for a specific message.
var ErrNotExist = errors.New("winhive: key or value does not exist")

// Key is the minimal registry surface every offline hive edit needs.
// Exported so both `rebuild` (winsystem.go's LoadHive) and `bmr` (the
// Windows RestoreSystemStateOffline, W06c) share one definition instead of
// two that could drift — see this plan's package-placement note.
type Key interface {
	// OpenKey resolves a `\`-separated, case-insensitive path relative to
	// the receiver. ErrNotExist when any component is absent.
	OpenKey(path string) (Key, error)
	// CreateKey creates every missing component of path and returns the
	// leaf, matching RegCreateKeyExW's "create if absent, open if present"
	// semantics.
	CreateKey(path string) (Key, error)
	// DeleteKey removes path and everything under it. A missing path is
	// not an error (RegDeleteTreeW's own "already gone" case).
	DeleteKey(path string) error
	GetString(name string) (string, error)
	GetDWORD(name string) (uint32, error)
	GetBinary(name string) ([]byte, error)
	SetString(name, value string) error
	SetDWORD(name string, value uint32) error
	SetBinary(name string, value []byte) error
	// DeleteValue removes name; a missing value is not an error.
	DeleteValue(name string) error
	ValueNames() ([]string, error)
	SubKeyNames() ([]string, error)
	// Close is a formality for Key (only Handle.Close does real work); every
	// concrete Key implementation's Close never errors.
	Close() error
}

// Handle is one loaded hive. Close flushes (RegFlushKey) and unloads
// (RegUnLoadKeyW) it — see the Global Constraint "every key handle is
// closed and RegFlushKey called before RegUnLoadKeyW".
type Handle interface {
	Root() Key
	Close() error
}

// HasNTDS reports whether the SYSTEM hive rooted at root has
// Services\NTDS in ANY selected control set (ControlSet<Select\Default>,
// and ControlSet<Select\Current> when it differs — see ControlSets) — the
// domain-controller signal the Global Constraint "Refuse before destructive
// work" checks (a DC source is refused unless
// Options.AllowDomainController). It fails closed: a hive whose selected
// control sets cannot be resolved, or whose NTDS key cannot be opened for
// any reason other than absence, is an error, never "not a DC". Every key it
// opens is closed before it returns: an open handle under a loaded hive
// makes RegUnLoadKeyW fail with ERROR_ACCESS_DENIED.
func HasNTDS(root Key) (bool, error) {
	sets, err := ControlSets(root)
	if err != nil {
		return false, fmt.Errorf("resolve control sets: %w", err)
	}
	for _, cs := range sets {
		ntds, err := root.OpenKey(cs + `\Services\NTDS`)
		if errors.Is(err, ErrNotExist) {
			continue
		}
		if err != nil {
			return false, fmt.Errorf(`open %s\Services\NTDS: %w`, cs, err)
		}
		_ = ntds.Close()
		return true, nil
	}
	return false, nil
}

// controlSetName formats a Select\Default DWORD as "ControlSet001" etc.
func controlSetName(n uint32) string {
	const digits = "0123456789"
	b := []byte{'C', 'o', 'n', 't', 'r', 'o', 'l', 'S', 'e', 't', '0', '0', '0'}
	b[len(b)-1] = digits[n%10]
	b[len(b)-2] = digits[(n/10)%10]
	b[len(b)-3] = digits[(n/100)%10]
	return string(b)
}
