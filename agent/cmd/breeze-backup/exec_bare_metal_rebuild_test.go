package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/hyperv"
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
	if res.Success || res.Stderr != "the rebuild engine has no implementation for this host platform" {
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

// --- hyperv: create a VM from the rebuilt VHDX (W06d Task 21) ---

// pinHostGOOS makes validate() see goos for the rest of the test, so the
// Windows-only hyperv path is exercised on the Linux/macOS CI agents too.
func pinHostGOOS(t *testing.T, goos string) {
	t.Helper()
	orig := hostGOOS
	hostGOOS = goos
	t.Cleanup(func() { hostGOOS = orig })
}

// stubCreateRebuildVM replaces the VM-create seam for the rest of the test
// and records every request it is handed.
func stubCreateRebuildVM(t *testing.T, err error) *[]hyperv.CreateVMRequest {
	t.Helper()
	orig := createRebuildVMFn
	var got []hyperv.CreateVMRequest
	createRebuildVMFn = func(_ context.Context, req hyperv.CreateVMRequest) error {
		got = append(got, req)
		return err
	}
	t.Cleanup(func() { createRebuildVMFn = orig })
	return &got
}

// testBareMetalRebuildPayloadWithHyperV is testBareMetalRebuildPayload with
// the target path under test control and an hyperv block (raw JSON, "" for
// none). A separate helper: adding hyperv to the shared payload would make
// every other exec test fail validate() off-Windows.
func testBareMetalRebuildPayloadWithHyperV(t *testing.T, server, targetPath, hypervJSON string) json.RawMessage {
	t.Helper()
	hv := ""
	if hypervJSON != "" {
		hv = `, "hyperv": ` + hypervJSON
	}
	return json.RawMessage(fmt.Sprintf(`{
		"recoveryId": "rec-1", "token": "brz_rec_test", "server": %q,
		"target": {"kind": "vhdx", "path": %q}%s
	}`, server, targetPath, hv))
}

type hyperVResultBody struct {
	Status     string   `json:"status"`
	RecoveryID string   `json:"recoveryId"`
	VMCreated  bool     `json:"vmCreated"`
	VMError    string   `json:"vmError"`
	Warnings   []string `json:"warnings"`
}

func decodeHyperVResult(t *testing.T, stdout string) hyperVResultBody {
	t.Helper()
	var out hyperVResultBody
	if err := json.Unmarshal([]byte(stdout), &out); err != nil {
		t.Fatalf("stdout %q: %v", stdout, err)
	}
	return out
}

// rebuiltVHDX creates a stand-in for the rebuilt disk so a test can prove
// the VM step never removes it.
func rebuiltVHDX(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "dev-1.vhdx")
	if err := os.WriteFile(path, []byte("vhdx"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// pushCompletedRun queues the dry run AND the real run — token mode calls
// the engine twice, so one pushed result would be eaten by the dry run.
func pushCompletedRun(fake *fakeRebuild, targetPath string, warnings ...string) {
	fake.push(&rebuild.Result{Status: "completed", Plan: &rebuild.Plan{}}, nil)
	fake.push(&rebuild.Result{
		Status: "completed", PhaseReached: rebuild.PhaseValidate, Plan: &rebuild.Plan{},
		Target:   rebuild.Target{Kind: rebuild.TargetVHDX, Path: targetPath},
		Warnings: warnings,
	}, nil)
}

func TestValidate_RejectsHyperVOffWindows(t *testing.T) {
	for _, goos := range []string{"linux", "darwin"} {
		pinHostGOOS(t, goos)
		p := &bareMetalRebuildPayload{RecoveryID: "rec-1", Token: "brz_rec_test", Server: "https://breeze.example.com"}
		p.Target.Kind, p.Target.Path = "vhdx", "/var/tmp/x.vhdx"
		p.HyperV = &hyperVPayload{VMName: "w06-proof"}
		if err := p.validate(); err == nil || !strings.Contains(err.Error(), "hyperv is only supported on Windows hosts") {
			t.Fatalf("%s: validate() = %v, want hyperv-not-windows error", goos, err)
		}
	}
}

func TestValidate_HyperVOnWindows(t *testing.T) {
	pinHostGOOS(t, "windows")
	for name, tt := range map[string]struct {
		kind, path string
		hv         *hyperVPayload
		want       string // "" = valid
	}{
		"valid":                {"vhdx", "/srv/x.vhdx", &hyperVPayload{VMName: "w06-proof", SwitchName: "LAN", MemoryMB: 8192, CPUCount: 4}, ""},
		"valid, no hyperv":     {"vhdx", "/srv/x.vhdx", nil, ""},
		"image target":         {"image", "/srv/x.img", &hyperVPayload{VMName: "w06-proof"}, "hyperv requires target.kind vhdx"},
		"no vmName":            {"vhdx", "/srv/x.vhdx", &hyperVPayload{}, "vmName is required"},
		"vmName quote":         {"vhdx", "/srv/x.vhdx", &hyperVPayload{VMName: "a'; Stop-Computer; '"}, ""},
		"vmName newline":       {"vhdx", "/srv/x.vhdx", &hyperVPayload{VMName: "a'\nStop-Computer"}, "control character"},
		"vmName NUL":           {"vhdx", "/srv/x.vhdx", &hyperVPayload{VMName: "a\x00b"}, "control character"},
		"switch CR":            {"vhdx", "/srv/x.vhdx", &hyperVPayload{VMName: "ok", SwitchName: "LAN\r"}, "control character"},
		"memory below minimum": {"vhdx", "/srv/x.vhdx", &hyperVPayload{VMName: "ok", MemoryMB: 100}, "memoryMb"},
		"cpu negative":         {"vhdx", "/srv/x.vhdx", &hyperVPayload{VMName: "ok", CPUCount: -2}, "cpuCount"},
		"UNC target":           {"vhdx", `\\srv\share\x.vhdx`, nil, "UNC"},
		"UNC target slashes":   {"vhdx", "//srv/share/x.vhdx", nil, "UNC"},
	} {
		t.Run(name, func(t *testing.T) {
			p := &bareMetalRebuildPayload{RecoveryID: "rec-1", Token: "brz_rec_test", Server: "https://breeze.example.com", HyperV: tt.hv}
			p.Target.Kind, p.Target.Path = tt.kind, tt.path
			err := p.validate()
			if tt.want == "" {
				if err != nil {
					t.Fatalf("validate() = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("validate() = %v, want error containing %q", err, tt.want)
			}
		})
	}
}

func TestExecBareMetalRebuild_CreatesVMOnHyperVSuccess(t *testing.T) {
	pinHostGOOS(t, "windows")
	got := stubCreateRebuildVM(t, nil)
	server, statuses := newTokenModeTestServer(t, biosLayoutJSON(t))
	vhdx := rebuiltVHDX(t)
	fake := &fakeRebuild{}
	pushCompletedRun(fake, vhdx)

	payload := testBareMetalRebuildPayloadWithHyperV(t, server.URL, vhdx, `{"vmName":"w06-proof","switchName":"LAN","memoryMb":8192,"cpuCount":4}`)
	result := execBareMetalRebuild(context.Background(), payload, fake.fn)
	if !result.Success {
		t.Fatalf("result = %+v", result)
	}
	want := hyperv.CreateVMRequest{VMName: "w06-proof", VHDXPath: vhdx, SwitchName: "LAN", MemoryMB: 8192, CPUCount: 4}
	if len(*got) != 1 || (*got)[0] != want {
		t.Fatalf("createRebuildVMFn calls = %+v, want exactly one %+v", *got, want)
	}
	res := decodeHyperVResult(t, result.Stdout)
	if !res.VMCreated || res.VMError != "" || res.Status != "completed" {
		t.Fatalf("result body = %+v, want completed with vmCreated", res)
	}
	if got := statuses(); strings.Join(got, ",") != "planned,restoring,validated" {
		t.Errorf("posted statuses = %v", got)
	}
}

func TestExecBareMetalRebuild_VMCreateFailureKeepsCompletedResult(t *testing.T) {
	pinHostGOOS(t, "windows")
	got := stubCreateRebuildVM(t, errors.New("New-VM: access denied"))
	server, _ := newTokenModeTestServer(t, biosLayoutJSON(t))
	vhdx := rebuiltVHDX(t)
	fake := &fakeRebuild{}
	// 70 engine warnings: past the 64-entry reporting cap, so a VM warning
	// appended at the end would be trimmed away.
	engineWarnings := make([]string, 70)
	for i := range engineWarnings {
		engineWarnings[i] = fmt.Sprintf("engine warning %d", i)
	}
	pushCompletedRun(fake, vhdx, engineWarnings...)

	payload := testBareMetalRebuildPayloadWithHyperV(t, server.URL, vhdx, `{"vmName":"w06-proof"}`)
	result := execBareMetalRebuild(context.Background(), payload, fake.fn)

	// The rebuild succeeded; only the convenience VM did not. The command
	// still succeeds and the failure is carried in the result, not swallowed.
	if !result.Success || result.Stderr != "" {
		t.Fatalf("expected the completed rebuild to still report success, got %+v", result)
	}
	if len(*got) != 1 {
		t.Fatalf("createRebuildVMFn calls = %d, want 1", len(*got))
	}
	res := decodeHyperVResult(t, result.Stdout)
	if res.VMCreated {
		t.Fatalf("vmCreated = true after a failed VM create: %+v", res)
	}
	if !strings.Contains(res.VMError, "New-VM: access denied") {
		t.Fatalf("vmError = %q, want the VM-create failure", res.VMError)
	}
	if len(res.Warnings) != 71 || !strings.Contains(res.Warnings[0], "hyperv VM creation failed: New-VM: access denied") {
		t.Fatalf("warnings[0] = %q (len %d), want the VM-create failure first so no warning cap can drop it", res.Warnings[0], len(res.Warnings))
	}
	if res.Status != "completed" || res.RecoveryID != "rec-1" {
		t.Fatalf("result body = %+v, want the completed rebuild result", res)
	}
	if _, err := os.Stat(vhdx); err != nil {
		t.Fatalf("the rebuilt VHDX must survive a VM-create failure: %v", err)
	}
}

func TestExecBareMetalRebuild_NoVMWithoutHyperVOrCompletedRun(t *testing.T) {
	pinHostGOOS(t, "windows")
	for name, tt := range map[string]struct {
		hv   string
		push func(*fakeRebuild, string)
	}{
		"no hyperv block": {"", func(f *fakeRebuild, p string) { pushCompletedRun(f, p) }},
		"failed run": {`{"vmName":"w06-proof"}`, func(f *fakeRebuild, p string) {
			f.push(&rebuild.Result{Status: "completed", Plan: &rebuild.Plan{}}, nil)
			f.push(&rebuild.Result{Status: "failed", Error: "DISM exploded"}, errors.New("DISM exploded"))
		}},
		"refused dry run": {`{"vmName":"w06-proof"}`, func(f *fakeRebuild, p string) {
			f.push(&rebuild.Result{Status: "refused", Refusal: "target is too small"}, &rebuild.RefusalError{Reason: "target is too small"})
		}},
	} {
		t.Run(name, func(t *testing.T) {
			got := stubCreateRebuildVM(t, nil)
			server, _ := newTokenModeTestServer(t, biosLayoutJSON(t))
			vhdx := rebuiltVHDX(t)
			fake := &fakeRebuild{}
			tt.push(fake, vhdx)
			result := execBareMetalRebuild(context.Background(), testBareMetalRebuildPayloadWithHyperV(t, server.URL, vhdx, tt.hv), fake.fn)
			if len(*got) != 0 {
				t.Fatalf("createRebuildVMFn called %d times, want never", len(*got))
			}
			if res := decodeHyperVResult(t, result.Stdout); res.VMCreated || res.VMError != "" {
				t.Fatalf("result body = %+v, want no VM outcome", res)
			}
		})
	}
}

// Off Windows the API never sends hyperv, but if it did the helper refuses
// the whole command before touching the engine or Hyper-V.
func TestExecBareMetalRebuild_HyperVRefusedOffWindowsBeforeEngine(t *testing.T) {
	pinHostGOOS(t, "linux")
	got := stubCreateRebuildVM(t, nil)
	fake := &fakeRebuild{}
	result := execBareMetalRebuild(context.Background(), testBareMetalRebuildPayloadWithHyperV(t, "https://breeze.example.com", "/srv/x.vhdx", `{"vmName":"w06-proof"}`), fake.fn)
	if result.Success || !strings.Contains(result.Stderr, "hyperv is only supported on Windows hosts") {
		t.Fatalf("result = %+v", result)
	}
	if len(fake.calls) != 0 || len(*got) != 0 {
		t.Fatalf("engine calls = %d, VM calls = %d; want neither", len(fake.calls), len(*got))
	}
}

// W06d final review: the optional VM is created BEFORE the "validated"
// progress post, so that post — the one that terminalises an identity:new
// recovery server-side — carries vmCreated/vmError. Posting validated first
// left the VM outcome on the command result alone, which the server then
// ignored because the recovery row was already terminal.
func TestExecBareMetalRebuild_VMOutcomeRidesTheValidatedPost(t *testing.T) {
	pinHostGOOS(t, "windows")
	for name, tt := range map[string]struct {
		createErr   error
		wantCreated bool
		wantError   string
	}{
		"created":       {nil, true, ""},
		"create failed": {errors.New("New-VM: access denied"), false, "New-VM: access denied"},
	} {
		t.Run(name, func(t *testing.T) {
			server, statuses, _, bodies := newTokenModeTestServerRecordingBodies(t, biosLayoutJSON(t), "new", "")
			var statusesAtCreate []string
			orig := createRebuildVMFn
			createRebuildVMFn = func(context.Context, hyperv.CreateVMRequest) error {
				statusesAtCreate = statuses()
				return tt.createErr
			}
			t.Cleanup(func() { createRebuildVMFn = orig })

			vhdx := rebuiltVHDX(t)
			fake := &fakeRebuild{}
			pushCompletedRun(fake, vhdx, "engine warning")
			result := execBareMetalRebuild(context.Background(), testBareMetalRebuildPayloadWithHyperV(t, server.URL, vhdx, `{"vmName":"w06-proof"}`), fake.fn)
			if !result.Success {
				t.Fatalf("result = %+v", result)
			}
			if strings.Join(statusesAtCreate, ",") != "planned,restoring" {
				t.Fatalf("statuses already posted when the VM was created = %v, want planned,restoring (validated must come after)", statusesAtCreate)
			}
			if got := statuses(); strings.Join(got, ",") != "planned,restoring,validated" {
				t.Fatalf("posted statuses = %v", got)
			}
			all := bodies()
			var validated struct {
				Status   string           `json:"status"`
				Warnings []string         `json:"warnings"`
				Result   hyperVResultBody `json:"result"`
			}
			if err := json.Unmarshal(all[len(all)-1], &validated); err != nil {
				t.Fatalf("validated body: %v", err)
			}
			if validated.Status != "validated" {
				t.Fatalf("last post status = %q, want validated", validated.Status)
			}
			if validated.Result.VMCreated != tt.wantCreated || validated.Result.VMError != tt.wantError {
				t.Fatalf("validated post result vmCreated=%v vmError=%q, want %v %q", validated.Result.VMCreated, validated.Result.VMError, tt.wantCreated, tt.wantError)
			}
			if tt.wantError != "" && (len(validated.Warnings) == 0 || !strings.Contains(validated.Warnings[0], tt.wantError)) {
				t.Fatalf("validated post warnings = %v, want the VM failure first", validated.Warnings)
			}
		})
	}
}

// D18: a VM-create error is agent-supplied free text of unbounded length;
// the agent caps it at 2000 runes before it lands in vmError (the server
// schema caps it at 10,000) and in the leading warning.
func TestExecBareMetalRebuild_VMErrorIsTruncated(t *testing.T) {
	pinHostGOOS(t, "windows")
	long := "New-VM: " + strings.Repeat("é", 5000)
	stubCreateRebuildVM(t, errors.New(long))
	server, _ := newTokenModeTestServer(t, biosLayoutJSON(t))
	vhdx := rebuiltVHDX(t)
	fake := &fakeRebuild{}
	pushCompletedRun(fake, vhdx)

	payload := testBareMetalRebuildPayloadWithHyperV(t, server.URL, vhdx, `{"vmName":"w06-proof"}`)
	result := execBareMetalRebuild(context.Background(), payload, fake.fn)
	if !result.Success {
		t.Fatalf("result = %+v", result)
	}
	res := decodeHyperVResult(t, result.Stdout)
	if n := utf8.RuneCountInString(res.VMError); n == 0 || n > 2000 || !strings.HasPrefix(res.VMError, "New-VM: éé") {
		t.Fatalf("vmError has %d runes (prefix %q), want 1..2000 runes keeping the start of the error", n, res.VMError[:min(len(res.VMError), 20)])
	}
	if !utf8.ValidString(res.VMError) {
		t.Fatal("vmError is not valid UTF-8 after truncation")
	}
	if len(res.Warnings) == 0 || !strings.HasSuffix(res.Warnings[0], res.VMError) || utf8.RuneCountInString(res.Warnings[0]) > 2000+len("hyperv VM creation failed: ") {
		t.Fatalf("warnings[0] (%d runes) must carry the same bounded error", utf8.RuneCountInString(res.Warnings[0]))
	}
}
