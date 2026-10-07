package tools

import "strings"

// Windows accepts several spellings for one directory, and the deny-list in
// isSensitiveReadPath is a string match, so every spelling has to be folded
// onto the one the list is written in. These rules mirror the server-side
// normaliser (apps/api/src/services/devicePathForms.ts) so the agent and the
// API agree on which spellings reach the same place:
//
//   - device-namespace and administrative-share prefixes (\\?\C:\x,
//     \\.\C:\x, \\?\UNC\host\C$\x, \\host\C$\x) reach the drive path;
//   - Win32 name resolution drops a trailing run of dots and spaces from each
//     component and reads "name:stream" as the object "name";
//   - the compatibility junctions every install ships with ("Documents and
//     Settings", "All Users", "ProgramData\Application Data", ...) reach
//     another directory under a different name.
//
// 8.3 short names cannot be folded from the string alone; they, and any
// junction or symlink an operator created, are handled by asking Windows for
// the final path of an open handle (fileops_final_windows.go).

// windowsMachineLinks are the machine-wide compatibility links, as c:-form
// prefixes anchored at a component boundary, and where each one leads.
var windowsMachineLinks = []struct{ from, to string }{
	{"c:/documents and settings", "c:/users"},
	{"c:/users/all users", "c:/programdata"},
	{"c:/users/default user", "c:/users/default"},
	{"c:/programdata/application data", "c:/programdata"},
	// Seen by 32-bit processes only; resolves to the real System32.
	{"c:/windows/sysnative", "c:/windows/system32"},
}

// windowsProfileLinks are the per-profile compatibility links under
// c:/users/<name>/, and where each one leads within the same profile.
var windowsProfileLinks = []struct{ from, to string }{
	{"application data", "appdata/roaming"},
	{"local settings", "appdata/local"},
	{"cookies", "appdata/roaming/microsoft/windows/cookies"},
	{"nethood", "appdata/roaming/microsoft/windows/nethood"},
	{"printhood", "appdata/roaming/microsoft/windows/printhood"},
	{"recent", "appdata/roaming/microsoft/windows/recent"},
	{"sendto", "appdata/roaming/microsoft/windows/sendto"},
	{"start menu", "appdata/roaming/microsoft/windows/start menu"},
	{"templates", "appdata/roaming/microsoft/windows/templates"},
}

// maxLinkRounds bounds link resolution. Every rule either shortens the path or
// moves it under a target no rule matches again, so real paths settle in a
// round or two; the cap only guards against a future rule that loops.
const maxLinkRounds = 16

// hasComponentPrefix reports whether p is prefix or lies beneath it.
func hasComponentPrefix(p, prefix string) bool {
	return p == prefix || strings.HasPrefix(p, prefix+"/")
}

func hasDrivePrefix(norm string) bool {
	return len(norm) >= 3 && norm[1] == ':' && norm[2] == '/' &&
		norm[0] >= 'a' && norm[0] <= 'z'
}

// stripWindowsNamespacePrefix rewrites a device-namespace path or an
// administrative-share path to the drive path it reaches. norm is lowercased
// and forward-slashed. Anything else is returned unchanged.
func stripWindowsNamespacePrefix(norm string) string {
	if strings.HasPrefix(norm, "//?/") || strings.HasPrefix(norm, "//./") {
		rest := norm[4:]
		if strings.HasPrefix(rest, "unc/") {
			norm = "//" + rest[4:]
		} else {
			return rest
		}
	}
	// //host/x$/... -> x:/...
	if strings.HasPrefix(norm, "//") {
		parts := strings.SplitN(norm[2:], "/", 3)
		if len(parts) >= 2 && len(parts[1]) == 2 && parts[1][1] == '$' &&
			parts[1][0] >= 'a' && parts[1][0] <= 'z' && parts[0] != "" {
			out := parts[1][:1] + ":/"
			if len(parts) == 3 {
				out += parts[2]
			}
			return out
		}
	}
	return norm
}

// win32Component applies Win32 name resolution to one path component: the
// stream suffix ("name:stream", "name::$DATA") and a trailing run of dots and
// spaces are dropped.
func win32Component(c string) string {
	if i := strings.IndexByte(c, ':'); i >= 0 {
		c = c[:i]
	}
	return strings.TrimRight(c, ". ")
}

// resolveWindowsLinkOnce applies the first matching compatibility link to a
// c:-form path. ok is false when no rule matches.
func resolveWindowsLinkOnce(p string) (string, bool) {
	for _, l := range windowsMachineLinks {
		if hasComponentPrefix(p, l.from) {
			return l.to + p[len(l.from):], true
		}
	}
	const users = "c:/users/"
	if strings.HasPrefix(p, users) {
		rest := p[len(users):]
		slash := strings.IndexByte(rest, '/')
		if slash > 0 {
			profile, tail := rest[:slash], rest[slash+1:]
			for _, l := range windowsProfileLinks {
				if hasComponentPrefix(tail, l.from) {
					return users + profile + "/" + l.to + tail[len(l.from):], true
				}
			}
		}
	}
	return "", false
}

// windowsContainmentForms returns the Windows spellings that norm (lowercased,
// forward-slashed, absolute) can resolve to, including norm itself. settled is
// false when link resolution did not converge; the caller must then treat the
// path as matching every rule.
func windowsContainmentForms(norm string) (forms []string, settled bool) {
	forms = []string{norm}
	p := stripWindowsNamespacePrefix(norm)
	if p != norm {
		forms = append(forms, p)
	}
	if !hasDrivePrefix(p) {
		return forms, true
	}
	components := strings.Split(p[3:], "/")
	for i, c := range components {
		components[i] = win32Component(c)
	}
	folded := p[:3] + strings.Join(components, "/")
	if folded != p {
		forms = append(forms, folded)
	}
	// The link rules are written against C:, but a Windows install or a
	// profile folder is not guaranteed to live there, so apply them to any
	// drive. The deny-list fragments themselves carry no drive letter.
	current := "c:" + folded[2:]
	for round := 0; round < maxLinkRounds; round++ {
		next, ok := resolveWindowsLinkOnce(current)
		if !ok {
			return forms, true
		}
		current = next
		forms = append(forms, current)
	}
	return forms, false
}
