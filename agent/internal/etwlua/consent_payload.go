package etwlua

import "strings"

// parseConsentPayload extracts the target executable path and command line
// from the raw UserData bytes of a Microsoft-Windows-LUA event 15028 (the
// elevation-request detail raised when AppInfo shows a UAC consent on
// Windows). The payload is a header (request id, session token, a
// string-offset table) followed by UTF-16LE strings: the full target path
// (emitted twice), then the quoted command line. The offset table layout is
// version-specific, so instead of parsing it we scan the blob for UTF-16
// strings and select by shape — the bare drive-rooted path is the target,
// and the quoted string is the command line.
//
// This is pure (no syscalls) so it can be unit-tested off-Windows against
// captured fixtures; the Windows-only caller wraps it with user/hash
// resolution. Returns empty targetPath when no path-like string is present.
func parseConsentPayload(raw []byte) (targetPath, commandLine string) {
	for _, str := range utf16Strings(raw, 4) {
		if commandLine == "" && strings.HasPrefix(str, `"`) {
			commandLine = strings.TrimRight(str, " ")
		}
		if targetPath == "" && looksLikeWindowsPath(str) {
			targetPath = str
		}
	}
	return targetPath, commandLine
}

// looksLikeWindowsPath reports whether s is a drive-rooted path like
// `C:\...` (and not a quoted command line).
func looksLikeWindowsPath(s string) bool {
	if len(s) < 4 || s[0] == '"' {
		return false
	}
	c := s[0]
	return ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) && s[1] == ':' && s[2] == '\\'
}

// utf16Strings scans b for runs of printable UTF-16LE characters (each run
// implicitly terminated by a non-printable unit such as the NUL separator),
// returning those at least minLen runes long.
func utf16Strings(b []byte, minLen int) []string {
	var out []string
	var cur []uint16
	flush := func() {
		if len(cur) >= minLen {
			r := make([]rune, 0, len(cur))
			for _, u := range cur {
				r = append(r, rune(u))
			}
			out = append(out, string(r))
		}
		cur = cur[:0]
	}
	for i := 0; i+1 < len(b); i += 2 {
		u := uint16(b[i]) | uint16(b[i+1])<<8
		if u >= 0x20 && u < 0xD800 { // printable BMP, excludes controls/surrogates
			cur = append(cur, u)
		} else {
			flush()
		}
	}
	flush()
	return out
}
