package integrity

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func sum(b string) string {
	s := sha256.Sum256([]byte(b))
	return hex.EncodeToString(s[:])
}

func attestedJSON(snapshotID, manifestBody string) string {
	return `{"v":1,"mode":"attested","trust":"server_verified","snapshotId":"` + snapshotID + `","objects":[` +
		`{"role":"manifest","key":"snapshots/` + snapshotID + `/manifest.json","sha256":"` + sum(manifestBody) + `","size":` + itoa(len(manifestBody)) + `}]}`
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestParseExpectation(t *testing.T) {
	good := sum("m")
	cases := []struct {
		name     string
		raw      string
		wantNil  bool
		wantErr  string
		wantMode string
		attested bool
	}{
		{name: "absent", raw: "", wantNil: true},
		{name: "json null", raw: "null", wantNil: true},
		{name: "attested server verified", raw: attestedJSON("snap-1", "m"), wantMode: ModeAttested, attested: true},
		{name: "attested producer only", raw: `{"v":1,"mode":"attested","trust":"producer_only","snapshotId":"s","objects":[{"role":"manifest","key":"snapshots/s/manifest.json","sha256":"` + good + `","size":1}]}`, wantMode: ModeAttested, attested: true},
		{name: "override", raw: `{"v":1,"mode":"unattested_override","snapshotId":"s","authorizationId":"a1"}`, wantMode: ModeUnattestedOverride},
		{name: "unattested informational", raw: `{"v":1,"mode":"unattested","snapshotId":"s","reason":"unattested_legacy"}`, wantMode: ModeUnattested},
		{name: "unknown version", raw: `{"v":2,"mode":"attested","snapshotId":"s"}`, wantErr: "version"},
		{name: "missing version", raw: `{"mode":"unattested","snapshotId":"s"}`, wantErr: "version"},
		{name: "unknown mode", raw: `{"v":1,"mode":"trusted","snapshotId":"s"}`, wantErr: "mode"},
		{name: "not an object", raw: `"attested"`, wantErr: "decode"},
		{name: "no snapshot id", raw: `{"v":1,"mode":"unattested"}`, wantErr: "snapshot"},
		{name: "attested unknown trust", raw: `{"v":1,"mode":"attested","trust":"maybe","snapshotId":"s","objects":[{"role":"manifest","key":"snapshots/s/manifest.json","sha256":"` + good + `","size":1}]}`, wantErr: "trust"},
		{name: "attested without manifest", raw: `{"v":1,"mode":"attested","trust":"server_verified","snapshotId":"s","objects":[{"role":"layout","key":"snapshots/s/layout.json","sha256":"` + good + `","size":1}]}`, wantErr: "manifest"},
		{name: "attested manifest under another key", raw: `{"v":1,"mode":"attested","trust":"server_verified","snapshotId":"s","objects":[{"role":"manifest","key":"snapshots/other/manifest.json","sha256":"` + good + `","size":1}]}`, wantErr: "key"},
		{name: "attested unknown role", raw: `{"v":1,"mode":"attested","trust":"server_verified","snapshotId":"s","objects":[{"role":"manifest","key":"snapshots/s/manifest.json","sha256":"` + good + `","size":1},{"role":"extra","key":"x","sha256":"` + good + `","size":1}]}`, wantErr: "role"},
		{name: "attested duplicate role", raw: `{"v":1,"mode":"attested","trust":"server_verified","snapshotId":"s","objects":[{"role":"manifest","key":"snapshots/s/manifest.json","sha256":"` + good + `","size":1},{"role":"manifest","key":"snapshots/s/manifest.json","sha256":"` + good + `","size":1}]}`, wantErr: "duplicate"},
		{name: "attested bad digest", raw: `{"v":1,"mode":"attested","trust":"server_verified","snapshotId":"s","objects":[{"role":"manifest","key":"snapshots/s/manifest.json","sha256":"ABC","size":1}]}`, wantErr: "digest"},
		{name: "attested negative size", raw: `{"v":1,"mode":"attested","trust":"server_verified","snapshotId":"s","objects":[{"role":"manifest","key":"snapshots/s/manifest.json","sha256":"` + good + `","size":-1}]}`, wantErr: "size"},
		{name: "snapshot id with a separator", raw: `{"v":1,"mode":"unattested","snapshotId":"a/b"}`, wantErr: "snapshot"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, err := Parse(json.RawMessage(tc.raw))
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
				}
				if !errors.Is(err, ErrInvalidExpectation) {
					t.Fatalf("err %v is not ErrInvalidExpectation", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tc.wantNil {
				if e != nil {
					t.Fatalf("got %+v, want nil", e)
				}
				if e.Attested() || e.Present() {
					t.Fatal("nil expectation must be neither present nor attested")
				}
				return
			}
			if e.Mode != tc.wantMode || e.Attested() != tc.attested || !e.Present() {
				t.Fatalf("got mode %q attested %v", e.Mode, e.Attested())
			}
		})
	}
}

func TestFromPayload(t *testing.T) {
	e, err := FromPayload(json.RawMessage(`{"snapshotId":"snap-1","integrity":` + attestedJSON("snap-1", "m") + `}`))
	if err != nil || !e.Attested() {
		t.Fatalf("e=%+v err=%v", e, err)
	}
	obj, ok := e.Object(RoleManifest)
	if !ok || obj.Key != "snapshots/snap-1/manifest.json" || obj.Size != 1 {
		t.Fatalf("manifest object = %+v", obj)
	}
	if _, ok := e.Object(RoleLayout); ok {
		t.Fatal("layout should be absent")
	}
	e, err = FromPayload(json.RawMessage(`{"snapshotId":"snap-1"}`))
	if err != nil || e != nil {
		t.Fatalf("payload without integrity: e=%+v err=%v", e, err)
	}
	if _, err := FromPayload(json.RawMessage(`{"integrity":{"v":9}}`)); err == nil {
		t.Fatal("invalid block must fail")
	}
	if e, err := FromPayload(nil); e != nil || err != nil {
		t.Fatal("empty payload is absent")
	}
}

func TestCheckSnapshot(t *testing.T) {
	e, _ := Parse(json.RawMessage(attestedJSON("snap-1", "m")))
	if err := e.CheckSnapshot("snap-1"); err != nil {
		t.Fatal(err)
	}
	if err := e.CheckSnapshot("snap-2"); err == nil {
		t.Fatal("different snapshot must be refused")
	}
	var none *Expectation
	if err := none.CheckSnapshot("anything"); err != nil {
		t.Fatal("absent expectation checks nothing")
	}
}

func TestControlObjectKey(t *testing.T) {
	cases := map[string]string{
		RoleManifest:            "snapshots/s1/manifest.json",
		RoleLayout:              "snapshots/s1/layout.json",
		RoleSystemStateManifest: "snapshots/s1/system-state/manifest.json",
	}
	for role, want := range cases {
		got, err := ControlObjectKey("s1", role)
		if err != nil || got != want {
			t.Fatalf("%s: got %q err %v", role, got, err)
		}
	}
	if _, err := ControlObjectKey("s1", "other"); err == nil {
		t.Fatal("unknown role must fail")
	}
}
