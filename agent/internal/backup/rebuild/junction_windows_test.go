//go:build windows

package rebuild

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// plantJunction makes base\relative a junction to target, failing rather than
// skipping when the runner cannot create one.
func plantJunction(t *testing.T, base, relative, target string) {
	t.Helper()
	if _, err := securefs.InstallJunction(base, relative, target, 0); err != nil {
		t.Fatalf("create junction %s: %v", relative, err)
	}
}

func TestWinIdentityRefusesJunctionOnWindows(t *testing.T) {
	for _, mode := range []IdentityMode{IdentityOriginal, IdentityNew} {
		t.Run(string(mode), func(t *testing.T) {
			sys := newFakeWinSystem(t.TempDir())
			seedFakeHives(sys)
			r := resumedWinRun(t, sys)
			seedWinTreeHives(t, r.rootVolume)
			r.opts.Identity = mode
			r.opts.Marker = &Marker{RecoveryID: "recovery", Nonce: "nonce"}
			other := t.TempDir()
			mustWriteFile(t, filepath.Join(other, "Breeze", "agent.yaml"), "agent_id: keep\n")
			mustWriteFile(t, filepath.Join(other, "Breeze", "secrets.yaml"), "keep")
			programData := filepath.Join(r.rootVolume, "ProgramData")
			if err := os.RemoveAll(programData); err != nil {
				t.Fatal(err)
			}
			plantJunction(t, r.rootVolume, "ProgramData", other)
			if err := winIdentity(context.Background(), r); err == nil {
				t.Fatal("expected an error for a junction in the volume")
			}
			assertFileContent(t, filepath.Join(other, "Breeze", "agent.yaml"), "agent_id: keep\n")
			assertFileContent(t, filepath.Join(other, "Breeze", "secrets.yaml"), "keep")
			if _, err := os.Lstat(filepath.Join(other, "Breeze", "data")); !os.IsNotExist(err) {
				t.Fatalf("marker directory created outside the volume: %v", err)
			}
		})
	}
}

func TestWinEncryptionRefusesJunctionOnWindows(t *testing.T) {
	r := bitlockerRun(t, TargetDisk, true)
	mustMkdirAll(t, r.rootVolume)
	other := t.TempDir()
	plantJunction(t, r.rootVolume, "ProgramData", other)
	if err := winEncryption(context.Background(), r); err == nil {
		t.Fatal("expected an error for a junction in the volume")
	}
	assertDirEmpty(t, other)
}
