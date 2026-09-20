package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func testBareMetalRebuildPayload(t *testing.T, server string) json.RawMessage {
	t.Helper()
	return json.RawMessage(fmt.Sprintf(`{
		"recoveryId": "rec-1", "token": "brz_rec_test", "server": %q,
		"target": {"kind": "vhdx", "path": "/srv/rebuild/dev-1.vhdx", "imageSizeBytes": 42949672960},
		"identity": "original"
	}`, server))
}

// fakeRebuild records every Options it is called with (dry run first, then
// the real run — exactly like runRebuildAndReport's token mode) and answers
// from the queue of results it was given.
type fakeRebuild struct {
	calls   []rebuild.Options
	results []struct {
		res *rebuild.Result
		err error
	}
}

func (f *fakeRebuild) push(res *rebuild.Result, err error) {
	f.results = append(f.results, struct {
		res *rebuild.Result
		err error
	}{res, err})
}

func (f *fakeRebuild) fn(_ context.Context, opts rebuild.Options) (*rebuild.Result, error) {
	f.calls = append(f.calls, opts)
	if len(f.results) == 0 {
		return &rebuild.Result{Status: "completed", Plan: &rebuild.Plan{}}, nil
	}
	next := f.results[0]
	f.results = f.results[1:]
	return next.res, next.err
}

func TestExecBareMetalRebuild_BuildsOptionsFromBootstrapAndReportsProgress(t *testing.T) {
	server, statuses := newTokenModeTestServer(t, biosLayoutJSON(t))
	fake := &fakeRebuild{}
	fake.push(&rebuild.Result{Status: "completed", Plan: &rebuild.Plan{TargetPath: "/srv/rebuild/dev-1.vhdx.raw"}}, nil)
	fake.push(&rebuild.Result{Status: "completed", PhaseReached: rebuild.PhaseConvert, Warnings: []string{"w1"}}, nil)

	res := execBareMetalRebuild(context.Background(), testBareMetalRebuildPayload(t, server.URL), fake.fn)
	if !res.Success {
		t.Fatalf("expected success, got stderr=%q", res.Stderr)
	}
	if len(fake.calls) != 2 || !fake.calls[0].DryRun || fake.calls[1].DryRun {
		t.Fatalf("expected a dry run then the real run, got %d calls: %+v", len(fake.calls), fake.calls)
	}
	opts := fake.calls[1]
	want := rebuild.Target{Kind: rebuild.TargetVHDX, Path: "/srv/rebuild/dev-1.vhdx", ImageSizeBytes: 40 << 30}
	if opts.Target != want {
		t.Errorf("target = %+v, want %+v", opts.Target, want)
	}
	// The payload said "original"; the bootstrap (server-enforced) says
	// "new" — the bootstrap wins and no marker is written.
	if opts.Identity != rebuild.IdentityNew || opts.Marker != nil {
		t.Errorf("identity = %q marker = %+v, want identity from the bootstrap (new) and no marker", opts.Identity, opts.Marker)
	}
	if opts.SnapshotID != "snap-1" || opts.Provider == nil || !opts.RegenerateInitramfs {
		t.Errorf("snapshot=%q provider=%v regenerateInitramfs=%v", opts.SnapshotID, opts.Provider != nil, opts.RegenerateInitramfs)
	}
	if got := statuses(); strings.Join(got, ",") != "planned,restoring,validated" {
		t.Errorf("posted statuses = %v", got)
	}
	var out struct {
		RecoveryID string   `json:"recoveryId"`
		Status     string   `json:"status"`
		Warnings   []string `json:"warnings"`
	}
	if err := json.Unmarshal([]byte(res.Stdout), &out); err != nil {
		t.Fatalf("stdout is not JSON: %v: %s", err, res.Stdout)
	}
	if out.RecoveryID != "rec-1" || out.Status != "completed" || len(out.Warnings) != 1 {
		t.Errorf("result = %+v (stdout %s)", out, res.Stdout)
	}
}

func TestExecBareMetalRebuild_InvalidPayloadFails(t *testing.T) {
	fake := &fakeRebuild{}
	for name, payload := range map[string]string{
		"not json":      `{`,
		"missing token": `{"recoveryId":"r","server":"http://x","target":{"kind":"vhdx","path":"/a.vhdx"}}`,
		"bad kind":      `{"recoveryId":"r","token":"t","server":"http://x","target":{"kind":"disk","path":"/dev/sda"}}`,
		"relative path": `{"recoveryId":"r","token":"t","server":"http://x","target":{"kind":"vhdx","path":"a.vhdx"}}`,
	} {
		res := execBareMetalRebuild(context.Background(), json.RawMessage(payload), fake.fn)
		if res.Success || res.Stderr == "" {
			t.Errorf("%s: expected a failure, got %+v", name, res)
		}
	}
	if len(fake.calls) != 0 {
		t.Fatalf("invalid payloads must never reach the engine: %+v", fake.calls)
	}
}

func TestExecBareMetalRebuild_UnsupportedHostMessage(t *testing.T) {
	server, statuses := newTokenModeTestServer(t, biosLayoutJSON(t))
	fake := &fakeRebuild{}
	fake.push(nil, rebuild.ErrUnsupportedHost)
	res := execBareMetalRebuild(context.Background(), testBareMetalRebuildPayload(t, server.URL), fake.fn)
	if res.Success || res.Stderr != "the rebuild engine runs on Linux only in this release" {
		t.Fatalf("res = %+v", res)
	}
	if got := statuses(); strings.Join(got, ",") != "failed" {
		t.Errorf("posted statuses = %v, want the server told once that the host cannot run the engine", got)
	}
}

func TestExecBareMetalRebuild_RefusedIsANonErrorResult(t *testing.T) {
	server, statuses := newTokenModeTestServer(t, biosLayoutJSON(t))
	fake := &fakeRebuild{}
	fake.push(&rebuild.Result{Status: "refused", Refusal: "target is too small"}, &rebuild.RefusalError{Reason: "target is too small"})
	res := execBareMetalRebuild(context.Background(), testBareMetalRebuildPayload(t, server.URL), fake.fn)
	if !res.Success {
		t.Fatalf("a refusal is an outcome the server maps, not a helper failure: %+v", res)
	}
	if len(fake.calls) != 1 {
		t.Fatalf("a refused dry run must not be followed by the real run: %d calls", len(fake.calls))
	}
	var out struct {
		RecoveryID string `json:"recoveryId"`
		Status     string `json:"status"`
		Refusal    string `json:"refusal"`
	}
	if err := json.Unmarshal([]byte(res.Stdout), &out); err != nil || out.Status != "refused" || out.RecoveryID != "rec-1" || out.Refusal != "target is too small" {
		t.Fatalf("stdout = %s err=%v", res.Stdout, err)
	}
	if got := statuses(); strings.Join(got, ",") != "refused" {
		t.Errorf("posted statuses = %v", got)
	}
}

func TestExecBareMetalRebuild_FailedRunKeepsResultBody(t *testing.T) {
	server, statuses := newTokenModeTestServer(t, biosLayoutJSON(t))
	fake := &fakeRebuild{}
	fake.push(&rebuild.Result{Status: "completed", Plan: &rebuild.Plan{}}, nil)
	fake.push(&rebuild.Result{Status: "failed", Error: "mkfs.ext4 exploded", PhaseReached: rebuild.PhaseProvision}, errors.New("mkfs.ext4 exploded"))
	res := execBareMetalRebuild(context.Background(), testBareMetalRebuildPayload(t, server.URL), fake.fn)
	if res.Success || res.Stderr != "mkfs.ext4 exploded" {
		t.Fatalf("res = %+v", res)
	}
	if !strings.Contains(res.Stdout, `"status":"failed"`) || !strings.Contains(res.Stdout, `"recoveryId":"rec-1"`) {
		t.Fatalf("a failed run must still carry its result body: %s", res.Stdout)
	}
	if got := statuses(); strings.Join(got, ",") != "planned,restoring,failed" {
		t.Errorf("posted statuses = %v", got)
	}
}

func TestBuildTokenModeOptions_MarkerFollowsIdentity(t *testing.T) {
	target := rebuild.Target{Kind: rebuild.TargetImage, Path: "/tmp/t.img"}
	for _, tt := range []struct {
		name, bootstrapIdentity, nonce, override string
		wantIdentity                             rebuild.IdentityMode
		wantMarker                               *rebuild.Marker
		wantErr                                  string
	}{
		{"original with nonce", "original", "n-1", "", rebuild.IdentityOriginal, &rebuild.Marker{RecoveryID: "rec-1", Nonce: "n-1"}, ""},
		{"new", "new", "", "", rebuild.IdentityNew, nil, ""},
		{"override to new", "original", "n-1", "new", rebuild.IdentityNew, nil, ""},
		{"original without nonce", "original", "", "", "", nil, "recovery nonce missing"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			server, _ := newTokenModeTestServerWithRecovery(t, biosLayoutJSON(t), tt.bootstrapIdentity, tt.nonce)
			opts, report, err := buildTokenModeOptions(context.Background(), server.URL, "brz_rec_test", target, tt.override)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if opts.Identity != tt.wantIdentity || opts.Target != target || opts.SnapshotID != "snap-1" || opts.Provider == nil || report == nil {
				t.Fatalf("opts = %+v", opts)
			}
			if (opts.Marker == nil) != (tt.wantMarker == nil) || (opts.Marker != nil && *opts.Marker != *tt.wantMarker) {
				t.Fatalf("marker = %+v, want %+v", opts.Marker, tt.wantMarker)
			}
		})
	}
}

func TestBuildTokenModeOptions_RejectsTokenWithoutRecovery(t *testing.T) {
	server, _ := newTokenModeTestServerWithRecovery(t, biosLayoutJSON(t), "", "")
	_, _, err := buildTokenModeOptions(context.Background(), server.URL, "brz_rec_test", rebuild.Target{Kind: rebuild.TargetImage, Path: "/tmp/t.img"}, "")
	if err == nil || !strings.Contains(err.Error(), "not bound to a bare-metal recovery") {
		t.Fatalf("err = %v", err)
	}
}

// TestExecuteCommand_DispatchesBareMetalRebuild proves both dispatch tables
// in main.go route the command here (with and without a configured backup
// manager) rather than falling through to "unknown command" / "backup not
// configured": an invalid payload must come back as THIS handler's error.
func TestExecuteCommand_DispatchesBareMetalRebuild(t *testing.T) {
	for _, withMgr := range []bool{false, true} {
		req := backupipc.BackupCommandRequest{CommandID: "c1", CommandType: tools.CmdBareMetalRebuild, Payload: json.RawMessage(`{"recoveryId":""}`)}
		var mgr *backup.BackupManager
		if withMgr {
			mgr = &backup.BackupManager{}
		}
		res := executeCommand(req, mgr, nil, nil, newActiveCommandCanceller())
		if res.Success || !strings.Contains(res.Stderr, "invalid bare_metal_rebuild payload") {
			t.Errorf("withMgr=%v: res = %+v", withMgr, res)
		}
	}
}
