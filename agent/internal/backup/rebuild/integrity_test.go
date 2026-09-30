package rebuild

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
)

// attestedFor builds an attested expectation for snapshot id whose objects
// digest the given roles' current bytes in p (overrides replace a role's
// attested bytes, to simulate stored bytes that differ from the attestation).
func attestedFor(t *testing.T, p *memProvider, id string, roles []string, overrides map[string][]byte) *integrity.Expectation {
	t.Helper()
	var objects []integrity.Object
	for _, role := range roles {
		key, err := integrity.ControlObjectKey(id, role)
		if err != nil {
			t.Fatal(err)
		}
		b := p.files[key]
		if o, ok := overrides[role]; ok {
			b = o
		}
		objects = append(objects, integrity.Object{Role: role, Key: key, SHA256: sum(b), Size: int64(len(b))})
	}
	raw, _ := json.Marshal(map[string]any{"v": 1, "mode": "attested", "trust": "server_verified", "snapshotId": id, "objects": objects})
	e, err := integrity.Parse(raw)
	if err != nil {
		t.Fatalf("parse expectation: %v", err)
	}
	return e
}

var allControlRoles = []string{integrity.RoleManifest, integrity.RoleLayout, integrity.RoleSystemStateManifest}

func sameSizeOther(b []byte) []byte { return []byte(strings.Repeat("q", len(b))) }

func dryRunOpts(dir string, p *memProvider, sys *fakeSystem, e *integrity.Expectation) Options {
	o := stateOpts(dir, p, sys, true)
	o.DryRun = true
	o.Integrity = e
	return o
}

func TestRun_AttestedSystemStateManifest(t *testing.T) {
	cases := []struct {
		name       string
		roles      []string
		override   map[string][]byte
		mutate     func(p *memProvider)
		wantRefuse string
	}{
		{name: "matching", roles: allControlRoles},
		{name: "state manifest bytes differ from attestation", roles: allControlRoles,
			override: map[string][]byte{integrity.RoleSystemStateManifest: nil}, wantRefuse: "integrity"},
		{name: "attestation has no state manifest", roles: []string{integrity.RoleManifest, integrity.RoleLayout}, wantRefuse: "not in the snapshot attestation"},
		{name: "artifact without checksum", roles: allControlRoles, mutate: func(p *memProvider) {
			svc := p.files["snapshots/snap-1/system-state/services/systemd.txt"]
			p.files["snapshots/snap-1/system-state/manifest.json"] = []byte(`{"platform":"linux","schemaVersion":1,"artifacts":[{"name":"services","category":"services","path":"services/systemd.txt","sizeBytes":` + itoa(len(svc)) + `}]}`)
		}, wantRefuse: "missing_checksum"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			sys := newFakeSystem(dir, 100*GiB)
			p := seedSnapshot(t, "snap-1", testLayout())
			if tc.mutate != nil {
				tc.mutate(p)
			}
			ov := map[string][]byte{}
			for role := range tc.override {
				key, _ := integrity.ControlObjectKey("snap-1", role)
				ov[role] = sameSizeOther(p.files[key])
			}
			e := attestedFor(t, p, "snap-1", tc.roles, ov)
			res, err := Run(context.Background(), dryRunOpts(dir, p, sys, e))
			if tc.wantRefuse == "" {
				if err != nil || res.Status != "completed" || !res.StateManifestFound {
					t.Fatalf("res=%+v err=%v", res, err)
				}
				return
			}
			var ref *RefusalError
			if !errors.As(err, &ref) || res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, tc.wantRefuse) {
				t.Fatalf("res=%+v err=%v, want refusal containing %q", res, err, tc.wantRefuse)
			}
			assertNoDiskWrites(t, sys)
		})
	}
}

func assertNoDiskWrites(t *testing.T, sys *fakeSystem) {
	t.Helper()
	for _, c := range sys.cmds {
		if strings.HasPrefix(c, "sgdisk") || strings.HasPrefix(c, "mkfs") || strings.HasPrefix(c, "mount") || strings.HasPrefix(c, "wipefs") {
			t.Fatalf("disk operation after an integrity failure: %s\n%s", c, sys.dump())
		}
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }
