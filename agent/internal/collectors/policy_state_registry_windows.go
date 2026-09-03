//go:build windows

package collectors

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// CollectRegistryState reads each configured probe out of the local registry.
//
// The returned error is a completeness signal, not a fatal one: entries always
// holds whatever was readable, and a non-nil error means at least one probe
// could not be read (access denied, I/O) so the result is PARTIAL. Callers must
// not upload a partial result with replace:true — that deletes the server's
// prior observation of every probe missing from this batch (#3529).
//
// An absent key or value is genuine absence rather than failure: it is reported
// by omission with no error, so a complete collection still clears stale server
// state for policies that were removed from the device.
func (c *PolicyStateCollector) CollectRegistryState(probes []RegistryProbe) ([]RegistryStateEntry, error) {
	entries := make([]RegistryStateEntry, 0, len(probes))
	seen := make(map[string]struct{})
	var probeErrs []error

	for _, probe := range probes {
		registryPath := strings.TrimSpace(probe.RegistryPath)
		valueName := strings.TrimSpace(probe.ValueName)
		if registryPath == "" || valueName == "" {
			continue
		}

		dedupeKey := strings.ToLower(registryPath) + "::" + strings.ToLower(valueName)
		if _, ok := seen[dedupeKey]; ok {
			continue
		}
		seen[dedupeKey] = struct{}{}

		root, subPath, err := resolveRegistryProbePath(registryPath)
		if err != nil {
			// Malformed probe configuration, not a collection failure: the
			// value can never be read, so absence is the honest report.
			continue
		}

		key, err := registry.OpenKey(root, subPath, registry.QUERY_VALUE)
		if err != nil {
			if !errors.Is(err, registry.ErrNotExist) {
				probeErrs = append(probeErrs, fmt.Errorf("open %s: %w", registryPath, err))
			}
			continue
		}

		// Probe existence separately from decoding: a value that is present but
		// unreadable (access denied) must not be reported as "policy absent".
		_, _, err = key.GetValue(valueName, nil)
		if err != nil {
			if !errors.Is(err, registry.ErrNotExist) {
				probeErrs = append(probeErrs, fmt.Errorf("read %s\\%s: %w", registryPath, valueName, err))
			}
			key.Close()
			continue
		}

		entry, ok := readRegistryProbeValue(key, registryPath, valueName)
		key.Close()
		if !ok {
			probeErrs = append(probeErrs, fmt.Errorf("read %s\\%s: unsupported value type", registryPath, valueName))
			continue
		}

		entries = append(entries, entry)
	}

	return entries, errors.Join(probeErrs...)
}

func resolveRegistryProbePath(path string) (registry.Key, string, error) {
	normalized := strings.ReplaceAll(strings.TrimSpace(path), "/", `\`)
	if normalized == "" {
		return 0, "", fmt.Errorf("empty registry path")
	}

	parts := strings.SplitN(normalized, `\`, 2)
	hive := strings.ToUpper(strings.TrimSpace(parts[0]))
	subPath := ""
	if len(parts) == 2 {
		subPath = strings.TrimSpace(parts[1])
	}

	switch hive {
	case "HKEY_LOCAL_MACHINE", "HKLM":
		return registry.LOCAL_MACHINE, subPath, nil
	case "HKEY_CURRENT_USER", "HKCU":
		return registry.CURRENT_USER, subPath, nil
	case "HKEY_CLASSES_ROOT", "HKCR":
		return registry.CLASSES_ROOT, subPath, nil
	case "HKEY_USERS", "HKU":
		return registry.USERS, subPath, nil
	case "HKEY_CURRENT_CONFIG", "HKCC":
		return registry.CURRENT_CONFIG, subPath, nil
	default:
		return 0, "", fmt.Errorf("unsupported registry hive: %s", hive)
	}
}

func readRegistryProbeValue(key registry.Key, registryPath string, valueName string) (RegistryStateEntry, bool) {
	if value, valueType, err := key.GetStringValue(valueName); err == nil {
		return RegistryStateEntry{
			RegistryPath: registryPath,
			ValueName:    valueName,
			ValueData:    strings.TrimSpace(value),
			ValueType:    registryTypeToString(valueType),
		}, true
	}

	if value, valueType, err := key.GetIntegerValue(valueName); err == nil {
		return RegistryStateEntry{
			RegistryPath: registryPath,
			ValueName:    valueName,
			ValueData:    value,
			ValueType:    registryTypeToString(valueType),
		}, true
	}

	if value, valueType, err := key.GetStringsValue(valueName); err == nil {
		return RegistryStateEntry{
			RegistryPath: registryPath,
			ValueName:    valueName,
			ValueData:    strings.Join(value, ";"),
			ValueType:    registryTypeToString(valueType),
		}, true
	}

	if value, valueType, err := key.GetBinaryValue(valueName); err == nil {
		return RegistryStateEntry{
			RegistryPath: registryPath,
			ValueName:    valueName,
			ValueData:    hex.EncodeToString(value),
			ValueType:    registryTypeToString(valueType),
		}, true
	}

	return RegistryStateEntry{}, false
}

func registryTypeToString(valueType uint32) string {
	switch valueType {
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
		return fmt.Sprintf("REG_%d", valueType)
	}
}
