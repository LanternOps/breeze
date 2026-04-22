//go:build darwin

package helper

import (
	"strings"
	"testing"
)

func TestXmlEscapeString_EscapesSpecialChars(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "plain path",
			input: "/Applications/Breeze Helper.app/Contents/MacOS/breeze-helper",
			want:  "/Applications/Breeze Helper.app/Contents/MacOS/breeze-helper",
		},
		{
			name:  "path with angle brackets",
			input: "/tmp/<test>/breeze-helper",
			want:  "/tmp/&lt;test&gt;/breeze-helper",
		},
		{
			name:  "path with ampersand",
			input: "/opt/breeze & co/breeze-helper",
			want:  "/opt/breeze &amp; co/breeze-helper",
		},
		{
			name:  "path with quotes",
			input: `/opt/breeze"helper`,
			want:  `/opt/breeze&#34;helper`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := xmlEscapeString(tc.input)
			if got != tc.want {
				t.Errorf("xmlEscapeString(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestInstallAutoStart_PathWithAngleBracketNotUnescaped(t *testing.T) {
	// A path containing '<' must appear XML-escaped in the plist output,
	// never as a raw '<' character between the <string> tags.
	binaryPath := "/tmp/<evil>/breeze-helper"

	// We call the plist builder indirectly by constructing what it would produce.
	// Since installAutoStart writes to disk (requires root on macOS), we test
	// the escape helper directly and verify it would be safe in the template.
	escaped := xmlEscapeString(binaryPath)

	if strings.Contains(escaped, "<evil>") {
		t.Errorf("xmlEscapeString(%q) contains unescaped '<evil>': %q", binaryPath, escaped)
	}
	if !strings.Contains(escaped, "&lt;evil&gt;") {
		t.Errorf("xmlEscapeString(%q) does not contain escaped form '&lt;evil&gt;': %q", binaryPath, escaped)
	}
}
