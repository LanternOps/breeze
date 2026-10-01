package bmr

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

func withRecoverHost(t *testing.T, goosValue string) {
	t.Helper()
	orig := recoverHostGOOS
	recoverHostGOOS = goosValue
	t.Cleanup(func() { recoverHostGOOS = orig })
}

// countExecSeam routes every command bmr would run through the exec seam
// into a counter.
func countExecSeam(t *testing.T) *[]string {
	t.Helper()
	var mu sync.Mutex
	var calls []string
	restore := SetRunCommandForTest(func(_ context.Context, name string, args ...string) ([]byte, error) {
		mu.Lock()
		defer mu.Unlock()
		calls = append(calls, strings.TrimSpace(name+" "+strings.Join(args, " ")))
		return []byte("ok"), nil
	})
	t.Cleanup(restore)
	return &calls
}

func seedStateSnapshot(t *testing.T, snapshotID string) *providers.LocalProvider {
	t.Helper()
	provider := providers.NewLocalProvider(t.TempDir())
	buildOrdinaryManifestFixture(t, provider, snapshotID)
	content := []byte("state artifact bytes")
	uploadSystemStateArtifact(t, provider, snapshotID, "registry_SYSTEM", content)
	uploadSystemStateManifest(t, provider, snapshotID, systemstate.SystemStateManifest{
		SchemaVersion: 1,
		Artifacts: []systemstate.Artifact{
			{Name: "registry", Category: "registry", Path: "registry_SYSTEM", SizeBytes: int64(len(content)), Checksum: sha256Hex(t, content)},
		},
	})
	return provider
}

func TestRunRecoveryContext_WindowsHost_FilesOnly(t *testing.T) {
	cases := []struct {
		name     string
		expect   bool
		seed     bool
		wantCode string
	}{
		{name: "snapshot with system state, advertised", expect: true, seed: true, wantCode: CodeSystemStateRequiresRebuild},
		{name: "snapshot with system state, not advertised", expect: false, seed: true, wantCode: CodeSystemStateRequiresRebuild},
		{name: "snapshot without system state", expect: false, seed: false, wantCode: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withRecoverHost(t, "windows")
			calls := countExecSeam(t)
			fr := useFakeRestorer(t, &fakeStateRestorer{})
			snapshotID := "snap-win-files-only"
			var provider *providers.LocalProvider
			if tc.seed {
				provider = seedStateSnapshot(t, snapshotID)
			} else {
				provider = providers.NewLocalProvider(t.TempDir())
				buildOrdinaryManifestFixture(t, provider, snapshotID)
			}

			res, err := RunRecoveryContext(context.Background(), RecoveryConfig{SnapshotID: snapshotID, ExpectSystemState: tc.expect}, provider)
			if err != nil {
				t.Fatalf("RunRecoveryContext: %v", err)
			}
			if fr.restoreCalls != 0 {
				t.Fatalf("system state restorer ran %d time(s) on a Windows host", fr.restoreCalls)
			}
			if len(*calls) != 0 {
				t.Fatalf("commands ran through the exec seam on a Windows host: %v", *calls)
			}
			if res.Code != tc.wantCode {
				t.Fatalf("code = %q, want %q", res.Code, tc.wantCode)
			}
			if res.StateApplied {
				t.Fatal("StateApplied = true on a files-only recovery")
			}
			if res.FilesRestored != 1 || res.Status != "completed" {
				t.Fatalf("result = %+v, want the files restored and status completed", res)
			}
			if tc.wantCode != "" {
				if !strings.Contains(strings.Join(res.Warnings, "\n"), CodeSystemStateRequiresRebuild) {
					t.Fatalf("warnings %v do not carry the code", res.Warnings)
				}
				body, _ := json.Marshal(res)
				if !strings.Contains(string(body), `"code":"system_state_requires_rebuild"`) {
					t.Fatalf("result JSON %s has no code field", body)
				}
			}
		})
	}
}

func TestRunRecoveryContext_LinuxHost_StillAppliesSystemState(t *testing.T) {
	withRecoverHost(t, "linux")
	fr := useFakeRestorer(t, &fakeStateRestorer{})
	provider := seedStateSnapshot(t, "snap-linux-state")

	res, err := RunRecoveryContext(context.Background(), RecoveryConfig{SnapshotID: "snap-linux-state", ExpectSystemState: true}, provider)
	if err != nil {
		t.Fatalf("RunRecoveryContext: %v", err)
	}
	if fr.restoreCalls != 1 || !res.StateApplied || res.Code != "" {
		t.Fatalf("restoreCalls=%d stateApplied=%v code=%q, want 1/true/empty", fr.restoreCalls, res.StateApplied, res.Code)
	}
}
