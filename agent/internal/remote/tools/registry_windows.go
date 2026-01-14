//go:build windows

package tools

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows/registry"
)

func listRegistryKeysOS(hive, path string, startTime time.Time) CommandResult {
	key, err := openRegistryKey(hive, path, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	defer key.Close()

	subkeys, err := key.ReadSubKeyNames(-1)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to read subkeys: %w", err), time.Since(startTime).Milliseconds())
	}

	var keys []RegistryKey
	for _, name := range subkeys {
		subkey, err := openRegistryKey(hive, path+"\\"+name, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
		if err != nil {
			keys = append(keys, RegistryKey{
				Name: name,
				Path: path + "\\" + name,
			})
			continue
		}

		subkeyInfo, _ := subkey.Stat()
		valueCount := 0
		subkeyCount := 0
		if subkeyInfo != nil {
			valueCount = int(subkeyInfo.ValueCount)
			subkeyCount = int(subkeyInfo.SubKeyCount)
		}

		keys = append(keys, RegistryKey{
			Name:        name,
			Path:        path + "\\" + name,
			SubKeyCount: subkeyCount,
			ValueCount:  valueCount,
		})

		subkey.Close()
	}

	response := RegistryKeysResponse{
		Keys: keys,
		Path: path,
		Hive: hive,
	}

	return NewSuccessResult(response, time.Since(startTime).Milliseconds())
}

func listRegistryValuesOS(hive, path string, startTime time.Time) CommandResult {
	key, err := openRegistryKey(hive, path, registry.QUERY_VALUE)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	defer key.Close()

	valueNames, err := key.ReadValueNames(-1)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to read values: %w", err), time.Since(startTime).Milliseconds())
	}

	var values []RegistryValue
	for _, name := range valueNames {
		val, valType, err := key.GetValue(name, nil)
		if err != nil {
			continue
		}

		// Read the actual value
		buf := make([]byte, val)
		_, _, err = key.GetValue(name, buf)
		if err != nil {
			continue
		}

		values = append(values, RegistryValue{
			Name: name,
			Type: typeToString(valType),
			Data: formatValue(buf, valType),
		})
	}

	response := RegistryValuesResponse{
		Values: values,
		Path:   path,
		Hive:   hive,
	}

	return NewSuccessResult(response, time.Since(startTime).Milliseconds())
}

func getRegistryValueOS(hive, path, name string, startTime time.Time) CommandResult {
	if name == "" {
		return NewErrorResult(fmt.Errorf("value name is required"), time.Since(startTime).Milliseconds())
	}

	key, err := openRegistryKey(hive, path, registry.QUERY_VALUE)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	defer key.Close()

	val, valType, err := key.GetValue(name, nil)
	if err != nil {
		return NewErrorResult(fmt.Errorf("value not found: %w", err), time.Since(startTime).Milliseconds())
	}

	buf := make([]byte, val)
	_, _, err = key.GetValue(name, buf)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to read value: %w", err), time.Since(startTime).Milliseconds())
	}

	value := RegistryValue{
		Name: name,
		Type: typeToString(valType),
		Data: formatValue(buf, valType),
	}

	return NewSuccessResult(value, time.Since(startTime).Milliseconds())
}

func setRegistryValueOS(hive, path, name, valueType, data string, startTime time.Time) CommandResult {
	if name == "" {
		return NewErrorResult(fmt.Errorf("value name is required"), time.Since(startTime).Milliseconds())
	}

	key, err := openRegistryKey(hive, path, registry.SET_VALUE)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	defer key.Close()

	switch valueType {
	case "REG_SZ":
		err = key.SetStringValue(name, data)
	case "REG_EXPAND_SZ":
		err = key.SetExpandStringValue(name, data)
	case "REG_DWORD":
		var val uint32
		fmt.Sscanf(data, "%d", &val)
		err = key.SetDWordValue(name, val)
	case "REG_QWORD":
		var val uint64
		fmt.Sscanf(data, "%d", &val)
		err = key.SetQWordValue(name, val)
	default:
		return NewErrorResult(fmt.Errorf("unsupported value type: %s", valueType), time.Since(startTime).Milliseconds())
	}

	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to set value: %w", err), time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"name":    name,
		"type":    valueType,
		"data":    data,
		"success": true,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

func deleteRegistryValueOS(hive, path, name string, startTime time.Time) CommandResult {
	if name == "" {
		return NewErrorResult(fmt.Errorf("value name is required"), time.Since(startTime).Milliseconds())
	}

	key, err := openRegistryKey(hive, path, registry.SET_VALUE)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	defer key.Close()

	err = key.DeleteValue(name)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to delete value: %w", err), time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"name":    name,
		"deleted": true,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

func openRegistryKey(hive, path string, access uint32) (registry.Key, error) {
	var root registry.Key
	switch hive {
	case "HKLM", "HKEY_LOCAL_MACHINE":
		root = registry.LOCAL_MACHINE
	case "HKCU", "HKEY_CURRENT_USER":
		root = registry.CURRENT_USER
	case "HKCR", "HKEY_CLASSES_ROOT":
		root = registry.CLASSES_ROOT
	case "HKU", "HKEY_USERS":
		root = registry.USERS
	case "HKCC", "HKEY_CURRENT_CONFIG":
		root = registry.CURRENT_CONFIG
	default:
		return 0, fmt.Errorf("unknown registry hive: %s", hive)
	}

	key, err := registry.OpenKey(root, path, access)
	if err != nil {
		return 0, fmt.Errorf("failed to open key: %w", err)
	}

	return key, nil
}

func typeToString(valType uint32) string {
	switch valType {
	case registry.SZ:
		return "REG_SZ"
	case registry.EXPAND_SZ:
		return "REG_EXPAND_SZ"
	case registry.BINARY:
		return "REG_BINARY"
	case registry.DWORD:
		return "REG_DWORD"
	case registry.MULTI_SZ:
		return "REG_MULTI_SZ"
	case registry.QWORD:
		return "REG_QWORD"
	default:
		return fmt.Sprintf("REG_TYPE_%d", valType)
	}
}

func formatValue(buf []byte, valType uint32) string {
	switch valType {
	case registry.SZ, registry.EXPAND_SZ:
		// UTF-16 to string
		if len(buf) > 1 {
			// Remove null terminator
			for len(buf) > 1 && buf[len(buf)-1] == 0 && buf[len(buf)-2] == 0 {
				buf = buf[:len(buf)-2]
			}
		}
		return string(buf)
	case registry.DWORD:
		if len(buf) >= 4 {
			val := uint32(buf[0]) | uint32(buf[1])<<8 | uint32(buf[2])<<16 | uint32(buf[3])<<24
			return fmt.Sprintf("%d", val)
		}
	case registry.QWORD:
		if len(buf) >= 8 {
			val := uint64(buf[0]) | uint64(buf[1])<<8 | uint64(buf[2])<<16 | uint64(buf[3])<<24 |
				uint64(buf[4])<<32 | uint64(buf[5])<<40 | uint64(buf[6])<<48 | uint64(buf[7])<<56
			return fmt.Sprintf("%d", val)
		}
	case registry.BINARY:
		return fmt.Sprintf("%x", buf)
	}
	return fmt.Sprintf("%v", buf)
}
