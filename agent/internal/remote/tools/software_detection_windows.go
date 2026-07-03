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

// errNoUsableFileVersion marks a file that exists but from which no comparable
// version can be read (no version resource, a zeroed fixed-version block, or an
// unparseable string version). It drives evaluateFileVersionRule to report the
// clause as undeterminable (supported=false) so the caller falls back to
// exit-code behavior — never a false "not installed".
var errNoUsableFileVersion = errors.New("file has no usable version resource")

// evaluateFileVersionRule reads a file's version on Windows and compares it to
// the rule's target version with the rule's operator.
//
// Returns (matched, supported):
//   - file genuinely absent               → (false, true)  clean negative
//   - present but no comparable version,
//     or an access/IO error, or an
//     unparseable/unknown operator         → (false, false) undeterminable
//   - version read & compared              → (compare result, true)
//
// The undeterminable cases fall back to exit-code behavior rather than
// mis-reporting an installed package as absent (#2089 / #2088 contract).
func evaluateFileVersionRule(rule DetectionRule) (matched bool, supported bool) {
	actual, found, err := readFileVersion(rule.Path)
	if err != nil {
		slog.Warn("detection: cannot determine file version", "path", rule.Path, "error", err.Error())
		return false, false
	}
	if !found {
		// File genuinely absent → clean negative.
		return false, true
	}
	return evaluateFileVersionComparison(actual, rule.Operator, rule.Version)
}

// readFileVersion returns a file's version string from its Win32 version
// resource.
//
//   - found=false, err=nil  → the file does not exist (a clean negative).
//   - err!=nil              → the file exists but yields no comparable version
//     (errNoUsableFileVersion), or an access/IO error — presence/version is
//     undeterminable.
//   - found=true            → version is the dotted numeric version to compare.
//
// It prefers the localized StringFileInfo "FileVersion" string: many toolchains
// (Go, Rust, Electron, MSVC) and installers populate only the string table and
// leave the binary VS_FIXEDFILEINFO block zeroed. It falls back to that fixed
// block when the string is absent or unparseable, and reports a zeroed fixed
// block as undeterminable (it is indistinguishable from "not populated").
func readFileVersion(path string) (version string, found bool, err error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", false, nil
	}

	var zeroHandle windows.Handle
	size, err := windows.GetFileVersionInfoSize(path, &zeroHandle)
	if err != nil {
		if fileNotFound(err) {
			return "", false, nil // file genuinely absent → clean negative
		}
		if noVersionResource(err) {
			return "", false, errNoUsableFileVersion // present but unversioned → undeterminable
		}
		return "", false, err // ACCESS_DENIED / unexpected → undeterminable
	}
	if size == 0 {
		return "", false, errNoUsableFileVersion
	}

	buf := make([]byte, size)
	if err := windows.GetFileVersionInfo(path, 0, size, unsafe.Pointer(&buf[0])); err != nil {
		if fileNotFound(err) {
			return "", false, nil
		}
		if noVersionResource(err) {
			return "", false, errNoUsableFileVersion
		}
		return "", false, err
	}

	// Prefer the StringFileInfo "FileVersion" string.
	if s, ok := stringTableFileVersion(buf); ok {
		normalized := normalizeVersionString(s)
		if _, perr := parseFileVersion(normalized); perr == nil {
			return normalized, true, nil
		}
	}

	// Fall back to the binary fixed-version quad.
	var fixed *windows.VS_FIXEDFILEINFO
	var fixedLen uint32
	if qerr := windows.VerQueryValue(unsafe.Pointer(&buf[0]), `\`, unsafe.Pointer(&fixed), &fixedLen); qerr != nil || fixed == nil || fixedLen == 0 {
		return "", false, errNoUsableFileVersion
	}

	// Each 32-bit word packs two 16-bit version components.
	major := (fixed.FileVersionMS >> 16) & 0xffff
	minor := fixed.FileVersionMS & 0xffff
	build := (fixed.FileVersionLS >> 16) & 0xffff
	revision := fixed.FileVersionLS & 0xffff
	if major == 0 && minor == 0 && build == 0 && revision == 0 {
		// A zeroed fixed block is indistinguishable from "not populated"; with no
		// usable string version we must not report an authoritative negative.
		return "", false, errNoUsableFileVersion
	}
	return fmt.Sprintf("%d.%d.%d.%d", major, minor, build, revision), true, nil
}

// fileNotFound reports whether a version-info API error means the file itself is
// absent (a clean negative), as opposed to present-but-unreadable.
func fileNotFound(err error) bool {
	return errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND)
}

// noVersionResource reports whether the error means the file exists but carries
// no version resource — undeterminable, not a clean negative.
func noVersionResource(err error) bool {
	return errors.Is(err, windows.ERROR_RESOURCE_TYPE_NOT_FOUND) ||
		errors.Is(err, windows.ERROR_RESOURCE_DATA_NOT_FOUND)
}

// stringFileInfoLangCodepages are the common StringFileInfo language/codepage
// blocks used by the toolchains whose binaries typically leave the fixed-version
// block zeroed (Go, Rust, Electron, MSVC). We query these directly rather than
// walking \VarFileInfo\Translation, avoiding pointer arithmetic over the block.
var stringFileInfoLangCodepages = []string{
	"040904b0", // US English, Unicode
	"040904e4", // US English, Windows Multilingual
	"000004b0", // language-neutral, Unicode
	"040004b0", // process-default language, Unicode
	"04090000", // US English, 7-bit ASCII
}

// stringTableFileVersion extracts the StringFileInfo "FileVersion" value from a
// version-info block, trying the common language/codepage blocks. The returned
// value may be free-form; the caller decides whether it parses as a version.
func stringTableFileVersion(block []byte) (string, bool) {
	for _, lc := range stringFileInfoLangCodepages {
		subBlock := `\StringFileInfo\` + lc + `\FileVersion`
		var valPtr unsafe.Pointer
		var valLen uint32
		if err := windows.VerQueryValue(unsafe.Pointer(&block[0]), subBlock, unsafe.Pointer(&valPtr), &valLen); err != nil || valPtr == nil || valLen == 0 {
			continue
		}
		s := strings.TrimSpace(windows.UTF16PtrToString((*uint16)(valPtr)))
		if s != "" {
			return s, true
		}
	}
	return "", false
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
