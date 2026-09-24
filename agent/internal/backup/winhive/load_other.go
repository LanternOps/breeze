//go:build !windows

package winhive

import "errors"

// Load is Windows-only; tests use Fake.
func Load(_, _ string) (Handle, error) {
	return nil, errors.New("winhive: loading a registry hive is only supported on windows")
}

// LoadReadOnly is Windows-only; tests use Fake.
func LoadReadOnly(_, _ string) (Handle, error) {
	return nil, errors.New("winhive: loading a registry hive is only supported on windows")
}

// UnloadStale has nothing to unload off Windows.
func UnloadStale(_ string) (int, error) { return 0, nil }
