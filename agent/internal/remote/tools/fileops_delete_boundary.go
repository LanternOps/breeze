package tools

import (
	"runtime"
	"strings"
)

// isRecursiveDeleteBoundary reports whether cleanPath sits at — or immediately
// below — the root of its filesystem, and so must not be recursively deleted.
//
// #3932: this replaces `strings.Split(strings.TrimPrefix(p, "/"), "/")` plus a
// `len(parts) <= 1` test. That form is correct only for POSIX paths:
// filepath.Clean returns BACKSLASH-separated paths on Windows, so every Windows
// path collapsed into a single component and the guard denied every recursive
// delete the file browser issued, however deeply nested — the reporter's
// `C:\ProgramData\SOTIKS\BreezePilot\delete-test.txt` among them. The failure
// mode being fixed is a false DENY, so nothing here may turn into a false ALLOW
// near a root.
//
// The boundary is expressed as depth below the filesystem root rather than as a
// raw separator count, so a volume specifier (`C:`), a UNC share root
// (`\\server\share`) and a POSIX `/` all contribute zero depth. Depth <= 1 is
// refused, which is exactly the existing POSIX rule (`/` and `/home` refused,
// `/home/user` allowed) carried across to Windows: `C:\`, `C:` and `C:\Windows`
// are refused, `C:\Temp\build` is allowed.
//
// Refusing depth 1 and not only depth 0 is deliberate. deniedSystemPaths
// (fileops.go) is entirely POSIX — it has no Windows entries at all — so on
// Windows this guard is the ONLY thing between a recursive delete and
// `C:\Windows`, `C:\Users` or `C:\ProgramData`. Refusing only the bare volume
// root would have made all three recursively deletable while `/usr` stayed
// refused on Linux.
func isRecursiveDeleteBoundary(cleanPath string) bool {
	return isRecursiveDeleteBoundaryFor(cleanPath, runtime.GOOS == "windows")
}

// isRecursiveDeleteBoundaryFor is isRecursiveDeleteBoundary with the platform
// path grammar passed in, so both grammars are testable from any host.
func isRecursiveDeleteBoundaryFor(cleanPath string, windows bool) bool {
	rest := cleanPath

	// Number of leading components that name the volume rather than a directory
	// inside it (a UNC host + share pair).
	volumeComponents := 0

	if windows {
		if prefixLen, isDevice := deviceNamespacePrefixLen(rest); isDevice {
			rest = rest[prefixLen:]
			switch {
			case hasUNCMarker(rest):
				// \\?\UNC\server\share\... — the host and share are the volume.
				rest = rest[4:]
				volumeComponents = 2
			case hasDriveSpecifier(rest):
				// \\?\C:\... — an ordinary drive behind the long-path prefix.
				rest = rest[2:]
			default:
				// Any other device-namespace path (\\?\GLOBALROOT\Device\...,
				// \\?\Volume{GUID}\..., \\.\PhysicalDrive0, \??\...) names an
				// object-manager entry whose components are namespace nodes, not
				// filesystem depth: counting them would make a volume-root-adjacent
				// target look arbitrarily deep. Fail closed — the file browser has
				// no reason to address a volume this way.
				return true
			}
		} else if hasDriveSpecifier(rest) {
			// C:\..., C:/... and the drive-relative C:foo.
			rest = rest[2:]
		} else if len(rest) >= 2 && isPathSeparator(rest[0], true) && isPathSeparator(rest[1], true) {
			// \\server\share\... — the host and share are the volume.
			volumeComponents = 2
		}

		// Past the volume specifier a colon is not legal in a Windows path
		// component, and it is not a separator either — so it would survive as a
		// component of its own and inflate the depth. "C::\Windows" would
		// otherwise strip "C:", split ":\Windows" into [":", "Windows"] and read
		// as depth 2, allowing a recursive delete of a path one stray colon away
		// from a volume-root child. Alternate-data-stream suffixes
		// ("C:\Temp\x:stream") land here too and are equally refused: the file
		// browser has no reason to address either shape.
		if strings.ContainsRune(rest, ':') {
			return true
		}
	}

	depth := 0
	for _, component := range splitPathComponents(rest, windows) {
		// filepath.Clean only leaves ".." at the head of a relative path, but a
		// relative path's real depth depends on the agent's working directory:
		// `..\Windows` counts as depth 2 while resolving to a volume root child.
		// Unknowable depth is refused, not guessed.
		if component == ".." {
			return true
		}
		if volumeComponents > 0 {
			volumeComponents--
			continue
		}
		depth++
	}

	return depth <= 1
}

// splitPathComponents splits on the separators meaningful to the target
// platform, dropping empty components (leading roots, doubled separators).
func splitPathComponents(p string, windows bool) []string {
	return strings.FieldsFunc(p, func(r rune) bool {
		return r < 0x80 && isPathSeparator(byte(r), windows)
	})
}

// isPathSeparator reports whether b separates path components on the target
// platform. Windows accepts both forms; on POSIX a backslash is an ordinary,
// legal character in a file name, so treating it as a separator there would
// OVER-count depth and turn "/data\evil" — one top-level directory whose name
// contains a backslash, refused today — into an allowed recursive delete.
func isPathSeparator(b byte, windows bool) bool {
	return b == '/' || (windows && b == '\\')
}

// deviceNamespacePrefixLen matches the Windows device / NT object-manager path
// prefixes `\\?\`, `\\.\` and `\??\` (in either separator form), returning the
// length of the prefix.
func deviceNamespacePrefixLen(p string) (int, bool) {
	if len(p) < 4 || !isPathSeparator(p[0], true) || !isPathSeparator(p[3], true) {
		return 0, false
	}
	switch {
	case isPathSeparator(p[1], true) && (p[2] == '?' || p[2] == '.'):
		return 4, true // \\?\ or \\.\
	case p[1] == '?' && p[2] == '?':
		return 4, true // \??\
	}
	return 0, false
}

// hasDriveSpecifier reports whether p starts with a drive letter followed by a
// colon ("C:", "C:\foo", the drive-relative "C:foo").
func hasDriveSpecifier(p string) bool {
	if len(p) < 2 || p[1] != ':' {
		return false
	}
	c := p[0]
	return ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z')
}

// hasUNCMarker reports whether p starts with the `UNC\` marker used inside a
// device-namespace path (`\\?\UNC\server\share`). Windows matches it
// case-insensitively.
func hasUNCMarker(p string) bool {
	return len(p) >= 4 && strings.EqualFold(p[:3], "UNC") && isPathSeparator(p[3], true)
}
