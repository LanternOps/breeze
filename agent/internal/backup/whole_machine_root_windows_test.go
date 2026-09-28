//go:build windows

package backup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/vss"
)

// A whole-machine Windows run backs up `C:\` with VSS forced on
// (cmd/breeze-backup defaultVSS), so rewritePathsForVSS hands the walker
// `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN\`. Under Windows path
// semantics filepath.Clean strips that trailing separator, and the bare
// device object does not stat ("Incorrect function"): every whole-machine
// backup failed before reading a single file. This pins the root form the
// walker stats and walks, under the only semantics where the bug exists.
func TestCleanBackupRoot_ShadowDeviceRootKeepsItsSeparator(t *testing.T) {
	const dev = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy7`

	tests := []struct {
		name string
		in   string
		want string
	}{
		{"rewritten C:\\ root (the whole-machine case)", dev + `\`, dev + `\`},
		{"rewritten bare C: root", dev, dev + `\`},
		{"doubled trailing separator", dev + `\\`, dev + `\`},
		{"forward-slash trailing separator", dev + `/`, dev + `\`},
		{"case-insensitive prefix", `\\?\globalroot\device\HarddiskVolumeShadowCopy7\`, `\\?\globalroot\device\HarddiskVolumeShadowCopy7\`},
		// Below the device root filepath.Clean is correct and must still run.
		{"path under the device root is cleaned normally", dev + `\Users\data\`, dev + `\Users\data`},
		{"dot segments under the device root are cleaned", dev + `\Users\.\data\..\x`, dev + `\Users\x`},
		{"ordinary drive root is untouched", `C:\`, `C:\`},
		{"ordinary path is cleaned", `C:\Users\data\`, `C:\Users\data`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cleanBackupRoot(tt.in); got != tt.want {
				t.Errorf("cleanBackupRoot(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// The walker and originalPathsForVSS must agree on the root form: children of
// a separator-terminated device root are produced by filepath.Join (which
// cleans), so their sourcePath is `<dev>\Windows`, and the journal's resume
// key must map back to `C:\Windows`.
func TestCleanBackupRoot_ChildrenMapBackThroughOriginalPathsForVSS(t *testing.T) {
	const dev = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy7`
	shadowPaths := map[string]string{"C:": dev}

	rewritten, unmapped := rewritePathsForVSS([]string{`C:\`}, shadowPaths, noStagingIdx)
	if len(unmapped) != 0 {
		t.Fatalf("C:\\ was not routed through the shadow copy: unmapped=%v", unmapped)
	}
	root := cleanBackupRoot(rewritten[0])
	child := filepath.Join(root, "Windows", "System32", "config", "SAM")

	rel, err := filepath.Rel(root, child)
	if err != nil || rel != `Windows\System32\config\SAM` {
		t.Fatalf("filepath.Rel(%q, %q) = %q, %v; want the volume-relative path", root, child, rel, err)
	}

	files := []backupFile{{sourcePath: child}}
	originalPathsForVSS(files, shadowPaths)
	if want := `C:\Windows\System32\config\SAM`; files[0].originalPath != want {
		t.Errorf("originalPath = %q, want %q", files[0].originalPath, want)
	}
}

// TestLive_WholeMachineShadowRootIsWalkable is the end-to-end proof against a
// REAL shadow copy: snapshot the system volume through the production provider,
// rewrite `C:\` through the production rewrite, and walk it through the
// production walker. Before the fix this returned
// "failed to stat backup path \\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN:
// Incorrect function." and zero files.
//
// Every top-level entry is excluded (a "*" base-name exclude) so the walk
// visits the root's immediate children only — excluded directories are still
// recorded (forced placeholders) but never descended — which keeps this a
// seconds-long test rather than a full-volume scan.
//
//	set BREEZE_VSS_LIVE=1 && go test ./internal/backup -run Live -v
func TestLive_WholeMachineShadowRootIsWalkable(t *testing.T) {
	if os.Getenv("BREEZE_VSS_LIVE") != "1" {
		t.Skip("set BREEZE_VSS_LIVE=1 to run live VSS tests (needs an elevated process)")
	}

	sysRoot := os.Getenv("SystemRoot")
	if sysRoot == "" {
		sysRoot = `C:\Windows`
	}
	vol := filepath.VolumeName(sysRoot)
	wholeMachineRoot := vol + `\`

	p := vss.NewProvider(vss.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	session, err := p.CreateShadowCopy(ctx, extractVolumes([]string{wholeMachineRoot}))
	if err != nil {
		t.Fatalf("CreateShadowCopy failed: %v", err)
	}
	defer p.ReleaseShadowCopy(session) //nolint:errcheck

	rewritten, unmapped := rewritePathsForVSS([]string{wholeMachineRoot}, session.ShadowPaths, noStagingIdx)
	if len(unmapped) != 0 {
		t.Fatalf("%s was not routed through the shadow copy (ShadowPaths=%v)", wholeMachineRoot, session.ShadowPaths)
	}
	t.Logf("rewritten whole-machine root: %s", rewritten[0])

	m := NewBackupManager(BackupConfig{})
	files, err := m.collectBackupFilesFromPaths(context.Background(), rewritten, newExcludeMatcher([]string{"*"}), nil)
	if err != nil {
		t.Fatalf("walking the shadow-copy root failed: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("walking the shadow-copy root produced no entries")
	}
	originalPathsForVSS(files, session.ShadowPaths)

	var sawWindows bool
	for _, f := range files {
		if !strings.HasPrefix(f.sourcePath, rewritten[0]) {
			t.Errorf("entry %q is not under the shadow root %q", f.sourcePath, rewritten[0])
		}
		if strings.EqualFold(f.originalPath, filepath.Join(wholeMachineRoot, "Windows")) {
			sawWindows = true
		}
	}
	if !sawWindows {
		t.Errorf("no entry mapped back to %sWindows; got %d entries", wholeMachineRoot, len(files))
	}
	t.Logf("walked %d top-level entries through %s", len(files), rewritten[0])
}
