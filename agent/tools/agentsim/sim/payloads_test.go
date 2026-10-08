package sim

import (
	"encoding/json"
	"math/rand/v2"
	"strings"
	"testing"
	"time"
)

func asJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func testPayloads() *Payloads {
	cfg := DefaultConfig()
	return NewPayloads(&cfg, rand.New(rand.NewPCG(1, 2)))
}

var testID = Identity{Index: 2, Hostname: "agentsim-abc123-00002", AgentID: "a2", DeviceID: "d2", OrgID: "o1"}

func TestHeartbeatPayloadCarriesTheRequiredFields(t *testing.T) {
	m := asJSON(t, testPayloads().Heartbeat(testID, 72*time.Hour))
	if m["status"] != "ok" || m["agentVersion"] != "dev-agentsim" || m["hostname"] != testID.Hostname {
		t.Fatalf("heartbeat %v", m)
	}
	caps := m["securityCapabilities"].(map[string]any)
	if caps["revocationLeaseProtocolVersion"] != float64(1) {
		t.Fatalf("capabilities %v", caps)
	}
	metrics := m["metrics"].(map[string]any)
	for _, k := range []string{"cpuPercent", "ramPercent", "ramUsedMb", "diskPercent", "diskUsedGb"} {
		if _, ok := metrics[k]; !ok {
			t.Errorf("metrics.%s missing (required by heartbeatSchema)", k)
		}
	}
}

func TestSoftwareObservationSatisfiesTheV2Refinements(t *testing.T) {
	m := asJSON(t, testPayloads().Software(time.Now()))
	items := m["items"].([]any)
	if m["schemaVersion"] != float64(2) || int(m["itemCount"].(float64)) != len(items) || len(items) == 0 {
		t.Fatalf("itemCount must equal len(items): %v / %d", m["itemCount"], len(items))
	}
	if fs, ok := m["failedSources"].([]any); !ok || len(fs) != 0 {
		t.Fatalf("failedSources must be an empty array, not null: %v", m["failedSources"])
	}
	if m["completeness"] != "complete" || !strings.HasSuffix(m["observedAt"].(string), "Z") {
		t.Fatalf("completeness/observedAt %v %v", m["completeness"], m["observedAt"])
	}
}

func TestSessionPrincipalHasExactlyOneOfUIDOrSID(t *testing.T) {
	m := asJSON(t, testPayloads().Sessions(time.Now()))
	s := m["sessions"].([]any)[0].(map[string]any)
	p := s["principal"].(map[string]any)
	_, hasUID := p["uid"]
	_, hasSID := p["sid"]
	if !hasUID || hasSID {
		t.Fatalf("principal must carry exactly one of uid/sid: %v", p)
	}
	if ev, ok := m["events"].([]any); !ok || len(ev) != 0 {
		t.Fatalf("events must be an empty array: %v", m["events"])
	}
}

func TestPerAgentIdentityFieldsDiffer(t *testing.T) {
	if macFor(1) == macFor(2) || ipFor(1) == ipFor(2) {
		t.Fatal("MAC and IP must be distinct per agent")
	}
	ps := asJSON(t, testPayloads().ProcessSample(time.Now()))
	if n := len(ps["processes"].([]any)); n == 0 || n > 16 {
		t.Fatalf("processes %d, schema allows 1..16", n)
	}
}
