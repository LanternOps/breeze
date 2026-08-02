package backup

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/vss"
)

// buildVSSMetadataFromSession mirrors the struct literal in RunBackupContext,
// which is buried inside a long Windows-gated run function and cannot be called
// directly from a portable test.
//
// Two guards keep the mirror honest, because a mirror that silently drifts is
// how the original bug survived review:
//   - TestVSSMetadataPopulatesEveryField reflects over vss.VSSMetadata and fails
//     when a newly-added field is left zero here.
//   - The production literal itself is pinned by source text in
//     apps/api/src/services/backupAgentContract.test.ts ("backup.go copies
//     UnprotectedVolumes into VSSMetadata").
func buildVSSMetadataFromSession(session *vss.VSSSession, durationMs int64) *vss.VSSMetadata {
	return &vss.VSSMetadata{
		ShadowCopyID:       session.ID,
		CreationTime:       session.CreatedAt,
		Writers:            session.Writers,
		ExposedPaths:       session.ShadowPaths,
		UnprotectedVolumes: session.UnprotectedVolumes,
		Warnings:           session.Warnings,
		DurationMs:         durationMs,
	}
}

// Fails when a field is added to vss.VSSMetadata and the production copy (and
// this mirror) forget to populate it — the exact shape of the #3027 bug, where
// the literal copied five fields and dropped the sixth.
func TestVSSMetadataPopulatesEveryField(t *testing.T) {
	session := &vss.VSSSession{
		ID:                 "{set-0}",
		Volumes:            []string{`C:\`, `D:\`},
		ShadowPaths:        map[string]string{`C:\`: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`},
		UnprotectedVolumes: []string{`D:\`},
		Writers:            []vss.WriterStatus{{Name: "SqlServerWriter", ID: "{a}", State: "stable"}},
		Warnings:           []string{"something degraded"},
		CreatedAt:          time.Now().UTC(),
	}

	value := reflect.ValueOf(*buildVSSMetadataFromSession(session, 42))
	typ := value.Type()
	for i := 0; i < typ.NumField(); i++ {
		if value.Field(i).IsZero() {
			t.Errorf("VSSMetadata.%s was left at its zero value: the session carries a value for it, "+
				"so the copy in RunBackupContext is dropping a diagnostic the server needs", typ.Field(i).Name)
		}
	}
}

// A volume that resolved no shadow device is read LIVE, so in-use files on it
// may be skipped or captured torn. Before #3027 the metadata struct copied five
// fields and omitted UnprotectedVolumes, so that fact never left the endpoint —
// and ExposedPaths cannot stand in for it, because it lists only what SUCCEEDED
// and so looks identical whether D: failed or was never requested.
func TestVSSMetadataCarriesUnprotectedVolumes(t *testing.T) {
	session := &vss.VSSSession{
		ID:                 "{set-1}",
		Volumes:            []string{`C:\`, `D:\`},
		ShadowPaths:        map[string]string{`C:\`: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`},
		UnprotectedVolumes: []string{`D:\`},
		Writers:            []vss.WriterStatus{{Name: "NTDS", ID: "{w}", State: "failed", LastError: "timed out"}},
		Warnings:           []string{`volume D:\ has no shadow copy`},
		CreatedAt:          time.Now().UTC(),
	}

	meta := buildVSSMetadataFromSession(session, 1200)

	if len(meta.UnprotectedVolumes) != 1 || meta.UnprotectedVolumes[0] != `D:\` {
		t.Fatalf("UnprotectedVolumes not carried into VSSMetadata: got %v", meta.UnprotectedVolumes)
	}

	// It must also survive the wire hop the server actually reads.
	encoded, err := json.Marshal(meta)
	if err != nil {
		t.Fatalf("marshal VSSMetadata: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal VSSMetadata: %v", err)
	}
	volumes, ok := decoded["unprotectedVolumes"].([]any)
	if !ok || len(volumes) != 1 || volumes[0] != `D:\` {
		t.Fatalf(`json key "unprotectedVolumes" missing or wrong: %s`, encoded)
	}
}

// A clean session must not emit the key at all — the server treats presence as
// evidence of an incomplete snapshot, so an always-present empty array would
// make every run look like it needed investigating.
func TestVSSMetadataOmitsUnprotectedVolumesOnACleanSession(t *testing.T) {
	session := &vss.VSSSession{
		ID:          "{set-2}",
		Volumes:     []string{`C:\`},
		ShadowPaths: map[string]string{`C:\`: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`},
		Writers:     []vss.WriterStatus{{Name: "SqlServerWriter", ID: "{a}", State: "stable"}},
		CreatedAt:   time.Now().UTC(),
	}

	encoded, err := json.Marshal(buildVSSMetadataFromSession(session, 300))
	if err != nil {
		t.Fatalf("marshal VSSMetadata: %v", err)
	}
	if strings.Contains(string(encoded), "unprotectedVolumes") {
		t.Fatalf("clean session must omit unprotectedVolumes, got %s", encoded)
	}
}

// appendWarning is the only VSS channel that survives the agent's IPC bounding
// when the result is oversize (result_bounds.go drops vssMetadata as a bulk
// container), so a total VSS failure — which produces no metadata at all — has
// to route through it or the run reaches the server looking clean.
func TestAppendWarningAccumulatesVSSFailures(t *testing.T) {
	job := &BackupJob{}
	// Fixtures deliberately free of ';' so the separator count below measures
	// the join, not the payloads.
	appendWarning(job, "VSS shadow copy could not be created")
	appendWarning(job, "read from the live volume, not the VSS shadow copy: C:\\data")

	if !strings.Contains(job.Warning, "could not be created") {
		t.Fatalf("first warning lost: %q", job.Warning)
	}
	if !strings.Contains(job.Warning, "C:\\data") {
		t.Fatalf("second warning lost: %q", job.Warning)
	}
	if strings.Count(job.Warning, ";") != 1 {
		t.Fatalf("warnings must join with a single separator, got %q", job.Warning)
	}
}
