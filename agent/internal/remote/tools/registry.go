package tools

import (
	"time"
)

// ListRegistryKeys returns subkeys at a registry path
func ListRegistryKeys(payload map[string]any) CommandResult {
	startTime := time.Now()

	hive := GetPayloadString(payload, "hive", "HKLM")
	path := GetPayloadString(payload, "path", "")

	return listRegistryKeysOS(hive, path, startTime)
}

// ListRegistryValues returns values at a registry path
func ListRegistryValues(payload map[string]any) CommandResult {
	startTime := time.Now()

	hive := GetPayloadString(payload, "hive", "HKLM")
	path := GetPayloadString(payload, "path", "")

	return listRegistryValuesOS(hive, path, startTime)
}

// GetRegistryValue returns a specific registry value
func GetRegistryValue(payload map[string]any) CommandResult {
	startTime := time.Now()

	hive := GetPayloadString(payload, "hive", "HKLM")
	path := GetPayloadString(payload, "path", "")
	name := GetPayloadString(payload, "name", "")

	return getRegistryValueOS(hive, path, name, startTime)
}

// SetRegistryValue sets a registry value
func SetRegistryValue(payload map[string]any) CommandResult {
	startTime := time.Now()

	hive := GetPayloadString(payload, "hive", "HKLM")
	path := GetPayloadString(payload, "path", "")
	name := GetPayloadString(payload, "name", "")
	valueType := GetPayloadString(payload, "type", "REG_SZ")
	data := GetPayloadString(payload, "data", "")

	return setRegistryValueOS(hive, path, name, valueType, data, startTime)
}

// DeleteRegistryValue deletes a registry value
func DeleteRegistryValue(payload map[string]any) CommandResult {
	startTime := time.Now()

	hive := GetPayloadString(payload, "hive", "HKLM")
	path := GetPayloadString(payload, "path", "")
	name := GetPayloadString(payload, "name", "")

	return deleteRegistryValueOS(hive, path, name, startTime)
}
