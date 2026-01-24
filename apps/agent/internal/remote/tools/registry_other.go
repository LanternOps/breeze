//go:build !windows

package tools

import (
	"errors"
)

// ErrNotWindows is returned when registry operations are attempted on non-Windows platforms.
var ErrNotWindows = errors.New("registry operations are only supported on Windows")

// ListKeys is not supported on non-Windows platforms.
func (rm *RegistryManager) ListKeys(hive string, path string) ([]RegistryKey, error) {
	return nil, ErrNotWindows
}

// ListValues is not supported on non-Windows platforms.
func (rm *RegistryManager) ListValues(hive string, path string) ([]RegistryValue, error) {
	return nil, ErrNotWindows
}

// GetValue is not supported on non-Windows platforms.
func (rm *RegistryManager) GetValue(hive string, path string, name string) (*RegistryValue, error) {
	return nil, ErrNotWindows
}

// SetValue is not supported on non-Windows platforms.
func (rm *RegistryManager) SetValue(hive string, path string, name string, valueType string, data interface{}) error {
	return ErrNotWindows
}

// DeleteValue is not supported on non-Windows platforms.
func (rm *RegistryManager) DeleteValue(hive string, path string, name string) error {
	return ErrNotWindows
}

// CreateKey is not supported on non-Windows platforms.
func (rm *RegistryManager) CreateKey(hive string, path string) error {
	return ErrNotWindows
}

// DeleteKey is not supported on non-Windows platforms.
func (rm *RegistryManager) DeleteKey(hive string, path string) error {
	return ErrNotWindows
}

// KeyExists is not supported on non-Windows platforms.
func (rm *RegistryManager) KeyExists(hive string, path string) (bool, error) {
	return false, ErrNotWindows
}

// ValueExists is not supported on non-Windows platforms.
func (rm *RegistryManager) ValueExists(hive string, path string, name string) (bool, error) {
	return false, ErrNotWindows
}
