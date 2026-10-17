package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/viper"
)

func TestConfigDefaults_ECHTrue(t *testing.T) {
	d := Default()
	if !d.ECH || !d.ECHServerEnabled {
		t.Fatalf("Default ECH=%v ECHServerEnabled=%v, want both true", d.ECH, d.ECHServerEnabled)
	}
}

func TestConfigLoad_ECHFalseRoundTrips(t *testing.T) {
	defer viper.Reset()

	cfgPath := filepath.Join(t.TempDir(), "agent.yaml")
	if err := os.WriteFile(cfgPath, []byte("server_url: https://api.example.test\nech: false\n"), 0o640); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}
	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ECH {
		t.Fatal("ech: false in file did not load as false")
	}
	if !cfg.ECHServerEnabled {
		t.Fatal("absent ech_server_enabled must keep its true default")
	}
}
