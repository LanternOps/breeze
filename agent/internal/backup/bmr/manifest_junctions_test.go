package bmr

import (
	"encoding/json"
	"testing"
)

// #7325: a manifest written by an agent that captures junctions carries them
// in a top-level "junctions" array. This reader (the reinstall-then-recover
// path, and every recovery medium already built from it) does not know that
// field and must read "files" exactly as before: no extra entries, no entry
// of a kind it cannot recreate, no decode error.
func TestSnapshotManifest_IgnoresJunctionsArray(t *testing.T) {
	data := []byte(`{
		"id": "s1",
		"files": [
			{"sourcePath": "C:\\Users\\a\\a.txt", "backupPath": "snapshots/s1/files/a", "size": 1},
			{"sourcePath": "C:\\Users\\a\\Documents", "backupPath": "", "kind": "dir"}
		],
		"junctions": [
			{"sourcePath": "C:\\Users\\a\\Documents\\My Music", "target": "C:\\Users\\a\\Music", "modTime": "2026-10-01T00:00:00Z", "winAttrs": 6}
		],
		"size": 1
	}`)
	var m snapshotManifest
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(m.Files) != 2 {
		t.Fatalf("files = %+v, want the two file entries only", m.Files)
	}
	for _, f := range m.Files {
		if f.Kind != "" && f.Kind != "dir" && f.Kind != "symlink" {
			t.Fatalf("unexpected kind %q", f.Kind)
		}
	}
}
