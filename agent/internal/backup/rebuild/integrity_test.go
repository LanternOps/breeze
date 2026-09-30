package rebuild

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
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

func TestRun_AttestedControlObjects_CheckedBeforeAnyDiskOperation(t *testing.T) {
	cases := []struct {
		name       string
		roles      []string
		override   []string
		snapshotID string // expectation snapshot id; "" = snap-1
		wantRefuse string
	}{
		{name: "manifest bytes differ from attestation", roles: allControlRoles, override: []string{integrity.RoleManifest}, wantRefuse: "integrity_mismatch"},
		{name: "layout bytes differ from attestation", roles: allControlRoles, override: []string{integrity.RoleLayout}, wantRefuse: "integrity_mismatch"},
		{name: "attestation has no layout", roles: []string{integrity.RoleManifest, integrity.RoleSystemStateManifest}, wantRefuse: "not_attested"},
		{name: "expectation for another snapshot", roles: allControlRoles, snapshotID: "snap-2", wantRefuse: "expectation is for snapshot \"snap-2\""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			sys := newFakeSystem(dir, 100*GiB)
			p := seedSnapshot(t, "snap-1", testLayout())
			ov := map[string][]byte{}
			for _, role := range tc.override {
				key, _ := integrity.ControlObjectKey("snap-1", role)
				ov[role] = sameSizeOther(p.files[key])
			}
			id := "snap-1"
			if tc.snapshotID != "" {
				id = tc.snapshotID
				for _, role := range tc.roles {
					from, _ := integrity.ControlObjectKey("snap-1", role)
					to, _ := integrity.ControlObjectKey(id, role)
					p.files[to] = p.files[from]
				}
			}
			e := attestedFor(t, p, id, tc.roles, ov)
			opts := stateOpts(dir, p, sys, true) // a full (non dry) run
			opts.Integrity = e
			res, err := Run(context.Background(), opts)
			var ref *RefusalError
			if !errors.As(err, &ref) || res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, tc.wantRefuse) {
				t.Fatalf("res=%+v err=%v, want refusal containing %q", res, err, tc.wantRefuse)
			}
			assertNoDiskWrites(t, sys)
		})
	}
}

func TestRun_OverrideExpectation_WarnsOnce(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	p := seedSnapshot(t, "snap-1", testLayout())
	e, err := integrity.Parse(json.RawMessage(`{"v":1,"mode":"unattested_override","snapshotId":"snap-1","authorizationId":"a"}`))
	if err != nil {
		t.Fatal(err)
	}
	res, err := Run(context.Background(), dryRunOpts(dir, p, sys, e))
	if err != nil || res.Status != "completed" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	n := 0
	for _, w := range res.Warnings {
		if w == integrity.UnattestedRestoreWarning {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("unattested warning appears %d times in %v, want 1", n, res.Warnings)
	}
}

func TestRestoreTree_PassesIntegrityToFileRestore(t *testing.T) {
	dir := t.TempDir()
	p := seedSnapshot(t, "snap-1", testLayout())
	e := attestedFor(t, p, "snap-1", allControlRoles, nil)
	var got *integrity.Expectation
	orig := restoreSnapshotFiles
	restoreSnapshotFiles = func(_ context.Context, _ providers.BackupProvider, cfg backup.RestoreConfig, _ backup.ProgressFunc) (*backup.RestoreResult, error) {
		got = cfg.Integrity
		return &backup.RestoreResult{Status: "completed"}, nil
	}
	t.Cleanup(func() { restoreSnapshotFiles = orig })
	r := &run{opts: Options{SnapshotID: "snap-1", Provider: p, Integrity: e, StateDir: dir}, staging: filepath.Join(dir, "mnt"), rootMount: filepath.Join(dir, "mnt"), result: &Result{}}
	_ = restoreTree(context.Background(), r)
	if got != e {
		t.Fatalf("file restore got expectation %+v, want the run's", got)
	}
}

func TestAppendRestoreWarnings_DropsRepeatedUnattestedWarning(t *testing.T) {
	r := &run{warnings: []string{integrity.UnattestedRestoreWarning}}
	r.appendRestoreWarnings([]string{integrity.UnattestedRestoreWarning, "other"})
	if strings.Join(r.warnings, "|") != integrity.UnattestedRestoreWarning+"|other" {
		t.Fatalf("warnings = %v", r.warnings)
	}
}
