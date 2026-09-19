package heartbeat

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
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
	for i, spec := range device.Specs {
		// The legacy label is the undotted OID, not a template display name.
		if spec.Name != device.OIDs[i] {
			t.Errorf("Specs[%d].Name = %q, want legacy OID %q", i, spec.Name, device.OIDs[i])
		}
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
	for _, tc := range []struct {
		name      string
		raw       []any
		firstMode string
		firstName string
	}{
		{
			name: "partial specs",
			raw: []any{
				map[string]any{"oid": "1.3.6.1.2.1.2.2.1.2"},
				map[string]any{"oid": "1.3.6.1.2.1.1.3.0", "mode": "sideways"},
				map[string]any{"name": "no oid at all"},
			},
			firstMode: snmppoll.ModeWalk,
			firstName: "1.3.6.1.2.1.2.2.1.2",
		},
		{name: "present but empty", raw: []any{}, firstMode: snmppoll.ModeGet, firstName: "1.3.6.1.2.1.1.3.0"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := basePayload()
			payload["oidSpecs"] = tc.raw
			device, _ := parseSnmpPollRequest(payload)
			if len(device.Specs) != 2 {
				t.Fatalf("Specs = %+v, want 2 entries", device.Specs)
			}
			if device.Specs[0].Mode != tc.firstMode || device.Specs[0].Name != tc.firstName {
				t.Errorf("spec 0 = %+v, want %s with name %s", device.Specs[0], tc.firstMode, tc.firstName)
			}
			if device.Specs[1].Mode != snmppoll.ModeGet {
				t.Errorf("spec 1 = %+v, want get", device.Specs[1])
			}
			if device.Specs[0].Cadence != snmppoll.CadenceFast {
				t.Errorf("missing cadence = %q, want fast", device.Specs[0].Cadence)
			}
		})
	}
}

func TestParseSnmpPollRequest_UnusableSpecsWarnAndFallBack(t *testing.T) {
	for _, tc := range []struct {
		name   string
		raw    any
		rawLen string
	}{
		{"missing oid", []any{map[string]any{"name": "x"}}, "rawLen=1"},
		{"empty", []any{}, "rawLen=0"},
		{"wrong array type", "invalid", "rawLen=0"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			previous := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
			defer slog.SetDefault(previous)
			payload := basePayload()
			payload["oidSpecs"] = tc.raw
			device, result := parseSnmpPollRequest(payload)
			if result != nil || len(device.Specs) != 2 {
				t.Fatalf("parse = %+v, %v; want 2 legacy specs", device, result)
			}
			for _, spec := range device.Specs {
				if spec.Mode != snmppoll.ModeGet {
					t.Errorf("fallback mode = %q, want get", spec.Mode)
				}
			}
			for _, want := range []string{"level=WARN", "snmp_poll: oidSpecs present but unusable; falling back to legacy GETs", tc.rawLen, "legacyOids="} {
				if !strings.Contains(logs.String(), want) {
					t.Errorf("logs = %q, want %q", logs.String(), want)
				}
			}
		})
	}
}

func TestParseSnmpPollRequest_WarnsOnDroppedSpecs(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previous)
	payload := basePayload()
	payload["oidSpecs"] = []any{map[string]any{"name": "x"}, map[string]any{"oid": " "}, map[string]any{"oid": "1.3.6.1.2.1.1.3.0"}}
	device, _ := parseSnmpPollRequest(payload)
	if len(device.Specs) != 1 {
		t.Fatalf("Specs = %+v, want one usable entry", device.Specs)
	}
	for _, want := range []string{"level=WARN", "snmp_poll: dropped malformed oidSpecs entries", "dropped=2"} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("logs = %q, want %q", logs.String(), want)
		}
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

func TestSnmpPollResultPayload_StampsProtocol2(t *testing.T) {
	payload := snmpPollResultPayload("dev-1", []snmppoll.SNMPMetric{
		{OID: ".1.3.6.1.2.1.1.3.0", BaseOID: "1.3.6.1.2.1.1.3.0", Name: "sysUpTime", Value: 1},
	})

	if payload["protocol"] != 2 {
		t.Errorf("protocol = %v, want 2 — the server reads the row shape off this marker", payload["protocol"])
	}
	if payload["deviceId"] != "dev-1" {
		t.Errorf("deviceId = %v, want dev-1", payload["deviceId"])
	}
	metrics, ok := payload["metrics"].([]snmppoll.SNMPMetric)
	if !ok || len(metrics) != 1 {
		t.Fatalf("metrics = %v, want the one row passed in", payload["metrics"])
	}
}

func TestSnmpPollResultPayload_StampsProtocol2ForEmptyAndLegacyPolls(t *testing.T) {
	// A poll that collected nothing, and a poll built from a legacy oids-only
	// payload, both still declare the new row shape: the marker describes the
	// AGENT, not the command it happened to receive.
	if got := snmpPollResultPayload("dev-1", nil)["protocol"]; got != 2 {
		t.Errorf("protocol on an empty poll = %v, want 2", got)
	}
}

func TestSnmpPollResultPayload_KeysAreExactlyTheContract(t *testing.T) {
	payload := snmpPollResultPayload("dev-1", nil)
	for _, key := range []string{"deviceId", "metrics", "protocol"} {
		if _, ok := payload[key]; !ok {
			t.Errorf("result payload is missing %q", key)
		}
	}
	if len(payload) != 3 {
		t.Errorf("result payload has %d keys (%v), want exactly 3", len(payload), payload)
	}
}

func TestParseSnmpPollRequest_VersionStrings(t *testing.T) {
	for _, tc := range []struct {
		wire string
		want snmppoll.SNMPVersion
	}{
		{`"v1"`, snmppoll.Version1}, {`"1"`, snmppoll.Version1},
		{`"v2c"`, snmppoll.Version2c}, {`"2c"`, snmppoll.Version2c},
		{`"v3"`, snmppoll.Version3}, {`"3"`, snmppoll.Version3},
		{`""`, snmppoll.Version2c}, {`null`, snmppoll.Version2c},
		{`"unknown"`, snmppoll.Version2c},
	} {
		t.Run(tc.wire, func(t *testing.T) {
			var payload map[string]any
			if err := json.Unmarshal([]byte(`{"target":"192.0.2.1","version":`+tc.wire+`}`), &payload); err != nil {
				t.Fatal(err)
			}
			device, errResult := parseSnmpPollRequest(payload)
			if errResult != nil {
				t.Fatal(errResult)
			}
			if got := device.ClientConfig().Version; got != tc.want {
				t.Fatalf("version = %v, want %v", got, tc.want)
			}
		})
	}
	payload := basePayload()
	delete(payload, "version")
	device, errResult := parseSnmpPollRequest(payload)
	if errResult != nil || device.Version != snmppoll.Version2c {
		t.Fatalf("missing version: %+v, %v", device, errResult)
	}
}
