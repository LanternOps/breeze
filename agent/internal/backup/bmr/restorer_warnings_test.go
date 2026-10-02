package bmr

import (
	"context"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

type warningRestorer struct {
	fakeStateRestorer
	warnings []string
}

func (w *warningRestorer) Warnings() []string { return w.warnings }

func TestApplySystemState_SurfacesRestorerWarnings(t *testing.T) {
	provider := providers.NewLocalProvider(t.TempDir())
	content := []byte("vim\tinstall\n")
	uploadSystemStateArtifact(t, provider, "snap-w", "packages/dpkg.txt", content)
	uploadSystemStateManifest(t, provider, "snap-w", systemstate.SystemStateManifest{
		SchemaVersion: 1,
		Artifacts:     []systemstate.Artifact{{Name: "packages", Category: "packages", Path: "packages/dpkg.txt", SizeBytes: int64(len(content)), Checksum: sha256Hex(t, content)}},
	})
	useFakeRestorer(t, &warningRestorer{warnings: []string{"packages: skipped 2 invalid package name(s)"}})

	res := applySystemState(context.Background(), RecoveryConfig{SnapshotID: "snap-w"}, provider)
	if res.err != nil {
		t.Fatalf("applySystemState: %v", res.err)
	}
	if !strings.Contains(strings.Join(res.warnings, "\n"), "skipped 2 invalid package name(s)") {
		t.Fatalf("restorer warnings not surfaced: %v", res.warnings)
	}
}
