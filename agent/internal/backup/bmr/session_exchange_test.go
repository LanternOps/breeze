package bmr

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The real POST /backup/bmr/recover/exchange response (captured 2026-09-11
// against a v0.112.x API during the W04b KIT proof, identifiers shortened):
// `bootstrap` is the same authenticate ENVELOPE /bmr/recover/authenticate
// returns — flat legacy fields plus a nested versioned `bootstrap` that
// carries `download` and `recovery`. The console previously unmarshalled the
// envelope straight into BootstrapResponse, so Download/Recovery were nil and
// the console failed with "bootstrap has no download descriptor" after the
// one-time code had already been consumed.
const realExchangeEnvelope = `{
  "token": "brt_test",
  "bootstrap": {
    "version": 1, "minHelperVersion": "0.111.1", "tokenId": "tok-1",
    "deviceId": "dev-1", "snapshotId": "snap-row-1", "restoreType": "bare_metal",
    "targetConfig": {"bareMetalRecoveryId": "rec-1"},
    "device": {"id": "dev-1", "hostname": "lab", "osType": "linux", "architecture": "amd64"},
    "snapshot": {"id": "snap-row-1", "snapshotId": "snapshot-20260911T095853Z-c8ed3cbc", "backupType": "system_image"},
    "authenticatedAt": "2026-09-11T23:35:13.968Z",
    "bootstrap": {
      "version": 1, "minHelperVersion": "0.111.1", "tokenId": "tok-1",
      "device": {"id": "dev-1", "hostname": "lab", "osType": "linux", "architecture": "amd64"},
      "snapshot": {"id": "snap-row-1", "snapshotId": "snapshot-20260911T095853Z-c8ed3cbc", "backupType": "system_image"},
      "restoreType": "bare_metal",
      "targetConfig": {"bareMetalRecoveryId": "rec-1"},
      "providerType": "s3",
      "backupConfig": {"id": "cfg-1", "name": "lab", "type": "s3", "provider": "s3", "isActive": true},
      "download": {"type": "breeze_proxy", "method": "GET", "url": "http://lab/api/v1/backup/bmr/recover/download",
        "tokenHeaderName": "authorization", "tokenHeaderFormat": "Bearer <recovery-token>", "pathQueryParam": "path",
        "requiresAuthentication": true, "pathPrefix": "snapshots/snapshot-20260911T095853Z-c8ed3cbc", "expiresAt": "2026-09-12T00:35:13.968Z"},
      "recovery": {"id": "rec-1", "identity": "new", "deviceId": "dev-1", "snapshotId": "snap-row-1", "nonce": "n0nce"}
    }
  }
}`

func exchangeServer(t *testing.T, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/backup/bmr/recover/exchange" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
}

func TestExchangeRecoveryCode_DecodesAuthenticateEnvelope(t *testing.T) {
	srv := exchangeServer(t, realExchangeEnvelope)
	defer srv.Close()

	token, bs, err := ExchangeRecoveryCode(context.Background(), srv.URL, "ABC-DEF-GHJ")
	if err != nil {
		t.Fatalf("ExchangeRecoveryCode: %v", err)
	}
	if token != "brt_test" {
		t.Fatalf("token = %q, want brt_test", token)
	}
	if bs.Download == nil {
		t.Fatal("Download is nil — the nested envelope bootstrap was not decoded")
	}
	if bs.Download.PathPrefix != "snapshots/snapshot-20260911T095853Z-c8ed3cbc" {
		t.Fatalf("Download.PathPrefix = %q", bs.Download.PathPrefix)
	}
	if bs.Recovery == nil || bs.Recovery.ID != "rec-1" || bs.Recovery.Nonce != "n0nce" {
		t.Fatalf("Recovery = %+v, want id rec-1 with nonce", bs.Recovery)
	}
	if bs.Snapshot == nil || bs.Snapshot.SnapshotID != "snapshot-20260911T095853Z-c8ed3cbc" {
		t.Fatalf("Snapshot = %+v", bs.Snapshot)
	}
	if bs.MinHelperVersion != "0.111.1" {
		t.Fatalf("MinHelperVersion = %q", bs.MinHelperVersion)
	}
}

// The flat versioned shape (what the fake server used to send) must keep
// working too — decodeBootstrapResponse accepts both.
func TestExchangeRecoveryCode_DecodesFlatVersionedBootstrap(t *testing.T) {
	var env map[string]json.RawMessage
	if err := json.Unmarshal([]byte(realExchangeEnvelope), &env); err != nil {
		t.Fatal(err)
	}
	var outer map[string]json.RawMessage
	if err := json.Unmarshal(env["bootstrap"], &outer); err != nil {
		t.Fatal(err)
	}
	flat, _ := json.Marshal(map[string]json.RawMessage{"token": env["token"], "bootstrap": outer["bootstrap"]})
	srv := exchangeServer(t, string(flat))
	defer srv.Close()

	_, bs, err := ExchangeRecoveryCode(context.Background(), srv.URL, "ABC-DEF-GHJ")
	if err != nil {
		t.Fatalf("ExchangeRecoveryCode(flat): %v", err)
	}
	if bs.Download == nil || bs.Recovery == nil {
		t.Fatalf("flat bootstrap lost fields: download=%v recovery=%v", bs.Download != nil, bs.Recovery != nil)
	}
}
