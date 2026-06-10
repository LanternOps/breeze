package executor

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

// #1184: user-created bash scripts with if/elif blocks fail when the content
// carries CRLF line endings (browser-authored on Windows). bash is invoked
// explicitly on the temp file, so `then\r` / `elif\r` are syntax errors.
// WriteScriptFile must normalize EOLs for unix-interpreted script types and
// leave Windows-native types (powershell, cmd) untouched.

const crlfBashScript = "#!/bin/bash\r\n" +
	"if command -v apt &> /dev/null; then\r\n" +
	"    echo \"apt found\"\r\n" +
	"elif command -v dnf &> /dev/null; then\r\n" +
	"    echo \"dnf found\"\r\n" +
	"else\r\n" +
	"    echo \"unknown\"\r\n" +
	"fi\r\n"

func readScript(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read script file: %v", err)
	}
	return string(b)
}

func TestWriteScriptFileNormalizesEOLs(t *testing.T) {
	tests := []struct {
		name       string
		scriptType string
		content    string
		wantCR     bool
	}{
		{"bash CRLF stripped", ScriptTypeBash, crlfBashScript, false},
		{"bash lone CR stripped", ScriptTypeBash, "#!/bin/bash\rif true; then\recho hi\rfi\r", false},
		{"python CRLF stripped", ScriptTypePython, "import sys\r\nprint(\"hi\")\r\n", false},
		{"powershell CRLF preserved", ScriptTypePowerShell, "Write-Host 'a'\r\nWrite-Host 'b'\r\n", true},
		{"cmd CRLF preserved", ScriptTypeCMD, "@echo off\r\necho hi\r\n", true},
		{"bash LF unchanged", ScriptTypeBash, "#!/bin/bash\necho hi\n", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path, err := WriteScriptFile(tt.content, tt.scriptType)
			if err != nil {
				t.Fatalf("WriteScriptFile: %v", err)
			}
			defer CleanupScript(path)
			got := readScript(t, path)
			hasCR := strings.Contains(got, "\r")
			if hasCR != tt.wantCR {
				t.Fatalf("CR presence = %v, want %v (content %q)", hasCR, tt.wantCR, got)
			}
			// Normalization must not lose any lines.
			wantLines := strings.Count(strings.ReplaceAll(tt.content, "\r\n", "\n"), "\n")
			gotLines := strings.Count(strings.ReplaceAll(got, "\r\n", "\n"), "\n")
			if gotLines < wantLines {
				t.Fatalf("line count shrank: got %d want >= %d", gotLines, wantLines)
			}
		})
	}
}

// End-to-end repro from #1184: the exact reported script, with CRLF, must
// now execute and produce stdout + exit 0 on unix.
func TestExecuteCRLFBashIfElif(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash execution path; unix only")
	}
	if _, err := os.Stat("/bin/bash"); err != nil {
		t.Skip("/bin/bash not available")
	}
	e := New(nil)
	res, err := e.Execute(ScriptExecution{
		ID:         "crlf-1184",
		Script:     crlfBashScript,
		ScriptType: ScriptTypeBash,
		Timeout:    30,
	})
	if err != nil {
		t.Fatalf("Execute: %v (error=%q stderr=%q)", err, res.Error, res.Stderr)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit=%d want 0; stderr=%q", res.ExitCode, res.Stderr)
	}
	out := strings.TrimSpace(res.Stdout)
	if out != "apt found" && out != "dnf found" && out != "unknown" {
		t.Fatalf("unexpected stdout %q", res.Stdout)
	}
	if strings.Contains(res.Stderr, "syntax error") {
		t.Fatalf("syntax error leaked: %q", res.Stderr)
	}
}
