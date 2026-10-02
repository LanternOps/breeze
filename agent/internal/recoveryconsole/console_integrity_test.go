package recoveryconsole

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
)

func TestConsole_PassesBootstrapIntegrityToRebuild(t *testing.T) {
	const attested = `{"v":1,"mode":"attested","trust":"server_verified","snapshotId":"snap-1","objects":[{"role":"manifest","key":"snapshots/snap-1/manifest.json","sha256":"` +
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" + `","size":10}]}`
	cases := []struct {
		name      string
		integrity string
		wantErr   bool
	}{
		{name: "attested", integrity: attested},
		{name: "unknown version", integrity: `{"v":5,"mode":"attested","snapshotId":"snap-1"}`, wantErr: true},
		{name: "for another snapshot", integrity: strings.ReplaceAll(attested, "snap-1", "snap-2"), wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			io := &fakeIO{Answers: []string{"https://breeze.example", "abc-def-ghj", "6002248"}}
			deps := &fakeDeps{
				exchangeFn: func(ctx context.Context, server, code string) (string, *bmr.BootstrapResponse, error) {
					return "tok-1", &bmr.BootstrapResponse{
						Version: 1, MinHelperVersion: "0.100.0", SnapshotID: "snap-1",
						Snapshot: &bmr.AuthenticatedSnapshot{SnapshotID: "snap-1", Integrity: json.RawMessage(tc.integrity)},
						Recovery: &bmr.RecoveryBinding{ID: "rec-1", Identity: "new"},
					}, nil
				},
				collectFn: func(ctx context.Context) (*layout.Manifest, error) { return singleDiskLayout(), nil },
				rebuildFn: func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
					if opts.DryRun {
						return samplePlan(), nil
					}
					return &rebuild.Result{Status: "completed"}, nil
				},
			}
			c := &Console{IO: io, Deps: deps.build("0.111.1"), Cmdline: "breeze.media=1"}
			err := c.Run(context.Background())
			if tc.wantErr {
				if err == nil || len(deps.rebuildCalls) != 0 {
					t.Fatalf("err=%v rebuildCalls=%d, want an error before any rebuild", err, len(deps.rebuildCalls))
				}
				if len(deps.progressCalls) == 0 || deps.progressCalls[len(deps.progressCalls)-1].Status != "refused" {
					t.Fatalf("progress = %+v, want a refused post", deps.progressCalls)
				}
				return
			}
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			if len(deps.rebuildCalls) != 2 {
				t.Fatalf("rebuild calls = %d, want 2", len(deps.rebuildCalls))
			}
			for i, call := range deps.rebuildCalls {
				if !call.Integrity.Attested() {
					t.Errorf("rebuild call %d carries no attested expectation", i)
				}
			}
		})
	}
}
