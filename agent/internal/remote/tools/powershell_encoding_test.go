package tools

import (
	"strings"
	"testing"
)

func TestUTF8PowerShellCommand(t *testing.T) {
	t.Parallel()

	inner := `Get-WinEvent -ListLog * | ConvertTo-Json`
	got := utf8PowerShellCommand(inner)

	if !strings.HasPrefix(got, "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;") {
		t.Fatalf("expected UTF-8 output-encoding prefix, got %q", got)
	}
	if !strings.HasSuffix(got, inner) {
		t.Fatalf("expected original command preserved as suffix, got %q", got)
	}
}
