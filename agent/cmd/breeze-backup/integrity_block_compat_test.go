package main

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

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
