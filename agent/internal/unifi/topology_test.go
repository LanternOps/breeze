package unifi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/topologycanon"
)

const integ = "/proxy/network/integration/v1"

type controllerFixture struct {
	ControllerSiteID string                     `json:"controllerSiteId"`
	Sites            json.RawMessage            `json:"sites"`
	Devices          json.RawMessage            `json:"devices"`
	Clients          json.RawMessage            `json:"clients"`
	DeviceDetails    map[string]json.RawMessage `json:"deviceDetails"`
}

func loadControllerFixture(t *testing.T) controllerFixture {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "topology_resources.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f controllerFixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// fixtureController serves the recorded controller responses; detailHits counts
// device-detail requests so tests can prove details are only read when asked.
func fixtureController(t *testing.T, f controllerFixture, detailHits *int32) *httptest.Server {
	t.Helper()
	site := f.ControllerSiteID
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch p := r.URL.Path; {
		case p == integ+"/sites":
			_, _ = w.Write(f.Sites)
		case p == integ+"/sites/"+site+"/devices":
			_, _ = w.Write(f.Devices)
		case p == integ+"/sites/"+site+"/clients":
			_, _ = w.Write(f.Clients)
		case strings.HasPrefix(p, integ+"/sites/"+site+"/devices/"):
			if detailHits != nil {
				atomic.AddInt32(detailHits, 1)
			}
			body, ok := f.DeviceDetails[strings.TrimPrefix(p, integ+"/sites/"+site+"/devices/")]
			if !ok || string(body) == "null" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = w.Write(body)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func resourceOf(t *testing.T, rs []Resource, site, kind string) Resource {
	t.Helper()
	for _, r := range rs {
		if r.ControllerSiteID == site && r.Kind == kind {
			return r
		}
	}
	t.Fatalf("no %s resource for site %s in %+v", kind, site, rs)
	return Resource{}
}

func TestPollRecordsIndependentResourcesPerSite(t *testing.T) {
	f := loadControllerFixture(t)
	srv := fixtureController(t, f, nil)
	defer srv.Close()
	snap, err := NewAPIClient(srv.URL, "k", srv.Client()).PollWith(context.Background(), PollOptions{DetailBudget: 8})
	if err != nil {
		t.Fatal(err)
	}
	site := f.ControllerSiteID
	if len(snap.Resources) != 4 {
		t.Fatalf("want 4 resources (one per kind), got %d", len(snap.Resources))
	}
	dl := resourceOf(t, snap.Resources, site, ResourceDeviceList)
	if dl.Outcome != topologycanon.Complete || dl.RowCount != 2 || len(dl.DeviceList) != 2 {
		t.Fatalf("device_list = %+v", dl)
	}
	// Controller MACs arrive in either separator; rows are canonical lowercase colon form.
	for _, d := range dl.DeviceList {
		if d.DeviceID == "dev-ap-1" && (d.MAC == nil || *d.MAC != "02:00:00:00:02:02") {
			t.Fatalf("dev-ap-1 mac not normalized: %+v", d.MAC)
		}
	}
	st := resourceOf(t, snap.Resources, site, ResourceStatistics)
	if st.Outcome != topologycanon.NotAttempted || st.RowCount != 0 {
		t.Fatalf("statistics must be not_attempted in M2, got %+v", st)
	}
	// dev-switch-1 detail succeeds, dev-ap-1 404s: the lists stay complete and
	// only the detail resource records the gap.
	dd := resourceOf(t, snap.Resources, site, ResourceDeviceDetails)
	if dd.Outcome != topologycanon.Partial || dd.ReasonCode != "detail_unsupported" || len(dd.DeviceDetails) != 1 {
		t.Fatalf("device_details = %+v", dd)
	}
	row := dd.DeviceDetails[0]
	if row.DeviceID != "dev-switch-1" || row.UplinkDeviceID == nil || *row.UplinkDeviceID != "dev-gateway-1" || row.UplinkPortIndex != nil {
		t.Fatalf("detail row identity = %+v", row)
	}
	if len(row.Ports) != 3 || row.Ports[0].PortIndex != 1 || row.Ports[1].PortIndex != 2 || row.Ports[2].PortIndex != 8 {
		t.Fatalf("ports must be ascending by idx: %+v", row.Ports)
	}
	p1, p2, p8 := row.Ports[0], row.Ports[1], row.Ports[2]
	if p1.LinkUp == nil || !*p1.LinkUp || p1.SpeedMbps == nil || *p1.SpeedMbps != 1000 || p1.Name != nil || p1.PoeMode != nil {
		t.Fatalf("port 1 = %+v", p1)
	}
	if p2.LinkUp == nil || *p2.LinkUp || p2.SpeedMbps != nil {
		t.Fatalf("port 2 (down, no speed) = %+v", p2)
	}
	if p8.LinkUp != nil {
		t.Fatalf("UNKNOWN link state must stay null, got %v", *p8.LinkUp)
	}
	cl := resourceOf(t, snap.Resources, site, ResourceClientList)
	if cl.Outcome != topologycanon.Complete || cl.RowCount != 3 {
		t.Fatalf("client_list = %+v", cl)
	}
}

func TestDeviceDetail404LeavesListsComplete(t *testing.T) {
	f := loadControllerFixture(t)
	f.DeviceDetails = map[string]json.RawMessage{} // every detail 404s
	srv := fixtureController(t, f, nil)
	defer srv.Close()
	snap, err := NewAPIClient(srv.URL, "k", srv.Client()).PollWith(context.Background(), PollOptions{DetailBudget: 8})
	if err != nil {
		t.Fatalf("a detail 404 must not surface as a poll error: %v", err)
	}
	site := f.ControllerSiteID
	if r := resourceOf(t, snap.Resources, site, ResourceDeviceList); r.Outcome != topologycanon.Complete {
		t.Fatalf("device_list = %+v", r)
	}
	if r := resourceOf(t, snap.Resources, site, ResourceClientList); r.Outcome != topologycanon.Complete {
		t.Fatalf("client_list = %+v", r)
	}
	dd := resourceOf(t, snap.Resources, site, ResourceDeviceDetails)
	if dd.Outcome != topologycanon.Unsupported || dd.ReasonCode != "endpoint_unavailable" || len(dd.DeviceDetails) != 0 {
		t.Fatalf("device_details = %+v", dd)
	}
	if len(snap.Devices) != 2 || len(snap.Clients) != 3 {
		t.Fatalf("legacy rows lost: %d devices %d clients", len(snap.Devices), len(snap.Clients))
	}
}

func TestDeviceDetailsAreBoundedAndRotate(t *testing.T) {
	f := loadControllerFixture(t)
	var hits int32
	srv := fixtureController(t, f, &hits)
	defer srv.Close()
	c := NewAPIClient(srv.URL, "k", srv.Client())
	snap, err := c.PollWith(context.Background(), PollOptions{DetailBudget: 1})
	if err != nil {
		t.Fatal(err)
	}
	if hits != 1 {
		t.Fatalf("budget 1 made %d detail requests", hits)
	}
	dd := resourceOf(t, snap.Resources, f.ControllerSiteID, ResourceDeviceDetails)
	if dd.Outcome != topologycanon.Partial || dd.ReasonCode != "limit_exceeded" || dd.OmittedRowCount != 1 {
		t.Fatalf("budget-limited details = %+v", dd)
	}
	first := dd.DeviceDetails
	snap2, _ := c.PollWith(context.Background(), PollOptions{DetailBudget: 1, DetailCursor: snap.NextDetailCursor})
	dd2 := resourceOf(t, snap2.Resources, f.ControllerSiteID, ResourceDeviceDetails)
	if hits != 2 || (len(first) == 1 && len(dd2.DeviceDetails) == 1 && first[0].DeviceID == dd2.DeviceDetails[0].DeviceID) {
		t.Fatalf("cursor did not rotate: %+v then %+v", first, dd2.DeviceDetails)
	}
}

func TestPollWithoutDetailBudgetNeverReadsDetails(t *testing.T) {
	f := loadControllerFixture(t)
	var hits int32
	srv := fixtureController(t, f, &hits)
	defer srv.Close()
	snap, err := NewAPIClient(srv.URL, "k", srv.Client()).Poll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if hits != 0 {
		t.Fatalf("legacy Poll made %d detail requests", hits)
	}
	if dd := resourceOf(t, snap.Resources, f.ControllerSiteID, ResourceDeviceDetails); dd.Outcome != topologycanon.NotAttempted {
		t.Fatalf("device_details = %+v", dd)
	}
}

func TestClientTypesArePreservedAndAbsentTypeIsUnknown(t *testing.T) {
	clients := `{"data":[` +
		`{"id":"c-wired","type":"WIRED","macAddress":"F4:A9:97:00:00:01"},` +
		`{"id":"c-wifi","type":"WIRELESS","macAddress":"f4:a9:97:00:00:02"},` +
		`{"id":"c-vpn","type":"VPN","macAddress":"f4:a9:97:00:00:03","ipAddress":"198.51.100.9"},` +
		`{"id":"c-tele","type":"TELEPORT"},` +
		`{"id":"c-new","type":"SOMETHING_NEW","macAddress":"f4:a9:97:00:00:05"},` +
		`{"id":"c-none","isWired":false,"macAddress":"f4:a9:97:00:00:06","ipAddress":"not-an-ip"}]}`
	srv := realControllerServer(t, `{"data":[]}`, clients)
	defer srv.Close()
	snap, err := NewAPIClient(srv.URL, "k", srv.Client()).Poll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cl := resourceOf(t, snap.Resources, "s1", ResourceClientList)
	want := map[string]string{"c-wired": "WIRED", "c-wifi": "WIRELESS", "c-vpn": "VPN", "c-tele": "TELEPORT", "c-new": "unknown", "c-none": "unknown"}
	if len(cl.ClientList) != len(want) {
		t.Fatalf("client rows = %+v", cl.ClientList)
	}
	for _, row := range cl.ClientList {
		if row.ClientType != want[row.ClientID] || row.RowKey != row.ClientID {
			t.Errorf("%s clientType = %q, want %q", row.ClientID, row.ClientType, want[row.ClientID])
		}
		if row.UplinkPortIndex != nil || row.SSID != nil || row.VLAN != nil || row.SignalDbm != nil {
			t.Errorf("%s: list endpoint carries no port/SSID/VLAN/signal, got %+v", row.ClientID, row)
		}
		switch row.ClientID {
		case "c-wired":
			if row.MAC == nil || *row.MAC != "f4:a9:97:00:00:01" {
				t.Errorf("mac not canonical: %v", row.MAC)
			}
		case "c-tele":
			if row.MAC != nil || row.IPAddress != nil || row.UplinkDeviceID != nil {
				t.Errorf("absent fields must be null: %+v", row)
			}
		case "c-none":
			if row.IPAddress != nil {
				t.Errorf("invalid IP must be null, got %q", *row.IPAddress)
			}
		}
	}
}

func TestOneSiteFailingLeavesTheOtherComplete(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case integ + "/sites":
			_, _ = w.Write([]byte(`{"data":[{"id":"ok"},{"id":"bad"}]}`))
		case integ + "/sites/ok/devices":
			_, _ = w.Write([]byte(`{"data":[{"id":"d1","macAddress":"02:00:00:00:00:01"}]}`))
		case integ + "/sites/ok/clients":
			_, _ = w.Write([]byte(`{"data":[{"id":"c1","type":"WIRED"}]}`))
		case integ + "/sites/bad/devices", integ + "/sites/bad/clients":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	snap, err := NewAPIClient(srv.URL, "k", srv.Client()).Poll(context.Background())
	if err == nil {
		t.Fatal("the failing site must still be reported in the legacy error")
	}
	for _, kind := range []string{ResourceDeviceList, ResourceClientList} {
		if r := resourceOf(t, snap.Resources, "ok", kind); r.Outcome != topologycanon.Complete || r.RowCount != 1 {
			t.Fatalf("ok/%s = %+v", kind, r)
		}
		if r := resourceOf(t, snap.Resources, "bad", kind); r.Outcome != topologycanon.Failed || r.ReasonCode != "request_failed" || r.RowCount != 0 {
			t.Fatalf("bad/%s = %+v", kind, r)
		}
	}
}

func TestListPage404OnlyMarksThatResourceUnsupported(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case integ + "/sites":
			_, _ = w.Write([]byte(`{"data":[{"id":"s1"}]}`))
		case integ + "/sites/s1/devices":
			_, _ = w.Write([]byte(`{"data":[{"id":"d1"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound) // the client list endpoint is absent
		}
	}))
	defer srv.Close()
	snap, _ := NewAPIClient(srv.URL, "k", srv.Client()).Poll(context.Background())
	if !snap.FirmwareOK {
		t.Fatal("a client-list 404 is not a firmware verdict")
	}
	if r := resourceOf(t, snap.Resources, "s1", ResourceClientList); r.Outcome != topologycanon.Unsupported || r.ReasonCode != "endpoint_unavailable" {
		t.Fatalf("client_list = %+v", r)
	}
	if r := resourceOf(t, snap.Resources, "s1", ResourceDeviceList); r.Outcome != topologycanon.Complete || r.RowCount != 1 {
		t.Fatalf("device_list = %+v", r)
	}
}

func buildFromFixture(t *testing.T, f controllerFixture, source, epoch string) *TopologyV1 {
	t.Helper()
	srv := fixtureController(t, f, nil)
	defer srv.Close()
	snap, err := NewAPIClient(srv.URL, "k", srv.Client()).PollWith(context.Background(), PollOptions{DetailBudget: 8})
	if err != nil {
		t.Fatal(err)
	}
	captured := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	report, err := BuildTopologyV1(snap, TopologyIdentity{SourceIdentity: source, ProducerEpoch: epoch}, 3, captured, captured.Add(1500*time.Millisecond), 300)
	if err != nil {
		t.Fatal(err)
	}
	return report
}

// The Go builder, fed controller responses that mirror the shared vector, must
// land on exactly the shared contract's digests (cross-language pin).
func TestBuildTopologyV1MatchesSharedFixtureDigests(t *testing.T) {
	vec := loadUnifiVectors(t).Vectors[0]
	var shared TopologyV1
	if err := json.Unmarshal(vec.Report, &shared); err != nil {
		t.Fatal(err)
	}
	report := buildFromFixture(t, loadControllerFixture(t), vec.SourceIdentity, shared.ProducerEpoch)
	if report.Version != 1 || report.Sequence != "3" || report.ExpectedIntervalSeconds != 300 || report.CaptureAgeAtSendMS == nil || *report.CaptureAgeAtSendMS != 1500 {
		t.Fatalf("envelope = %+v", report)
	}
	if report.CapturedAt != "2026-09-15T12:00:00Z" || len(report.SnapshotID) != 36 {
		t.Fatalf("capturedAt/snapshotId = %q %q", report.CapturedAt, report.SnapshotID)
	}
	for _, kind := range []string{ResourceDeviceList, ResourceClientList} {
		got := resourceOf(t, report.Resources, shared.Resources[0].ControllerSiteID, kind)
		want := resourceOf(t, shared.Resources, shared.Resources[0].ControllerSiteID, kind)
		if got.ContentDigest != want.ContentDigest {
			gb, _ := CanonicalizeTopologyResource(vec.SourceIdentity, shared.ProducerEpoch, got)
			t.Fatalf("%s digest %s != shared %s\ncanonical: %s", kind, got.ContentDigest, want.ContentDigest, gb)
		}
	}
	// Every resource digest is the canonical digest of what is on the wire.
	b, _ := json.Marshal(report)
	var back TopologyV1
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	for _, r := range back.Resources {
		c, err := CanonicalizeTopologyResource(vec.SourceIdentity, shared.ProducerEpoch, r)
		if err != nil || topologycanon.DigestHex(c) != r.ContentDigest {
			t.Fatalf("%s wire digest does not verify (%v)", r.Kind, err)
		}
	}
}

func TestTopologyDigestStableUnderControllerReordering(t *testing.T) {
	f := loadControllerFixture(t)
	a := buildFromFixture(t, f, "src", "epoch")
	var env struct {
		Data []json.RawMessage `json:"data"`
	}
	for _, field := range []*json.RawMessage{&f.Devices, &f.Clients} {
		if err := json.Unmarshal(*field, &env); err != nil {
			t.Fatal(err)
		}
		for i, j := 0, len(env.Data)-1; i < j; i, j = i+1, j-1 {
			env.Data[i], env.Data[j] = env.Data[j], env.Data[i]
		}
		*field, _ = json.Marshal(map[string]any{"data": env.Data, "totalCount": len(env.Data)})
	}
	b := buildFromFixture(t, f, "src", "epoch")
	for _, ra := range a.Resources {
		rb := resourceOf(t, b.Resources, ra.ControllerSiteID, ra.Kind)
		if ra.ContentDigest != rb.ContentDigest {
			t.Fatalf("%s digest changed under reordering", ra.Kind)
		}
	}
	if a.SnapshotID == b.SnapshotID {
		t.Fatal("each capture needs its own snapshotId")
	}
}

// ---- collector wiring ----

type capturedUpload struct {
	mu     sync.Mutex
	bodies []map[string]json.RawMessage
	// respond, when set, builds the 202 response body for an upload.
	respond func(body map[string]json.RawMessage) any
}

// echoReceipts accepts every uploaded resource at its own digest, like the API
// route's `topology` receipt block.
func echoReceipts(body map[string]json.RawMessage) any {
	raw, ok := body["topologyV1"]
	if !ok {
		return map[string]any{"accepted": true}
	}
	var r TopologyV1
	_ = json.Unmarshal(raw, &r)
	resources := make([]map[string]any, 0, len(r.Resources))
	for _, res := range r.Resources {
		resources = append(resources, map[string]any{"controllerSiteId": res.ControllerSiteID, "kind": res.Kind, "accepted": true, "contentDigest": res.ContentDigest})
	}
	return map[string]any{"accepted": true, "topology": map[string]any{"accepted": true, "reportSequence": r.Sequence, "resources": resources}}
}

func (c *capturedUpload) server(t *testing.T, cfgs string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/agents/agent-1/unifi-telemetry":
			var m map[string]json.RawMessage
			_ = json.NewDecoder(r.Body).Decode(&m)
			c.mu.Lock()
			c.bodies = append(c.bodies, m)
			c.mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			if c.respond != nil {
				_ = json.NewEncoder(w).Encode(c.respond(m))
			}
		case "/api/v1/agents/agent-1/unifi-collectors":
			_, _ = w.Write([]byte(cfgs))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestRunOnceOmitsTopologyWithoutAdvertisement(t *testing.T) {
	f := loadControllerFixture(t)
	var hits int32
	controller := fixtureController(t, f, &hits)
	defer controller.Close()
	up := &capturedUpload{}
	api := up.server(t, "")
	defer api.Close()
	deps := CollectorDeps{APIBaseURL: func() string { return api.URL }, AgentID: "agent-1", HTTP: api.Client(), StateDir: t.TempDir()}
	for _, cfg := range []CollectorConfig{
		{CollectorID: "c1", ControllerURL: controller.URL, APIKey: "k"},
		{CollectorID: "c1", ControllerURL: controller.URL, APIKey: "k", AcceptedUnifiTopologyVersions: []int{2}, TopologyProducerEpoch: "e", TopologySourceIdentity: "s"},
		// Advertised, but without a server-issued epoch there is nothing to fence on.
		{CollectorID: "c1", ControllerURL: controller.URL, APIKey: "k", AcceptedUnifiTopologyVersions: []int{1}},
	} {
		if err := RunOnce(context.Background(), deps, cfg, controller.Client()); err != nil {
			t.Fatal(err)
		}
	}
	if len(up.bodies) != 3 {
		t.Fatalf("uploads = %d", len(up.bodies))
	}
	for i, b := range up.bodies {
		if _, ok := b["topologyV1"]; ok {
			t.Fatalf("upload %d carried topologyV1 without a v1 advertisement + epoch", i)
		}
		// Legacy clients keep isWired; type is not a legacy field.
		var clients []map[string]any
		_ = json.Unmarshal(b["clients"], &clients)
		if len(clients) != 3 || clients[0]["isWired"] == nil || clients[0]["clientType"] != nil {
			t.Fatalf("legacy client shape changed: %+v", clients)
		}
	}
	if hits != 0 {
		t.Fatalf("legacy-only uploads made %d detail requests", hits)
	}
	if entries, _ := os.ReadDir(deps.StateDir); len(entries) != 0 {
		t.Fatalf("legacy-only uploads wrote topology state: %v", entries)
	}
}

func TestRunOnceAttachesTopologyV1AndPersistsSequence(t *testing.T) {
	f := loadControllerFixture(t)
	controller := fixtureController(t, f, nil)
	defer controller.Close()
	up := &capturedUpload{respond: echoReceipts}
	api := up.server(t, "")
	defer api.Close()
	dir := t.TempDir()
	deps := CollectorDeps{APIBaseURL: func() string { return api.URL }, AgentID: "agent-1", HTTP: api.Client(), StateDir: dir}
	cfg := CollectorConfig{CollectorID: "c1", ControllerURL: controller.URL, APIKey: "k", PollIntervalSeconds: 300,
		AcceptedUnifiTopologyVersions: []int{1}, TopologyProducerEpoch: "epoch-1", TopologySourceIdentity: "org:site:unifi:dev:c1"}
	for i := 0; i < 2; i++ {
		if err := RunOnce(context.Background(), deps, cfg, controller.Client()); err != nil {
			t.Fatal(err)
		}
	}
	var seqs []string
	for _, b := range up.bodies {
		raw, ok := b["topologyV1"]
		if !ok {
			t.Fatal("advertised collector upload lacks topologyV1")
		}
		var r TopologyV1
		if err := json.Unmarshal(raw, &r); err != nil {
			t.Fatal(err)
		}
		if r.ProducerEpoch != "epoch-1" || len(r.Resources) != 4 || r.ExpectedIntervalSeconds != 300 {
			t.Fatalf("topologyV1 = %+v", r)
		}
		seqs = append(seqs, r.Sequence)
		// The legacy body is still complete alongside the companion.
		var devices []any
		_ = json.Unmarshal(b["devices"], &devices)
		if len(devices) != 2 {
			t.Fatalf("legacy devices = %d", len(devices))
		}
	}
	// No prior state: the first sequence starts from a wall-clock floor so a
	// lost state file can never replay numbers the server already accepted.
	s0, _ := strconv.ParseUint(seqs[0], 10, 64)
	s1, _ := strconv.ParseUint(seqs[1], 10, 64)
	if s0 < uint64(time.Now().Add(-time.Hour).UnixMilli()) || s1 != s0+1 {
		t.Fatalf("sequences = %v", seqs)
	}
	// Sequence survives a restart (fresh state handle) and an epoch change resets it.
	st, err := OpenTopologyState(topologyStatePath(dir, "c1"))
	if err != nil {
		t.Fatal(err)
	}
	snap := st.Snapshot()
	if snap.Sequence != s1 || snap.ProducerEpoch != "epoch-1" || len(snap.AcknowledgedDigests) != 4 || snap.AcknowledgedSequence != seqs[1] {
		t.Fatalf("persisted state = %+v", snap)
	}
	cfg.TopologyProducerEpoch = "epoch-2"
	if err := RunOnce(context.Background(), deps, cfg, controller.Client()); err != nil {
		t.Fatal(err)
	}
	var r TopologyV1
	_ = json.Unmarshal(up.bodies[2]["topologyV1"], &r)
	if r.ProducerEpoch != "epoch-2" || r.Sequence != "1" {
		t.Fatalf("new epoch must restart the sequence: %s/%s", r.ProducerEpoch, r.Sequence)
	}
}

func TestTopologyStateRejectsCorruptFileWithoutResettingSilently(t *testing.T) {
	dir := t.TempDir()
	path := topologyStatePath(dir, "c1")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := OpenTopologyState(path)
	if err == nil {
		t.Fatal("corrupt state must be reported")
	}
	// A corrupt file only ever recovers through a (new or re-installed) epoch.
	if _, err := st.AllocateSequence(); err == nil {
		t.Fatal("allocation without an epoch must fail")
	}
	if err := st.InstallEpoch("src", "epoch-x"); err != nil {
		t.Fatal(err)
	}
	if seq, err := st.AllocateSequence(); err != nil || seq <= uint64(time.Now().Add(-time.Hour).UnixMilli()) {
		t.Fatalf("recovered sequence must jump past any counter value: seq = %d err = %v", seq, err)
	}
	// A clean epoch rotation afterwards restarts at 1.
	if err := st.InstallEpoch("src", "epoch-y"); err != nil {
		t.Fatal(err)
	}
	if seq, err := st.AllocateSequence(); err != nil || seq != 1 {
		t.Fatalf("seq = %d err = %v", seq, err)
	}
}

func TestTopologyStatePathIsSafeForHostileCollectorIDs(t *testing.T) {
	dir := t.TempDir()
	p := topologyStatePath(dir, "../../etc/passwd")
	if filepath.Dir(p) != dir || strings.Contains(filepath.Base(p), "..") {
		t.Fatalf("state path escaped the state dir: %s", p)
	}
	if topologyStatePath(dir, "a/b") == topologyStatePath(dir, "a_b") {
		t.Fatal("distinct collector ids must not share state")
	}
}

func TestDuplicateControllerRowsAreDroppedAndMarkedPartial(t *testing.T) {
	clients := `{"data":[{"id":"c1","type":"WIRED"},{"id":"c2","type":"VPN"},{"id":"c1","type":"WIRELESS"},{"type":"WIRED"}]}`
	srv := realControllerServer(t, `{"data":[]}`, clients)
	defer srv.Close()
	snap, _ := NewAPIClient(srv.URL, "k", srv.Client()).Poll(context.Background())
	cl := resourceOf(t, snap.Resources, "s1", ResourceClientList)
	// An id-less element is invalid (no source-local identity) and takes precedence.
	if cl.Outcome != topologycanon.Partial || cl.ReasonCode != "invalid_row" || cl.RowCount != 2 || len(cl.ClientList) != 2 {
		t.Fatalf("client_list = %+v", cl)
	}
	if cl.ClientList[0].RowKey != "c1" || cl.ClientList[0].ClientType != "WIRED" || cl.ClientList[1].RowKey != "c2" {
		t.Fatalf("rows = %+v", cl.ClientList)
	}
	if len(snap.Clients) != 4 {
		t.Fatalf("legacy upload keeps every decoded element, got %d", len(snap.Clients))
	}
}

// Acknowledgement comes from the server's per-resource receipts, never from the
// HTTP status alone (M2 Task 5).
func TestRunOnceAcknowledgesOnlyAcceptedReceiptDigests(t *testing.T) {
	f := loadControllerFixture(t)
	controller := fixtureController(t, f, nil)
	defer controller.Close()
	cfg := CollectorConfig{CollectorID: "c1", ControllerURL: controller.URL, APIKey: "k", PollIntervalSeconds: 300,
		AcceptedUnifiTopologyVersions: []int{1}, TopologyProducerEpoch: "epoch-1", TopologySourceIdentity: "org:site:unifi:dev:c1"}
	run := func(respond func(map[string]json.RawMessage) any) (TopologyProducerState, TopologyV1) {
		t.Helper()
		up := &capturedUpload{respond: respond}
		api := up.server(t, "")
		defer api.Close()
		dir := t.TempDir()
		deps := CollectorDeps{APIBaseURL: func() string { return api.URL }, AgentID: "agent-1", HTTP: api.Client(), StateDir: dir}
		if err := RunOnce(context.Background(), deps, cfg, controller.Client()); err != nil {
			t.Fatal(err)
		}
		var r TopologyV1
		_ = json.Unmarshal(up.bodies[0]["topologyV1"], &r)
		st, err := OpenTopologyState(topologyStatePath(dir, "c1"))
		if err != nil {
			t.Fatal(err)
		}
		return st.Snapshot(), r
	}

	// Older server: HTTP 202 without receipts acknowledges nothing (legacy-only).
	snap, _ := run(nil)
	if len(snap.AcknowledgedDigests) != 0 || snap.AcknowledgedSequence != "" {
		t.Fatalf("202 without receipts must not acknowledge: %+v", snap)
	}

	// Mixed receipts: one accepted at the sent digest, one accepted at a
	// different digest, one rejected, one missing.
	snap, sent := run(func(body map[string]json.RawMessage) any {
		var r TopologyV1
		_ = json.Unmarshal(body["topologyV1"], &r)
		return map[string]any{"accepted": true, "topology": map[string]any{"accepted": false, "reportSequence": r.Sequence, "resources": []map[string]any{
			{"controllerSiteId": r.Resources[0].ControllerSiteID, "kind": r.Resources[0].Kind, "accepted": true, "contentDigest": r.Resources[0].ContentDigest},
			{"controllerSiteId": r.Resources[1].ControllerSiteID, "kind": r.Resources[1].Kind, "accepted": true, "contentDigest": strings.Repeat("f", 64)},
			{"controllerSiteId": r.Resources[2].ControllerSiteID, "kind": r.Resources[2].Kind, "accepted": false, "reason": "controller_site_unmapped"},
		}}}
	})
	if len(snap.AcknowledgedDigests) != 1 || snap.AcknowledgedDigests[ResourceKey(sent.Resources[0])] != sent.Resources[0].ContentDigest || snap.AcknowledgedSequence != sent.Sequence {
		t.Fatalf("acknowledged = %+v", snap.AcknowledgedDigests)
	}

	// Receipts for a different report sequence are ignored.
	snap, _ = run(func(body map[string]json.RawMessage) any {
		receipts := echoReceipts(body).(map[string]any)
		receipts["topology"].(map[string]any)["reportSequence"] = "1"
		return receipts
	})
	if len(snap.AcknowledgedDigests) != 0 {
		t.Fatalf("receipts for another sequence acknowledged: %+v", snap.AcknowledgedDigests)
	}
}
