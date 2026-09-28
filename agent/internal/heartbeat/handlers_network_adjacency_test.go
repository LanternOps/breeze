package heartbeat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/discovery"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/snmppoll"
)

func fdbTarget(ip string, rows int) discovery.TargetPhysical {
	fdb := discovery.PhysicalSection{Kind: discovery.SectionFDB, ContextKey: "default", Outcome: discovery.OutcomeComplete, Fdb: []discovery.FdbRow{}}
	for i := 0; i < rows; i++ {
		mac := strings.Repeat("0", 2) + ":00:00:" + hexByte(i>>16) + ":" + hexByte(i>>8) + ":" + hexByte(i)
		fdb.Fdb = append(fdb.Fdb, discovery.FdbRow{RowKey: "default|-|" + mac + "|3", BridgeContext: "default", MAC: mac, BridgePort: 3, Status: snmppoll.FdbStatusLearned,
			VLANMapping: snmppoll.VLANMappingUnknown, IfName: strings.Repeat("y", 100)})
	}
	fdb.RowCount = len(fdb.Fdb)
	return discovery.TargetPhysical{Target: ip, CapturedAt: time.Now().UTC(), Sections: []discovery.PhysicalSection{fdb}}
}

func hexByte(n int) string {
	const h = "0123456789abcdef"
	return string([]byte{h[(n>>4)&15], h[n&15]})
}

func withStubPhysical(t *testing.T, targets []discovery.TargetPhysical, gotProtocols *[]string) {
	t.Helper()
	prev := collectDiscoveryPhysical
	collectDiscoveryPhysical = func(_ *discovery.Scanner, _ context.Context, _ []discovery.DiscoveredHost, protocols []string, _ string) []discovery.TargetPhysical {
		if gotProtocols != nil {
			*gotProtocols = protocols
		}
		return targets
	}
	t.Cleanup(func() { collectDiscoveryPhysical = prev })
}

func TestBoundLegacyAdjacencyCapsRowsAndBytes(t *testing.T) {
	var blocks []discovery.DeviceAdjacency
	for i := 0; i < 5; i++ {
		b := discovery.LegacyAdjacencyFromSections("10.0.0."+hexByte(i), fdbTarget("x", 3000).Sections)
		b.Lldp = append(b.Lldp, discovery.LldpNeighbor{LocalPort: "1", RemoteChassisID: "c", RemotePortID: "p"})
		blocks = append(blocks, b)
	}
	out, truncated := boundLegacyAdjacency(blocks)
	if !truncated {
		t.Fatal("expected truncation flag")
	}
	for _, b := range out {
		if n := len(b.Lldp) + len(b.Cdp) + len(b.Fdb); n > legacyAdjacencyRowsPerTarget {
			t.Fatalf("target has %d rows", n)
		}
		if len(b.Lldp) != 1 {
			t.Fatal("fdb must be trimmed before lldp")
		}
	}
	enc, _ := json.Marshal(out)
	if len(enc) > legacyAdjacencyMaxBytes {
		t.Fatalf("legacy adjacency %d bytes exceeds cap", len(enc))
	}
	one := []discovery.DeviceAdjacency{{SourceDeviceIP: "10.0.0.1", Lldp: []discovery.LldpNeighbor{}, Cdp: []discovery.CdpNeighbor{}, Fdb: []discovery.FdbEntry{{MAC: "02:00:00:00:00:01", BridgePort: 1}}}}
	if got, tr := boundLegacyAdjacency(one); tr || len(got) != 1 || len(got[0].Fdb) != 1 {
		t.Fatal("small adjacency must pass untouched")
	}
}

func TestNetworkDiscoveryLegacyOnlyWithoutTopologyBlock(t *testing.T) {
	var posts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { posts++ }))
	defer srv.Close()
	withStubPhysical(t, []discovery.TargetPhysical{fdbTarget("192.0.2.10", 2)}, nil)
	h := &Heartbeat{config: &config.Config{ServerURL: srv.URL, AgentID: "agent-1", AuthToken: "tok"}, client: srv.Client()}
	res := handleNetworkDiscovery(h, Command{ID: "20000000-0000-4000-8000-000000000001", Type: tools.CmdNetworkDiscovery,
		Payload: map[string]any{"jobId": "20000000-0000-4000-8000-000000000001", "subnets": []any{"127.0.0.1/32"}, "methods": []any{"ping"}, "timeout": float64(1)}})
	if res.Status != "completed" {
		t.Fatalf("status %s %s", res.Status, res.Error)
	}
	if posts != 0 {
		t.Fatal("posted V2 without an advertised capability")
	}
	var data map[string]any
	_ = json.Unmarshal([]byte(res.Stdout), &data)
	adj, _ := data["adjacency"].([]any)
	if len(adj) != 1 {
		t.Fatalf("legacy adjacency = %v", data["adjacency"])
	}
}

func TestNetworkDiscoveryPostsV2WhenAdvertisedAndBoundsResult(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		bodies = append(bodies, body)
		auth = r.Header.Get("Authorization")
		mu.Unlock()
		if r.URL.Path != "/api/v1/agents/agent-1/topology/adjacency" {
			w.WriteHeader(404)
			return
		}
		report := body["report"].(map[string]any)
		_ = json.NewEncoder(w).Encode(map[string]any{"accepted": true, "contentDigest": report["contentDigest"], "baseSnapshotId": report["snapshotId"], "receipts": []any{}})
	}))
	defer srv.Close()
	t.Setenv("BREEZE_DATA_DIR", t.TempDir())
	var protocols []string
	withStubPhysical(t, []discovery.TargetPhysical{fdbTarget("192.0.2.10", 3000), fdbTarget("192.0.2.11", 1)}, &protocols)
	h := &Heartbeat{config: &config.Config{ServerURL: srv.URL, AgentID: "agent-1", AuthToken: "tok"}, client: srv.Client()}
	h.adjacencyStatePath = t.TempDir() + "/state.json"
	job := "20000000-0000-4000-8000-000000000001"
	res := handleNetworkDiscovery(h, Command{ID: job, Type: tools.CmdNetworkDiscovery, Payload: map[string]any{
		"jobId": job, "subnets": []any{"127.0.0.1/32"}, "methods": []any{"ping"}, "timeout": float64(1),
		"topology": map[string]any{"acceptedAdjacencyVersions": []any{float64(2)}, "producerEpoch": strings.Repeat("a", 64), "sourceIdentity": "o:s:discovery:d",
			"deadline": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339), "protocols": []any{"lldp", "fdb"}, "contexts": []any{"default"}, "expectedIntervalSeconds": float64(3600)},
	}})
	if res.Status != "completed" {
		t.Fatalf("status %s %s", res.Status, res.Error)
	}
	if len(protocols) != 2 || protocols[0] != "lldp" || protocols[1] != "fdb" {
		t.Fatalf("collection not filtered to requested protocols: %v", protocols)
	}
	if len(bodies) != 2 || auth != "Bearer tok" {
		t.Fatalf("posts=%d auth=%q", len(bodies), auth)
	}
	for _, b := range bodies {
		report := b["report"].(map[string]any)
		if b["parentJobId"] != job || report["parentCommandId"] != job || report["reportKind"] != "full" {
			t.Fatalf("bad body %v", b["parentJobId"])
		}
	}
	var data map[string]any
	_ = json.Unmarshal([]byte(res.Stdout), &data)
	if _, ok := data["hosts"]; !ok {
		t.Fatal("hosts missing from result")
	}
	if data["adjacencyTruncated"] != true {
		t.Fatalf("expected adjacencyTruncated, got %v", data["adjacencyTruncated"])
	}
	if len(res.Stdout) > 2*1024*1024 {
		t.Fatalf("result %d bytes", len(res.Stdout))
	}
}
