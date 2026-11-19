package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/viper"
)

// The Linux desktop helper (#12117) stays off until its lab leg passes.
func TestDesktopWaylandHelper_DefaultOff(t *testing.T) {
	if Default().DesktopWaylandHelper {
		t.Fatal("desktop_wayland_helper defaults on")
	}
}

func TestDesktopWaylandHelper_LoadsFromAgentYAML(t *testing.T) {
	defer viper.Reset()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(cfgPath, []byte("server_url: https://api.example.test\ndesktop_wayland_helper: true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secrets.yaml"), []byte("auth_token: brz_x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !loaded.DesktopWaylandHelper {
		t.Fatal("desktop_wayland_helper: true did not load")
	}
}
