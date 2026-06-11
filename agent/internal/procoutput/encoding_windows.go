//go:build windows

package procoutput

import "golang.org/x/sys/windows"

// GetOEMCP is not exposed by golang.org/x/sys/windows, so bind it directly from
// kernel32. Signature: UINT GetOEMCP(void) — returns the OEM code page and
// cannot fail (no error out-param), so Call's error return is ignored.
var procGetOEMCP = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetOEMCP")

func getOEMCP() uint32 {
	r, _, _ := procGetOEMCP.Call()
	return uint32(r)
}

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
	if cp := getOEMCP(); cp != 0 && cp != 65001 {
		return cp, true
	}
	return 0, false
}
