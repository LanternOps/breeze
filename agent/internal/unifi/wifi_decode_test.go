package unifi

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/topologycanon"
)

func f64(v float64) *float64 { return &v }
func str(v string) *string   { return &v }

// ---- §5.1 / §14.2: capability shapes ----

func TestDecodeCapabilitySet_Spec51(t *testing.T) {
	doc := documentedFeatures
	tests := []struct {
		name        string
		raw         string
		want        []string
		wantNil     bool
		wantDropped int
	}{
		{name: "absent key is null", raw: ``, wantNil: true},
		{name: "json null is null", raw: `null`, wantNil: true},
		{name: "list shape (local capture list row)", raw: `["accessPoint"]`, want: []string{"accessPoint"}},
		{name: "detail object shape (local capture detail)", raw: `{"accessPoint":{}}`, want: []string{"accessPoint"}},
		{name: "object with null member is not a capability", raw: `{"accessPoint":null}`, want: []string{}},
		{name: "explicit empty list stays empty", raw: `[]`, want: []string{}},
		{name: "explicit empty object stays empty", raw: `{}`, want: []string{}},
		{name: "unknown-only list is null, not empty", raw: `["vpnGateway"]`, wantNil: true, wantDropped: 1},
		{name: "unknown-only object is null, not empty", raw: `{"vpnGateway":{}}`, wantNil: true, wantDropped: 1},
		{name: "known plus unknown keeps known", raw: `["gateway","bogus","accessPoint"]`, want: []string{"accessPoint", "gateway"}, wantDropped: 1},
		{name: "duplicates collapse and sort", raw: `["switching","accessPoint","switching"]`, want: []string{"accessPoint", "switching"}},
		{name: "non-string elements are dropped", raw: `[1,"accessPoint"]`, want: []string{"accessPoint"}, wantDropped: 1},
		{name: "scalar is unusable, not empty", raw: `"accessPoint"`, wantNil: true, wantDropped: 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, dropped := decodeCapabilitySet(json.RawMessage(tc.raw), doc)
			if tc.wantNil {
				if got != nil {
					t.Fatalf("got %#v, want nil (null)", got)
				}
			} else if !reflect.DeepEqual(got, tc.want) || got == nil {
				t.Fatalf("got %#v, want %#v", got, tc.want)
			}
			if dropped != tc.wantDropped {
				t.Fatalf("dropped = %d, want %d", dropped, tc.wantDropped)
			}
		})
	}
}

// §6.2: AP identity comes from documented signals only, never a model name.
func TestIsAPCandidate_Spec62NoModelHeuristics(t *testing.T) {
	if !isAPCandidate([]string{"accessPoint"}, nil) || !isAPCandidate(nil, []string{"radios"}) {
		t.Fatal("documented signals must qualify")
	}
	if isAPCandidate([]string{"switching"}, []string{"ports"}) || isAPCandidate(nil, nil) {
		t.Fatal("non-AP / unknown must not qualify")
	}
}

// ---- §5.2: detail radios ----

func TestParseDetailV2Radios_Spec52(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		wantNil   bool // radios key omitted -> null
		wantCount int
		wantAP    bool
		check     func(t *testing.T, r []TopologyRadioOverview)
	}{
		{name: "radios key omitted -> null (not empty)", body: `{"features":{"switching":{}},"interfaces":{"ports":[]}}`, wantNil: true},
		{name: "explicit empty radios -> [] and no AP confirmation", body: `{"interfaces":{"radios":[]}}`, wantCount: 0},
		{name: "AP with no radio entries still confirmed by features", body: `{"features":{"accessPoint":{}},"interfaces":{"ports":[]}}`, wantNil: true, wantAP: true},
		{name: "one radio, channel absent (offline cloud case)", body: `{"interfaces":{"radios":[{"frequencyGHz":2.4,"channelWidthMHz":20,"wlanStandard":"802.11n"}]}}`,
			wantCount: 1, wantAP: true, check: func(t *testing.T, r []TopologyRadioOverview) {
				if r[0].Channel != nil || *r[0].ChannelWidthMHz != 20 || *r[0].WlanStandard != "802.11n" {
					t.Fatalf("%+v", r[0])
				}
			}},
		{name: "several radios, input order does not matter (2.4/5/6, 802.11be)", body: `{"features":{"accessPoint":{}},"interfaces":{"radios":[
			{"wlanStandard":"802.11be","frequencyGHz":6,"channelWidthMHz":160,"channel":53},
			{"wlanStandard":"802.11be","frequencyGHz":2.4,"channelWidthMHz":20,"channel":6},
			{"wlanStandard":"802.11be","frequencyGHz":5,"channelWidthMHz":80,"channel":48}]}}`,
			wantCount: 3, wantAP: true, check: func(t *testing.T, r []TopologyRadioOverview) {
				for i, want := range []struct {
					f  float64
					ch uint32
					w  uint32
				}{{2.4, 6, 20}, {5, 48, 80}, {6, 53, 160}} {
					if r[i].FrequencyGHz != want.f || *r[i].Channel != want.ch || *r[i].ChannelWidthMHz != want.w || *r[i].WlanStandard != "802.11be" {
						t.Fatalf("radio %d = %+v", i, r[i])
					}
				}
			}},
		{name: "radio without frequency is dropped, not guessed", body: `{"interfaces":{"radios":[{"channel":6},{"frequencyGHz":5,"channel":36}]}}`, wantCount: 1, wantAP: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseDetailV2([]byte(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if tc.wantNil != (got.Radios == nil) {
				t.Fatalf("radios = %#v, wantNil=%v", got.Radios, tc.wantNil)
			}
			if !tc.wantNil && len(got.Radios) != tc.wantCount {
				t.Fatalf("radios = %d, want %d", len(got.Radios), tc.wantCount)
			}
			if got.APConfirmed != tc.wantAP {
				t.Fatalf("APConfirmed = %v, want %v", got.APConfirmed, tc.wantAP)
			}
			if tc.check != nil {
				tc.check(t, got.Radios)
			}
		})
	}
	if _, err := parseDetailV2([]byte(`not json`)); err == nil {
		t.Fatal("malformed detail must be an error (isolated per device by the caller)")
	}
}

// ---- §5.3 / §9.3: statistics, missing vs zero ----

func TestParseStatistics_Spec53MissingVersusZero(t *testing.T) {
	tests := []struct {
		name  string
		body  string
		check func(t *testing.T, r TopologyStatisticsRowV2)
	}{
		{name: "local E7: retries 0.0/0.0/10.0, empty uplink -> null rates, load averages ignored",
			body: `{"uptimeSec":4272049,"loadAverage1Min":2.46,"loadAverage5Min":2.3,"loadAverage15Min":2.18,"cpuUtilizationPct":4.8,"memoryUtilizationPct":33.1,"uplink":{},
				"interfaces":{"radios":[{"frequencyGHz":2.4,"txRetriesPct":0.0},{"frequencyGHz":5,"txRetriesPct":0.0},{"frequencyGHz":6,"txRetriesPct":10.0}]}}`,
			check: func(t *testing.T, r TopologyStatisticsRowV2) {
				if *r.UptimeSeconds != 4272049 || *r.CPUUtilizationPct != 4.8 || *r.MemoryUtilizationPct != 33.1 {
					t.Fatalf("%+v", r)
				}
				if r.UplinkRxRateBps != nil || r.UplinkTxRateBps != nil {
					t.Fatal("omitted rate keys must be null, never 0")
				}
				if len(r.Radios) != 3 || r.Radios[0].TxRetriesPct == nil || *r.Radios[0].TxRetriesPct != 0 || *r.Radios[1].TxRetriesPct != 0 || *r.Radios[2].TxRetriesPct != 10 {
					t.Fatalf("radios = %+v", r.Radios)
				}
			}},
		{name: "cloud U6 LR online: positive rates, retries 26 and 0",
			body: `{"cpuUtilizationPct":1.2,"memoryUtilizationPct":37.5,"uptimeSec":3604448,"uplink":{"rxRateBps":712,"txRateBps":2072},
				"interfaces":{"radios":[{"frequencyGHz":2.4,"txRetriesPct":26.0},{"frequencyGHz":5,"txRetriesPct":0.0}]}}`,
			check: func(t *testing.T, r TopologyStatisticsRowV2) {
				if *r.UplinkRxRateBps != 712 || *r.UplinkTxRateBps != 2072 || *r.Radios[0].TxRetriesPct != 26 || *r.Radios[1].TxRetriesPct != 0 {
					t.Fatalf("%+v", r)
				}
			}},
		{name: "cloud U6 Lite offline: cpu/mem/uptime/retries absent, positive uplink",
			body: `{"uplink":{"rxRateBps":1724576,"txRateBps":53711480},"interfaces":{"radios":[{"frequencyGHz":2.4},{"frequencyGHz":5}]}}`,
			check: func(t *testing.T, r TopologyStatisticsRowV2) {
				if r.UptimeSeconds != nil || r.CPUUtilizationPct != nil || r.MemoryUtilizationPct != nil {
					t.Fatalf("offline: cpu/mem/uptime must be null: %+v", r)
				}
				if *r.UplinkRxRateBps != 1724576 || *r.UplinkTxRateBps != 53711480 {
					t.Fatalf("%+v", r)
				}
				if len(r.Radios) != 2 || r.Radios[0].TxRetriesPct != nil || r.Radios[1].TxRetriesPct != nil {
					t.Fatalf("absent txRetriesPct must be null, never 0: %+v", r.Radios)
				}
			}},
		{name: "measured zero rates and zero cpu are zeros", body: `{"cpuUtilizationPct":0,"uptimeSec":0,"uplink":{"rxRateBps":0,"txRateBps":0}}`,
			check: func(t *testing.T, r TopologyStatisticsRowV2) {
				if r.CPUUtilizationPct == nil || *r.CPUUtilizationPct != 0 || r.UptimeSeconds == nil || r.UplinkRxRateBps == nil || *r.UplinkTxRateBps != 0 {
					t.Fatalf("%+v", r)
				}
				if r.Radios != nil {
					t.Fatal("missing interfaces.radios must be null")
				}
			}},
		{name: "explicit empty radios stays []", body: `{"interfaces":{"radios":[]}}`,
			check: func(t *testing.T, r TopologyStatisticsRowV2) {
				if r.Radios == nil || len(r.Radios) != 0 {
					t.Fatalf("%#v", r.Radios)
				}
			}},
		{name: "out-of-range percentage is dropped to null", body: `{"cpuUtilizationPct":140,"memoryUtilizationPct":-1}`,
			check: func(t *testing.T, r TopologyStatisticsRowV2) {
				if r.CPUUtilizationPct != nil || r.MemoryUtilizationPct != nil {
					t.Fatalf("%+v", r)
				}
			}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r, err := parseStatistics("ap-1", []byte(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if r.RowKey != "ap-1" || r.DeviceID != "ap-1" {
				t.Fatalf("keys %+v", r)
			}
			tc.check(t, r)
		})
	}
	if _, err := parseStatistics("ap-1", []byte(`[`)); err == nil {
		t.Fatal("decode failure must surface as an error")
	}
}

// loadAverage* is decoded but must never reach the wire (v2 has no such field).
func TestStatisticsRowEmissionIgnoresLoadAverage_Spec53(t *testing.T) {
	r, err := parseStatistics("ap-1", []byte(`{"uptimeSec":1,"loadAverage1Min":2.46,"loadAverage5Min":2.3,"loadAverage15Min":2.18,"uplink":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(r)
	if strings.Contains(strings.ToLower(string(b)), "load") {
		t.Fatalf("loadAverage leaked onto the v2 wire: %s", b)
	}
	if !strings.Contains(string(b), `"uplinkRxRateBps":null`) || !strings.Contains(string(b), `"radios":null`) {
		t.Fatalf("absent values must be explicit null: %s", b)
	}
	z, _ := parseStatistics("ap-1", []byte(`{"interfaces":{"radios":[{"frequencyGHz":5,"txRetriesPct":0.0}]}}`))
	zb, _ := json.Marshal(z)
	if !strings.Contains(string(zb), `"txRetriesPct":0`) {
		t.Fatalf("measured zero must survive marshalling: %s", zb)
	}
}

// ---- §5.4: correlation ----

func TestCorrelateRadios_Spec54FrequencyOnlyAndUnique(t *testing.T) {
	ov := func(f float64) TopologyRadioOverview { return TopologyRadioOverview{FrequencyGHz: f} }
	st := func(f, r float64) TopologyRadioStatistics {
		return TopologyRadioStatistics{FrequencyGHz: f, TxRetriesPct: f64(r)}
	}
	tests := []struct {
		name string
		o    []TopologyRadioOverview
		s    []TopologyRadioStatistics
		want []float64
	}{
		{"unique on both sides joins regardless of array order", []TopologyRadioOverview{ov(6), ov(2.4)}, []TopologyRadioStatistics{st(2.4, 1), st(6, 2)}, []float64{2.4, 6}},
		{"duplicate frequency in detail is never joined", []TopologyRadioOverview{ov(5), ov(5), ov(2.4)}, []TopologyRadioStatistics{st(5, 1), st(2.4, 2)}, []float64{2.4}},
		{"duplicate frequency in statistics is never joined", []TopologyRadioOverview{ov(5), ov(2.4)}, []TopologyRadioStatistics{st(5, 1), st(5, 2), st(2.4, 3)}, []float64{2.4}},
		{"same count different frequencies: no positional pairing", []TopologyRadioOverview{ov(2.4)}, []TopologyRadioStatistics{st(5, 1)}, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var got []float64
			for _, p := range CorrelateRadios(tc.o, tc.s) {
				if p.Overview.FrequencyGHz != p.Statistics.FrequencyGHz {
					t.Fatal("paired different frequencies")
				}
				got = append(got, p.Overview.FrequencyGHz)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

// ---- §7: wireless client count ----

func TestWirelessClientCounts_Spec7(t *testing.T) {
	cl := func(typ string, uplink *string) TopologyClientRow {
		return TopologyClientRow{ClientType: typ, UplinkDeviceID: uplink}
	}
	ap := str("ap-1")
	complete := Resource{Kind: ResourceClientList, Outcome: topologycanon.Complete, ClientList: []TopologyClientRow{
		cl("WIRELESS", ap), cl("WIRELESS", ap), cl("WIRED", ap), cl("VPN", ap), cl("TELEPORT", ap), cl("unknown", ap), cl("WIRELESS", nil), cl("WIRELESS", str("other"))}}
	t.Run("only WIRELESS with non-null uplink counts; WIRED with the same uplink is excluded", func(t *testing.T) {
		got, ok := WirelessClientCounts(complete, []string{"ap-1", "ap-2"})
		if !ok || got["ap-1"] != 2 {
			t.Fatalf("%v %v", got, ok)
		}
		if n, present := got["ap-2"]; !present || n != 0 {
			t.Fatalf("an AP with no wireless rows is a measured 0, got %v present=%v", n, present)
		}
		if _, present := got["other"]; present {
			t.Fatal("non-AP device must not get a count")
		}
	})
	for _, o := range []topologycanon.Outcome{topologycanon.Partial, topologycanon.Failed, topologycanon.Unsupported, topologycanon.NotAttempted} {
		t.Run("outcome "+string(o)+" gives no authoritative count", func(t *testing.T) {
			part := complete
			part.Outcome = o
			if got, ok := WirelessClientCounts(part, []string{"ap-1"}); ok || got != nil {
				t.Fatalf("lower-bound count leaked: %v", got)
			}
		})
	}
}

// ---- §6.3: cadence and token bucket ----

func TestStatisticsCadenceBudget_Spec63Table(t *testing.T) {
	for _, tc := range []struct{ interval, want int }{{15, 4}, {30, 8}, {60, 16}, {61, 16}, {300, 16}, {3600, 16}, {1, 1}, {0, 1}, {4, 1}} {
		if got := StatisticsCadenceBudget(tc.interval); got != tc.want {
			t.Errorf("interval %ds: budget %d, want %d", tc.interval, got, tc.want)
		}
	}
}

func openTestState(t *testing.T, path string) *TopologyState {
	t.Helper()
	st, err := OpenTopologyState(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.InstallEpoch("src", "epoch-1"); err != nil {
		t.Fatal(err)
	}
	return st
}

func TestStatisticsTokenBucket_Spec63PersistsAcrossRestart(t *testing.T) {
	path := topologyStatePath(t.TempDir(), "c1")
	t0 := time.Unix(1_800_000_000, 0)
	st := openTestState(t, path)

	p := st.PlanStatistics(t0, 60)
	if p.Budget != 16 {
		t.Fatalf("fresh bucket starts at capacity: budget %d", p.Budget)
	}
	if err := st.CommitStatistics(p, 16, 5); err != nil {
		t.Fatal(err)
	}
	// Restart: a new handle on the same file must not reset the budget.
	st = openTestState(t, path)
	if p := st.PlanStatistics(t0, 60); p.Budget != 0 || p.Cursor != 5 {
		t.Fatalf("restart reset the bucket/cursor: %+v", p)
	}
	// 15 s later 4 tokens have refilled (16/min); cadence at 15 s is also 4.
	if p := st.PlanStatistics(t0.Add(15*time.Second), 60); p.Budget != 4 {
		t.Fatalf("after 15s budget %d, want 4", p.Budget)
	}
	// Fast polls cannot exceed the sustained cap: 8 per 30 s poll, 16 tokens then dry.
	st2 := openTestState(t, topologyStatePath(t.TempDir(), "c2"))
	total, now := 0, t0
	for i := 0; i < 4; i++ { // 4 polls, 1 s apart
		p := st2.PlanStatistics(now, 30)
		total += p.Budget
		if err := st2.CommitStatistics(p, p.Budget, 0); err != nil {
			t.Fatal(err)
		}
		now = now.Add(time.Second)
	}
	if total > 16+1 { // capacity + ~3 s of refill (0.8 token)
		t.Fatalf("burst of fast polls issued %d requests", total)
	}
	// Refill is capped at capacity.
	if p := st.PlanStatistics(t0.Add(time.Hour), 3600); p.Budget != 16 {
		t.Fatalf("refill must cap at 16, got %d", p.Budget)
	}
	// Failures cost tokens too: committing attempted > balance floors at zero.
	st3 := openTestState(t, topologyStatePath(t.TempDir(), "c3"))
	_ = st3.CommitStatistics(st3.PlanStatistics(t0, 60), 99, 0)
	if p := st3.PlanStatistics(t0, 60); p.Budget != 0 {
		t.Fatalf("budget %d", p.Budget)
	}
}

func TestStatisticsCursorSurvivesRestartAndEpochChange_Spec64(t *testing.T) {
	path := topologyStatePath(t.TempDir(), "c1")
	t0 := time.Unix(1_800_000_000, 0)
	st := openTestState(t, path)
	if err := st.CommitStatistics(st.PlanStatistics(t0, 60), 3, 7); err != nil {
		t.Fatal(err)
	}
	st = openTestState(t, path)
	if got := st.PlanStatistics(t0, 60); got.Cursor != 7 {
		t.Fatalf("cursor after restart = %d", got.Cursor)
	}
	// A new epoch resets sequence/digests but keeps controller-traffic state.
	if _, err := st.AllocateSequence(); err != nil {
		t.Fatal(err)
	}
	if err := st.InstallEpoch("src", "epoch-2"); err != nil {
		t.Fatal(err)
	}
	snap := st.Snapshot()
	if snap.StatisticsCursor != 7 || snap.StatisticsTokens == nil || snap.Sequence != 0 {
		t.Fatalf("epoch install: %+v", snap)
	}
}
