package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/biosconfig"
)

// observe_vendors (#10838 observe-first amendment §1): an absent key, which is
// what an older API sends, grants nothing; an unknown vendor is ignored; and
// the grant is a closed set of lanes, never a name the server chose.
func TestObserveVendorsAbsentMeansNone(t *testing.T) {
	for name, raw := range map[string]map[string]any{
		"absent":   {"enabled": true},
		"null":     {"enabled": true, "observe_vendors": nil},
		"string":   {"enabled": true, "observe_vendors": "hp"},
		"object":   {"enabled": true, "observe_vendors": map[string]any{"hp": true}},
		"empty":    {"enabled": true, "observe_vendors": []any{}},
		"non-text": {"enabled": true, "observe_vendors": []any{1.0, true, nil}},
	} {
		s, ok := parseWakeSettings(raw)
		if !ok || s.Observe != 0 {
			t.Errorf("%s: got %+v ok=%v, want no observe grant", name, s, ok)
		}
	}
}

func TestObserveVendorsUnknownVendorIgnored(t *testing.T) {
	s, ok := parseWakeSettings(map[string]any{
		"enabled":         true,
		"observe_vendors": []any{"dell", "HP", "acme", "lenovo", " surface ", "microsoft", "__proto__"},
	})
	if !ok {
		t.Fatal("rejected")
	}
	want := biosconfig.VendorHP | biosconfig.VendorLenovo | biosconfig.VendorSurface
	if s.Observe != want {
		t.Fatalf("observe = %v, want %v", s.Observe, want)
	}
	camel, _ := parseWakeSettings(map[string]any{"enabled": true, "observeVendors": []any{"lenovo"}})
	if camel.Observe != biosconfig.VendorLenovo {
		t.Fatalf("camelCase observe = %v", camel.Observe)
	}
	// Dell follows the plan's own write path and is never an observe lane;
	// "microsoft" is the snapshot's vendor label, not a lane name.
	for _, name := range []string{"dell", "microsoft"} {
		other, _ := parseWakeSettings(map[string]any{"enabled": true, "observe_vendors": []any{name}})
		if other.Observe != 0 {
			t.Fatalf("%s granted observe: %v", name, other.Observe)
		}
	}
}

// A long list is read only up to a small bound, so a hostile payload cannot
// make the parse do unbounded work; the lanes are still a closed set.
func TestObserveVendorsListIsBounded(t *testing.T) {
	list := make([]any, 0, 1001)
	for range 1000 {
		list = append(list, "acme")
	}
	list = append(list, "hp")
	s, _ := parseWakeSettings(map[string]any{"enabled": true, "observe_vendors": list})
	if s.Observe != 0 {
		t.Fatalf("an entry past the bound was read: %v", s.Observe)
	}
}

// configure_settings and observe_vendors are independent: observe never turns
// a write on, and a write flag never grants observation.
func TestObserveVendorsIndependentOfConfigure(t *testing.T) {
	s, _ := parseWakeSettings(map[string]any{"enabled": true, "observe_vendors": []any{"hp"}})
	if s.ConfigureSettings {
		t.Fatal("observe_vendors turned configure_settings on")
	}
	s, _ = parseWakeSettings(map[string]any{"enabled": true, "configure_settings": true})
	if s.Observe != 0 {
		t.Fatal("configure_settings granted observation")
	}
}
