//go:build linux

package bmr

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// This opt-in control runs the host's systemctl against synthetic offline trees.
func TestOfflineServiceManagerRootBoundary(t *testing.T) {
	if os.Getenv("BREEZE_TEST_SYSTEMCTL") != "1" {
		t.Skip("requires isolated systemctl fixture environment")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		t.Fatal(err)
	}
	const unit = "[Unit]\nDescription=Fixture\n[Service]\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n"
	for _, shape := range []string{"regular", "system-directory", "wants-directory", "unit-file"} {
		t.Run(shape, func(t *testing.T) {
			root, staging, other := t.TempDir(), t.TempDir(), t.TempDir()
			system := filepath.Join(root, "etc", "systemd", "system")
			mustWriteFile(t, filepath.Join(system, "fixture.service"), unit)
			mustWriteFile(t, filepath.Join(staging, "services", "systemd.txt"), "fixture.service enabled\n")
			switch shape {
			case "system-directory":
				if err := os.RemoveAll(system); err != nil {
					t.Fatal(err)
				}
				mustWriteFile(t, filepath.Join(other, "fixture.service"), unit)
				if err := os.Symlink(other, system); err != nil {
					t.Fatal(err)
				}
			case "wants-directory":
				if err := os.Symlink(other, filepath.Join(system, "multi-user.target.wants")); err != nil {
					t.Fatal(err)
				}
			case "unit-file":
				path := filepath.Join(system, "fixture.service")
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				mustWriteFile(t, filepath.Join(other, "fixture.service"), unit)
				if err := os.Symlink(filepath.Join(other, "fixture.service"), path); err != nil {
					t.Fatal(err)
				}
			}
			err := (&linuxRestorer{}).restoreServices(staging, root)
			if shape == "regular" {
				if err != nil {
					t.Fatal(err)
				}
				if _, err := os.Readlink(filepath.Join(system, "multi-user.target.wants", "fixture.service")); err != nil {
					t.Fatal(err)
				}
			}
			entries, readErr := os.ReadDir(other)
			if readErr != nil {
				t.Fatal(readErr)
			}
			want := 0
			if shape == "system-directory" || shape == "unit-file" {
				want = 1
			}
			if len(entries) != want {
				t.Fatalf("other directory changed: %v (service result %v)", entries, err)
			}
			if want == 1 {
				got, err := os.ReadFile(filepath.Join(other, "fixture.service"))
				if err != nil || string(got) != unit {
					t.Fatalf("other unit changed: %q %v", got, err)
				}
			}
		})
	}
}
