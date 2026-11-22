//go:build linux

package bmr

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type envCommand struct {
	env  []string
	name string
	args []string
}

// fakeEnvCommands records every command the restorer runs, through either
// exec seam, with the extra environment it was given.
func fakeEnvCommands(t *testing.T) *[]envCommand {
	t.Helper()
	var calls []envCommand
	origPlain, origEnv := runCommand, runCommandEnv
	runCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, envCommand{name: name, args: args})
		return []byte("ok"), nil
	}
	runCommandEnv = func(_ context.Context, env []string, name string, args ...string) ([]byte, error) {
		calls = append(calls, envCommand{env: env, name: name, args: args})
		return []byte("ok"), nil
	}
	t.Cleanup(func() { runCommand, runCommandEnv = origPlain, origEnv })
	return &calls
}

// Offline enablement never lets the host's systemctl hand a unit to the
// SysV compatibility helper, which runs the restored tree's update-rc.d or
// chkconfig in a chroot; a unit with no unit file in the restored tree is
// not passed to systemctl at all (its restored rc links already carry its
// state).
func TestOfflineServicesNeverHandOffToSysVScripts(t *testing.T) {
	root, staging := t.TempDir(), t.TempDir()
	const unit = "[Unit]\nDescription=Fixture\n[Service]\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n"
	mustWriteFile(t, filepath.Join(root, "usr", "lib", "systemd", "system", "native.service"), unit)
	mustWriteFile(t, filepath.Join(root, "etc", "init.d", "native"), "#!/bin/sh\n")
	mustWriteFile(t, filepath.Join(root, "lib", "systemd", "system", "getty@.service"), unit)
	mustWriteFile(t, filepath.Join(root, "etc", "systemd", "system", "local.service"), unit)
	mustWriteFile(t, filepath.Join(root, "etc", "init.d", "legacyd"), "#!/bin/sh\n")
	mustWriteFile(t, filepath.Join(staging, "services", "systemd.txt"),
		"native.service enabled\nlegacyd.service enabled\ngetty@tty1.service enabled\nlocal.service enabled\n")
	calls := fakeEnvCommands(t)

	r := &linuxRestorer{}
	if err := r.restoreServices(staging, root); err != nil {
		t.Fatal(err)
	}
	enabled := map[string]bool{}
	for _, c := range *calls {
		if c.name != "systemctl" {
			t.Fatalf("unexpected command %s %v", c.name, c.args)
		}
		if !slices.Contains(c.env, "SYSTEMCTL_SKIP_SYSV=1") {
			t.Fatalf("offline systemctl ran without SYSTEMCTL_SKIP_SYSV=1: env=%v args=%v", c.env, c.args)
		}
		enabled[c.args[len(c.args)-1]] = true
	}
	for _, want := range []string{"native.service", "getty@tty1.service", "local.service"} {
		if !enabled[want] {
			t.Errorf("%s not enabled: %+v", want, *calls)
		}
	}
	if enabled["legacyd.service"] {
		t.Errorf("a unit with no unit file in the restored tree reached systemctl: %+v", *calls)
	}
	if !strings.Contains(strings.Join(r.warnings, "\n"), "legacyd.service") {
		t.Errorf("warnings = %v, want the skipped unit named", r.warnings)
	}
}

// The live restore keeps its plain systemctl enable.
func TestLiveServicesKeepPlainEnable(t *testing.T) {
	staging := t.TempDir()
	mustWriteFile(t, filepath.Join(staging, "services", "systemd.txt"), "native.service enabled\n")
	calls := fakeEnvCommands(t)
	if err := (&linuxRestorer{}).restoreServices(staging, ""); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || strings.Join((*calls)[0].args, " ") != "enable -- native.service" {
		t.Fatalf("calls = %+v", *calls)
	}
}

// copyHostShell copies /bin/sh and the libraries it loads into tree, so a
// script in tree can run under chroot.
func copyHostShell(t *testing.T, tree string) {
	t.Helper()
	out, err := exec.Command("ldd", "/bin/sh").Output()
	if err != nil {
		t.Skipf("ldd: %v", err)
	}
	files := []string{"/bin/sh"}
	for _, field := range strings.Fields(string(out)) {
		if strings.HasPrefix(field, "/") {
			files = append(files, field)
		}
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		dst := filepath.Join(tree, f)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, b, 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

// This opt-in control runs the host's systemctl against a tree whose SysV
// helper programs leave a marker when they run.
func TestOfflineServiceEnableRunsNothingFromTheTree(t *testing.T) {
	if os.Getenv("BREEZE_TEST_SYSTEMCTL") != "1" {
		t.Skip("requires isolated systemctl fixture environment")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		t.Fatal(err)
	}
	const unit = "[Unit]\nDescription=Fixture\n[Service]\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n"
	const initScript = "#!/bin/sh\n### BEGIN INIT INFO\n# Provides: %s\n# Default-Start: 2 3 4 5\n# Default-Stop: 0 1 6\n### END INIT INFO\n"
	const marker = "#!/bin/sh\necho \"$0 $*\" >> /TREE_PROGRAM_RAN\n"
	for _, listed := range []string{"legacyd.service", "both.service"} {
		t.Run(listed, func(t *testing.T) {
			root, staging := t.TempDir(), t.TempDir()
			copyHostShell(t, root)
			mustWriteFile(t, filepath.Join(root, "etc", "init.d", "legacyd"), strings.Replace(initScript, "%s", "legacyd", 1))
			mustWriteFile(t, filepath.Join(root, "etc", "init.d", "both"), strings.Replace(initScript, "%s", "both", 1))
			mustWriteFile(t, filepath.Join(root, "usr", "lib", "systemd", "system", "both.service"), unit)
			for _, helper := range []string{"usr/sbin/update-rc.d", "sbin/chkconfig", "usr/sbin/chkconfig", "sbin/insserv", "usr/sbin/insserv"} {
				mustWriteFile(t, filepath.Join(root, helper), marker)
				if err := os.Chmod(filepath.Join(root, helper), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			mustWriteFile(t, filepath.Join(staging, "services", "systemd.txt"), listed+" enabled\n")
			err := (&linuxRestorer{}).restoreServices(staging, root)
			if b, readErr := os.ReadFile(filepath.Join(root, "TREE_PROGRAM_RAN")); readErr == nil {
				t.Fatalf("a program from the restored tree ran: %s (service result %v)", b, err)
			}
			if err != nil {
				t.Fatal(err)
			}
			if listed == "both.service" {
				if _, err := os.Readlink(filepath.Join(root, "etc", "systemd", "system", "multi-user.target.wants", "both.service")); err != nil {
					t.Fatalf("native unit not enabled: %v", err)
				}
			}
		})
	}
}
