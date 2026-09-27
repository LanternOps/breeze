package tools

import "strings"

// deniedRegistryHiveRoots maps a canonicalized hive name to the top-level
// subkey names under it that hold OS credential material and must never be
// exposed through the registry browser tools, regardless of the caller's
// access decision.
//
// SAM and SECURITY are the registry-backed equivalents of /etc/shadow: SAM
// holds the local account database (password hashes), and SECURITY holds LSA
// policy state including cached domain credentials and the LSA "Secrets"
// store (HKLM\SECURITY\Policy\Secrets, a subkey of SECURITY and so already
// covered by the SECURITY entry below) — DPAPI master keys, service account
// passwords, and other secrets the OS itself protects. This is
// defense-in-depth (it mirrors the file-read deny-list in
// fileops.go): the primary gate is the API re-tiering that requires
// devices.execute for a registry read, but the agent runs as
// root/LocalSystem and must not blindly trust the hive/path it is handed.
var deniedRegistryHiveRoots = map[string]map[string]bool{
	"HKLM": {"sam": true, "security": true},
}

// canonicalRegistryHive normalizes both the short (HKLM) and long
// (HKEY_LOCAL_MACHINE) spellings the API and agent accept to one canonical
// short form.
func canonicalRegistryHive(hive string) string {
	switch strings.ToUpper(strings.TrimSpace(hive)) {
	case "HKLM", "HKEY_LOCAL_MACHINE":
		return "HKLM"
	case "HKCU", "HKEY_CURRENT_USER":
		return "HKCU"
	case "HKCR", "HKEY_CLASSES_ROOT":
		return "HKCR"
	case "HKU", "HKEY_USERS":
		return "HKU"
	case "HKCC", "HKEY_CURRENT_CONFIG":
		return "HKCC"
	default:
		return strings.ToUpper(strings.TrimSpace(hive))
	}
}

// registryPathSegments splits a registry key path into its component names,
// resolving "." and ".." the same way a filesystem path would. The registry
// itself has no ".." semantics, but the caller-supplied path string is not
// otherwise validated against traversal sequences before it reaches here, so
// this collapses them defensively rather than trusting an upstream caller
// always will. Accepts either separator so a path is denied the same way
// regardless of which one the caller used.
func registryPathSegments(path string) []string {
	normalized := strings.ReplaceAll(strings.ToLower(path), "/", "\\")
	raw := strings.Split(normalized, "\\")
	resolved := make([]string, 0, len(raw))
	for _, seg := range raw {
		switch seg {
		case "", ".":
			continue
		case "..":
			if len(resolved) > 0 {
				resolved = resolved[:len(resolved)-1]
			}
		default:
			resolved = append(resolved, seg)
		}
	}
	return resolved
}

// isDeniedRegistryTarget reports whether hive+path targets a credential-store
// registry root (SAM, SECURITY, or any subkey under either — including the
// LSA secrets store).
func isDeniedRegistryTarget(hive, path string) bool {
	roots, ok := deniedRegistryHiveRoots[canonicalRegistryHive(hive)]
	if !ok {
		return false
	}
	segments := registryPathSegments(path)
	if len(segments) == 0 {
		return false
	}
	return roots[segments[0]]
}
