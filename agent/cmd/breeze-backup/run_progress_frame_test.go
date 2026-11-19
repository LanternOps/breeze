package main

import (
	"encoding/json"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
)

// #11014: the resume/dedupe check counters must reach the wire under the names
// the API's backupProgressPayloadSchema reads (verifiedFiles/verifiedBytes),
// beside the unchanged upload counters.
func TestBackupRunProgressFrame(t *testing.T) {
	cases := []struct {
		name string
		in   backup.RunProgress
		want map[string]any
	}{
		{
			name: "resume pass: checks counted, nothing done yet",
			in:   backup.RunProgress{FilesTotal: 10, BytesTotal: 1000, VerifiedFiles: 3, VerifiedBytes: 300, SnapshotID: "snap-1"},
			want: map[string]any{"commandId": "cmd-1", "phase": "uploading", "current": float64(0), "total": float64(1000),
				"filesTotal": float64(10), "verifiedFiles": float64(3), "verifiedBytes": float64(300), "snapshotId": "snap-1"},
		},
		{
			name: "upload: no checks made, verified fields omitted",
			in:   backup.RunProgress{FilesDone: 2, FilesTotal: 10, BytesDone: 200, BytesTotal: 1000, SnapshotID: "snap-1"},
			want: map[string]any{"commandId": "cmd-1", "phase": "uploading", "current": float64(200), "total": float64(1000),
				"filesDone": float64(2), "filesTotal": float64(10), "snapshotId": "snap-1"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw, err := json.Marshal(backupRunProgressFrame("cmd-1", c.in))
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatal(err)
			}
			if len(got) != len(c.want) {
				t.Fatalf("frame = %v, want %v", got, c.want)
			}
			for k, v := range c.want {
				if got[k] != v {
					t.Fatalf("frame[%q] = %v, want %v (frame %v)", k, got[k], v, got)
				}
			}
		})
	}
}
