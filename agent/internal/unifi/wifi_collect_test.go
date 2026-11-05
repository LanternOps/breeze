package unifi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/topologycanon"
)

// stubResp scripts one controller answer. drop closes the connection (transport error).
type stubResp struct {
	status int
	body   string
	drop   bool
}

// wifiController is a fake Integration API that counts every request by kind so
// request-budget claims are proven against the wire, not the implementation.
type wifiController struct {
	site, devices, clients string
	details, stats         map[string]stubResp
	statsHits, detailHits  int32
	allHits                int32
	mu                     sync.Mutex
	order                  []string // "detail" / "stats" in request order
	statsIDs               []string
	onStats                func()
}

func (wc *wifiController) server(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&wc.allHits, 1)
		p := r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		answer := func(s stubResp, ok bool) {
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if s.drop {
				hj, _ := w.(http.Hijacker)
				c, _, _ := hj.Hijack()
				_ = c.Close()
				return
			}
			if s.status != 0 {
				w.WriteHeader(s.status)
			}
			_, _ = w.Write([]byte(s.body))
		}
		prefix := integ + "/sites/" + wc.site + "/devices/"
		switch {
		case p == integ+"/sites":
			_, _ = fmt.Fprintf(w, `{"data":[{"id":%q,"name":"Default"}],"offset":0,"limit":200,"count":1,"totalCount":1}`, wc.site)
		case p == integ+"/sites/"+wc.site+"/devices":
			_, _ = w.Write([]byte(wc.devices))
		case p == integ+"/sites/"+wc.site+"/clients":
			_, _ = w.Write([]byte(wc.clients))
		case strings.HasPrefix(p, prefix) && strings.HasSuffix(p, "/statistics/latest"):
			id := strings.TrimSuffix(strings.TrimPrefix(p, prefix), "/statistics/latest")
			atomic.AddInt32(&wc.statsHits, 1)
			wc.mu.Lock()
			wc.order, wc.statsIDs = append(wc.order, "stats"), append(wc.statsIDs, id)
			wc.mu.Unlock()
			if wc.onStats != nil {
				wc.onStats()
			}
			s, ok := wc.stats[id]
			answer(s, ok)
		case strings.HasPrefix(p, prefix):
			id := strings.TrimPrefix(p, prefix)
			atomic.AddInt32(&wc.detailHits, 1)
			wc.mu.Lock()
			wc.order = append(wc.order, "detail")
			wc.mu.Unlock()
			s, ok := wc.details[id]
			answer(s, ok)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func devList(rows ...string) string {
	return fmt.Sprintf(`{"data":[%s],"offset":0,"limit":200,"count":%d,"totalCount":%d}`, strings.Join(rows, ","), len(rows), len(rows))
}

func apRow(id string) string {
	return fmt.Sprintf(`{"id":%q,"model":"E7","state":"ONLINE","features":["accessPoint"],"interfaces":["radios"]}`, id)
}

const okStats = `{"uptimeSec":1,"cpuUtilizationPct":1.5,"memoryUtilizationPct":2.5,"uplink":{},"interfaces":{"radios":[{"frequencyGHz":5,"txRetriesPct":0.0}]}}`

func newWifiController(t *testing.T, aps int, extraRows ...string) *wifiController {
	t.Helper()
	wc := &wifiController{site: "site-1", details: map[string]stubResp{}, stats: map[string]stubResp{},
		clients: `{"data":[],"offset":0,"limit":200,"count":0,"totalCount":0}`}
	var rows []string
	for i := 0; i < aps; i++ {
		id := fmt.Sprintf("ap-%03d", i)
		rows = append(rows, apRow(id))
		wc.stats[id] = stubResp{body: okStats}
		wc.details[id] = stubResp{body: fmt.Sprintf(`{"id":%q,"features":{"accessPoint":{}},"interfaces":{"radios":[{"frequencyGHz":5,"channel":36,"channelWidthMHz":80,"wlanStandard":"802.11ax"}]}}`, id)}
	}
	wc.devices = devList(append(rows, extraRows...)...)
	return wc
}

type wifiDeps struct {
	deps CollectorDeps
	up   *capturedUpload
	dir  string
	logs *[]string
	stop func()
}

func newWifiDeps(t *testing.T) wifiDeps {
	t.Helper()
	up := &capturedUpload{respond: echoReceiptsAny}
	api := up.server(t, "")
	var logs []string
	var mu sync.Mutex
	dir := t.TempDir()
	return wifiDeps{up: up, dir: dir, logs: &logs, stop: api.Close, deps: CollectorDeps{APIBaseURL: func() string { return api.URL }, AgentID: "agent-1",
		HTTP: api.Client(), StateDir: dir, Logf: func(f string, a ...any) { mu.Lock(); logs = append(logs, fmt.Sprintf(f, a...)); mu.Unlock() }}}
}

// echoReceiptsAny accepts whichever single companion was uploaded, like the route.
func echoReceiptsAny(body map[string]json.RawMessage) any {
	if _, ok := body["topologyV2"]; !ok {
		return echoReceipts(body)
	}
	var r TopologyV2
	_ = json.Unmarshal(body["topologyV2"], &r)
	resources := make([]map[string]any, 0, len(r.Resources))
	for _, res := range r.Resources {
		resources = append(resources, map[string]any{"controllerSiteId": res.ControllerSiteID, "kind": res.Kind, "accepted": true, "contentDigest": res.ContentDigest})
	}
	return map[string]any{"accepted": true, "topology": map[string]any{"accepted": true, "reportSequence": r.Sequence, "resources": resources}}
}

func v2Of(t *testing.T, b map[string]json.RawMessage) TopologyV2 {
	t.Helper()
	raw, ok := b["topologyV2"]
	if !ok {
		t.Fatal("no topologyV2 in upload")
	}
	var r TopologyV2
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func v2ResourceOf(r TopologyV2, kind string) ResourceV2 {
	for _, x := range r.Resources {
		if x.Kind == kind {
			return x
		}
	}
	return ResourceV2{}
}

func cfgFor(url string, interval int, versions ...int) CollectorConfig {
	return CollectorConfig{CollectorID: "c1", ControllerURL: url, APIKey: "k", PollIntervalSeconds: interval,
		AcceptedUnifiTopologyVersions: versions, TopologyProducerEpoch: "epoch-1", TopologySourceIdentity: "org:site:unifi:dev:c1"}
}

func poll(t *testing.T, ctx context.Context, wc *wifiController, ts *httptest.Server, o PollOptions) Snapshot {
	t.Helper()
	snap, err := NewAPIClient(ts.URL, "k", ts.Client()).PollWith(ctx, o)
	if err != nil {
		t.Fatal(err)
	}
	return snap
}

// ---- §6.2 / §6.3 / maintainer (3): request budget ----

func TestStatisticsRequestsAreBounded_Spec63(t *testing.T) {
	for _, tc := range []struct{ interval, wantPerPoll int }{{15, 4}, {30, 8}, {60, 16}, {120, 16}} {
		t.Run(fmt.Sprintf("interval %ds", tc.interval), func(t *testing.T) {
			wc := newWifiController(t, 40, `{"id":"sw-1","model":"USW","state":"ONLINE","features":["switching"],"interfaces":["ports"]}`,
				`{"id":"zz-u6-by-name","model":"U6-Pro","state":"ONLINE"}`) // model name alone is NOT an AP signal
			ts := wc.server(t)
			defer ts.Close()
			d := newWifiDeps(t)
			defer d.stop()
			if err := RunOnce(context.Background(), d.deps, cfgFor(ts.URL, tc.interval, 1, 2), ts.Client()); err != nil {
				t.Fatal(err)
			}
			if int(wc.statsHits) != tc.wantPerPoll {
				t.Fatalf("statistics requests = %d, want %d", wc.statsHits, tc.wantPerPoll)
			}
			if wc.detailHits > MaxDetailsPerPoll {
				t.Fatalf("detail requests %d exceed the cap", wc.detailHits)
			}
			// Total extra requests are bounded: list endpoints + details + statistics only.
			if wc.allHits > 3+MaxDetailsPerPoll+16 {
				t.Fatalf("total requests = %d", wc.allHits)
			}
			for _, id := range wc.statsIDs {
				if !strings.HasPrefix(id, "ap-") {
					t.Fatalf("non-AP %q received a statistics request", id)
				}
			}
		})
	}
}

func TestStatisticsPersistedBucketCapsSustainedRate_Spec63(t *testing.T) {
	wc := newWifiController(t, 40)
	ts := wc.server(t)
	defer ts.Close()
	d := newWifiDeps(t)
	defer d.stop()
	var per []int
	for i := 0; i < 4; i++ {
		before := wc.statsHits
		if err := RunOnce(context.Background(), d.deps, cfgFor(ts.URL, 30, 1, 2), ts.Client()); err != nil {
			t.Fatal(err)
		}
		per = append(per, int(wc.statsHits-before))
	}
	// 8 (cadence) + 8 (bucket drained to ~0), then the bucket is dry: sustained cap holds
	// even though every poll "fires" with a fresh in-process client (a restart each time).
	if per[0] != 8 || per[1] != 8 || per[2] > 1 || per[3] > 1 {
		t.Fatalf("per-poll statistics requests = %v", per)
	}
}

// ---- §6.4: fair rotation, restart-stable ----

func TestStatisticsCursorRotatesFairlyAndSurvivesRestart_Spec64(t *testing.T) {
	wc := newWifiController(t, 20)
	ts := wc.server(t)
	defer ts.Close()
	d := newWifiDeps(t)
	defer d.stop()
	cfg := cfgFor(ts.URL, 30, 1, 2) // 8 per poll
	for i := 0; i < 2; i++ {
		if err := RunOnce(context.Background(), d.deps, cfg, ts.Client()); err != nil {
			t.Fatal(err)
		}
	}
	want := make([]string, 0, 16)
	for i := 0; i < 16; i++ {
		want = append(want, fmt.Sprintf("ap-%03d", i))
	}
	got := append([]string(nil), wc.statsIDs...)
	if !reflect.DeepEqual(got, want) { // sorted (controllerSiteId, deviceId), no repeats, no skips
		t.Fatalf("rotation order = %v", got)
	}
	// Restart: the persisted state (not process memory) carries the cursor.
	st, err := OpenTopologyState(topologyStatePath(d.dir, "c1"))
	if err != nil || st.Snapshot().StatisticsCursor != 16 {
		t.Fatalf("persisted cursor = %d err=%v", st.Snapshot().StatisticsCursor, err)
	}
}

func TestStatisticsDeadlineKeepsTurn_Spec64And65(t *testing.T) {
	wc := newWifiController(t, 6)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	wc.onStats = cancel // enrichment deadline expires during the first statistics request
	ts := wc.server(t)
	defer ts.Close()
	snap := poll(t, ctx, wc, ts, PollOptions{Wifi: true, StatisticsBudget: 6})
	if snap.StatisticsAttempted != 1 || snap.NextStatisticsCursor != 1 {
		t.Fatalf("attempted %d cursor %d: deadline-skipped targets must keep their turn", snap.StatisticsAttempted, snap.NextStatisticsCursor)
	}
	if wc.statsHits != 1 {
		t.Fatalf("requests after the deadline: %d", wc.statsHits)
	}
}

func TestDetailHasPriorityOverStatistics_Spec65(t *testing.T) {
	wc := newWifiController(t, 5)
	ts := wc.server(t)
	defer ts.Close()
	poll(t, context.Background(), wc, ts, PollOptions{Wifi: true, DetailBudget: MaxDetailsPerPoll, StatisticsBudget: 16})
	seenStats := false
	for _, k := range wc.order {
		if k == "stats" {
			seenStats = true
		} else if seenStats {
			t.Fatalf("a detail request ran after statistics began: %v", wc.order)
		}
	}
	if wc.detailHits != 5 || wc.statsHits != 5 {
		t.Fatalf("details %d stats %d", wc.detailHits, wc.statsHits)
	}
}

// ---- §6.5 / §13: per-device failure isolation ----

func TestStatisticsFailuresAreIsolatedPerDevice_Spec65(t *testing.T) {
	cases := []struct {
		name     string
		resp     stubResp
		unsup    bool
		wantCode string
	}{
		{"404", stubResp{status: 404}, true, "endpoint_unavailable"},
		{"500", stubResp{status: 500, body: `{}`}, false, "request_failed"},
		{"transport error", stubResp{drop: true}, false, "request_failed"},
		{"decode error", stubResp{body: `{"uptimeSec":`}, false, "request_failed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wc := newWifiController(t, 3)
			wc.stats["ap-001"] = tc.resp // sibling ap-000 and ap-002 stay healthy
			ts := wc.server(t)
			defer ts.Close()
			snap := poll(t, context.Background(), wc, ts, PollOptions{Wifi: true, StatisticsBudget: 16})
			var st ResourceV2
			for _, r := range snap.ResourcesV2 {
				if r.Kind == ResourceStatistics {
					st = r
				}
			}
			var ids []string
			for _, r := range st.Statistics {
				ids = append(ids, r.DeviceID)
			}
			if !reflect.DeepEqual(ids, []string{"ap-000", "ap-002"}) {
				t.Fatalf("sibling rows lost: %v", ids)
			}
			if st.Outcome != topologycanon.Partial || st.ReasonCode != tc.wantCode {
				t.Fatalf("outcome %s/%s, want partial/%s", st.Outcome, st.ReasonCode, tc.wantCode)
			}
			for _, r := range st.Statistics {
				if r.DeviceID == "ap-001" {
					t.Fatal("a failed device must not appear as a zero-valued row")
				}
			}
		})
	}
}

func TestStatisticsOnlyFailuresAreNotZeroRows_Spec13(t *testing.T) {
	wc := newWifiController(t, 1)
	wc.stats["ap-000"] = stubResp{status: 404}
	ts := wc.server(t)
	defer ts.Close()
	snap := poll(t, context.Background(), wc, ts, PollOptions{Wifi: true, StatisticsBudget: 16})
	for _, r := range snap.ResourcesV2 {
		if r.Kind == ResourceStatistics && (r.Outcome != topologycanon.Unsupported || len(r.Statistics) != 0) {
			t.Fatalf("%+v", r)
		}
	}
	// Budget 0: targets exist but none attempted -> omitted coverage, never rows.
	snap = poll(t, context.Background(), wc, ts, PollOptions{Wifi: true, StatisticsBudget: 0})
	for _, r := range snap.ResourcesV2 {
		if r.Kind == ResourceStatistics && (r.Outcome != topologycanon.Partial || r.ReasonCode != "limit_exceeded" || r.OmittedRowCount != 1 || len(r.Statistics) != 0) {
			t.Fatalf("%+v", r)
		}
	}
}

// ---- §5.1: unknown values, list vs detail shape, through a real poll ----

func TestCapabilityFilteringBeforeCanonicalization_Spec51(t *testing.T) {
	wc := newWifiController(t, 0,
		`{"id":"a-known-unknown","features":["accessPoint","vpnGateway"],"interfaces":["radios","wifi7"]}`,
		`{"id":"b-unknown-only","features":["vpnGateway"],"interfaces":["wifi7"]}`,
		`{"id":"c-empty","features":[],"interfaces":[]}`,
		`{"id":"d-missing"}`)
	wc.stats["a-known-unknown"] = stubResp{body: okStats}
	ts := wc.server(t)
	defer ts.Close()
	snap := poll(t, context.Background(), wc, ts, PollOptions{Wifi: true, StatisticsBudget: 16})
	rows := map[string]TopologyDeviceRowV2{}
	for _, r := range snap.ResourcesV2 {
		for _, row := range r.DeviceList {
			rows[row.DeviceID] = row
		}
	}
	if r := rows["a-known-unknown"]; !reflect.DeepEqual(r.Features, []string{"accessPoint"}) || !reflect.DeepEqual(r.Interfaces, []string{"radios"}) {
		t.Fatalf("known+unknown: %+v", r)
	}
	if r := rows["b-unknown-only"]; r.Features != nil || r.Interfaces != nil {
		t.Fatalf("unknown-only must be null (no false negative), got %+v", r)
	}
	if r := rows["c-empty"]; r.Features == nil || len(r.Features) != 0 || r.Interfaces == nil || len(r.Interfaces) != 0 {
		t.Fatalf("explicit empty must stay []: %+v", r)
	}
	if r := rows["d-missing"]; r.Features != nil || r.Interfaces != nil {
		t.Fatalf("absent must be null: %+v", r)
	}
	if snap.DroppedCapabilityValues != 4 {
		t.Fatalf("dropped = %d, want 4", snap.DroppedCapabilityValues)
	}
	if wc.statsHits != 1 || wc.statsIDs[0] != "a-known-unknown" {
		t.Fatalf("only the documented AP is targeted: %v", wc.statsIDs)
	}
	b, _ := json.Marshal(rows["b-unknown-only"])
	if strings.Contains(string(b), "vpnGateway") || strings.Contains(string(b), "wifi7") {
		t.Fatalf("raw unknown text reached the wire: %s", b)
	}
}

// ---- §4.3 / §4.4 / maintainer (1): negotiation ----

func TestNegotiationV1V2NeverBoth_Spec43(t *testing.T) {
	cases := []struct {
		name     string
		versions []int
		want     string // "v1", "v2" or "none"
		stats    bool
	}{
		{"[1] -> exact v1", []int{1}, "v1", false},
		{"[1,2] -> v2", []int{1, 2}, "v2", true},
		{"[2,1] -> v2", []int{2, 1}, "v2", true},
		{"nothing advertised -> none", nil, "none", false},
		{"[] -> none", []int{}, "none", false},
		{"only unimplemented -> none", []int{3}, "none", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wc := newWifiController(t, 3)
			ts := wc.server(t)
			defer ts.Close()
			d := newWifiDeps(t)
			defer d.stop()
			if err := RunOnce(context.Background(), d.deps, cfgFor(ts.URL, 60, tc.versions...), ts.Client()); err != nil {
				t.Fatal(err)
			}
			b := d.up.bodies[0]
			_, has1 := b["topologyV1"]
			_, has2 := b["topologyV2"]
			if has1 && has2 {
				t.Fatal("both companions in one poll")
			}
			got := map[bool]map[bool]string{false: {false: "none", true: "v2"}, true: {false: "v1"}}[has1][has2]
			if got != tc.want {
				t.Fatalf("emitted %s, want %s", got, tc.want)
			}
			if (wc.statsHits > 0) != tc.stats {
				t.Fatalf("statistics requests = %d, want any=%v", wc.statsHits, tc.stats)
			}
			if !tc.stats && wc.detailHits > 0 && tc.want == "none" {
				t.Fatalf("legacy-only poll made detail requests")
			}
		})
	}
}

// Maintainer (1)+(4): v1 stays v1 bytes (no v2-only keys), legacy body shape unchanged.
func TestV1PayloadUnchangedByV2Support_Spec41(t *testing.T) {
	wc := newWifiController(t, 2)
	ts := wc.server(t)
	defer ts.Close()
	d := newWifiDeps(t)
	defer d.stop()
	if err := RunOnce(context.Background(), d.deps, cfgFor(ts.URL, 60, 1), ts.Client()); err != nil {
		t.Fatal(err)
	}
	raw := d.up.bodies[0]["topologyV1"]
	for _, forbidden := range []string{`"features"`, `"interfaces"`, `"radios"`, `"uplinkRxRateBps"`, `"txRetriesPct"`, `"version":2`} {
		if bytes.Contains(raw, []byte(forbidden)) {
			t.Fatalf("v1 companion contains v2 key %s", forbidden)
		}
	}
	if !bytes.Contains(raw, []byte(`"version":1`)) {
		t.Fatalf("v1 companion lost its version: %s", raw)
	}
	var legacy map[string]json.RawMessage
	_ = json.Unmarshal(mustJSON(t, d.up.bodies[0]), &legacy)
	keys := make([]string, 0, len(legacy))
	for k := range legacy {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	want := []string{"clients", "collectorId", "devices", "firmwareOk", "polledAt", "sites", "topologyV1"}
	if !reflect.DeepEqual(keys, want) {
		t.Fatalf("legacy payload keys = %v, want %v", keys, want)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestV2PayloadHasNoSecondChannel_Spec43(t *testing.T) {
	wc := newWifiController(t, 2)
	ts := wc.server(t)
	defer ts.Close()
	d := newWifiDeps(t)
	defer d.stop()
	if err := RunOnce(context.Background(), d.deps, cfgFor(ts.URL, 60, 1, 2), ts.Client()); err != nil {
		t.Fatal(err)
	}
	keys := []string{}
	for k := range d.up.bodies[0] {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	want := []string{"clients", "collectorId", "devices", "firmwareOk", "polledAt", "sites", "topologyV2"}
	if !reflect.DeepEqual(keys, want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	for _, k := range []string{"devices", "clients"} { // no Wi-Fi metric rides the legacy rows
		for _, f := range []string{"txRetries", "frequencyGHz", "uplinkRx", "wirelessClient", "channelWidth"} {
			if bytes.Contains(d.up.bodies[0][k], []byte(f)) {
				t.Fatalf("legacy %s carries %s", k, f)
			}
		}
	}
}

// ---- local capture end to end (maintainer 2) ----

type localCapture struct {
	SiteID       string          `json:"siteId"`
	APID         string          `json:"apId"`
	DeviceList   json.RawMessage `json:"deviceList"`
	DeviceDetail json.RawMessage `json:"deviceDetail"`
	Statistics   json.RawMessage `json:"statistics"`
	Clients      json.RawMessage `json:"clients"`
}

func loadLocalCapture(t *testing.T) localCapture {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "wifi_local_e7_capture.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c localCapture
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func localCaptureReport(t *testing.T) TopologyV2 {
	t.Helper()
	c := loadLocalCapture(t)
	wc := &wifiController{site: c.SiteID, devices: string(c.DeviceList), clients: string(c.Clients),
		details: map[string]stubResp{c.APID: {body: string(c.DeviceDetail)}}, stats: map[string]stubResp{c.APID: {body: string(c.Statistics)}}}
	ts := wc.server(t)
	defer ts.Close()
	d := newWifiDeps(t)
	defer d.stop()
	if err := RunOnce(context.Background(), d.deps, cfgFor(ts.URL, 60, 1, 2), ts.Client()); err != nil {
		t.Fatal(err)
	}
	return v2Of(t, d.up.bodies[0])
}

func TestLocalCaptureE7EmitsOnlyObservedFields_Spec23(t *testing.T) {
	r := localCaptureReport(t)
	c := loadLocalCapture(t)

	dl := v2ResourceOf(r, ResourceDeviceList).DeviceList
	if len(dl) != 1 || !reflect.DeepEqual(dl[0].Features, []string{"accessPoint"}) || !reflect.DeepEqual(dl[0].Interfaces, []string{"radios"}) {
		t.Fatalf("list-shape capabilities: %+v", dl)
	}
	det := v2ResourceOf(r, ResourceDeviceDetails).DeviceDetails
	if len(det) != 1 || len(det[0].Radios) != 3 {
		t.Fatalf("detail radios: %+v", det)
	}
	for i, want := range []struct {
		f     float64
		ch, w uint32
	}{{2.4, 6, 20}, {5, 48, 80}, {6, 53, 160}} {
		x := det[0].Radios[i]
		if x.FrequencyGHz != want.f || *x.Channel != want.ch || *x.ChannelWidthMHz != want.w || *x.WlanStandard != "802.11be" {
			t.Fatalf("radio %d = %+v", i, x)
		}
	}
	st := v2ResourceOf(r, ResourceStatistics)
	if st.Outcome != topologycanon.Complete || len(st.Statistics) != 1 {
		t.Fatalf("statistics resource: %+v", st)
	}
	row := st.Statistics[0]
	if *row.UptimeSeconds != 4272049 || *row.CPUUtilizationPct != 4.8 || *row.MemoryUtilizationPct != 33.1 || row.UplinkRxRateBps != nil || row.UplinkTxRateBps != nil {
		t.Fatalf("%+v", row)
	}
	var retries []float64
	for _, x := range row.Radios {
		retries = append(retries, *x.TxRetriesPct)
	}
	if !reflect.DeepEqual(retries, []float64{0, 0, 10}) {
		t.Fatalf("retries = %v", retries)
	}
	if pairs := CorrelateRadios(det[0].Radios, row.Radios); len(pairs) != 3 {
		t.Fatalf("pairs = %d", len(pairs))
	}

	// Every v2-added JSON key must exist in the real captures (maintainer 2). The
	// rate and heartbeat keys are absent from THIS body (uplink was {} and heartbeats
	// were redacted) but are published in the same comments / the cloud capture.
	captured := map[string]bool{}
	for _, raw := range [][]byte{c.DeviceList, c.DeviceDetail, c.Statistics} {
		collectKeys(generic(t, raw), captured)
	}
	publishedElsewhere := map[string]bool{"rxRateBps": true, "txRateBps": true, "lastHeartbeatAt": true, "nextHeartbeatAt": true}
	wire := map[string]string{"features": "features", "interfaces": "interfaces", "radios": "radios", "frequencyGHz": "frequencyGHz",
		"channel": "channel", "channelWidthMHz": "channelWidthMHz", "wlanStandard": "wlanStandard", "txRetriesPct": "txRetriesPct",
		"cpuUtilizationPct": "cpuUtilizationPct", "memoryUtilizationPct": "memoryUtilizationPct", "uptimeSeconds": "uptimeSec",
		"uplinkRxRateBps": "rxRateBps", "uplinkTxRateBps": "txRateBps", "lastHeartbeatAt": "lastHeartbeatAt", "nextHeartbeatAt": "nextHeartbeatAt"}
	emitted := map[string]bool{}
	for _, res := range r.Resources {
		collectKeys(generic(t, mustJSON(t, res)), emitted)
	}
	for k, src := range wire {
		if emitted[k] && !captured[src] && !publishedElsewhere[src] {
			t.Errorf("emitted key %q has no source key %q in the capture", k, src)
		}
	}
	for _, banned := range []string{"loadAverage1Min", "loadAverage5Min", "loadAverage15Min", "loadAverage"} {
		if emitted[banned] {
			t.Errorf("%s must not be emitted", banned)
		}
	}
}

func collectKeys(v any, into map[string]bool) {
	switch x := v.(type) {
	case map[string]any:
		for k, c := range x {
			into[k] = true
			collectKeys(c, into)
		}
	case []any:
		for _, c := range x {
			collectKeys(c, into)
		}
	}
}

func TestLocalCaptureWirelessCountIgnoresWiredSameUplink_Spec7(t *testing.T) {
	r := localCaptureReport(t)
	cl := v2ResourceOf(r, ResourceClientList)
	res := Resource{Kind: ResourceClientList, Outcome: cl.Outcome, ClientList: cl.ClientList}
	got, ok := WirelessClientCounts(res, []string{loadLocalCapture(t).APID})
	if !ok || got["ap-e7-local"] != 1 {
		t.Fatalf("counts = %v ok=%v (1 WIRELESS + 1 WIRED on the same uplink)", got, ok)
	}
}
