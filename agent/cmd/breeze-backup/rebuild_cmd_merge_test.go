package main

import (
	"encoding/json"
	"io"
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
)

// cliOwnedRebuildFields are the rebuild options the command line decides in
// token mode; every other field comes from the server's bootstrap.
var cliOwnedRebuildFields = map[string]bool{
	"Target": true, "StateDir": true, "StagingRoot": true, "DryRun": true, "ForceReprovision": true,
	"AllowPartialRestore": true, "RegenerateInitramfs": true, "SkipBoot": true, "System": true,
	"Progress": true, "WinSystem": true, "WorkRoot": true, "DriverDirs": true, "ForceDisk": true,
	"AllowDomainController": true,
}

// TestTokenModeRebuildOptions_KeepsEveryBootstrapField: token mode starts
// from the options the bootstrap produced and lays the command-line flags on
// top, so no bootstrap field — the integrity expectation included — can be
// dropped on the way to the rebuild engine.
func TestTokenModeRebuildOptions_KeepsEveryBootstrapField(t *testing.T) {
	e, err := integrity.Parse(json.RawMessage(`{"v":1,"mode":"attested","trust":"server_verified","snapshotId":"snap-1","objects":[{"role":"manifest","key":"snapshots/snap-1/manifest.json","sha256":"` +
		"0000000000000000000000000000000000000000000000000000000000000000" + `","size":1}]}`))
	if err != nil {
		t.Fatal(err)
	}
	fromToken := rebuild.Options{
		SnapshotID: "snap-1", Provider: providers.NewLocalProvider(t.TempDir()), Identity: rebuild.IdentityMode("new"),
		Marker: &rebuild.Marker{RecoveryID: "r", Nonce: "n"}, Layout: &layout.Manifest{}, ExpectSystemState: true, Integrity: e,
	}
	cli := rebuild.Options{
		SnapshotID: "ignored", Identity: rebuild.IdentityMode("original"),
		Target: rebuild.Target{Kind: "image", Path: "/x.img"}, StateDir: "/state", StagingRoot: "/staging", DryRun: true,
		ForceReprovision: true, AllowPartialRestore: true, RegenerateInitramfs: true, SkipBoot: true,
		WorkRoot: "/work", DriverDirs: []string{"/d"}, ForceDisk: true, AllowDomainController: true,
		Progress: func(rebuild.Phase, string, int64, int64) {},
	}
	got := tokenModeRebuildOptions(fromToken, cli, true, false, io.Discard)

	gv, tv, cv := reflect.ValueOf(got), reflect.ValueOf(fromToken), reflect.ValueOf(cli)
	for i := 0; i < gv.NumField(); i++ {
		name := gv.Type().Field(i).Name
		want := tv.Field(i)
		if cliOwnedRebuildFields[name] {
			want = cv.Field(i)
		}
		if gv.Field(i).Kind() == reflect.Func {
			if gv.Field(i).IsNil() != want.IsNil() {
				t.Errorf("%s: func presence differs", name)
			}
			continue
		}
		if !reflect.DeepEqual(gv.Field(i).Interface(), want.Interface()) {
			t.Errorf("%s = %#v, want %#v", name, gv.Field(i).Interface(), want.Interface())
		}
	}
	if got.Integrity != e {
		t.Fatal("the integrity expectation did not reach the engine options")
	}
}

func TestTokenModeRebuildOptions_ExpectSystemStateFlag(t *testing.T) {
	cases := []struct {
		name               string
		server, flag, auto bool
		want               bool
	}{
		{name: "auto follows the server", server: true, auto: true, want: true},
		{name: "explicit true strengthens", server: false, flag: true, want: true},
		{name: "explicit false never weakens", server: true, flag: false, want: true},
		{name: "explicit false with server false", server: false, flag: false, want: false},
	}
	for _, tc := range cases {
		got := tokenModeRebuildOptions(rebuild.Options{ExpectSystemState: tc.server}, rebuild.Options{}, tc.flag, tc.auto, io.Discard)
		if got.ExpectSystemState != tc.want {
			t.Errorf("%s: ExpectSystemState = %v, want %v", tc.name, got.ExpectSystemState, tc.want)
		}
	}
}
