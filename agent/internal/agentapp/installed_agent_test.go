package agentapp

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestResolveIsInstalledAgent(t *testing.T) {
	canonical := filepath.Join(t.TempDir(), "Breeze", "agent.yaml")
	other := filepath.Join(t.TempDir(), "lab", "agent.yaml")
	sep := string(filepath.Separator)
	cases := []struct {
		name                string
		supportMode         bool
		underServiceManager bool
		active              string
		want                bool
	}{
		{name: "service manager, canonical config", underServiceManager: true, active: canonical, want: true},
		{name: "service manager, canonical config via unclean path", underServiceManager: true,
			active: filepath.Dir(canonical) + sep + "." + sep + "agent.yaml", want: true},
		{name: "service manager, another config file", underServiceManager: true, active: other, want: false},
		{name: "service manager, no config file loaded", underServiceManager: true, active: "", want: false},
		{name: "foreground run, canonical config", underServiceManager: false, active: canonical, want: false},
		{name: "quick support client", supportMode: true, underServiceManager: true, active: canonical, want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveIsInstalledAgent(tc.supportMode, tc.underServiceManager, tc.active, canonical); got != tc.want {
				t.Fatalf("resolveIsInstalledAgent(%v, %v, %q) = %v, want %v",
					tc.supportMode, tc.underServiceManager, tc.active, got, tc.want)
			}
		})
	}
}

// Windows paths are case-insensitive: the SCM service may see the config
// path with different casing than ConfigDir() builds it.
func TestResolveIsInstalledAgentPathCaseOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("case-insensitive config path match is Windows-only")
	}
	canonical := `C:\ProgramData\Breeze\agent.yaml`
	if !resolveIsInstalledAgent(false, true, strings.ToLower(canonical), canonical) {
		t.Fatal("canonical config path with different casing should match on Windows")
	}
}
