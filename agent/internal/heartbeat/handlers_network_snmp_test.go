package heartbeat

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/snmppoll"
)

func basePayload() map[string]any {
	return map[string]any{
		"deviceId":  "dev-1",
		"target":    "192.0.2.10",
		"port":      161,
		"version":   "v2c",
		"community": "public",
		"oids":      []any{"1.3.6.1.2.1.1.3.0", "1.3.6.1.2.1.43.11.1.1.9"},
	}
}

func TestParseSnmpPollRequest_LegacyPayloadBecomesAllGets(t *testing.T) {
	device, errResult := parseSnmpPollRequest(basePayload())
	if errResult != nil {
		t.Fatalf("parseSnmpPollRequest returned %v, want nil error result", errResult)
	}
	if len(device.Specs) != 2 {
		t.Fatalf("Specs = %v, want 2 specs", device.Specs)
	}
	for _, spec := range device.Specs {
		if spec.Mode != snmppoll.ModeGet {
			t.Errorf("legacy OID %q parsed as mode %q, want %q — a pre-W02 server never asked for a walk",
				spec.OID, spec.Mode, snmppoll.ModeGet)
		}
	}
	if device.Limits != snmppoll.DefaultPollLimits {
		t.Errorf("Limits = %+v, want DefaultPollLimits %+v", device.Limits, snmppoll.DefaultPollLimits)
	}
	// The legacy field is still handed to the device so nothing downstream that
	// reads OIDs changes meaning.
	if len(device.OIDs) != 2 {
		t.Errorf("OIDs = %v, want the 2 payload OIDs", device.OIDs)
	}
}

func TestParseSnmpPollRequest_OidSpecsWin(t *testing.T) {
	payload := basePayload()
	payload["oidSpecs"] = []any{
		map[string]any{"oid": "1.3.6.1.2.1.1.3.0", "name": "sysUpTime", "mode": "get", "cadence": "fast"},
		map[string]any{"oid": "1.3.6.1.2.1.43.11.1.1.9", "name": "prtMarkerSuppliesLevel", "mode": "walk", "cadence": "fast"},
	}

	device, errResult := parseSnmpPollRequest(payload)
	if errResult != nil {
		t.Fatalf("parseSnmpPollRequest returned %v, want nil error result", errResult)
	}
	if len(device.Specs) != 2 {
		t.Fatalf("Specs = %v, want 2", device.Specs)
	}
	if device.Specs[0].Name != "sysUpTime" || device.Specs[0].Mode != snmppoll.ModeGet {
		t.Errorf("spec 0 = %+v, want sysUpTime/get", device.Specs[0])
	}
	if device.Specs[1].Name != "prtMarkerSuppliesLevel" || device.Specs[1].Mode != snmppoll.ModeWalk {
		t.Errorf("spec 1 = %+v, want prtMarkerSuppliesLevel/walk", device.Specs[1])
	}
}

func TestParseSnmpPollRequest_SpecDefaultsFillGaps(t *testing.T) {
	payload := basePayload()
	payload["oidSpecs"] = []any{
		map[string]any{"oid": "1.3.6.1.2.1.2.2.1.2"},                   // no name, no mode, no cadence
		map[string]any{"oid": "1.3.6.1.2.1.1.3.0", "mode": "sideways"}, // unknown mode
		map[string]any{"name": "no oid at all"},                        // unusable
	}

	device, _ := parseSnmpPollRequest(payload)
	if len(device.Specs) != 2 {
		t.Fatalf("Specs = %+v, want the 2 usable entries", device.Specs)
	}
	if device.Specs[0].Mode != snmppoll.ModeWalk || device.Specs[0].Name != "1.3.6.1.2.1.2.2.1.2" {
		t.Errorf("spec 0 = %+v, want walk with the OID as its name", device.Specs[0])
	}
	if device.Specs[1].Mode != snmppoll.ModeGet {
		t.Errorf("unknown mode %q should fall back to the .0 default get, got %q", "sideways", device.Specs[1].Mode)
	}
	if device.Specs[0].Cadence != snmppoll.CadenceFast {
		t.Errorf("missing cadence = %q, want fast", device.Specs[0].Cadence)
	}
}

func TestParseSnmpPollRequest_LimitsFromPayload(t *testing.T) {
	payload := basePayload()
	payload["limits"] = map[string]any{
		"maxRowsPerOid":   float64(16),
		"maxRowsPerPoll":  float64(32),
		"maxBytesPerPoll": float64(4096),
		"maxDurationMs":   float64(1500),
	}

	device, _ := parseSnmpPollRequest(payload)
	want := snmppoll.PollLimits{MaxRowsPerOID: 16, MaxRowsPerPoll: 32, MaxBytesPerPoll: 4096, MaxDuration: 1500 * time.Millisecond}
	if device.Limits != want {
		t.Errorf("Limits = %+v, want %+v", device.Limits, want)
	}
}

func TestParseSnmpPollRequest_PartialLimitsKeepDefaults(t *testing.T) {
	payload := basePayload()
	payload["limits"] = map[string]any{"maxRowsPerOid": float64(8)}

	device, _ := parseSnmpPollRequest(payload)
	if device.Limits.MaxRowsPerOID != 8 {
		t.Errorf("MaxRowsPerOID = %d, want 8", device.Limits.MaxRowsPerOID)
	}
	if device.Limits.MaxRowsPerPoll != snmppoll.DefaultPollLimits.MaxRowsPerPoll {
		t.Errorf("MaxRowsPerPoll = %d, want the default %d", device.Limits.MaxRowsPerPoll, snmppoll.DefaultPollLimits.MaxRowsPerPoll)
	}
	if device.Limits.MaxDuration != snmppoll.DefaultPollLimits.MaxDuration {
		t.Errorf("MaxDuration = %v, want the default %v", device.Limits.MaxDuration, snmppoll.DefaultPollLimits.MaxDuration)
	}
}

func TestParseSnmpPollRequest_NonPositiveLimitsAreIgnored(t *testing.T) {
	payload := basePayload()
	payload["limits"] = map[string]any{"maxRowsPerOid": float64(0), "maxDurationMs": float64(-1)}

	device, _ := parseSnmpPollRequest(payload)
	// A zero bound would mean "collect nothing" and a negative duration would
	// mean "already expired" — both silently kill collection, so they are
	// treated as absent.
	if device.Limits.MaxRowsPerOID != snmppoll.DefaultPollLimits.MaxRowsPerOID {
		t.Errorf("MaxRowsPerOID = %d, want the default %d", device.Limits.MaxRowsPerOID, snmppoll.DefaultPollLimits.MaxRowsPerOID)
	}
	if device.Limits.MaxDuration != snmppoll.DefaultPollLimits.MaxDuration {
		t.Errorf("MaxDuration = %v, want the default %v", device.Limits.MaxDuration, snmppoll.DefaultPollLimits.MaxDuration)
	}
}

func TestParseSnmpPollRequest_RejectsBadPortAndMissingTarget(t *testing.T) {
	if _, errResult := parseSnmpPollRequest(map[string]any{"port": 161}); errResult == nil {
		t.Error("missing target should return an error result")
	}
	payload := basePayload()
	payload["port"] = 70000
	if _, errResult := parseSnmpPollRequest(payload); errResult == nil {
		t.Error("out-of-range port should return an error result")
	}
}
