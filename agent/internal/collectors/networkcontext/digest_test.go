package networkcontext

import (
	"encoding/json"
	"os"
	"strings"
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

// The agent reads native names as raw bytes; json.Marshal replaces invalid
// UTF-8 with U+FFFD, written escaped by Go 1.26 and raw by Go 1.27. Both must
// reach the API's digest for the same name decoded to U+FFFD (#11941).
func TestSharedDigestVectorInvalidUTF8(t *testing.T) {
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
		}
	}
	if e = json.Unmarshal(b, &data); e != nil {
		t.Fatal(e)
	}
	for _, v := range data.Vectors {
		if v.Name != "invalid-utf8-replacement" {
			continue
		}
		for i, raw := range v.Report.Sections {
			var s Section[InterfaceRow]
			if e = json.Unmarshal(raw, &s); e != nil || s.Kind != "interfaces" {
				continue
			}
			s.Rows[0].Name = strings.ReplaceAll(s.Rows[0].Name, "\uFFFD", "\xff")
			if v.Report.Sections[i], e = json.Marshal(s); e != nil {
				t.Fatal(e)
			}
		}
		got, e := CanonicalizeReport(v.Report, v.SourceIdentity)
		if e != nil {
			t.Fatal(e)
		}
		if string(got) != v.Canonical || digestBytes(got) != v.Report.ContentDigest {
			t.Fatalf("canonical mismatch\n got %s\nwant %s", got, v.Canonical)
		}
		return
	}
	t.Fatal("missing invalid-utf8-replacement vector")
}
