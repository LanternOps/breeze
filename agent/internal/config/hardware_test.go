package config

import (
	"path/filepath"
	"testing"

	"github.com/spf13/viper"
)

func TestHardwareToolDirs(t *testing.T) {
	for _, bad := range []string{"", "relative/tools", "bad\x00dir"} {
		c := Default()
		c.Hardware.ToolDirs = []string{bad}
		if !c.ValidateTiered().HasFatals() {
			t.Fatalf("accepted %q", bad)
		}
	}
	c := Default()
	c.Hardware.ToolDirs = []string{t.TempDir()}
	if c.ValidateTiered().HasFatals() {
		t.Fatal("absolute directory rejected")
	}
}

func TestHardwareToolDirsRoundTrip(t *testing.T) {
	viper.Reset()
	defer viper.Reset()
	c := Default()
	c.Hardware.ToolDirs = []string{t.TempDir()}
	p := filepath.Join(t.TempDir(), "agent.yaml")
	if e := SaveTo(c, p); e != nil {
		t.Fatal(e)
	}
	viper.Reset()
	got, e := Load(p)
	if e != nil {
		t.Fatal(e)
	}
	if len(got.Hardware.ToolDirs) != 1 || got.Hardware.ToolDirs[0] != c.Hardware.ToolDirs[0] {
		t.Fatal(got.Hardware)
	}
}
