package unifi

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/topologycanon"
)

// The v2 vectors are shared with TypeScript (packages/shared/src/testing/topology-unifi-v2.json,
// matching the four CLOUD cases of discussioncomment-18961621) exactly like the v1 vectors:
// Go and TS must derive the same canonical bytes and digest (spec §14.1).
func loadUnifiV2Vectors(t *testing.T) unifiVectorFile {
	t.Helper()
	b, err := os.ReadFile("../../../packages/shared/src/testing/topology-unifi-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var f unifiVectorFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Vectors) == 0 {
		t.Fatal("missing unifi v2 vectors")
	}
	return f
}

func TestUnifiTopologyV2SharedFixtureRoundTripAndDigestParity_Spec141(t *testing.T) {
	for _, v := range loadUnifiV2Vectors(t).Vectors {
		t.Run(v.Name, func(t *testing.T) {
			var r TopologyV2
			if err := json.Unmarshal(v.Report, &r); err != nil {
				t.Fatal(err)
			}
			out, err := json.Marshal(r)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(generic(t, out), generic(t, v.Report)) {
				t.Fatalf("round trip lost fields (a null/zero collapsed?)\n got %s\nwant %s", out, v.Report)
			}
			if len(r.Resources) == 0 {
				t.Fatal("no resources")
			}
			for _, res := range r.Resources {
				b, err := CanonicalizeTopologyResourceV2(v.SourceIdentity, r.ProducerEpoch, res)
				if err != nil {
					t.Fatal(err)
				}
				var want string
				for _, e := range v.Expected.Resources {
					if e.Kind == res.Kind && e.ControllerSiteID == res.ControllerSiteID {
						want = e.Canonical
					}
				}
				if string(b) != want {
					t.Fatalf("%s canonical differs from TS\n got %s\nwant %s", res.Kind, b, want)
				}
				if got := topologycanon.DigestHex(b); got != res.ContentDigest {
					t.Fatalf("%s digest %s, TS fixture %s", res.Kind, got, res.ContentDigest)
				}
			}
		})
	}
}

// BuildTopologyV2 over the fixture's own resources reproduces the TS digests, and
// the v2 contract never collides with v1 for the same rows.
func TestBuildTopologyV2MatchesSharedFixtureDigests_Spec141(t *testing.T) {
	v := loadUnifiV2Vectors(t).Vectors[0]
	var shared TopologyV2
	if err := json.Unmarshal(v.Report, &shared); err != nil {
		t.Fatal(err)
	}
	stripped := make([]ResourceV2, len(shared.Resources))
	for i, r := range shared.Resources {
		r.ContentDigest = ""
		stripped[i] = r
	}
	built, err := BuildTopologyV2(Snapshot{ResourcesV2: stripped}, TopologyIdentity{SourceIdentity: v.SourceIdentity, ProducerEpoch: shared.ProducerEpoch}, 4, mustTime(shared.CapturedAt), mustTime(shared.CapturedAt), 300)
	if err != nil {
		t.Fatal(err)
	}
	if built.Version != 2 || len(built.Resources) != len(shared.Resources) {
		t.Fatalf("%+v", built)
	}
	for _, r := range built.Resources {
		var want string
		for _, s := range shared.Resources {
			if s.Kind == r.Kind && s.ControllerSiteID == r.ControllerSiteID {
				want = s.ContentDigest
			}
		}
		if r.ContentDigest != want {
			t.Fatalf("%s digest %s want %s", r.Kind, r.ContentDigest, want)
		}
	}
}

// Nested ordering (radios, capability sets, rows) must not change the digest.
func TestV2RadioAndCapabilityOrderingDoesNotChangeDigest_Spec141(t *testing.T) {
	v := loadUnifiV2Vectors(t).Vectors[0]
	var r TopologyV2
	_ = json.Unmarshal(v.Report, &r)
	digestOf := func(res ResourceV2) string {
		b, err := CanonicalizeTopologyResourceV2(v.SourceIdentity, r.ProducerEpoch, res)
		if err != nil {
			t.Fatal(err)
		}
		return topologycanon.DigestHex(b)
	}
	for _, res := range r.Resources {
		before := digestOf(res)
		rev := res
		rev.DeviceList = append([]TopologyDeviceRowV2(nil), res.DeviceList...)
		rev.DeviceDetails = append([]TopologyDeviceDetailRowV2(nil), res.DeviceDetails...)
		rev.Statistics = append([]TopologyStatisticsRowV2(nil), res.Statistics...)
		for i := range rev.DeviceList {
			rev.DeviceList[i].Features = reverse(rev.DeviceList[i].Features)
			rev.DeviceList[i].Interfaces = reverse(rev.DeviceList[i].Interfaces)
		}
		for i := range rev.DeviceDetails {
			rs := append(make([]TopologyRadioOverview, 0), rev.DeviceDetails[i].Radios...)
			for a, b := 0, len(rs)-1; a < b; a, b = a+1, b-1 {
				rs[a], rs[b] = rs[b], rs[a]
			}
			if rev.DeviceDetails[i].Radios != nil {
				rev.DeviceDetails[i].Radios = rs
			}
		}
		for i := range rev.Statistics {
			rs := append(make([]TopologyRadioStatistics, 0), rev.Statistics[i].Radios...)
			for a, b := 0, len(rs)-1; a < b; a, b = a+1, b-1 {
				rs[a], rs[b] = rs[b], rs[a]
			}
			if rev.Statistics[i].Radios != nil {
				rev.Statistics[i].Radios = rs
			}
		}
		// rows too
		for a, b := 0, len(rev.Statistics)-1; a < b; a, b = a+1, b-1 {
			rev.Statistics[a], rev.Statistics[b] = rev.Statistics[b], rev.Statistics[a]
		}
		if after := digestOf(rev); after != before {
			t.Fatalf("%s digest changed with ordering: %s != %s", res.Kind, after, before)
		}
	}
}

func reverse(in []string) []string {
	if in == nil {
		return nil
	}
	out := append([]string{}, in...)
	for a, b := 0, len(out)-1; a < b; a, b = a+1, b-1 {
		out[a], out[b] = out[b], out[a]
	}
	return out
}

// null (omitted) and [] (explicit empty) are different observations and digest differently.
func TestV2NullVersusEmptyRadiosDigestDiffer_Spec52(t *testing.T) {
	mk := func(radios []TopologyRadioOverview) string {
		res := ResourceV2{ControllerSiteID: "s", Kind: ResourceDeviceDetails, Outcome: topologycanon.Complete, RowCount: 1,
			DeviceDetails: []TopologyDeviceDetailRowV2{{TopologyDeviceDetailRow: TopologyDeviceDetailRow{RowKey: "d", DeviceID: "d", Ports: []TopologyPort{}}, Radios: radios}}}
		b, err := CanonicalizeTopologyResourceV2("src", "ep", res)
		if err != nil {
			t.Fatal(err)
		}
		if radios == nil && !strings.Contains(string(b), `"radios":null`) || radios != nil && !strings.Contains(string(b), `"radios":[]`) {
			t.Fatalf("%s", b)
		}
		return topologycanon.DigestHex(b)
	}
	if mk(nil) == mk([]TopologyRadioOverview{}) {
		t.Fatal("null and [] must not share a digest")
	}
}

// v1 and v2 never share a digest even for identical device_list content.
func TestV1AndV2ContractsAreVersionBound_Spec41(t *testing.T) {
	v1 := Resource{ControllerSiteID: "s", Kind: ResourceDeviceList, Outcome: topologycanon.Complete, RowCount: 1,
		DeviceList: []TopologyDeviceRow{{RowKey: "d", DeviceID: "d"}}}
	v2 := ResourceV2{ControllerSiteID: "s", Kind: ResourceDeviceList, Outcome: topologycanon.Complete, RowCount: 1,
		DeviceList: []TopologyDeviceRowV2{{TopologyDeviceRow: TopologyDeviceRow{RowKey: "d", DeviceID: "d"}}}}
	b1, _ := CanonicalizeTopologyResource("src", "ep", v1)
	b2, _ := CanonicalizeTopologyResourceV2("src", "ep", v2)
	if topologycanon.DigestHex(b1) == topologycanon.DigestHex(b2) || !strings.Contains(string(b2), "unifi_topology_v2") {
		t.Fatal("v1/v2 digests collide or v2 lacks its contract name")
	}
}

func mustTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		panic(err)
	}
	return t
}
