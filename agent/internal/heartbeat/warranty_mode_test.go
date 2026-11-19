package heartbeat

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// HP CMSL mode handling (#5511 observe-first amendment §1, O2). The mode and
// tiers live in memory only, are authority for 24 h after the last heartbeat
// that carried them, and start empty after a restart. The persisted
// hp_warranty_collection_enabled flag alone authorizes nothing.

func newModeHeartbeat(t *testing.T, persisted bool, clock *time.Time) *Heartbeat {
	t.Helper()
	orig := persistWarrantyCollectionEnabled
	t.Cleanup(func() { persistWarrantyCollectionEnabled = orig })
	persistWarrantyCollectionEnabled = func(bool) error { return nil }
	cfg := config.Default()
	cfg.HPWarrantyCollectionEnabled = persisted
	h := &Heartbeat{config: cfg}
	h.hpWarrantyNow = func() time.Time { return *clock }
	return h
}

func warrantyUpdate(block map[string]any) map[string]any {
	return map[string]any{"warranty_settings": block}
}

func observeBlock() map[string]any {
	return map[string]any{"hp_cmsl_enabled": false, "hp_cmsl_mode": "observe", "hp_cmsl_tiers": []any{}}
}

func TestModeNotPersisted(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	orig := persistWarrantyCollectionEnabled
	t.Cleanup(func() { persistWarrantyCollectionEnabled = orig })
	var persisted []bool
	persistWarrantyCollectionEnabled = func(enabled bool) error {
		persisted = append(persisted, enabled)
		return nil
	}
	h := &Heartbeat{config: config.Default()}
	h.hpWarrantyNow = func() time.Time { return now }

	h.applyConfigUpdate(warrantyUpdate(map[string]any{
		"hp_cmsl_enabled": true, "hp_cmsl_mode": "act", "hp_cmsl_tiers": []any{"t0_ingest"},
	}))
	if mode, tiers := h.hpCmslAuthority(); mode != hpCmslModeAct || !reflect.DeepEqual(tiers, []string{"t0_ingest"}) {
		t.Fatalf("authority = %q %v, want act [t0_ingest]", mode, tiers)
	}
	// Only the legacy boolean reaches disk; there is no config key for the mode.
	if !reflect.DeepEqual(persisted, []bool{true}) {
		t.Fatalf("persisted = %v, want only the legacy flag [true]", persisted)
	}
	for _, f := range reflect.VisibleFields(reflect.TypeOf(config.Config{})) {
		tag := strings.ToLower(f.Tag.Get("mapstructure"))
		if strings.Contains(tag, "cmsl_mode") || strings.Contains(tag, "cmsl_tiers") {
			t.Fatalf("config.Config persists %s; the mode must stay in memory", f.Name)
		}
	}
}

func TestModeExpiresAfter24h(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	h := newModeHeartbeat(t, false, &now)
	h.applyConfigUpdate(warrantyUpdate(observeBlock()))

	now = now.Add(24*time.Hour - time.Second)
	if mode, _ := h.hpCmslAuthority(); mode != hpCmslModeObserve {
		t.Fatalf("at 23:59:59 mode = %q, want observe", mode)
	}
	// A heartbeat without the block (the server omits it on a resolver error)
	// does not refresh the authority.
	h.applyConfigUpdate(map[string]any{"event_log_settings": map[string]any{}})
	now = now.Add(2 * time.Second)
	if mode, tiers := h.hpCmslAuthority(); mode != hpCmslModeOff || len(tiers) != 0 {
		t.Fatalf("after 24h with no fresh block mode = %q %v, want off", mode, tiers)
	}

	// A fresh block restores it.
	h.applyConfigUpdate(warrantyUpdate(observeBlock()))
	if mode, _ := h.hpCmslAuthority(); mode != hpCmslModeObserve {
		t.Fatalf("after a fresh block mode = %q, want observe", mode)
	}
}

func TestRestartStartsOff(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	// A previous process persisted the legacy flag true.
	h := newModeHeartbeat(t, true, &now)
	if mode, tiers := h.hpCmslAuthority(); mode != hpCmslModeOff || len(tiers) != 0 {
		t.Fatalf("fresh process mode = %q %v, want off", mode, tiers)
	}
}

func TestPersistedEnabledAloneDoesNothing(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	h := newModeHeartbeat(t, true, &now)
	// An older server's block: the legacy flag only, no mode.
	h.applyConfigUpdate(warrantyUpdate(map[string]any{"hp_cmsl_enabled": true}))
	if !h.hpWarrantyCollectionEnabled() {
		t.Fatal("legacy flag should still be applied as before")
	}
	if mode, tiers := h.hpCmslAuthority(); mode != hpCmslModeOff || len(tiers) != 0 {
		t.Fatalf("legacy flag alone gave mode %q %v, want off", mode, tiers)
	}
	if h.hpCmslTierOpen("t0_ingest") {
		t.Fatal("legacy flag alone opened an act tier")
	}
}

func TestUnknownModeIsOff(t *testing.T) {
	cases := map[string]map[string]any{
		"unknown mode":     {"hp_cmsl_enabled": false, "hp_cmsl_mode": "scan", "hp_cmsl_tiers": []any{}},
		"non-string mode":  {"hp_cmsl_enabled": false, "hp_cmsl_mode": true, "hp_cmsl_tiers": []any{}},
		"upper-case mode":  {"hp_cmsl_enabled": false, "hp_cmsl_mode": "OBSERVE", "hp_cmsl_tiers": []any{}},
		"missing mode":     {"hp_cmsl_enabled": false},
		"explicit off":     {"hp_cmsl_enabled": false, "hp_cmsl_mode": "off", "hp_cmsl_tiers": []any{}},
		"non-object block": nil,
	}
	for name, block := range cases {
		t.Run(name, func(t *testing.T) {
			now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
			h := newModeHeartbeat(t, false, &now)
			h.applyConfigUpdate(warrantyUpdate(observeBlock()))
			var raw any = block
			if block == nil {
				raw = "observe"
			}
			h.applyConfigUpdate(map[string]any{"warranty_settings": raw})
			want := hpCmslModeOff
			if block == nil {
				// A non-object payload is ignored whole: the previous authority stands.
				want = hpCmslModeObserve
			}
			if mode, _ := h.hpCmslAuthority(); mode != want {
				t.Fatalf("mode = %q, want %q", mode, want)
			}
		})
	}
}

func TestTiersOnlyAtActAndOnlyKnown(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	h := newModeHeartbeat(t, false, &now)

	h.applyConfigUpdate(warrantyUpdate(map[string]any{
		"hp_cmsl_enabled": false, "hp_cmsl_mode": "observe", "hp_cmsl_tiers": []any{"t0_ingest"},
	}))
	if h.hpCmslTierOpen("t0_ingest") {
		t.Fatal("a tier opened outside act")
	}

	h.applyConfigUpdate(warrantyUpdate(map[string]any{
		"hp_cmsl_enabled": true, "hp_cmsl_mode": "act", "hp_cmsl_tiers": []any{"install", "t9", 7, "t0_ingest", "t0_ingest"},
	}))
	_, tiers := h.hpCmslAuthority()
	if !reflect.DeepEqual(tiers, []string{"install", "t0_ingest"}) {
		t.Fatalf("tiers = %v, want known, deduplicated [install t0_ingest]", tiers)
	}
	if h.hpCmslTierOpen("t1_refresh") || !h.hpCmslTierOpen("install") {
		t.Fatal("tier membership is wrong")
	}

	// act with no tiers opens nothing.
	h.applyConfigUpdate(warrantyUpdate(map[string]any{"hp_cmsl_enabled": true, "hp_cmsl_mode": "act", "hp_cmsl_tiers": []any{}}))
	for _, tier := range []string{"t0_ingest", "t1_refresh", "install"} {
		if h.hpCmslTierOpen(tier) {
			t.Fatalf("act with empty tiers opened %s", tier)
		}
	}
}
