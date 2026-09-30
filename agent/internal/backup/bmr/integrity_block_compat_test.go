package bmr

import (
	"encoding/json"
	"reflect"
	"testing"
)

// The server adds an `integrity` block (the snapshot's attestation digests,
// or why there are none) to the recovery bootstrap, on the envelope and on
// the nested bootstrap, and to bmr_recover command payloads. A helper that
// does not know the block must decode everything else exactly as before:
// encoding/json drops keys no struct field names, and nothing in this
// package decodes with DisallowUnknownFields.
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
	for name, block := range integrityBlocks {
		t.Run(name, func(t *testing.T) {
			got, err := decodeBootstrapResponse(bootstrapEnvelope(block))
			if err != nil {
				t.Fatalf("decode bootstrap with integrity: %v", err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("bootstrap decoded differently with an integrity block:\n got %+v\nwant %+v", got, want)
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
