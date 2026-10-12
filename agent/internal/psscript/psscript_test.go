package psscript

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestWithBOM(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    string
	}{
		{"ascii gets BOM", "Write-Host 'x'\r\n", BOM + "Write-Host 'x'\r\n"},
		{"non-ascii path gets BOM", "$p = 'C:\\Programme\\Brüder'\r\n", BOM + "$p = 'C:\\Programme\\Brüder'\r\n"},
		{"empty gets BOM", "", BOM},
		{"existing BOM not doubled", BOM + "Write-Host 'x'", BOM + "Write-Host 'x'"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := WithBOM(tt.content); got != tt.want {
				t.Fatalf("WithBOM(%q) = %q, want %q", tt.content, got, tt.want)
			}
		})
	}
}

func TestCreateTemp(t *testing.T) {
	tests := []struct {
		name    string
		pattern string
		content string
	}{
		{"ascii helper", "breeze-restart-*.ps1", "Start-Sleep -Seconds 2\r\nRestart-Service -Name 'BreezeAgent' -Force"},
		{"localized install path", "breeze-uninstall-*.ps1", "$agent = 'C:\\Programmes\\Société\\breeze-agent.exe'\r\n"},
		{"content already carrying BOM", "breeze-update-*.ps1", BOM + "Write-Host 'x'"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path, err := CreateTemp(tt.pattern, tt.content)
			if err != nil {
				t.Fatalf("CreateTemp: %v", err)
			}
			t.Cleanup(func() { _ = os.Remove(path) })

			if filepath.Dir(path) != filepath.Clean(os.TempDir()) {
				t.Fatalf("path %q not in os.TempDir() %q", path, os.TempDir())
			}
			prefix, suffix, _ := strings.Cut(tt.pattern, "*")
			base := filepath.Base(path)
			if !strings.HasPrefix(base, prefix) || !strings.HasSuffix(base, suffix) {
				t.Fatalf("name %q does not match pattern %q", base, tt.pattern)
			}
			b, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			if want := BOM + strings.TrimPrefix(tt.content, BOM); string(b) != want {
				t.Fatalf("file content = %q, want %q", b, want)
			}
		})
	}
}

func TestCreateTempBadPatternFails(t *testing.T) {
	if _, err := CreateTemp("bad/pattern-*.ps1", "x"); err == nil {
		t.Fatal("expected error for a pattern containing a path separator")
	}
}

// TestNoBOMlessPowerShellTempWriters is the #3581 guard: every agent code path
// that writes its own .ps1 temp file must go through this package so the BOM
// rule lives in one place. Windows PowerShell 5.1 decodes a BOM-less .ps1 as
// the ANSI codepage, which mangles interpolated non-ASCII install paths.
func TestNoBOMlessPowerShellTempWriters(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	self, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	var offenders []string
	err = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			name := d.Name()
			if path != root && (path == self || name == "vendor" || name == "testdata" || strings.HasPrefix(name, ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		// A file that names a .ps1 must not create temp files itself: the
		// pattern may be a variable (startDetachedServiceRestart), so match
		// per file rather than per line.
		src := string(b)
		if !strings.Contains(src, ".ps1\"") {
			return nil
		}
		for i, line := range strings.Split(src, "\n") {
			if strings.Contains(line, "os.CreateTemp(") {
				rel, _ := filepath.Rel(root, path)
				offenders = append(offenders, rel+":"+strconv.Itoa(i+1)+": "+strings.TrimSpace(line))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(offenders) > 0 {
		t.Fatalf("write .ps1 temp files with psscript.CreateTemp (stamps the UTF-8 BOM), not os.CreateTemp:\n%s",
			strings.Join(offenders, "\n"))
	}
}
