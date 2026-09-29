// Package hosttool resolves a Windows tool to the host's own binary, by
// absolute path in the System32 directory under the Windows directory the
// OS reports: never resolved through PATH, never taken from the SystemRoot
// environment variable, and never a binary from a restored volume or tree.
// The Hyper-V restores (powershell.exe, bcdboot.exe) and bare-metal
// recovery's driver step (pnputil.exe) resolve their tools here.
//
// The rebuild engine keeps its own copy of this rule (rebuild/win_boot.go
// hostSystemTool), with a test seam its fixtures pin.
package hosttool

import "strings"

// windowsDir is SystemTool's seam: the host's Windows directory as the OS
// reports it (GetSystemWindowsDirectoryW in hosttool_windows.go), "" off
// Windows (hosttool_other.go).
var windowsDir func() string

// SystemTool returns the absolute path of name in the host's own System32,
// e.g. C:\Windows\System32\bcdboot.exe (X:\Windows\... under WinPE). When
// the OS gives no drive-absolute Windows directory it falls back to
// C:\Windows. The path is built with `\` explicitly so it is the same
// Windows path on every test host.
func SystemTool(name string) string {
	root := strings.TrimRight(windowsDir(), `\/`)
	if !isDriveAbsolute(root) {
		root = `C:\Windows`
	}
	return root + `\System32\` + name
}

// isDriveAbsolute reports whether p is `<letter>:\...` (or `/`), with
// something after the root.
func isDriveAbsolute(p string) bool {
	if len(p) < 4 || p[1] != ':' || (p[2] != '\\' && p[2] != '/') {
		return false
	}
	c := p[0] | 0x20 // ASCII lower-case
	return c >= 'a' && c <= 'z'
}
