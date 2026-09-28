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
	"strings"
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

// DCStatus is IsDomainController's verdict. Evidence names the registry
// value that proved a domain controller (empty when IsDC is false);
// Warnings carries the ambiguous-signal notes a caller must surface to the
// operator.
type DCStatus struct {
	IsDC     bool
	Evidence string
	Warnings []string
}

// IsDomainController reports whether the SYSTEM hive rooted at root is a
// domain controller's, checking ANY selected control set
// (ControlSet<Select\Default>, and ControlSet<Select\Current> when it
// differs — see ControlSets) — the signal the Global Constraint "Refuse
// before destructive work" checks (a DC source is refused unless
// Options.AllowDomainController).
//
// The canonical offline signal is <ControlSet>\Control\ProductOptions
// value ProductType: "LanmanNt" is a DC, "ServerNT" a member or standalone
// server, "WinNT" a workstation. The mere presence of Services\NTDS is NOT a
// DC signal: a standalone Server 2022 without AD DS carries that key (no
// values, an empty "RID Values" subkey), which is how the previous
// key-exists check refused non-DCs.
//
// When ProductType is missing (key or value absent) or holds an
// unrecognized value, the set falls back to Services\NTDS\Parameters: a
// "DSA Database file" or "DSA Working Directory" value (either present
// means an AD DS database is configured) is a DC; otherwise it is not a DC
// and a warning is returned so the operator knows the check was
// inconclusive rather than a confirmed non-DC.
//
// It fails closed on errors: a hive whose selected control sets cannot be
// resolved, or a key/value that cannot be read for any reason other than
// absence, is an error, never "not a DC". Every key it opens is closed
// before it returns: an open handle under a loaded hive makes
// RegUnLoadKeyW fail with ERROR_ACCESS_DENIED.
func IsDomainController(root Key) (DCStatus, error) {
	var st DCStatus
	sets, err := ControlSets(root)
	if err != nil {
		return DCStatus{}, fmt.Errorf("resolve control sets: %w", err)
	}
	for _, cs := range sets {
		pt, err := readProductType(root, cs)
		if err != nil {
			return DCStatus{}, err
		}
		switch {
		case strings.EqualFold(pt, "LanmanNt"):
			st.IsDC = true
			st.Evidence = cs + `\Control\ProductOptions\ProductType is LanmanNt`
			return st, nil
		case strings.EqualFold(pt, "ServerNT"), strings.EqualFold(pt, "WinNT"):
			continue
		}
		dsa, err := ntdsDatabaseValue(root, cs)
		if err != nil {
			return DCStatus{}, err
		}
		what := cs + `\Control\ProductOptions\ProductType is missing`
		if pt != "" {
			what = fmt.Sprintf(`%s\Control\ProductOptions\ProductType is unrecognized (%q)`, cs, pt)
		}
		if dsa != "" {
			st.IsDC = true
			st.Evidence = fmt.Sprintf(`%s and %s\Services\NTDS\Parameters has %q`, what, cs, dsa)
			return st, nil
		}
		st.Warnings = append(st.Warnings, fmt.Sprintf(`domain-controller check inconclusive: %s and %s\Services\NTDS\Parameters has no AD DS database value; treating the source as not a domain controller`, what, cs))
	}
	return st, nil
}

// readProductType returns cs\Control\ProductOptions\ProductType, or ""
// when the key or value is absent.
func readProductType(root Key, cs string) (string, error) {
	k, err := root.OpenKey(cs + `\Control\ProductOptions`)
	if errors.Is(err, ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf(`open %s\Control\ProductOptions: %w`, cs, err)
	}
	defer func() { _ = k.Close() }()
	v, err := k.GetString("ProductType")
	if errors.Is(err, ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf(`read %s\Control\ProductOptions\ProductType: %w`, cs, err)
	}
	return v, nil
}

// ntdsDatabaseValue returns the name of the first AD DS database value
// present under cs\Services\NTDS\Parameters ("DSA Database file" or
// "DSA Working Directory"), or "" when neither (or the key) is present.
// Presence is by value name, not type.
func ntdsDatabaseValue(root Key, cs string) (string, error) {
	k, err := root.OpenKey(cs + `\Services\NTDS\Parameters`)
	if errors.Is(err, ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf(`open %s\Services\NTDS\Parameters: %w`, cs, err)
	}
	defer func() { _ = k.Close() }()
	names, err := k.ValueNames()
	if err != nil {
		return "", fmt.Errorf(`list %s\Services\NTDS\Parameters values: %w`, cs, err)
	}
	for _, want := range []string{"DSA Database file", "DSA Working Directory"} {
		for _, n := range names {
			if strings.EqualFold(n, want) {
				return want, nil
			}
		}
	}
	return "", nil
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
