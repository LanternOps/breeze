package bmr

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

// stateFixture is a snapshot in memory whose system-state manifest lists
// the given artifacts (checksummed unless noSum), plus an attested
// expectation covering the snapshot manifest and the state manifest.
type stateFixture struct {
	provider      *memStateProvider
	snapshotID    string
	stateManifest []byte
}

func newStateFixture(t *testing.T, snapshotID string, artifacts map[string][]byte, noSum bool) *stateFixture {
	t.Helper()
	p := &memStateProvider{files: map[string][]byte{}}
	var man systemstate.SystemStateManifest
	for artifactPath, content := range artifacts {
		p.files[path.Join("snapshots", snapshotID, "system-state", artifactPath)] = content
		sum := integrity.DigestBytes(content)
		if noSum {
			sum = ""
		}
		man.Artifacts = append(man.Artifacts, systemstate.Artifact{
			Name: strings.SplitN(artifactPath, "/", 2)[0], Category: "test", Path: artifactPath,
			SizeBytes: int64(len(content)), Checksum: sum,
		})
	}
	data, err := json.Marshal(man)
	if err != nil {
		t.Fatal(err)
	}
	p.files[path.Join("snapshots", snapshotID, "system-state", "manifest.json")] = data
	p.files[path.Join("snapshots", snapshotID, "manifest.json")] = []byte(`{"files":[]}`)
	return &stateFixture{provider: p, snapshotID: snapshotID, stateManifest: data}
}

func (fx *stateFixture) attested(t *testing.T, withStateObject bool, stateBytes []byte) *integrity.Expectation {
	t.Helper()
	var extra []integrity.Object
	if withStateObject {
		if stateBytes == nil {
			stateBytes = fx.stateManifest
		}
		extra = append(extra, integrity.Object{
			Role: integrity.RoleSystemStateManifest, Key: path.Join("snapshots", fx.snapshotID, "system-state", "manifest.json"),
			SHA256: integrity.DigestBytes(stateBytes), Size: int64(len(stateBytes)),
		})
	}
	return attestedExpectation(t, fx.snapshotID, []byte(`{"files":[]}`), extra...)
}

func TestDownloadSystemStateVerified(t *testing.T) {
	artifacts := map[string][]byte{"services/systemd.txt": []byte("ssh.service\n")}
	cases := []struct {
		name      string
		noSum     bool
		expect    bool
		mode      string // attested | attested-no-state-object | attested-other-bytes | override | absent
		wantErr   error
		wantOK    bool
		wantInErr string
	}{
		{name: "attested and matching", mode: "attested", expect: true, wantOK: true},
		{name: "state manifest bytes differ from attestation", mode: "attested-other-bytes", expect: true, wantErr: integrity.ErrIntegrityMismatch},
		{name: "attestation has no state manifest, snapshot expected to carry state", mode: "attested-no-state-object", expect: true, wantErr: integrity.ErrObjectNotAttested},
		{name: "attestation has no state manifest, snapshot carries one anyway", mode: "attested-no-state-object", expect: false, wantErr: integrity.ErrObjectNotAttested},
		{name: "attested, artifact without checksum", mode: "attested", noSum: true, expect: true, wantErr: integrity.ErrMissingChecksum},
		{name: "override, artifact without checksum", mode: "override", noSum: true, expect: true, wantOK: true},
		{name: "absent, artifact without checksum", mode: "absent", noSum: true, expect: true, wantOK: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newStateFixture(t, "snap-ss", artifacts, tc.noSum)
			var e *integrity.Expectation
			switch tc.mode {
			case "attested":
				e = fx.attested(t, true, nil)
			case "attested-other-bytes":
				e = fx.attested(t, true, []byte(strings.Repeat("z", len(fx.stateManifest))))
			case "attested-no-state-object":
				e = fx.attested(t, false, nil)
			case "override":
				e = overrideExpectation(t, fx.snapshotID)
			}
			dir := t.TempDir()
			m, warnings, err := DownloadSystemStateVerified(context.Background(), fx.provider, fx.snapshotID, tc.expect, dir, e)
			if !tc.wantOK {
				if err == nil || !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				if errors.Is(err, ErrNoSystemState) {
					t.Fatalf("err = %v must not read as 'no system state'", err)
				}
				return
			}
			if err != nil || m == nil || len(m.Artifacts) != 1 {
				t.Fatalf("m=%+v err=%v", m, err)
			}
			if b, _ := os.ReadFile(filepath.Join(dir, "services", "systemd.txt")); string(b) != "ssh.service\n" {
				t.Fatalf("artifact = %q", b)
			}
			if tc.noSum && !strings.Contains(strings.Join(warnings, "\n"), "unverified") {
				t.Fatalf("checksum-less artifact accepted without its warning: %v", warnings)
			}
		})
	}
}

func TestDownloadSystemStateVerified_AttestedNoStateAnywhere_IsNoSystemState(t *testing.T) {
	p := &memStateProvider{files: map[string][]byte{"snapshots/snap-none/manifest.json": []byte(`{"files":[]}`)}}
	e := attestedExpectation(t, "snap-none", []byte(`{"files":[]}`))
	_, _, err := DownloadSystemStateVerified(context.Background(), p, "snap-none", false, t.TempDir(), e)
	if !errors.Is(err, ErrNoSystemState) {
		t.Fatalf("err = %v, want ErrNoSystemState", err)
	}
}

func TestApplySystemState_Attested(t *testing.T) {
	artifacts := map[string][]byte{"etc/hosts": []byte("127.0.0.1 localhost\n")}
	cases := []struct {
		name        string
		noSum       bool
		mode        string
		expect      bool
		wantApplied bool
		wantFatal   bool
		wantInWarn  string
	}{
		{name: "attested and matching", mode: "attested", expect: true, wantApplied: true},
		{name: "state manifest bytes differ from attestation", mode: "attested-other-bytes", expect: true, wantFatal: true},
		{name: "no state object while snapshot carries state", mode: "attested-no-state-object", expect: true, wantFatal: true},
		{name: "no state object, state manifest present anyway", mode: "attested-no-state-object", expect: false, wantFatal: true},
		{name: "attested, artifact without checksum", mode: "attested", noSum: true, expect: true, wantInWarn: "missing_checksum"},
		{name: "override, artifact without checksum", mode: "override", noSum: true, expect: true, wantApplied: true, wantInWarn: "unverified"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newStateFixture(t, "snap-apply", artifacts, tc.noSum)
			var e *integrity.Expectation
			switch tc.mode {
			case "attested":
				e = fx.attested(t, true, nil)
			case "attested-other-bytes":
				e = fx.attested(t, true, []byte(strings.Repeat("z", len(fx.stateManifest))))
			case "attested-no-state-object":
				e = fx.attested(t, false, nil)
			case "override":
				e = overrideExpectation(t, fx.snapshotID)
			}
			fr := useFakeRestorer(t, &fakeStateRestorer{})
			res := applySystemState(context.Background(), RecoveryConfig{SnapshotID: fx.snapshotID, ExpectSystemState: tc.expect, Integrity: e}, fx.provider)
			if tc.wantFatal {
				if res.err == nil {
					t.Fatalf("want a fatal error, got %+v", res)
				}
				if fr.restoreCalls != 0 {
					t.Fatal("restorer ran after a state manifest integrity failure")
				}
				return
			}
			if res.err != nil {
				t.Fatalf("unexpected fatal error: %v", res.err)
			}
			if res.applied != tc.wantApplied {
				t.Fatalf("applied = %v, want %v (warnings %v)", res.applied, tc.wantApplied, res.warnings)
			}
			if tc.wantInWarn != "" && !strings.Contains(strings.Join(res.warnings, "\n"), tc.wantInWarn) {
				t.Fatalf("warnings %v do not contain %q", res.warnings, tc.wantInWarn)
			}
		})
	}
}
