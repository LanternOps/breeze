//go:build windows

package tools

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/sys/windows/registry"
)

var (
	// ErrUnsupportedHive is returned when an unsupported registry hive is specified.
	ErrUnsupportedHive = errors.New("unsupported registry hive")
	// ErrCriticalPath is returned when attempting to modify a critical system path.
	ErrCriticalPath = errors.New("operation blocked: critical system path")
	// ErrCriticalValue is returned when attempting to modify a critical system value.
	ErrCriticalValue = errors.New("operation blocked: critical system value")
	// ErrUnsupportedType is returned when an unsupported registry value type is specified.
	ErrUnsupportedType = errors.New("unsupported registry value type")
	// ErrKeyNotEmpty is returned when attempting to delete a non-empty key.
	ErrKeyNotEmpty = errors.New("cannot delete non-empty key")
)

// hiveMap maps hive string names to registry.Key constants.
var hiveMap = map[string]registry.Key{
	HiveLocalMachine:  registry.LOCAL_MACHINE,
	HiveCurrentUser:   registry.CURRENT_USER,
	HiveClassesRoot:   registry.CLASSES_ROOT,
	HiveUsers:         registry.USERS,
	HiveCurrentConfig: registry.CURRENT_CONFIG,
}

// getHive returns the registry.Key for the given hive name.
func getHive(hive string) (registry.Key, error) {
	h := strings.ToUpper(hive)
	if key, ok := hiveMap[h]; ok {
		return key, nil
	}
	return 0, fmt.Errorf("%w: %s", ErrUnsupportedHive, hive)
}

// isCriticalPath checks if the given path is a critical system path.
func isCriticalPath(path string) bool {
	normalizedPath := strings.ToUpper(strings.ReplaceAll(path, "/", "\\"))
	normalizedPath = strings.TrimPrefix(normalizedPath, "\\")
	normalizedPath = strings.TrimSuffix(normalizedPath, "\\")

	for _, critical := range criticalPaths {
		normalizedCritical := strings.ToUpper(critical)
		if normalizedPath == normalizedCritical || strings.HasPrefix(normalizedPath, normalizedCritical+"\\") {
			return true
		}
	}
	return false
}

// isCriticalValue checks if the given value in the path is a critical system value.
func isCriticalValue(path, valueName string) bool {
	normalizedPath := strings.ToUpper(strings.ReplaceAll(path, "/", "\\"))
	normalizedPath = strings.TrimPrefix(normalizedPath, "\\")
	normalizedPath = strings.TrimSuffix(normalizedPath, "\\")
	normalizedValue := strings.ToUpper(valueName)

	for critPath, values := range criticalValues {
		if strings.ToUpper(critPath) == normalizedPath {
			for _, v := range values {
				if strings.ToUpper(v) == normalizedValue {
					return true
				}
			}
		}
	}
	return false
}

// valueTypeToString converts a registry value type to its string representation.
func valueTypeToString(valType uint32) string {
	switch valType {
	case registry.SZ:
		return RegSZ
	case registry.EXPAND_SZ:
		return RegExpandSZ
	case registry.BINARY:
		return RegBinary
	case registry.DWORD:
		return RegDWORD
	case registry.MULTI_SZ:
		return RegMultiSZ
	case registry.QWORD:
		return RegQWORD
	case registry.NONE:
		return RegNone
	case registry.FULL_RESOURCE_DESCRIPTOR:
		return RegFullResourceDescriptor
	case registry.RESOURCE_LIST:
		return RegResourceList
	case registry.RESOURCE_REQUIREMENTS_LIST:
		return RegResourceRequirementsList
	default:
		return fmt.Sprintf("UNKNOWN(%d)", valType)
	}
}

// ListKeys lists all subkeys at the specified registry path.
func (rm *RegistryManager) ListKeys(hive string, path string) ([]RegistryKey, error) {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	hiveKey, err := getHive(hive)
	if err != nil {
		return nil, err
	}

	key, err := registry.OpenKey(hiveKey, path, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
	if err != nil {
		return nil, fmt.Errorf("failed to open key %s\\%s: %w", hive, path, err)
	}
	defer key.Close()

	subKeyNames, err := key.ReadSubKeyNames(-1)
	if err != nil {
		return nil, fmt.Errorf("failed to read subkeys: %w", err)
	}

	keys := make([]RegistryKey, 0, len(subKeyNames))
	for _, name := range subKeyNames {
		subPath := path
		if subPath != "" {
			subPath += "\\"
		}
		subPath += name

		subKey, err := registry.OpenKey(hiveKey, subPath, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
		if err != nil {
			// Skip keys we can't access
			keys = append(keys, RegistryKey{
				Name:        name,
				Path:        subPath,
				SubKeyCount: -1,
				ValueCount:  -1,
			})
			continue
		}

		stat, err := subKey.Stat()
		subKey.Close()
		if err != nil {
			keys = append(keys, RegistryKey{
				Name:        name,
				Path:        subPath,
				SubKeyCount: -1,
				ValueCount:  -1,
			})
			continue
		}

		keys = append(keys, RegistryKey{
			Name:        name,
			Path:        subPath,
			SubKeyCount: int(stat.SubKeyCount),
			ValueCount:  int(stat.ValueCount),
		})
	}

	return keys, nil
}

// ListValues lists all values at the specified registry path.
func (rm *RegistryManager) ListValues(hive string, path string) ([]RegistryValue, error) {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	hiveKey, err := getHive(hive)
	if err != nil {
		return nil, err
	}

	key, err := registry.OpenKey(hiveKey, path, registry.QUERY_VALUE)
	if err != nil {
		return nil, fmt.Errorf("failed to open key %s\\%s: %w", hive, path, err)
	}
	defer key.Close()

	valueNames, err := key.ReadValueNames(-1)
	if err != nil {
		return nil, fmt.Errorf("failed to read value names: %w", err)
	}

	values := make([]RegistryValue, 0, len(valueNames))
	for _, name := range valueNames {
		val, err := rm.readValue(key, name)
		if err != nil {
			// Skip values we can't read
			values = append(values, RegistryValue{
				Name:     name,
				Type:     "UNKNOWN",
				Data:     nil,
				DataSize: -1,
			})
			continue
		}
		values = append(values, *val)
	}

	return values, nil
}

// readValue reads a single registry value.
func (rm *RegistryManager) readValue(key registry.Key, name string) (*RegistryValue, error) {
	// First get the value info to determine type and size
	_, valType, err := key.GetValue(name, nil)
	if err != nil {
		return nil, err
	}

	val := &RegistryValue{
		Name: name,
		Type: valueTypeToString(valType),
	}

	switch valType {
	case registry.SZ, registry.EXPAND_SZ:
		s, _, err := key.GetStringValue(name)
		if err != nil {
			return nil, err
		}
		val.Data = s
		val.DataSize = len(s) * 2 // UTF-16

	case registry.DWORD:
		d, _, err := key.GetIntegerValue(name)
		if err != nil {
			return nil, err
		}
		val.Data = uint32(d)
		val.DataSize = 4

	case registry.QWORD:
		q, _, err := key.GetIntegerValue(name)
		if err != nil {
			return nil, err
		}
		val.Data = q
		val.DataSize = 8

	case registry.BINARY:
		buf := make([]byte, 4096)
		n, _, err := key.GetValue(name, buf)
		if err != nil {
			return nil, err
		}
		val.Data = base64.StdEncoding.EncodeToString(buf[:n])
		val.DataSize = n

	case registry.MULTI_SZ:
		ss, _, err := key.GetStringsValue(name)
		if err != nil {
			return nil, err
		}
		val.Data = ss
		size := 0
		for _, s := range ss {
			size += (len(s) + 1) * 2
		}
		size += 2 // Final null terminator
		val.DataSize = size

	default:
		// For unknown types, read as binary
		buf := make([]byte, 4096)
		n, _, err := key.GetValue(name, buf)
		if err != nil {
			return nil, err
		}
		val.Data = base64.StdEncoding.EncodeToString(buf[:n])
		val.DataSize = n
	}

	return val, nil
}

// GetValue retrieves a specific registry value.
func (rm *RegistryManager) GetValue(hive string, path string, name string) (*RegistryValue, error) {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	hiveKey, err := getHive(hive)
	if err != nil {
		return nil, err
	}

	key, err := registry.OpenKey(hiveKey, path, registry.QUERY_VALUE)
	if err != nil {
		return nil, fmt.Errorf("failed to open key %s\\%s: %w", hive, path, err)
	}
	defer key.Close()

	return rm.readValue(key, name)
}

// SetValue sets a registry value. Returns an error if attempting to modify critical system values.
func (rm *RegistryManager) SetValue(hive string, path string, name string, valueType string, data interface{}) error {
	// Check for critical paths and values
	if isCriticalPath(path) {
		return fmt.Errorf("%w: %s", ErrCriticalPath, path)
	}
	if isCriticalValue(path, name) {
		return fmt.Errorf("%w: %s\\%s", ErrCriticalValue, path, name)
	}

	rm.mu.Lock()
	defer rm.mu.Unlock()

	hiveKey, err := getHive(hive)
	if err != nil {
		return err
	}

	key, err := registry.OpenKey(hiveKey, path, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("failed to open key %s\\%s: %w", hive, path, err)
	}
	defer key.Close()

	switch strings.ToUpper(valueType) {
	case RegSZ:
		s, ok := data.(string)
		if !ok {
			return fmt.Errorf("REG_SZ requires string data, got %T", data)
		}
		return key.SetStringValue(name, s)

	case RegExpandSZ:
		s, ok := data.(string)
		if !ok {
			return fmt.Errorf("REG_EXPAND_SZ requires string data, got %T", data)
		}
		return key.SetExpandStringValue(name, s)

	case RegDWORD:
		var d uint32
		switch v := data.(type) {
		case uint32:
			d = v
		case int:
			d = uint32(v)
		case int32:
			d = uint32(v)
		case int64:
			d = uint32(v)
		case uint64:
			d = uint32(v)
		case float64:
			d = uint32(v)
		default:
			return fmt.Errorf("REG_DWORD requires integer data, got %T", data)
		}
		return key.SetDWordValue(name, d)

	case RegQWORD:
		var q uint64
		switch v := data.(type) {
		case uint64:
			q = v
		case int:
			q = uint64(v)
		case int32:
			q = uint64(v)
		case int64:
			q = uint64(v)
		case uint32:
			q = uint64(v)
		case float64:
			q = uint64(v)
		default:
			return fmt.Errorf("REG_QWORD requires integer data, got %T", data)
		}
		return key.SetQWordValue(name, q)

	case RegBinary:
		var b []byte
		switch v := data.(type) {
		case []byte:
			b = v
		case string:
			// Assume base64 encoded
			decoded, err := base64.StdEncoding.DecodeString(v)
			if err != nil {
				return fmt.Errorf("REG_BINARY string data must be base64 encoded: %w", err)
			}
			b = decoded
		default:
			return fmt.Errorf("REG_BINARY requires []byte or base64 string data, got %T", data)
		}
		return key.SetBinaryValue(name, b)

	case RegMultiSZ:
		var ss []string
		switch v := data.(type) {
		case []string:
			ss = v
		case []interface{}:
			ss = make([]string, len(v))
			for i, item := range v {
				s, ok := item.(string)
				if !ok {
					return fmt.Errorf("REG_MULTI_SZ requires []string data, element %d is %T", i, item)
				}
				ss[i] = s
			}
		default:
			return fmt.Errorf("REG_MULTI_SZ requires []string data, got %T", data)
		}
		return key.SetStringsValue(name, ss)

	default:
		return fmt.Errorf("%w: %s", ErrUnsupportedType, valueType)
	}
}

// DeleteValue deletes a registry value. Returns an error if attempting to delete critical system values.
func (rm *RegistryManager) DeleteValue(hive string, path string, name string) error {
	// Check for critical paths and values
	if isCriticalPath(path) {
		return fmt.Errorf("%w: %s", ErrCriticalPath, path)
	}
	if isCriticalValue(path, name) {
		return fmt.Errorf("%w: %s\\%s", ErrCriticalValue, path, name)
	}

	rm.mu.Lock()
	defer rm.mu.Unlock()

	hiveKey, err := getHive(hive)
	if err != nil {
		return err
	}

	key, err := registry.OpenKey(hiveKey, path, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("failed to open key %s\\%s: %w", hive, path, err)
	}
	defer key.Close()

	return key.DeleteValue(name)
}

// CreateKey creates a new registry key. Returns an error if attempting to create in critical system paths.
func (rm *RegistryManager) CreateKey(hive string, path string) error {
	// Check for critical paths
	if isCriticalPath(path) {
		return fmt.Errorf("%w: %s", ErrCriticalPath, path)
	}

	rm.mu.Lock()
	defer rm.mu.Unlock()

	hiveKey, err := getHive(hive)
	if err != nil {
		return err
	}

	key, _, err := registry.CreateKey(hiveKey, path, registry.ALL_ACCESS)
	if err != nil {
		return fmt.Errorf("failed to create key %s\\%s: %w", hive, path, err)
	}
	key.Close()

	return nil
}

// DeleteKey deletes a registry key. The key must be empty (no subkeys).
// Returns an error if attempting to delete critical system paths.
func (rm *RegistryManager) DeleteKey(hive string, path string) error {
	// Check for critical paths
	if isCriticalPath(path) {
		return fmt.Errorf("%w: %s", ErrCriticalPath, path)
	}

	rm.mu.Lock()
	defer rm.mu.Unlock()

	hiveKey, err := getHive(hive)
	if err != nil {
		return err
	}

	// First check if the key has subkeys
	key, err := registry.OpenKey(hiveKey, path, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return fmt.Errorf("failed to open key %s\\%s: %w", hive, path, err)
	}

	subKeys, err := key.ReadSubKeyNames(-1)
	key.Close()
	if err != nil {
		return fmt.Errorf("failed to enumerate subkeys: %w", err)
	}

	if len(subKeys) > 0 {
		return fmt.Errorf("%w: %s has %d subkeys", ErrKeyNotEmpty, path, len(subKeys))
	}

	// Get the parent path and key name
	lastSlash := strings.LastIndex(path, "\\")
	if lastSlash == -1 {
		return fmt.Errorf("cannot delete root-level key: %s", path)
	}

	parentPath := path[:lastSlash]
	keyName := path[lastSlash+1:]

	parentKey, err := registry.OpenKey(hiveKey, parentPath, registry.CREATE_SUB_KEY)
	if err != nil {
		return fmt.Errorf("failed to open parent key %s\\%s: %w", hive, parentPath, err)
	}
	defer parentKey.Close()

	return registry.DeleteKey(parentKey, keyName)
}

// KeyExists checks if a registry key exists.
func (rm *RegistryManager) KeyExists(hive string, path string) (bool, error) {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	hiveKey, err := getHive(hive)
	if err != nil {
		return false, err
	}

	key, err := registry.OpenKey(hiveKey, path, registry.QUERY_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	key.Close()

	return true, nil
}

// ValueExists checks if a registry value exists.
func (rm *RegistryManager) ValueExists(hive string, path string, name string) (bool, error) {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	hiveKey, err := getHive(hive)
	if err != nil {
		return false, err
	}

	key, err := registry.OpenKey(hiveKey, path, registry.QUERY_VALUE)
	if err != nil {
		return false, err
	}
	defer key.Close()

	_, _, err = key.GetValue(name, nil)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return false, nil
		}
		return false, err
	}

	return true, nil
}
