package etwlua

import (
	"encoding/binary"
	"encoding/hex"
	"testing"
)

// realLUA15028BreezeAgent is the raw UserData of a Microsoft-Windows-LUA
// event 15028, captured live on Windows 11 (build 26200) when a UAC consent
// was raised for `breeze-agent.exe version`. Used as a ground-truth fixture
// so the parser is exercised in CI (which runs on Linux and can't compile
// the Windows ETW subscriber).
const realLUA15028BreezeAgent = "e201000000000000020000000000000000000000000000000c0200000000000006000000010000001002000000000000960000001ddaba324d32436f6d57364b4f303230542b724d7478504448512e300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000078e077b0ce0000001005000000000000f8000000000000003e010000000000008401000000000000e001000000000000749b00000000000043003a005c0062007200650065007a0065002d00700061006d0074006500730074005c0062007200650065007a0065002d006100670065006e0074002e00650078006500000043003a005c0062007200650065007a0065002d00700061006d0074006500730074005c0062007200650065007a0065002d006100670065006e0074002e006500780065000000220043003a005c0062007200650065007a0065002d00700061006d0074006500730074005c0062007200650065007a0065002d006100670065006e0074002e0065007800650022002000760065007200730069006f006e00200000000000"

func utf16Payload(strs ...string) []byte {
	var b []byte
	for _, s := range strs {
		for _, r := range s {
			b = binary.LittleEndian.AppendUint16(b, uint16(r))
		}
		b = append(b, 0, 0) // UTF-16 NUL separator
	}
	return b
}

func TestParseConsentPayload(t *testing.T) {
	realBytes, err := hex.DecodeString(realLUA15028BreezeAgent)
	if err != nil {
		t.Fatalf("decode fixture: %v", err)
	}

	tests := []struct {
		name        string
		raw         []byte
		wantPath    string
		wantCmdLine string
	}{
		{
			name:        "real Win11 15028 (with args)",
			raw:         realBytes,
			wantPath:    `C:\breeze-pamtest\breeze-agent.exe`,
			wantCmdLine: `"C:\breeze-pamtest\breeze-agent.exe" version`,
		},
		{
			name:        "synthetic no-args (trailing space trimmed)",
			raw:         utf16Payload(`C:\Windows\System32\notepad.exe`, `C:\Windows\System32\notepad.exe`, `"C:\Windows\System32\notepad.exe" `),
			wantPath:    `C:\Windows\System32\notepad.exe`,
			wantCmdLine: `"C:\Windows\System32\notepad.exe"`,
		},
		{
			name:        "lowercase drive letter",
			raw:         utf16Payload(`d:\tools\app.exe`),
			wantPath:    `d:\tools\app.exe`,
			wantCmdLine: "",
		},
		{
			name:        "no path-like string yields empty",
			raw:         utf16Payload("ConsentUI", "some token text"),
			wantPath:    "",
			wantCmdLine: "",
		},
		{
			name:        "empty input",
			raw:         nil,
			wantPath:    "",
			wantCmdLine: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotPath, gotCmd := parseConsentPayload(tc.raw)
			if gotPath != tc.wantPath {
				t.Errorf("path = %q, want %q", gotPath, tc.wantPath)
			}
			if gotCmd != tc.wantCmdLine {
				t.Errorf("cmdline = %q, want %q", gotCmd, tc.wantCmdLine)
			}
		})
	}
}

func TestLooksLikeWindowsPath(t *testing.T) {
	tests := []struct {
		s    string
		want bool
	}{
		{`C:\Windows\notepad.exe`, true},
		{`z:\x`, true},
		{`"C:\quoted\path.exe"`, false}, // quoted = command line, not the bare path
		{`\\server\share\file`, false},  // UNC is not drive-rooted
		{`notepad.exe`, false},
		{`C:`, false}, // too short
		{``, false},
	}
	for _, tc := range tests {
		if got := looksLikeWindowsPath(tc.s); got != tc.want {
			t.Errorf("looksLikeWindowsPath(%q) = %v, want %v", tc.s, got, tc.want)
		}
	}
}
