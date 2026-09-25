package hwhealth

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestSnapshotWire(t *testing.T) {
	s := Snapshot{
		SnapshotID:                "4f370dba-213a-4b89-a333-012345678901",
		Sequence:                  7,
		CollectedAt:               time.Unix(1, 0).UTC(),
		AgentVersion:              "test",
		PollIntervalMinutes:       10,
		DiskHealthIntervalMinutes: 60,
		TiersRun:                  []string{"raid"},
		Sources: []SourceReport{{
			Source:      "storcli",
			Status:      "ok",
			Complete:    ptr(true),
			ToolVersion: "1",
			Path:        "tool",
			DurationMs:  1,
			Error:       "detail",
			RetryAt:     ptr(time.Unix(2, 0).UTC()),
			Warnings:    []string{"note"},
		}},
		Components: []Component{{
			ComponentKey:    "storcli:c0:e-:s1",
			ComponentType:   "physical_disk",
			ParentKey:       ptr("storcli:c0"),
			Source:          "storcli",
			Name:            "Slot 1",
			Model:           ptr("disk"),
			Serial:          ptr("S"),
			Firmware:        ptr("F"),
			SizeBytes:       ptr(int64(1)),
			State:           "online",
			StateDetail:     ptr("Onln"),
			ProgressPercent: ptr(1),
			TemperatureC:    ptr(30),
			MemberErrors:    ptr(false),
			OSHealthStatus:  ptr("healthy"),
			SmartPassed:     ptr(true),
			Attributes:      map[string]any{},
		}},
	}
	b, e := json.Marshal(s)
	if e != nil {
		t.Fatal(e)
	}
	var root map[string]json.RawMessage
	if e = json.Unmarshal(b, &root); e != nil {
		t.Fatal(e)
	}
	assertKeys(t, root, "snapshotId sequence collectedAt agentVersion pollIntervalMinutes diskHealthIntervalMinutes tiersRun sources components")
	var components, sources []map[string]json.RawMessage
	_ = json.Unmarshal(root["components"], &components)
	_ = json.Unmarshal(root["sources"], &sources)
	assertKeys(t, components[0], "componentKey componentType parentKey source name model serial firmware sizeBytes state stateDetail progressPercent temperatureC predictiveFailure alertExempt memberErrors osHealthStatus smartPassed attributes")
	assertKeys(t, sources[0], "source status complete toolVersion path durationMs error retryAt warnings")
	var round Snapshot
	if e = json.Unmarshal(b, &round); e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(s, round) {
		t.Fatalf("round trip: %#v", round)
	}
}

func assertKeys(t *testing.T, m map[string]json.RawMessage, want string) {
	t.Helper()
	got := []string{}
	for k := range m {
		got = append(got, k)
	}
	w := strings.Fields(want)
	sort.Strings(got)
	sort.Strings(w)
	if !reflect.DeepEqual(got, w) {
		t.Fatalf("keys %v want %v", got, w)
	}
}
