package executor

import (
	"strings"
	"testing"
)

// AI-generated PowerShell containing typographic Unicode (curly quotes,
// em-dashes) parses fine as UTF-8 but Windows PowerShell 5.1 decodes a
// BOM-less .ps1 as ANSI, producing cascading "Unexpected token" /
// "missing terminator" parse errors. WriteScriptFile must stamp a UTF-8 BOM
// on .ps1 files — and only .ps1 files (a BOM hides the shebang from bash and
// runs as a garbage first command; cmd feeds it to the first command).
func TestWriteScriptFileUTF8BOM(t *testing.T) {
	tests := []struct {
		name       string
		scriptType string
		content    string
		wantBOM    bool
	}{
		{"powershell gets BOM", ScriptTypePowerShell, "Write-Host \"done (“ok”)\"\r\n", true},
		{"powershell ascii gets BOM", ScriptTypePowerShell, "Write-Host 'plain'\r\n", true},
		{"powershell existing BOM not doubled", ScriptTypePowerShell, utf8BOM + "Write-Host 'x'\r\n", true},
		{"powershell LF content gets BOM", ScriptTypePowerShell, "Write-Host 'lf'\n", true},
		{"bash no BOM", ScriptTypeBash, "#!/bin/bash\necho hi\n", false},
		{"python no BOM", ScriptTypePython, "print('hi')\n", false},
		{"cmd no BOM", ScriptTypeCMD, "@echo off\r\necho hi\r\n", false},
		// #3581: a script saved from a Windows editor arrives with a BOM. For
		// bash the BOM hides the shebang and runs as a garbage first command,
		// so it is stripped (the mirror image of the .ps1 BOM-add).
		{"bash leading BOM stripped", ScriptTypeBash, utf8BOM + "#!/bin/bash\necho hi\n", false},
		{"bash leading BOM stripped with CRLF", ScriptTypeBash, utf8BOM + "#!/bin/bash\r\necho hi\r\n", false},
		{"python leading BOM stripped", ScriptTypePython, utf8BOM + "print('hi')\n", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path, err := WriteScriptFile(tt.content, tt.scriptType)
			if err != nil {
				t.Fatalf("WriteScriptFile: %v", err)
			}
			defer CleanupScript(path)
			got := readScript(t, path)
			if hasBOM := strings.HasPrefix(got, utf8BOM); hasBOM != tt.wantBOM {
				t.Fatalf("BOM presence = %v, want %v (content %q)", hasBOM, tt.wantBOM, got)
			}
			if strings.HasPrefix(got, utf8BOM+utf8BOM) {
				t.Fatalf("BOM doubled: %q", got)
			}
			// Original content must survive intact after the optional BOM
			// (bash/python content is additionally CRLF-normalized).
			want := strings.TrimPrefix(tt.content, utf8BOM)
			if tt.scriptType == ScriptTypeBash || tt.scriptType == ScriptTypePython {
				want = strings.ReplaceAll(want, "\r\n", "\n")
			}
			if !strings.HasSuffix(got, want) {
				t.Fatalf("content mangled: %q", got)
			}
			if tt.scriptType == ScriptTypeBash && !strings.HasPrefix(got, "#!") {
				t.Fatalf("bash shebang not first bytes: %q", got)
			}
		})
	}
}
