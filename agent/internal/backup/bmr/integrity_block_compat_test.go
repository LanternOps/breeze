package bmr

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
)

// The server adds an `integrity` block (the snapshot's attestation digests,
// or why there are none) to the recovery bootstrap, on the envelope and on
// the nested bootstrap, and to bmr_recover command payloads. The recovery
// client reads the nested bootstrap's block (BootstrapIntegrity) and decodes
// everything else exactly as before; a block in a format it does not know
// refuses the recovery and asks for an agent update.
var integrityBlocks = map[string]string{
	"attested": `{"v":1,"mode":"attested","trust":"server_verified","snapshotId":"provider-snapshot-1",` +
		`"objects":[{"role":"manifest","key":"snapshots/provider-snapshot-1/manifest.json","sha256":"` +
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + `","size":1234}]}`,
	"unattested": `{"v":1,"mode":"unattested","snapshotId":"provider-snapshot-1","reason":"unattested_legacy"}`,
	"future":     `{"v":7,"mode":"something_new","extra":[1,2,3]}`,
}

func bootstrapEnvelope(integrity string) []byte {
	nested := `{"version":1,"minHelperVersion":"0.118.0","tokenId":"token-1","deviceId":"device-1","snapshotId":"snapshot-db-id",` +
		`"restoreType":"bare_metal","targetConfig":null,"device":{"id":"device-1","hostname":"srv","osType":"linux"},` +
		`"snapshot":{"id":"snapshot-db-id","snapshotId":"provider-snapshot-1","size":2048,"fileCount":2,"backupType":"file"},` +
		`"providerType":"s3","backupConfig":{"id":"cfg","provider":"s3"},` +
		`"download":{"type":"breeze_proxy","method":"GET","url":"https://api.example/api/v1/backup/bmr/recover/download",` +
		`"pathQueryParam":"path","pathPrefix":"snapshots/provider-snapshot-1","expiresAt":"2099-01-01T00:00:00Z"}`
	envelope := `{"version":1,"minHelperVersion":"0.118.0","tokenId":"token-1","deviceId":"device-1","snapshotId":"snapshot-db-id",` +
		`"restoreType":"bare_metal","targetConfig":null,"device":null,` +
		`"snapshot":{"id":"snapshot-db-id","snapshotId":"provider-snapshot-1"},"authenticatedAt":"2026-09-30T00:00:00Z"`
	if integrity != "" {
		nested += `,"integrity":` + integrity
		envelope += `,"integrity":` + integrity
	}
	return []byte(envelope + `,"bootstrap":` + nested + `}}`)
}

func TestRecoveryBootstrapWithIntegrityBlockDecodesAsBefore(t *testing.T) {
	want, err := decodeBootstrapResponse(bootstrapEnvelope(""))
	if err != nil {
		t.Fatalf("decode bootstrap without integrity: %v", err)
	}
	if want.Download == nil || want.Snapshot == nil || want.Snapshot.SnapshotID != "provider-snapshot-1" {
		t.Fatalf("fixture did not decode through the versioned bootstrap: %+v", want)
	}
	if e, err := BootstrapIntegrity(want); e != nil || err != nil {
		t.Fatalf("bootstrap without a block: expectation %+v, err %v; want none", e, err)
	}
	wantMode := map[string]string{"attested": integrity.ModeAttested, "unattested": integrity.ModeUnattested}
	for name, block := range integrityBlocks {
		t.Run(name, func(t *testing.T) {
			got, err := decodeBootstrapResponse(bootstrapEnvelope(block))
			if err != nil {
				t.Fatalf("decode bootstrap with integrity: %v", err)
			}
			if string(got.Integrity) != block {
				t.Fatalf("nested bootstrap integrity = %s, want %s", got.Integrity, block)
			}
			// Everything else decodes exactly as before.
			stripped := *got
			stripped.Integrity = nil
			if !reflect.DeepEqual(&stripped, want) {
				t.Fatalf("bootstrap decoded differently with an integrity block:\n got %+v\nwant %+v", &stripped, want)
			}
			e, err := BootstrapIntegrity(got)
			if name == "future" {
				if !errors.Is(err, integrity.ErrInvalidExpectation) || !strings.Contains(err.Error(), "update the Breeze agent") {
					t.Fatalf("future block: err %v, want a refusal asking for an agent update", err)
				}
				return
			}
			if err != nil || e == nil || e.Mode != wantMode[name] || e.SnapshotID != "provider-snapshot-1" {
				t.Fatalf("expectation %+v err %v, want mode %s", e, err, wantMode[name])
			}
		})
	}
}

func TestRecoveryCommandPayloadWithIntegrityBlockDecodesAsBefore(t *testing.T) {
	base := `{"recoveryToken":"brz_rec_x","serverUrl":"https://api.example","snapshotId":"provider-snapshot-1","deviceId":"device-1"`
	var want RecoveryConfig
	if err := json.Unmarshal([]byte(base+`}`), &want); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	for name, block := range integrityBlocks {
		t.Run(name, func(t *testing.T) {
			var got RecoveryConfig
			if err := json.Unmarshal([]byte(base+`,"integrity":`+block+`}`), &got); err != nil {
				t.Fatalf("decode payload with integrity: %v", err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("payload decoded differently with an integrity block:\n got %+v\nwant %+v", got, want)
			}
		})
	}
}
