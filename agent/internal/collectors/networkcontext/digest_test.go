package networkcontext

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedDigestVectors(t *testing.T) {
	b, e := os.ReadFile("../../../../packages/shared/src/testing/topology-vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	var data struct {
		Vectors []struct {
			Name           string `json:"name"`
			SourceIdentity string `json:"sourceIdentity"`
			Report         Report `json:"report"`
			Canonical      string `json:"canonical"`
			Digest         string `json:"digest"`
		}
	}
	if e = json.Unmarshal(b, &data); e != nil {
		t.Fatal(e)
	}
	if len(data.Vectors) == 0 {
		t.Fatal("missing vectors")
	}
	for _, v := range data.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			got, e := CanonicalizeReport(v.Report, v.SourceIdentity)
			if e != nil {
				t.Fatal(e)
			}
			if digestBytes(got) != v.Report.ContentDigest {
				t.Fatalf("digest mismatch %s expected %s\n%s", digestBytes(got), v.Report.ContentDigest, got)
			}
			for _, section := range v.Report.Sections {
				var s struct {
					ContentDigest string `json:"contentDigest"`
				}
				if e = json.Unmarshal(section, &s); e != nil {
					t.Fatal(e)
				}
				b, e := CanonicalizeSection(v.Report, section, v.SourceIdentity)
				if e != nil || digestBytes(b) != s.ContentDigest {
					t.Fatalf("section mismatch %s expected %s error %v", digestBytes(b), s.ContentDigest, e)
				}
			}
		})
	}
}
