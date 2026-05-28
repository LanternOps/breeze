//go:build windows

package procoutput

import "golang.org/x/sys/windows"

func decodeWindowsConsoleBytes(b []byte) (string, bool) {
	cp, ok := activeConsoleCodePage()
	if !ok {
		return "", false
	}
	return decodeFromWindowsCodePage(b, cp)
}

// activeConsoleCodePage returns the code page used for captured console/process
// output. GetConsoleOutputCP reflects the active console; when unavailable (e.g.
// piped capture with no console), GetOEMCP is used as a fallback.
func activeConsoleCodePage() (uint32, bool) {
	if cp, err := windows.GetConsoleOutputCP(); err == nil && cp != 0 && cp != 65001 {
		return cp, true
	}
	if cp, err := windows.GetOEMCP(); err == nil && cp != 0 && cp != 65001 {
		return cp, true
	}
	return 0, false
}
