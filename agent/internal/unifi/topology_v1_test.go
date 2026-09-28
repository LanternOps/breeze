package unifi

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/topologycanon"
)

type unifiVectorFile struct {
	Vectors []struct {
		Name           string          `json:"name"`
		SourceIdentity string          `json:"sourceIdentity"`
		Report         json.RawMessage `json:"report"`
		Expected       struct {
			Resources []struct {
				ControllerSiteID string `json:"controllerSiteId"`
				Kind             string `json:"kind"`
				Canonical        string `json:"canonical"`
			} `json:"resources"`
		} `json:"expected"`
	} `json:"vectors"`
}

func loadUnifiVectors(t *testing.T) unifiVectorFile {
	t.Helper()
	b, err := os.ReadFile("../../../packages/shared/src/testing/topology-unifi-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var f unifiVectorFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Vectors) == 0 {
		t.Fatal("missing unifi vectors")
	}
	return f
}

func generic(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if err := d.Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestUnifiTopologyV1FixtureRoundTripAndDigests(t *testing.T) {
	for _, v := range loadUnifiVectors(t).Vectors {
		t.Run(v.Name, func(t *testing.T) {
			var r TopologyV1
			if err := json.Unmarshal(v.Report, &r); err != nil {
				t.Fatal(err)
			}
			out, err := json.Marshal(r)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(generic(t, out), generic(t, v.Report)) {
				t.Fatalf("round trip lost fields\n got %s\nwant %s", out, v.Report)
			}
			var sawVPN bool
			for _, res := range r.Resources {
				for _, c := range res.ClientList {
					if c.ClientType == ClientTypeVPN {
						sawVPN = c.UplinkPortIndex == nil && c.SSID == nil && c.VLAN == nil && c.SignalDbm == nil
					}
				}
				b, err := CanonicalizeTopologyResource(v.SourceIdentity, r.ProducerEpoch, res)
				if err != nil {
					t.Fatal(err)
				}
				var want string
				for _, e := range v.Expected.Resources {
					if e.Kind == res.Kind && e.ControllerSiteID == res.ControllerSiteID {
						want = e.Canonical
					}
				}
				if string(b) != want || topologycanon.DigestHex(b) != res.ContentDigest {
					t.Fatalf("%s canonical mismatch\n got %s\nwant %s", res.Kind, b, want)
				}
			}
			if !sawVPN {
				t.Fatal("VPN client must keep null port/SSID/VLAN/signal")
			}
		})
	}
}
