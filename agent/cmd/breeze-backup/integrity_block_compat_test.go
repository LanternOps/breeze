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
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"

	"github.com/breeze-rmm/agent/internal/backup/storagesession"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

// The server adds an `integrity` block to every restore-shaped command it
// delivers (the snapshot's attestation digests, or why there are none). This
// helper reads it: an unattested block runs the command as before and labels
// the result, an attested block whose digests the stored manifest does not
// match stops the command before anything is restored, a block for another
// snapshot is refused, and a block in a newer format refuses the command and
// asks for an agent update. Payload decoders that do not read the block are
// unchanged by it.
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

func TestIntegrityBlock_CoreCommandsHonorTheBlock(t *testing.T) {
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
				var body struct {
					Status   string   `json:"status"`
					Error    string   `json:"error"`
					Warnings []string `json:"warnings"`
				}
				_ = json.Unmarshal([]byte(result.Stdout), &body)
				switch blockName {
				case "unattested":
					// Runs as before, labelled as not checked against an
					// attestation.
					if !result.Success {
						t.Fatalf("%s with an unattested block failed: %q", cmd, result.Stderr)
					}
					if cmd == "backup_restore" {
						checkRestored(files)(t, result, target)
					} else {
						checkStatus("passed")(t, result, target)
					}
					if !strings.Contains(strings.Join(body.Warnings, "\n"), "not checked against a snapshot attestation") {
						t.Fatalf("warnings %v do not label the unattested snapshot", body.Warnings)
					}
				case "attested":
					// The stored manifest does not match the attested digest:
					// a restore fails before writing, a verification reports
					// a failed check in a completed command.
					if cmd == "backup_restore" {
						if result.Success {
							t.Fatalf("restore ran although the manifest differs from its attestation: %+v", result)
						}
						if entries, _ := os.ReadDir(target); len(entries) != 0 {
							t.Fatalf("restore wrote %d entries", len(entries))
						}
					} else if body.Status != "failed" || !strings.Contains(body.Error, "attestation") {
						t.Fatalf("%s: status %q error %q, want a failed attestation check", cmd, body.Status, body.Error)
					}
				case "future":
					if result.Success || !strings.Contains(result.Stderr+result.Stdout, "update the Breeze agent") {
						t.Fatalf("%s with a newer integrity format: %+v, want a refusal asking for an agent update", cmd, result)
					}
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

// rebuildBlocks are integrity blocks for the token-mode rebuild fixture's
// snapshot ("snap-1").
var rebuildBlocks = map[string]any{
	"unattested":       map[string]any{"v": 1, "mode": "unattested", "snapshotId": "snap-1", "reason": "unattested_legacy"},
	"another snapshot": map[string]any{"v": 1, "mode": "unattested", "snapshotId": "snap-other", "reason": "unattested_legacy"},
	"future":           map[string]any{"v": 9, "mode": "something_new", "extra": []any{1, 2}},
}

func TestIntegrityBlock_BareMetalRebuildHonorsTheBlock(t *testing.T) {
	type observed struct {
		target     rebuild.Target
		identity   string
		snapshotID string
		dryRuns    []bool
	}
	run := func(t *testing.T, block any) (observed, []rebuild.Options, backupipc.BackupCommandResult) {
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
		var o observed
		if len(fake.calls) == 2 {
			o = observed{target: fake.calls[1].Target, identity: string(fake.calls[1].Identity), snapshotID: fake.calls[1].SnapshotID}
			for _, c := range fake.calls {
				o.dryRuns = append(o.dryRuns, c.DryRun)
			}
		}
		return o, fake.calls, res
	}
	want, _, res := run(t, nil)
	if !res.Success {
		t.Fatalf("bare_metal_rebuild without a block failed: %q", res.Stderr)
	}
	for name, block := range rebuildBlocks {
		t.Run(name, func(t *testing.T) {
			got, calls, res := run(t, block)
			switch name {
			case "unattested":
				// Runs as before; the engine receives the expectation.
				if !res.Success || !reflect.DeepEqual(got, want) {
					t.Fatalf("rebuild with an unattested block: %+v, options %+v, want %+v", res, got, want)
				}
				for _, c := range calls {
					if c.Integrity == nil || c.Integrity.Mode != integrity.ModeUnattested {
						t.Fatalf("engine options carry integrity %+v, want the unattested expectation", c.Integrity)
					}
				}
			case "another snapshot":
				if res.Success || len(calls) != 0 {
					t.Fatalf("a block for another snapshot must refuse the rebuild before the engine runs: %+v (%d engine calls)", res, len(calls))
				}
			case "future":
				if res.Success || len(calls) != 0 || !strings.Contains(res.Stderr, "update the Breeze agent") {
					t.Fatalf("a newer integrity format must refuse the rebuild and ask for an update: %+v (%d engine calls)", res, len(calls))
				}
			}
		})
	}
}

func TestIntegrityBlock_BMRRecoverCommandHonorsTheBlock(t *testing.T) {
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
		t.Run(name, func(t *testing.T) {
			got = got[:1]
			with := map[string]any{"integrity": block}
			for k, v := range base {
				with[k] = v
			}
			res := execBMRRecover(context.Background(), sessionPayloadJSON(t, with), nil)
			if name == "future" {
				if res.Success || len(got) != 1 || !strings.Contains(res.Stderr, "update the Breeze agent") {
					t.Fatalf("a newer integrity format must refuse the recovery before it starts and ask for an update: %+v", res)
				}
				return
			}
			if !res.Success || len(got) != 2 {
				t.Fatalf("bmr_recover with an integrity block: %+v", res)
			}
			// The recovery receives the command's expectation; everything
			// else is configured exactly as before.
			if got[1].Integrity == nil || got[1].Integrity.SnapshotID != "snap-integrity-compat" {
				t.Fatalf("recovery config carries integrity %+v", got[1].Integrity)
			}
			stripped := got[1]
			stripped.Integrity = nil
			if !reflect.DeepEqual(stripped, got[0]) {
				t.Fatalf("recovery config differs with an integrity block:\n got %+v\nwant %+v", stripped, got[0])
			}
		})
	}
}
