//go:build linux

package wayland

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSystemdHelpSupportsPipe(t *testing.T) {
	if !systemdHelpSupportsPipe("--pipe\n--collect\n") {
		t.Fatal("current systemd-run help should count as supported")
	}
	if systemdHelpSupportsPipe("--wait\n") {
		t.Fatal("help without --pipe and --collect is too old")
	}
	if systemdHelpSupportsPipe("--pipe\n") {
		t.Fatal("--pipe without --collect cannot run this helper")
	}
}

func TestPipewirePluginFile(t *testing.T) {
	root := t.TempDir()
	if pipewirePluginIn([]string{root}) {
		t.Fatal("empty library dir reported a plugin")
	}
	dir := filepath.Join(root, "x86_64-linux-gnu", "gstreamer-1.0")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "libgstpipewire.so"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !pipewirePluginIn([]string{root}) {
		t.Fatal("plugin file was not found")
	}
}
