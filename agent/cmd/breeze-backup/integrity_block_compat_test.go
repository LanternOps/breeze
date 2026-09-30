package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"reflect"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"

	"github.com/breeze-rmm/agent/internal/backup/storagesession"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

// The server now adds an `integrity` block to every restore-shaped command it
// delivers (the snapshot's attestation digests, or why there are none). This
// helper does not know the block yet: it must run every command exactly as
// before. encoding/json drops keys no struct field names, and no payload
// decoder in this program uses DisallowUnknownFields.
var compatIntegrityBlocks = map[string]any{
	"attested": map[string]any{
		"v": 1, "mode": "attested", "trust": "server_verified", "snapshotId": "snap-integrity-compat",
		"objects": []any{map[string]any{
			"role": "manifest", "key": "snapshots/snap-integrity-compat/manifest.json",
			"sha256": "0000000000000000000000000000000000000000000000000000000000000000", "size": 1,
		}},
	},
	"unattested": map[string]any{"v": 1, "mode": "unattested", "snapshotId": "snap-integrity-compat", "reason": "unattested_legacy"},
	"future":     map[string]any{"v": 9, "mode": "something_new", "extra": []any{1, 2}},
}

func TestIntegrityBlock_CoreCommandsRunAsBefore(t *testing.T) {
	origWorkRoot := backupRestoreWorkRoot
	backupRestoreWorkRoot = func() string { return t.TempDir() }
	t.Cleanup(func() { backupRestoreWorkRoot = origWorkRoot })

	snapshotID := "snap-integrity-compat"
	files := map[string][]byte{"a.txt": []byte("alpha"), "b.txt": []byte("beta")}
	for blockName, block := range compatIntegrityBlocks {
		for _, cmd := range []string{"backup_restore", "backup_verify", "backup_test_restore"} {
			t.Run(blockName+"/"+cmd, func(t *testing.T) {
				e := newBrokeredEnv(t)
				e.seedBrokeredSnapshot(snapshotID, files)
				target := t.TempDir()
				payload := sessionPayloadJSON(t, map[string]any{
					"snapshotId": snapshotID, "targetPath": target, "storageSession": e.session(), "integrity": block,
				})
				result := executeCommand(backupipc.BackupCommandRequest{CommandID: "c-" + cmd, CommandType: cmd, Payload: payload},
					nil, &vaultManagerRef{}, nil, newActiveCommandCanceller())
				if !result.Success {
					t.Fatalf("%s with an integrity block failed: %q", cmd, result.Stderr)
				}
				if cmd == "backup_restore" {
					checkRestored(files)(t, result, target)
				} else {
					checkStatus("passed")(t, result, target)
				}
			})
		}
	}
}

func TestIntegrityBlock_StorageSessionDescriptorUnchanged(t *testing.T) {
	e := newBrokeredEnv(t)
	base := map[string]any{"snapshotId": "snap-x", "storageSession": e.session(), "provider": "s3"}
	now := time.Now()
	want, err := storagesession.ParsePayload(sessionPayloadJSON(t, base), now)
	if err != nil || want == nil {
		t.Fatalf("parse payload without integrity: %v (descriptor %v)", err, want)
	}
	for name, block := range compatIntegrityBlocks {
		with := map[string]any{"integrity": block}
		for k, v := range base {
			with[k] = v
		}
		got, err := storagesession.ParsePayload(sessionPayloadJSON(t, with), now)
		if err != nil {
			t.Fatalf("%s: parse payload with integrity: %v", name, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: descriptor differs with an integrity block:\n got %+v\nwant %+v", name, got, want)
		}
	}
}

func TestIntegrityBlock_BareMetalRebuildPayloadUnchanged(t *testing.T) {
	base := `{"recoveryId":"rec-1","token":"brz_rec_test","server":"https://breeze.example.com",` +
		`"target":{"kind":"image","path":"/var/lib/breeze/rebuild/out/disk.img"},"identity":"original"`
	var want bareMetalRebuildPayload
	if err := json.Unmarshal([]byte(base+`}`), &want); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	for name, block := range compatIntegrityBlocks {
		raw, _ := json.Marshal(block)
		var got bareMetalRebuildPayload
		if err := json.Unmarshal([]byte(base+`,"integrity":`+string(raw)+`}`), &got); err != nil {
			t.Fatalf("%s: decode payload with integrity: %v", name, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: payload decoded differently with an integrity block", name)
		}
		if hostGOOS != "windows" {
			if err := got.validate(); err != nil {
				t.Fatalf("%s: validate: %v", name, err)
			}
		}
	}
}

// withIntegrityInBootstrap fronts a recovery test server and adds an
// integrity block to the authenticate response, on the envelope and on the
// nested bootstrap, exactly where the server puts it.
func withIntegrityInBootstrap(t *testing.T, upstream *httptest.Server, block any) *httptest.Server {
	t.Helper()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse upstream: %v", err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ModifyResponse = func(resp *http.Response) error {
		if resp.Request.URL.Path != "/api/v1/backup/bmr/recover/authenticate" || resp.StatusCode != http.StatusOK {
			return nil
		}
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		var envelope map[string]any
		if err := json.Unmarshal(raw, &envelope); err != nil {
			return err
		}
		envelope["integrity"] = block
		if nested, ok := envelope["bootstrap"].(map[string]any); ok {
			nested["integrity"] = block
		}
		out, err := json.Marshal(envelope)
		if err != nil {
			return err
		}
		resp.Body = io.NopCloser(bytes.NewReader(out))
		resp.ContentLength = int64(len(out))
		resp.Header.Del("Content-Length")
		return nil
	}
	server := httptest.NewServer(proxy)
	t.Cleanup(server.Close)
	return server
}

func TestIntegrityBlock_BareMetalRebuildRunsAsBefore(t *testing.T) {
	type observed struct {
		target     rebuild.Target
		identity   string
		snapshotID string
		dryRuns    []bool
	}
	run := func(t *testing.T, block any) observed {
		upstream, _ := newTokenModeTestServer(t, biosLayoutJSON(t))
		server := upstream
		payload := testBareMetalRebuildPayload(t, upstream.URL)
		if block != nil {
			server = withIntegrityInBootstrap(t, upstream, block)
			var p map[string]any
			if err := json.Unmarshal(testBareMetalRebuildPayload(t, server.URL), &p); err != nil {
				t.Fatalf("payload: %v", err)
			}
			p["integrity"] = block
			payload, _ = json.Marshal(p)
		}
		fake := &fakeRebuild{}
		res := execBareMetalRebuild(context.Background(), payload, fake.fn)
		if !res.Success {
			t.Fatalf("bare_metal_rebuild failed: %q", res.Stderr)
		}
		if len(fake.calls) != 2 {
			t.Fatalf("rebuild calls = %d, want a dry run then the run", len(fake.calls))
		}
		o := observed{target: fake.calls[1].Target, identity: string(fake.calls[1].Identity), snapshotID: fake.calls[1].SnapshotID}
		for _, c := range fake.calls {
			o.dryRuns = append(o.dryRuns, c.DryRun)
		}
		return o
	}
	want := run(t, nil)
	for name, block := range compatIntegrityBlocks {
		t.Run(name, func(t *testing.T) {
			if got := run(t, block); !reflect.DeepEqual(got, want) {
				t.Fatalf("rebuild options differ with an integrity block:\n got %+v\nwant %+v", got, want)
			}
		})
	}
}

func TestIntegrityBlock_BMRRecoverCommandRunsAsBefore(t *testing.T) {
	orig := runBMRRecovery
	t.Cleanup(func() { runBMRRecovery = orig })
	var got []bmr.RecoveryConfig
	runBMRRecovery = func(_ context.Context, cfg bmr.RecoveryConfig) (*bmr.RecoveryResult, error) {
		got = append(got, cfg)
		return &bmr.RecoveryResult{Status: "completed"}, nil
	}
	base := map[string]any{"recoveryToken": "brz_rec_x", "serverUrl": "https://api.example", "snapshotId": "snap-integrity-compat", "deviceId": "dev-1"}
	if res := execBMRRecover(context.Background(), sessionPayloadJSON(t, base), nil); !res.Success {
		t.Fatalf("bmr_recover failed: %q", res.Stderr)
	}
	for name, block := range compatIntegrityBlocks {
		with := map[string]any{"integrity": block}
		for k, v := range base {
			with[k] = v
		}
		if res := execBMRRecover(context.Background(), sessionPayloadJSON(t, with), nil); !res.Success {
			t.Fatalf("%s: bmr_recover with an integrity block failed: %q", name, res.Stderr)
		}
	}
	for i := 1; i < len(got); i++ {
		if !reflect.DeepEqual(got[i], got[0]) {
			t.Fatalf("recovery config differs with an integrity block:\n got %+v\nwant %+v", got[i], got[0])
		}
	}
	if len(got) != 1+len(compatIntegrityBlocks) {
		t.Fatalf("recoveries run = %d", len(got))
	}
}
