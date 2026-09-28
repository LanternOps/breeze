package discovery

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/breeze-rmm/agent/internal/topologycanon"
)

type fdbNormalizationVectors struct {
	Threshold int      `json:"threshold"`
	Buckets   [][2]any `json:"buckets"`
	Vectors   []struct {
		Name     string          `json:"name"`
		Input    json.RawMessage `json:"input"`
		Expected json.RawMessage `json:"expected"`
	} `json:"vectors"`
}

func TestFdbNormalizationSharedVectors(t *testing.T) {
	b, err := os.ReadFile("../../../packages/shared/src/testing/topology-fdb-normalization-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fdbNormalizationVectors
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if f.Threshold != FdbSharedPortMACThreshold {
		t.Fatalf("threshold %d, want %d", FdbSharedPortMACThreshold, f.Threshold)
	}
	for _, pair := range f.Buckets {
		n := int(pair[0].(float64))
		if got := FdbSharedPortBucket(n); got != pair[1].(string) {
			t.Fatalf("bucket(%d) = %q, want %q", n, got, pair[1])
		}
	}
	if len(f.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range f.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			var in PhysicalSection
			if err := json.Unmarshal(v.Input, &in); err != nil {
				t.Fatal(err)
			}
			got, err := topologycanon.StableJSON(NormalizeFdbSection(in))
			if err != nil {
				t.Fatal(err)
			}
			var expected any
			if err := json.Unmarshal(v.Expected, &expected); err != nil {
				t.Fatal(err)
			}
			want, err := topologycanon.StableJSON(expected)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != string(want) {
				t.Fatalf("normalized mismatch\n got %s\nwant %s", got, want)
			}
		})
	}
}

func TestFdbNormalizationOrderIndependent(t *testing.T) {
	b, _ := os.ReadFile("../../../packages/shared/src/testing/topology-fdb-normalization-v1.json")
	var f fdbNormalizationVectors
	_ = json.Unmarshal(b, &f)
	var in PhysicalSection
	if err := json.Unmarshal(f.Vectors[0].Input, &in); err != nil {
		t.Fatal(err)
	}
	a, _ := topologycanon.StableJSON(NormalizeFdbSection(in))
	rev := in
	rev.Fdb = make([]FdbRow, len(in.Fdb))
	for i, r := range in.Fdb {
		rev.Fdb[len(in.Fdb)-1-i] = r
	}
	c, _ := topologycanon.StableJSON(NormalizeFdbSection(rev))
	if string(a) != string(c) {
		t.Fatal("normalization depends on input order")
	}
}

type transportVectorFile struct {
	Identity struct {
		SourceIdentity string          `json:"sourceIdentity"`
		ProducerEpoch  string          `json:"producerEpoch"`
		Source         AdjacencySource `json:"source"`
	} `json:"identity"`
	Sections []PhysicalSection `json:"sections"`
	Expected struct {
		Scopes []struct {
			Kind       string `json:"kind"`
			ContextKey string `json:"contextKey"`
			Canonical  string `json:"canonical"`
			Digest     string `json:"digest"`
		} `json:"scopes"`
		ReportDigest string `json:"reportDigest"`
	} `json:"expected"`
}

func TestAdjacencyTransportDigestVectors(t *testing.T) {
	b, err := os.ReadFile("../../../packages/shared/src/testing/topology-adjacency-transport-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var f transportVectorFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	id := AdjacencyDigestIdentity{SourceIdentity: f.Identity.SourceIdentity, ProducerEpoch: f.Identity.ProducerEpoch, Source: f.Identity.Source}
	if len(f.Expected.Scopes) != len(f.Sections) {
		t.Fatalf("vector scopes %d != sections %d", len(f.Expected.Scopes), len(f.Sections))
	}
	for i, s := range f.Sections {
		exp := f.Expected.Scopes[i]
		canonical, err := CanonicalizeAdjacencyScopeNormalized(id, s)
		if err != nil {
			t.Fatal(err)
		}
		if string(canonical) != exp.Canonical {
			t.Fatalf("%s canonical mismatch\n got %s\nwant %s", s.Kind, canonical, exp.Canonical)
		}
		digest, err := AdjacencyScopeDigest(id, s)
		if err != nil || digest != exp.Digest {
			t.Fatalf("%s digest = %s (%v), want %s", s.Kind, digest, err, exp.Digest)
		}
	}
	report, err := AdjacencyReportDigest(id, f.Sections)
	if err != nil || report != f.Expected.ReportDigest {
		t.Fatalf("report digest = %s (%v), want %s", report, err, f.Expected.ReportDigest)
	}
}
