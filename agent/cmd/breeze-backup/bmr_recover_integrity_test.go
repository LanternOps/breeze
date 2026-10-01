package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
)

func TestExecBMRRecover_ReadsIntegrityFromPayload(t *testing.T) {
	cases := []struct {
		name        string
		integrity   string
		wantRun     bool
		wantPresent bool
	}{
		{name: "absent", wantRun: true},
		{name: "override block", integrity: `{"v":1,"mode":"unattested_override","snapshotId":"snap-1","authorizationId":"a"}`, wantRun: true, wantPresent: true},
		{name: "unknown version", integrity: `{"v":9,"mode":"attested","snapshotId":"snap-1"}`},
		{name: "unknown mode", integrity: `{"v":1,"mode":"whatever","snapshotId":"snap-1"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			orig := runBMRRecovery
			t.Cleanup(func() { runBMRRecovery = orig })
			var got *bmr.RecoveryConfig
			runBMRRecovery = func(_ context.Context, cfg bmr.RecoveryConfig) (*bmr.RecoveryResult, error) {
				got = &cfg
				return &bmr.RecoveryResult{Status: "completed"}, nil
			}
			p := map[string]any{"recoveryToken": "brz_rec_t", "serverUrl": "https://api.example.com"}
			if tc.integrity != "" {
				p["integrity"] = json.RawMessage(tc.integrity)
			}
			payload, _ := json.Marshal(p)
			res := execBMRRecover(context.Background(), payload, nil)
			if !tc.wantRun {
				if res.Success || got != nil {
					t.Fatalf("recovery ran with an invalid integrity block (success=%v)", res.Success)
				}
				if !strings.Contains(res.Stderr, "integrity") {
					t.Fatalf("stderr %q does not explain the integrity refusal", res.Stderr)
				}
				return
			}
			if !res.Success || got == nil {
				t.Fatalf("recovery did not run: %q", res.Stderr)
			}
			if got.Integrity.Present() != tc.wantPresent {
				t.Fatalf("cfg.Integrity present = %v, want %v", got.Integrity.Present(), tc.wantPresent)
			}
		})
	}
}
