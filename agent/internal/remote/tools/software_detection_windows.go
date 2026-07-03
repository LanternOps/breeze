//go:build windows

package tools

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// registryKeyMissing reports whether an OpenKey error means the key simply does
// not exist (a clean negative) rather than an error we couldn't interpret (e.g.
// ACCESS_DENIED), which must NOT be read as "absent". OpenKey returns the raw
// syscall errno, so this checks the Windows not-found codes directly.
func registryKeyMissing(err error) bool {
	return errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) || errors.Is(err, syscall.ERROR_PATH_NOT_FOUND)
}

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
		// Unknown hive — we can't evaluate, so report unsupported (fall back to
		// exit-code) rather than a false negative.
		slog.Warn("detection: unknown registry hive", "hive", hive)
		return false, false
	}

	key, err := registry.OpenKey(root, rule.Path, registry.QUERY_VALUE|registry.READ)
	if err != nil {
		if registryKeyMissing(err) {
			return false, true // key genuinely absent → clean negative
		}
		// ACCESS_DENIED / unexpected — can't determine presence.
		slog.Warn("detection: cannot open registry key", "hive", hive, "path", rule.Path, "error", err.Error())
		return false, false
	}
	defer key.Close()

	// Key exists; if no value name required we're done.
	if rule.ValueName == "" {
		return true, true
	}

	// Read the value as a string; a wrong-type value falls back to integer.
	strVal, _, err := key.GetStringValue(rule.ValueName)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return false, true // value genuinely absent → clean negative
		}
		// Wrong type (e.g. DWORD) or other — try reading it as an integer.
		intVal, _, intErr := key.GetIntegerValue(rule.ValueName)
		if intErr != nil {
			if errors.Is(intErr, registry.ErrNotExist) {
				return false, true
			}
			// A value type we don't handle (binary/multi-string) or an access
			// error — can't compare it, so report unsupported.
			slog.Warn("detection: cannot read registry value",
				"hive", hive, "path", rule.Path, "value", rule.ValueName, "error", intErr.Error())
			return false, false
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

	sawUndeterminable := false
	for _, path := range paths {
		key, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
		if err == nil {
			key.Close()
			return true, true
		}
		if !registryKeyMissing(err) {
			// Not a clean "not found" — couldn't determine for this path.
			slog.Warn("detection: cannot open MSI uninstall key", "path", path, "error", err.Error())
			sawUndeterminable = true
		}
	}

	if sawUndeterminable {
		// Neither path matched, but at least one couldn't be evaluated — don't
		// claim the product is absent; fall back to exit-code behavior.
		return false, false
	}
	return false, true
}

// evaluateFileVersionRule reads a file's version resource on Windows and
// compares it to the rule's target version with the rule's operator.
//
// Returns (matched, supported). A file that is missing or carries no version
// resource is a clean negative (matched=false, supported=true). An access/IO
// error, or an unparseable/unknown operator, is undeterminable
// (supported=false) so the caller falls back to exit-code behavior rather than
// mis-reporting an installed package as absent (#2089).
func evaluateFileVersionRule(rule DetectionRule) (matched bool, supported bool) {
	actual, found, err := readFileVersion(rule.Path)
	if err != nil {
		slog.Warn("detection: cannot read file version", "path", rule.Path, "error", err.Error())
		return false, false
	}
	if !found {
		// File absent or no version info to compare → clean negative.
		return false, true
	}
	return evaluateFileVersionComparison(actual, rule.Operator, rule.Version)
}

// readFileVersion returns the fixed file version ("major.minor.build.revision")
// from a file's Win32 version resource.
//
//   - found=false, err=nil  → the file does not exist or has no version
//     resource (a clean negative for detection purposes).
//   - err!=nil              → an access/IO error; presence is undeterminable.
func readFileVersion(path string) (version string, found bool, err error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", false, nil
	}

	var zeroHandle windows.Handle
	size, err := windows.GetFileVersionInfoSize(path, &zeroHandle)
	if err != nil {
		if fileVersionInfoMissing(err) {
			return "", false, nil // no version info available → clean negative
		}
		return "", false, err
	}
	if size == 0 {
		return "", false, nil
	}

	buf := make([]byte, size)
	if err := windows.GetFileVersionInfo(path, 0, size, unsafe.Pointer(&buf[0])); err != nil {
		if fileVersionInfoMissing(err) {
			return "", false, nil
		}
		return "", false, err
	}

	var fixed *windows.VS_FIXEDFILEINFO
	var fixedLen uint32
	if err := windows.VerQueryValue(unsafe.Pointer(&buf[0]), `\`, unsafe.Pointer(&fixed), &fixedLen); err != nil {
		if fileVersionInfoMissing(err) {
			return "", false, nil
		}
		return "", false, err
	}
	if fixed == nil || fixedLen == 0 {
		return "", false, nil
	}

	// Each 32-bit word packs two 16-bit version components.
	major := (fixed.FileVersionMS >> 16) & 0xffff
	minor := fixed.FileVersionMS & 0xffff
	build := (fixed.FileVersionLS >> 16) & 0xffff
	revision := fixed.FileVersionLS & 0xffff
	return fmt.Sprintf("%d.%d.%d.%d", major, minor, build, revision), true, nil
}

// fileVersionInfoMissing reports whether a version-info API error means the file
// simply doesn't exist or carries no version resource — a clean negative — as
// opposed to an error we can't interpret (e.g. ACCESS_DENIED) which must NOT be
// read as "absent".
func fileVersionInfoMissing(err error) bool {
	return errors.Is(err, windows.ERROR_FILE_NOT_FOUND) ||
		errors.Is(err, windows.ERROR_PATH_NOT_FOUND) ||
		errors.Is(err, windows.ERROR_RESOURCE_TYPE_NOT_FOUND) ||
		errors.Is(err, windows.ERROR_RESOURCE_DATA_NOT_FOUND)
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
