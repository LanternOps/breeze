//go:build windows

package tools

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A volume mounted at a folder is accepted as a scan root and walked as that
// volume's root; a junction to an ordinary folder is refused. Mounting needs
// Administrator; the system volume is mounted a second time at a temporary
// folder and unmounted afterwards.
func TestScanRootAtVolumeMountPoint(t *testing.T) {
	out, err := exec.Command("mountvol", os.Getenv("SystemDrive")+`\`, "/L").Output()
	if err != nil {
		t.Skipf("mountvol: %v", err)
	}
	volume := strings.TrimSpace(string(out))
	mnt := filepath.Join(t.TempDir(), "mnt")
	if err := os.Mkdir(mnt, 0o700); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("mountvol", mnt, volume).CombinedOutput(); err != nil {
		t.Skipf("mountvol (needs Administrator): %v %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("mountvol", mnt, "/D").Run() })

	s := NewScanScope()
	r, err := s.CheckRoot(mnt)
	if err != nil {
		t.Fatalf("a volume mount point was refused as a root: %v", err)
	}
	if r.WalkPath() != mnt+`\` {
		t.Fatalf("walk path = %q", r.WalkPath())
	}
	sam := filepath.Join(mnt, "Windows", "System32", "config", "SAM")
	if info, err := os.Lstat(sam); err == nil && !s.Skip(r, sam, info) {
		t.Error("the credential hive on the mounted volume was not recognised from its root")
	}

	target := t.TempDir()
	junction := filepath.Join(t.TempDir(), "junction")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", junction, target).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J: %v %s", err, out)
	}
	if _, err := s.CheckRoot(junction); err == nil {
		t.Error("a junction to an ordinary folder was accepted as a root")
	}
}
