package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/viper"
)

// loadYAML drives the real loader (Load -> viper.Unmarshal over Default() ->
// ValidateTiered) so unset-vs-explicit behaviour is proven on the path the
// agent uses. Not parallel: it owns the viper singleton.
func loadYAML(t *testing.T, body string) *Config {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "agent.yaml")
	full := "agent_id: 00000000-0000-4000-8000-000000000001\nserver_url: http://localhost\n" + body
	if err := os.WriteFile(p, []byte(full), 0o600); err != nil {
		t.Fatal(err)
	}
	viper.Reset()
	t.Cleanup(viper.Reset)
	cfg, err := Load(p)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return cfg
}

func warnsContain(r ValidationResult, sub string) bool {
	for _, w := range r.Warnings {
		if strings.Contains(w.Error(), sub) {
			return true
		}
	}
	return false
}

func TestConfigReconnectKeys(t *testing.T) {
	t.Run("defaults", func(t *testing.T) {
		d := Default()
		if d.WsFirstReconnectWindowSeconds != 30 {
			t.Errorf("window default = %d, want 30", d.WsFirstReconnectWindowSeconds)
		}
		if !d.LoopRetryAfter {
			t.Error("loop_retry_after default = false, want true")
		}
	})

	t.Run("explicit zero accepted", func(t *testing.T) {
		d := Default()
		d.WsFirstReconnectWindowSeconds = 0
		r := d.ValidateTiered()
		if d.WsFirstReconnectWindowSeconds != 0 {
			t.Errorf("window = %d, want 0 kept", d.WsFirstReconnectWindowSeconds)
		}
		if warnsContain(r, "ws_first_reconnect_window_seconds") {
			t.Error("0 must not warn")
		}
	})

	t.Run("301 clamped to 300 with warning", func(t *testing.T) {
		d := Default()
		d.WsFirstReconnectWindowSeconds = 301
		r := d.ValidateTiered()
		if d.WsFirstReconnectWindowSeconds != 300 {
			t.Errorf("window = %d, want 300", d.WsFirstReconnectWindowSeconds)
		}
		if !warnsContain(r, "ws_first_reconnect_window_seconds") {
			t.Error("expected a clamp warning")
		}
		if r.HasFatals() {
			t.Error("clamp must not be fatal")
		}
	})

	t.Run("300 accepted silently", func(t *testing.T) {
		d := Default()
		d.WsFirstReconnectWindowSeconds = 300
		r := d.ValidateTiered()
		if d.WsFirstReconnectWindowSeconds != 300 || warnsContain(r, "ws_first_reconnect_window_seconds") {
			t.Errorf("300 should pass untouched, got %d", d.WsFirstReconnectWindowSeconds)
		}
	})

	t.Run("negative falls back to default with warning", func(t *testing.T) {
		d := Default()
		d.WsFirstReconnectWindowSeconds = -5
		r := d.ValidateTiered()
		if d.WsFirstReconnectWindowSeconds != 30 {
			t.Errorf("window = %d, want 30", d.WsFirstReconnectWindowSeconds)
		}
		if !warnsContain(r, "ws_first_reconnect_window_seconds") {
			t.Error("expected a warning")
		}
	})

	t.Run("yaml without keys yields defaults", func(t *testing.T) {
		cfg := loadYAML(t, "heartbeat_interval_seconds: 60\n")
		if cfg.WsFirstReconnectWindowSeconds != 30 {
			t.Errorf("window = %d, want 30", cfg.WsFirstReconnectWindowSeconds)
		}
		if !cfg.LoopRetryAfter {
			t.Error("loop_retry_after absent must be true")
		}
	})

	t.Run("yaml explicit values", func(t *testing.T) {
		cfg := loadYAML(t, "ws_first_reconnect_window_seconds: 0\nloop_retry_after: false\n")
		if cfg.WsFirstReconnectWindowSeconds != 0 {
			t.Errorf("window = %d, want explicit 0", cfg.WsFirstReconnectWindowSeconds)
		}
		if cfg.LoopRetryAfter {
			t.Error("loop_retry_after: false must load as false")
		}
	})

	t.Run("yaml loop_retry_after true and window 120", func(t *testing.T) {
		cfg := loadYAML(t, "ws_first_reconnect_window_seconds: 120\nloop_retry_after: true\n")
		if cfg.WsFirstReconnectWindowSeconds != 120 || !cfg.LoopRetryAfter {
			t.Errorf("got %d / %v", cfg.WsFirstReconnectWindowSeconds, cfg.LoopRetryAfter)
		}
	})

	t.Run("yaml out of range goes through Load clamp", func(t *testing.T) {
		cfg := loadYAML(t, "ws_first_reconnect_window_seconds: 9999\n")
		if cfg.WsFirstReconnectWindowSeconds != 300 {
			t.Errorf("window = %d, want 300", cfg.WsFirstReconnectWindowSeconds)
		}
		cfg = loadYAML(t, "ws_first_reconnect_window_seconds: -1\n")
		if cfg.WsFirstReconnectWindowSeconds != 30 {
			t.Errorf("window = %d, want 30", cfg.WsFirstReconnectWindowSeconds)
		}
	})
}
