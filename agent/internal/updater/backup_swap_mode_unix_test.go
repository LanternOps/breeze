//go:build !windows

package updater

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestRollbackSwapPreservesExecutableModesFromLiveFiles(t *testing.T) {
	for _, mode := range []os.FileMode{0o755, 0o750, 0o700} {
		for _, retainJournal := range []bool{false, true} {
			t.Run(fmt.Sprintf("mode=%04o/retain=%t", mode, retainJournal), func(t *testing.T) {
				dir := t.TempDir()
				set := RollbackSwapSet{DirectiveID: "rollback-modes", JournalPath: filepath.Join(dir, "rollback.json")}
				liveModes := make(map[RollbackComponent]os.FileMode)
				for _, component := range []RollbackComponent{RollbackComponentAgent, RollbackComponentBackup} {
					live := filepath.Join(dir, string(component))
					if err := os.WriteFile(live, []byte("old "+string(component)), mode); err != nil {
						t.Fatal(err)
					}
					liveInfo, err := os.Stat(live)
					if err != nil {
						t.Fatal(err)
					}
					// Respect a restrictive test-process umask instead of widening
					// the fixture to permissions the copy would mask out again.
					liveModes[component] = liveInfo.Mode().Perm()
					// Match downloadFromURL: CreateTemp stages artifacts at 0600,
					// regardless of the installed executable's permissions.
					staged, err := os.CreateTemp(dir, "downloaded-*")
					if err != nil {
						t.Fatal(err)
					}
					if _, err := staged.WriteString("target " + string(component)); err != nil {
						_ = staged.Close()
						t.Fatal(err)
					}
					if err := staged.Close(); err != nil {
						t.Fatal(err)
					}
					set.Artifacts = append(set.Artifacts, RollbackSwapArtifact{
						Component: component, StagedPath: staged.Name(), LivePath: live,
					})
				}

				var err error
				if retainJournal {
					err = SwapRollbackArtifactsRetainingJournal(set)
				} else {
					err = SwapRollbackArtifacts(set)
				}
				if err != nil {
					t.Fatal(err)
				}
				for _, artifact := range set.Artifacts {
					info, err := os.Stat(artifact.LivePath)
					if err != nil {
						t.Fatal(err)
					}
					if got, want := info.Mode().Perm(), liveModes[artifact.Component]; got != want {
						t.Errorf("%s installed mode = %04o, want %04o", artifact.Component, got, want)
					}
					got, err := os.ReadFile(artifact.LivePath)
					if err != nil {
						t.Fatal(err)
					}
					if want := "target " + string(artifact.Component); string(got) != want {
						t.Errorf("%s bytes = %q, want %q", artifact.Component, got, want)
					}
				}
				if retainJournal {
					if err := CommitRollbackSwap(set.JournalPath); err != nil {
						t.Fatal(err)
					}
				}
			})
		}
	}
}
