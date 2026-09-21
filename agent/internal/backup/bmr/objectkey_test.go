package bmr

import (
	"encoding/json"
	"os"
	"testing"
)

type objectKeyVector struct {
	Key        string `json:"key"`
	Valid      bool   `json:"valid"`
	SnapshotID string `json:"snapshotId,omitempty"`
	Rest       string `json:"rest,omitempty"`
}

func loadObjectKeyVectors(t *testing.T) []objectKeyVector {
	t.Helper()
	data, err := os.ReadFile("testdata/object-key-vectors.json")
	if err != nil {
		t.Fatalf("read vectors file: %v", err)
	}
	var vectors []objectKeyVector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("unmarshal vectors file: %v", err)
	}
	if len(vectors) < 20 {
		t.Fatalf("vectors file must pin at least 20 cases per Part 0 §1, got %d", len(vectors))
	}
	return vectors
}

func TestParseObjectKey_MatchesSharedVectors(t *testing.T) {
	for _, v := range loadObjectKeyVectors(t) {
		v := v
		t.Run(v.Key, func(t *testing.T) {
			parsed, ok := ParseObjectKey(v.Key)
			if ok != v.Valid {
				t.Fatalf("key %q: ok = %v, want %v", v.Key, ok, v.Valid)
			}
			if v.Valid {
				if parsed.SnapshotID != v.SnapshotID {
					t.Fatalf("key %q: snapshotID = %q, want %q", v.Key, parsed.SnapshotID, v.SnapshotID)
				}
				if parsed.Rest != v.Rest {
					t.Fatalf("key %q: rest = %q, want %q", v.Key, parsed.Rest, v.Rest)
				}
			}
		})
	}
}

func TestIsExternalObjectKey_ClassifiesOwnVsExternal(t *testing.T) {
	external, origin, ok := IsExternalObjectKey("snapshots/gen-1/files/a.gz", "gen-2")
	if !ok || !external || origin != "gen-1" {
		t.Fatalf("external, origin, ok = %v, %q, %v; want true, gen-1, true", external, origin, ok)
	}

	external, origin, ok = IsExternalObjectKey("snapshots/gen-2/files/a.gz", "gen-2")
	if !ok || external || origin != "gen-2" {
		t.Fatalf("external, origin, ok = %v, %q, %v; want false, gen-2, true", external, origin, ok)
	}

	_, _, ok = IsExternalObjectKey("snapshots/gen-2/", "gen-2")
	if ok {
		t.Fatal("an invalid key must never be classified as own")
	}
}
