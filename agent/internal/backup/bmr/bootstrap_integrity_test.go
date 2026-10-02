package bmr

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
)

func attestedBlock(snapshotID string, objects ...string) json.RawMessage {
	list := ""
	for i, o := range objects {
		if i > 0 {
			list += ","
		}
		list += o
	}
	return json.RawMessage(fmt.Sprintf(`{"v":1,"mode":"attested","trust":"server_verified","snapshotId":%q,"objects":[%s]}`, snapshotID, list))
}

func objectJSON(role, key, sha string, size int) string {
	return fmt.Sprintf(`{"role":%q,"key":%q,"sha256":%q,"size":%d}`, role, key, sha, size)
}

func TestBootstrapIntegrity_ComparesBothBlocks(t *testing.T) {
	const snap = "snap-bi"
	sumA := integrity.DigestBytes([]byte("manifest"))
	sumB := integrity.DigestBytes([]byte("state"))
	sumC := integrity.DigestBytes([]byte("other"))
	manifestObj := objectJSON(integrity.RoleManifest, "snapshots/snap-bi/manifest.json", sumA, 8)
	stateObj := objectJSON(integrity.RoleSystemStateManifest, "snapshots/snap-bi/system-state/manifest.json", sumB, 5)
	otherStateObj := objectJSON(integrity.RoleSystemStateManifest, "snapshots/snap-bi/system-state/manifest.json", sumC, 5)
	override := func(auth string) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`{"v":1,"mode":"unattested_override","snapshotId":%q,"authorizationId":%q}`, snap, auth))
	}

	cases := []struct {
		name         string
		snapshot     json.RawMessage
		top          json.RawMessage
		wantErr      bool
		wantAttested bool
	}{
		{name: "same block, objects in another order", snapshot: attestedBlock(snap, manifestObj, stateObj), top: attestedBlock(snap, stateObj, manifestObj), wantAttested: true},
		{name: "same block", snapshot: attestedBlock(snap, manifestObj, stateObj), top: attestedBlock(snap, manifestObj, stateObj), wantAttested: true},
		{name: "blocks differ in an object digest", snapshot: attestedBlock(snap, manifestObj, stateObj), top: attestedBlock(snap, manifestObj, otherStateObj), wantErr: true},
		{name: "blocks differ in object count", snapshot: attestedBlock(snap, manifestObj, stateObj), top: attestedBlock(snap, manifestObj), wantErr: true},
		{name: "blocks differ in mode", snapshot: attestedBlock(snap, manifestObj), top: override("6f1c2c1e-0000-4000-8000-000000000001"), wantErr: true},
		{name: "override blocks differ in authorization", snapshot: override("6f1c2c1e-0000-4000-8000-000000000001"), top: override("6f1c2c1e-0000-4000-8000-000000000002"), wantErr: true},
		{name: "malformed top-level block", snapshot: attestedBlock(snap, manifestObj), top: json.RawMessage(`{"v":1,"mode":"attested","snapshotId":`), wantErr: true},
		{name: "top-level block of an unknown mode", snapshot: attestedBlock(snap, manifestObj), top: json.RawMessage(`{"v":1,"mode":"sometimes","snapshotId":"snap-bi"}`), wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bs := &BootstrapResponse{Snapshot: &AuthenticatedSnapshot{SnapshotID: snap, Integrity: tc.snapshot}, Integrity: tc.top}
			e, err := BootstrapIntegrity(bs)
			if tc.wantErr {
				if err == nil || !errors.Is(err, integrity.ErrInvalidExpectation) {
					t.Fatalf("err = %v, want ErrInvalidExpectation", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("BootstrapIntegrity: %v", err)
			}
			if e.Attested() != tc.wantAttested {
				t.Fatalf("attested = %v, want %v", e.Attested(), tc.wantAttested)
			}
		})
	}
}

func TestResolveIntegrity_BetweenTwoBlocks(t *testing.T) {
	manifest := []byte(`{"files":[]}`)
	extra := integrity.Object{Role: integrity.RoleSystemStateManifest, Key: "snapshots/s1/system-state/manifest.json", SHA256: integrity.DigestBytes([]byte("state")), Size: 5}
	att := attestedExpectation(t, "s1", manifest, extra)
	reordered := attestedExpectation(t, "s1", manifest, extra)
	reordered.Objects[0], reordered.Objects[1] = reordered.Objects[1], reordered.Objects[0]
	otherObjects := attestedExpectation(t, "s1", manifest)
	ovr := overrideExpectation(t, "s1")
	info, err := integrity.Parse([]byte(`{"v":1,"mode":"unattested","snapshotId":"s1","reason":"unattested_legacy"}`))
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name      string
		cmd, boot *integrity.Expectation
		want      *integrity.Expectation
		wantErr   bool
	}{
		{name: "override command, informational bootstrap: command kept", cmd: ovr, boot: info, want: ovr},
		{name: "informational command, override bootstrap: command kept", cmd: info, boot: ovr, want: info},
		{name: "attested both, same objects in another order", cmd: att, boot: reordered, want: att},
		{name: "attested both, different objects", cmd: att, boot: otherObjects, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveIntegrity(tc.cmd, tc.boot)
			if tc.wantErr {
				if err == nil || !errors.Is(err, integrity.ErrInvalidExpectation) {
					t.Fatalf("err = %v, want ErrInvalidExpectation", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ResolveIntegrity: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestSameObjects_IsAMultisetComparison(t *testing.T) {
	a := integrity.Object{Role: "manifest", Key: "k1", SHA256: "aa", Size: 1}
	b := integrity.Object{Role: "manifest", Key: "k2", SHA256: "bb", Size: 2}
	if sameObjects([]integrity.Object{a, b}, []integrity.Object{b, b}) {
		t.Fatal("lists with different members compared equal")
	}
	if !sameObjects([]integrity.Object{a, b}, []integrity.Object{b, a}) {
		t.Fatal("the same members in another order compared different")
	}
}
