package backup

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/vss"
)

func sampleVSSSession() *vss.VSSSession {
	return &vss.VSSSession{
		ID:                 "{set-1}",
		Volumes:            []string{`C:\`, `D:\`},
		ShadowPaths:        map[string]string{`C:\`: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`},
		UnprotectedVolumes: []string{`D:\`},
		Writers:            []vss.WriterStatus{{Name: "NTDS", ID: "{w}", State: "failed", LastError: "timed out"}},
		Warnings:           []string{`volume D:\ has no shadow copy`},
		CreatedAt:          time.Now().UTC(),
	}
}

// Fails when a field is added to vss.VSSMetadata and buildVSSMetadata forgets to
// populate it — the exact shape of the #3027 bug, where the copy took five of
// the session's six diagnostic fields and dropped the sixth.
//
// This asserts against the PRODUCTION function, not a test-local mirror. An
// earlier version of this suite mirrored the struct literal (it was inline in a
// long Windows-gated run function); that made the test vacuous, because the
// mirror could stay complete while production drifted. buildVSSMetadata was
// extracted so this test actually holds the real code.
func TestVSSMetadataPopulatesEveryField(t *testing.T) {
	value := reflect.ValueOf(*buildVSSMetadata(sampleVSSSession(), 42))
	typ := value.Type()
	for i := 0; i < typ.NumField(); i++ {
		if value.Field(i).IsZero() {
			t.Errorf("VSSMetadata.%s was left at its zero value even though the session carries one: "+
				"buildVSSMetadata is dropping a diagnostic the server needs", typ.Field(i).Name)
		}
	}
}

// A volume that resolved no shadow device is read LIVE, so in-use files on it
// may be skipped or captured torn. Before #3027 that fact never left the
// endpoint — and ExposedPaths cannot stand in for it, because it lists only what
// SUCCEEDED and so looks identical whether D: failed or was never requested.
func TestVSSMetadataCarriesUnprotectedVolumes(t *testing.T) {
	meta := buildVSSMetadata(sampleVSSSession(), 1200)

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
// make every healthy run look like it needed investigating.
func TestVSSMetadataOmitsUnprotectedVolumesOnACleanSession(t *testing.T) {
	session := sampleVSSSession()
	session.UnprotectedVolumes = nil
	session.Warnings = nil
	session.ShadowPaths = map[string]string{`C:\`: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`}

	encoded, err := json.Marshal(buildVSSMetadata(session, 300))
	if err != nil {
		t.Fatalf("marshal VSSMetadata: %v", err)
	}
	if strings.Contains(string(encoded), "unprotectedVolumes") {
		t.Fatalf("clean session must omit unprotectedVolumes, got %s", encoded)
	}
}

func TestBuildVSSMetadataOnNilSession(t *testing.T) {
	if meta := buildVSSMetadata(nil, 0); meta != nil {
		t.Fatalf("nil session must yield nil metadata, got %+v", meta)
	}
}

// The worst VSS outcome is the quietest one: when CreateShadowCopy fails there
// is no VSSMetadata at all, so job.Warning is the ONLY server-visible channel.
// Pin that the note names the consequence, not just the error — "VSS failed" on
// its own does not tell a tech that in-use files may have been skipped.
func TestVSSCreationFailureWarningNamesTheConsequence(t *testing.T) {
	warning := vssCreationFailureWarning(errors.New("0x80042308"))

	for _, want := range []string{"live volume", "skipped", "0x80042308"} {
		if !strings.Contains(warning, want) {
			t.Errorf("VSS creation-failure warning must mention %q, got %q", want, warning)
		}
	}
}

// Regression: the system-state block ASSIGNED job.Warning rather than appending,
// so on a run where VSS creation failed AND system state was incomplete — which
// co-occur, since a wedged writer subsystem causes both — the VSS note was
// destroyed before it ever left the endpoint.
func TestSystemStateWarningDoesNotClobberTheVSSWarning(t *testing.T) {
	job := &BackupJob{}
	appendWarning(job, vssCreationFailureWarning(errors.New("0x80042308")))
	appendWarning(job, "system state collection incomplete: [certs] failed")

	if !strings.Contains(job.Warning, "0x80042308") {
		t.Fatalf("VSS creation failure was clobbered by the system-state warning: %q", job.Warning)
	}
	if !strings.Contains(job.Warning, "system state collection incomplete") {
		t.Fatalf("system-state warning lost: %q", job.Warning)
	}
}

func TestAppendWarningJoinsWithASingleSeparator(t *testing.T) {
	job := &BackupJob{}
	// Fixtures deliberately free of ';' so the count below measures the join,
	// not the payloads.
	appendWarning(job, "first note")
	appendWarning(job, "second note")

	if job.Warning != "first note; second note" {
		t.Fatalf("unexpected join, got %q", job.Warning)
	}
	if strings.Count(job.Warning, ";") != 1 {
		t.Fatalf("warnings must join with a single separator, got %q", job.Warning)
	}
}
