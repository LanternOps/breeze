//go:build linux

package bmr

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// The offline system-state apply writes into a restored tree. A directory or
// file link inside that tree, or inside the staged system state, must not
// carry the apply's reads or writes outside them.

func linkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skip(err)
	}
}

func requireEmptyDir(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("directory outside the tree changed: %v %v", entries, err)
	}
}

func TestOfflineStateRegularPaths(t *testing.T) {
	root, staging := t.TempDir(), t.TempDir()
	sources := map[string]string{
		filepath.Join("etc", "config"):                         "config",
		filepath.Join("firewall", "iptables.rules"):            "rules",
		filepath.Join("crontabs", "spool", "crontabs", "user"): "crontab",
	}
	for name, content := range sources {
		mustWriteFile(t, filepath.Join(staging, name), content)
	}
	calls := fakeCommands(t, nil)
	if _, err := RestoreSystemStateOffline(context.Background(), root, staging); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 {
		t.Fatalf("unexpected commands: %v", *calls)
	}
	for name, content := range sources {
		got, err := os.ReadFile(filepath.Join(staging, name))
		if err != nil || string(got) != content {
			t.Fatalf("staged %s changed: %q %v", name, got, err)
		}
	}
	for name, content := range map[string]string{
		filepath.Join("etc", "config"):                               "config",
		filepath.Join("etc", "breeze", "recovery", "iptables.rules"): "rules",
		filepath.Join("var", "spool", "cron", "crontabs", "user"):    "crontab",
	} {
		got, err := os.ReadFile(filepath.Join(root, name))
		if err != nil || string(got) != content {
			t.Fatalf("%s: %q %v", name, got, err)
		}
	}
}

func TestOfflineStateDirectoryBoundary(t *testing.T) {
	for _, operation := range []string{"etc", "crontab", "firewall"} {
		t.Run(operation, func(t *testing.T) {
			root, other, staging := t.TempDir(), t.TempDir(), t.TempDir()
			r := &linuxRestorer{}
			var err error
			switch operation {
			case "etc":
				linkOrSkip(t, other, filepath.Join(root, "etc"))
				mustWriteFile(t, filepath.Join(staging, "etc", "config"), "content")
				fakeCommands(t, nil)
				_, err = RestoreSystemStateOffline(context.Background(), root, staging)
			case "crontab":
				linkOrSkip(t, other, filepath.Join(root, "var"))
				mustWriteFile(t, filepath.Join(staging, "crontabs", "spool", "crontabs", "user"), "content")
				err = r.restoreCrontabs(staging, root)
			case "firewall":
				linkOrSkip(t, other, filepath.Join(root, "etc"))
				mustWriteFile(t, filepath.Join(staging, "firewall", "iptables.rules"), "content")
				_, err = r.restoreFirewallOffline(staging, root)
			}
			if err == nil {
				t.Fatal("expected an error for a directory outside the tree")
			}
			requireEmptyDir(t, other)
		})
	}
}

func TestOfflineServiceDirectoryBoundary(t *testing.T) {
	for _, shape := range []string{"system-directory", "wants-directory"} {
		t.Run(shape, func(t *testing.T) {
			root, staging, other := t.TempDir(), t.TempDir(), t.TempDir()
			mustWriteFile(t, filepath.Join(staging, "services", "systemd.txt"), "fixture.service enabled\n")
			system := filepath.Join(root, "etc", "systemd", "system")
			if shape == "system-directory" {
				linkOrSkip(t, other, system)
			} else {
				linkOrSkip(t, other, filepath.Join(system, "multi-user.target.wants"))
			}
			calls := fakeCommands(t, nil)
			if err := (&linuxRestorer{}).restoreServices(staging, root); err == nil {
				t.Fatal("expected an error for a service directory outside the tree")
			}
			if len(*calls) != 0 {
				t.Fatalf("unexpected commands: %v", *calls)
			}
			requireEmptyDir(t, other)
		})
	}
}

func TestOfflineServicesValidateUnitArguments(t *testing.T) {
	for _, name := range []string{"../unit.service", "-unit.service", "unit/child.service", "unit.exe"} {
		t.Run(name, func(t *testing.T) {
			root, staging := t.TempDir(), t.TempDir()
			mustWriteFile(t, filepath.Join(staging, "services", "systemd.txt"), name+" enabled\n")
			calls := fakeCommands(t, nil)
			if err := (&linuxRestorer{}).restoreServices(staging, root); err == nil {
				t.Fatal("expected unit validation error")
			}
			if len(*calls) != 0 {
				t.Fatalf("unexpected commands: %v", *calls)
			}
		})
	}
}

func TestOfflineScalarSourceBoundary(t *testing.T) {
	for _, operation := range []string{"services", "firewall"} {
		t.Run(operation, func(t *testing.T) {
			root, staging, other := t.TempDir(), t.TempDir(), t.TempDir()
			name, content := "systemd.txt", "fixture.service enabled\n"
			if operation == "firewall" {
				name, content = "iptables.rules", "content"
			}
			mustWriteFile(t, filepath.Join(other, name), content)
			linkOrSkip(t, other, filepath.Join(staging, operation))
			calls := fakeCommands(t, nil)
			r := &linuxRestorer{}
			var err error
			if operation == "services" {
				err = r.restoreServices(staging, root)
			} else {
				_, err = r.restoreFirewallOffline(staging, root)
			}
			if err == nil {
				t.Fatal("expected an error for a staged input outside the staging directory")
			}
			if len(*calls) != 0 {
				t.Fatalf("unexpected commands: %v", *calls)
			}
			if _, err := os.Lstat(filepath.Join(root, "etc", "breeze", "recovery", "iptables.rules")); !os.IsNotExist(err) {
				t.Fatalf("unexpected output: %v", err)
			}
		})
	}
}

func TestOfflineAccountLookupTreeBoundary(t *testing.T) {
	root, other := t.TempDir(), t.TempDir()
	mustWriteFile(t, filepath.Join(other, "passwd"), "fixture:x:45123:45124::/:/bin/false\n")
	mustWriteFile(t, filepath.Join(other, "group"), "crontab:x:45124:\n")
	mustWriteFile(t, filepath.Join(other, "sbin", "grub2-mkconfig"), "marker")
	for _, name := range []string{"etc", "usr"} {
		linkOrSkip(t, other, filepath.Join(root, name))
	}
	if got := lookupPasswdUID(root, "fixture"); got != -1 {
		t.Fatalf("uid read from outside the tree: %d", got)
	}
	if got := lookupGroupGID(root, "crontab"); got != 0 {
		t.Fatalf("gid read from outside the tree: %d", got)
	}
	if !crontabsSpoolDirIsDebian(root) {
		t.Fatal("distribution marker read from outside the tree")
	}
}
