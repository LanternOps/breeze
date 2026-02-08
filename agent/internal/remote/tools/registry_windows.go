//go:build windows

package tools

import (
	"encoding/binary"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"

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
	case "REG_MULTI_SZ":
		values := []string{}
		for _, line := range strings.Split(data, "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed != "" {
				values = append(values, trimmed)
			}
		}
		err = key.SetStringsValue(name, values)
	case "REG_BINARY":
		hexData := strings.ReplaceAll(data, " ", "")
		if len(hexData)%2 != 0 {
			hexData = "0" + hexData
		}
		buf := make([]byte, len(hexData)/2)
		for i := 0; i < len(hexData); i += 2 {
			var parsed uint64
			_, scanErr := fmt.Sscanf(hexData[i:i+2], "%02x", &parsed)
			if scanErr != nil {
				return NewErrorResult(fmt.Errorf("failed to parse binary value: %w", scanErr), time.Since(startTime).Milliseconds())
			}
			buf[i/2] = byte(parsed)
		}
		err = key.SetBinaryValue(name, buf)
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

func createRegistryKeyOS(hive, path string, startTime time.Time) CommandResult {
	if path == "" {
		return NewErrorResult(fmt.Errorf("key path is required"), time.Since(startTime).Milliseconds())
	}

	root, err := resolveRegistryRoot(hive)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	key, _, err := registry.CreateKey(root, path, registry.ALL_ACCESS)
	if err != nil {
		return NewErrorResult(fmt.Errorf("failed to create key: %w", err), time.Since(startTime).Milliseconds())
	}
	key.Close()

	result := map[string]any{
		"path":    path,
		"created": true,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

func deleteRegistryKeyOS(hive, path string, startTime time.Time) CommandResult {
	if path == "" {
		return NewErrorResult(fmt.Errorf("key path is required"), time.Since(startTime).Milliseconds())
	}

	root, err := resolveRegistryRoot(hive)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	if err := registry.DeleteKey(root, path); err != nil {
		return NewErrorResult(fmt.Errorf("failed to delete key: %w", err), time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"path":    path,
		"deleted": true,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

func openRegistryKey(hive, path string, access uint32) (registry.Key, error) {
	root, err := resolveRegistryRoot(hive)
	if err != nil {
		return 0, err
	}

	key, err := registry.OpenKey(root, path, access)
	if err != nil {
		return 0, fmt.Errorf("failed to open key: %w", err)
	}

	return key, nil
}

func resolveRegistryRoot(hive string) (registry.Key, error) {
	switch hive {
	case "HKLM", "HKEY_LOCAL_MACHINE":
		return registry.LOCAL_MACHINE, nil
	case "HKCU", "HKEY_CURRENT_USER":
		return registry.CURRENT_USER, nil
	case "HKCR", "HKEY_CLASSES_ROOT":
		return registry.CLASSES_ROOT, nil
	case "HKU", "HKEY_USERS":
		return registry.USERS, nil
	case "HKCC", "HKEY_CURRENT_CONFIG":
		return registry.CURRENT_CONFIG, nil
	default:
		return 0, fmt.Errorf("unknown registry hive: %s", hive)
	}
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
		return decodeUTF16LE(buf)
	case registry.MULTI_SZ:
		decoded := decodeUTF16LE(buf)
		parts := strings.Split(decoded, "\x00")
		cleaned := make([]string, 0, len(parts))
		for _, part := range parts {
			if part != "" {
				cleaned = append(cleaned, part)
			}
		}
		return strings.Join(cleaned, "\n")
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
		return strings.ToUpper(fmt.Sprintf("% X", buf))
	}
	return fmt.Sprintf("%v", buf)
}

func decodeUTF16LE(buf []byte) string {
	if len(buf) < 2 {
		return ""
	}

	if len(buf)%2 != 0 {
		buf = buf[:len(buf)-1]
	}

	u16 := make([]uint16, 0, len(buf)/2)
	for i := 0; i < len(buf); i += 2 {
		u16 = append(u16, binary.LittleEndian.Uint16(buf[i:i+2]))
	}

	for len(u16) > 0 && u16[len(u16)-1] == 0 {
		u16 = u16[:len(u16)-1]
	}

	return string(utf16.Decode(u16))
}
