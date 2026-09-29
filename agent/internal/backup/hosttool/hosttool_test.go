package hosttool

import "testing"

// SystemTool resolves a tool by absolute path in the host's own System32,
// under the Windows directory the OS reports, falling back to C:\Windows
// when that answer is empty or not drive-absolute.
func TestSystemTool_ResolvesAbsoluteSystem32Path(t *testing.T) {
	orig := windowsDir
	t.Cleanup(func() { windowsDir = orig })

	for _, tc := range []struct{ dir, want string }{
		{"", `C:\Windows\System32\bcdboot.exe`},
		{`X:\Windows`, `X:\Windows\System32\bcdboot.exe`},
		{`D:\WinNT\`, `D:\WinNT\System32\bcdboot.exe`},
		{`Windows`, `C:\Windows\System32\bcdboot.exe`},
		{`C:`, `C:\Windows\System32\bcdboot.exe`},
		{`\\server\share\Windows`, `C:\Windows\System32\bcdboot.exe`},
	} {
		windowsDir = func() string { return tc.dir }
		if got := SystemTool("bcdboot.exe"); got != tc.want {
			t.Errorf("windowsDir()=%q: got %q, want %q", tc.dir, got, tc.want)
		}
	}
}

// The path comes only from the Windows directory the OS reports, never from
// the SystemRoot environment variable, which any process environment can set.
func TestSystemTool_IgnoresSystemRootEnvVar(t *testing.T) {
	orig := windowsDir
	t.Cleanup(func() { windowsDir = orig })

	t.Setenv("SystemRoot", `D:\elsewhere`)
	windowsDir = func() string { return `X:\Windows` }

	if got, want := SystemTool("pnputil.exe"), `X:\Windows\System32\pnputil.exe`; got != want {
		t.Errorf("SystemRoot leaked into resolution: got %q, want %q", got, want)
	}
}
