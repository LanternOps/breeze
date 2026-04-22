//go:build linux

package helper

import (
	"strings"
	"testing"
)

func TestRenderAutoStartEntry_QuotesExecPath(t *testing.T) {
	tests := []struct {
		name       string
		binaryPath string
		wantExec   string
	}{
		{
			name:       "simple path",
			binaryPath: "/usr/local/bin/breeze-helper",
			wantExec:   `Exec="/usr/local/bin/breeze-helper"`,
		},
		{
			name:       "path with space",
			binaryPath: "/usr/local/bin/breeze helper",
			wantExec:   `Exec="/usr/local/bin/breeze helper"`,
		},
		{
			name:       "path with special chars",
			binaryPath: "/opt/breeze & co/breeze-helper",
			wantExec:   `Exec="/opt/breeze & co/breeze-helper"`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			entry := renderAutoStartEntry(tc.binaryPath)
			if !strings.Contains(entry, tc.wantExec) {
				t.Errorf("renderAutoStartEntry(%q):\ngot:\n%s\nwant it to contain: %s",
					tc.binaryPath, entry, tc.wantExec)
			}
		})
	}
}

func TestRenderAutoStartEntry_PreservesOtherFields(t *testing.T) {
	entry := renderAutoStartEntry("/usr/local/bin/breeze-helper")
	requiredFields := []string{
		"[Desktop Entry]",
		"Type=Application",
		"Name=Breeze Helper",
		"Hidden=false",
		"NoDisplay=true",
		"X-GNOME-Autostart-enabled=true",
	}
	for _, field := range requiredFields {
		if !strings.Contains(entry, field) {
			t.Errorf("renderAutoStartEntry output missing required field %q:\n%s", field, entry)
		}
	}
}
