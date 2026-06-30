//go:build windows

package tools

import (
	"fmt"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// evaluateRegistryRule checks whether a registry key (and optionally a value
// and its data) exists on Windows.
//
// Returns (matched, supported=true) always on Windows.
func evaluateRegistryRule(rule DetectionRule) (matched bool, supported bool) {
	hive := rule.Hive
	if hive == "" {
		hive = "HKLM"
	}

	root, err := resolveDetectionRegistryRoot(hive)
	if err != nil {
		// Unknown hive — treat as not matched but still supported.
		return false, true
	}

	key, err := registry.OpenKey(root, rule.Path, registry.QUERY_VALUE|registry.READ)
	if err != nil {
		// Key absent.
		return false, true
	}
	defer key.Close()

	// Key exists; if no value name required we're done.
	if rule.ValueName == "" {
		return true, true
	}

	// Read the value as a string; fall back to integer.
	strVal, _, err := key.GetStringValue(rule.ValueName)
	if err != nil {
		// Try integer.
		intVal, _, intErr := key.GetIntegerValue(rule.ValueName)
		if intErr != nil {
			// Value absent.
			return false, true
		}
		strVal = fmt.Sprintf("%d", intVal)
	}

	// Value exists; if no data match required we're done.
	if rule.ValueData == "" {
		return true, true
	}

	// Case-insensitive exact match.
	return strings.EqualFold(strVal, rule.ValueData), true
}

// evaluateMsiProductCodeRule checks whether a product code (MSI GUID) is
// present in the Windows uninstall registry.
//
// Returns (matched, supported=true) always on Windows.
func evaluateMsiProductCodeRule(rule DetectionRule) (matched bool, supported bool) {
	code := normalizeMsiProductCode(rule.ProductCode)
	if code == "" {
		return false, true
	}

	// Check both the native and WOW6432Node uninstall paths.
	paths := []string{
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\` + code,
		`SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\` + code,
	}

	for _, path := range paths {
		key, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
		if err == nil {
			key.Close()
			return true, true
		}
	}

	return false, true
}

// normalizeMsiProductCode converts a product-code GUID to the uppercase
// braced form required by the uninstall registry key name.
// Returns "" for empty or obviously invalid input.
func normalizeMsiProductCode(code string) string {
	code = strings.TrimSpace(code)
	if code == "" {
		return ""
	}
	// Strip braces if present, then re-add in uppercase.
	code = strings.TrimPrefix(code, "{")
	code = strings.TrimSuffix(code, "}")
	code = strings.ToUpper(code)
	if code == "" {
		return ""
	}
	return "{" + code + "}"
}

// resolveDetectionRegistryRoot maps a hive abbreviation to a registry.Key root.
// Mirrors the logic in registry_windows.go's resolveRegistryRoot but is kept
// separate to avoid coupling the detection logic to the registry tool.
func resolveDetectionRegistryRoot(hive string) (registry.Key, error) {
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
