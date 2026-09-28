package discovery

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type adjacencyVectorFile struct {
	Vectors []struct {
		Name           string          `json:"name"`
		SourceIdentity string          `json:"sourceIdentity"`
		Report         json.RawMessage `json:"report"`
		Expected       struct {
			ReportCanonical string `json:"reportCanonical"`
			Sections        []struct {
				Kind       string `json:"kind"`
				ContextKey string `json:"contextKey"`
				Canonical  string `json:"canonical"`
			} `json:"sections"`
		} `json:"expected"`
	} `json:"vectors"`
}

func loadAdjacencyVectors(t *testing.T) adjacencyVectorFile {
	t.Helper()
	b, err := os.ReadFile("../../../packages/shared/src/testing/topology-adjacency-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var f adjacencyVectorFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Vectors) < 2 {
		t.Fatal("missing adjacency vectors")
	}
	return f
}

func sha(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func genericJSON(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if err := d.Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestAdjacencyV2FixtureRoundTrip(t *testing.T) {
	for _, v := range loadAdjacencyVectors(t).Vectors {
		t.Run(v.Name, func(t *testing.T) {
			var r AdjacencyV2
			if err := json.Unmarshal(v.Report, &r); err != nil {
				t.Fatal(err)
			}
			out, err := json.Marshal(r)
			if err != nil {
				t.Fatal(err)
			}
			if got, want := genericJSON(t, out), genericJSON(t, v.Report); !reflect.DeepEqual(got, want) {
				t.Fatalf("round trip lost semantic fields\n got %s\nwant %s", out, v.Report)
			}
		})
	}
}

func TestAdjacencyV2FixtureSemantics(t *testing.T) {
	f := loadAdjacencyVectors(t)
	var base AdjacencyV2
	if err := json.Unmarshal(f.Vectors[0].Report, &base); err != nil {
		t.Fatal(err)
	}
	byKind := map[string]PhysicalSection{}
	for _, s := range base.Sections {
		byKind[s.Kind] = s
	}
	if s := byKind[SectionLLDP]; s.Outcome != OutcomeComplete || s.RowCount != 0 || s.Lldp == nil {
		t.Fatalf("complete-empty LLDP must keep an empty row set: %+v", s)
	}
	if s := byKind[SectionCDP]; s.Outcome != OutcomeFailed || s.ReasonCode != "timeout" {
		t.Fatalf("failed CDP lost its outcome: %+v", s)
	}
	fdb := byKind[SectionFDB].Fdb
	if len(fdb) == 0 || fdb[0].FDBID == nil || *fdb[0].FDBID != 700 || !reflect.DeepEqual(fdb[0].VLANs, []uint16{10, 20}) {
		t.Fatalf("Q-BRIDGE FDB identity lost: %+v", fdb)
	}
	var pos AdjacencyV2
	if err := json.Unmarshal(f.Vectors[1].Report, &pos); err != nil {
		t.Fatal(err)
	}
	for _, s := range pos.Sections {
		if s.Kind == SectionLLDP {
			if s.Lldp[0].LocalPort.Namespace != PortNamespaceLLDPLocal || s.Lldp[0].RemoteChassis.Subtype != "mac_address" {
				t.Fatalf("LLDP typed identity lost: %+v", s.Lldp[0])
			}
		}
		if s.Kind == SectionCDP && s.Cdp[0].LocalPort.Namespace != PortNamespaceIfIndex {
			t.Fatalf("CDP port namespace lost: %+v", s.Cdp[0])
		}
	}
}

func TestAdjacencyV2DigestsMatchSharedVectors(t *testing.T) {
	for _, v := range loadAdjacencyVectors(t).Vectors {
		t.Run(v.Name, func(t *testing.T) {
			var r AdjacencyV2
			if err := json.Unmarshal(v.Report, &r); err != nil {
				t.Fatal(err)
			}
			id := AdjacencyDigestIdentity{SourceIdentity: v.SourceIdentity, ProducerEpoch: r.ProducerEpoch, Source: r.Source}
			got, err := CanonicalizeAdjacencyReport(id, r.Sections)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != v.Expected.ReportCanonical || sha(got) != r.ContentDigest {
				t.Fatalf("report canonical mismatch\n got %s\nwant %s", got, v.Expected.ReportCanonical)
			}
			for _, s := range r.Sections {
				b, err := CanonicalizeAdjacencyScope(id, s)
				if err != nil {
					t.Fatal(err)
				}
				var want string
				for _, e := range v.Expected.Sections {
					if e.Kind == s.Kind && e.ContextKey == s.ContextKey {
						want = e.Canonical
					}
				}
				if string(b) != want || sha(b) != s.ContentDigest {
					t.Fatalf("%s scope canonical mismatch\n got %s\nwant %s", s.Kind, b, want)
				}
			}
		})
	}
}

func TestAdjacencyV2DigestExcludesTimeMarkButNotOutcome(t *testing.T) {
	f := loadAdjacencyVectors(t)
	var r AdjacencyV2
	if err := json.Unmarshal(f.Vectors[1].Report, &r); err != nil {
		t.Fatal(err)
	}
	id := AdjacencyDigestIdentity{SourceIdentity: f.Vectors[1].SourceIdentity, ProducerEpoch: r.ProducerEpoch, Source: r.Source}
	base, _ := CanonicalizeAdjacencyReport(id, r.Sections)
	for i := range r.Sections {
		for j := range r.Sections[i].Lldp {
			r.Sections[i].Lldp[j].TimeMark += 5000
		}
	}
	r.Sequence, r.CapturedAt, r.ParentJobID = "99", "2026-09-15T13:00:00Z", "20000000-0000-4000-8000-0000000000aa"
	moved, _ := CanonicalizeAdjacencyReport(id, r.Sections)
	if !bytes.Equal(base, moved) {
		t.Fatal("timeMark/sequence/capture metadata changed the semantic digest")
	}
	r.Sections[1].Outcome = OutcomePartial
	changed, _ := CanonicalizeAdjacencyReport(id, r.Sections)
	if bytes.Equal(base, changed) {
		t.Fatal("outcome change did not change the digest")
	}
}
