//go:build linux

package bmr

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// recordedCommand captures one runCommand invocation so tests can assert on
// what the restorer actually shelled out to, without running real
// apt-get/systemctl/crontab/iptables-restore.
type recordedCommand struct {
	name string
	args []string
}

// fakeCommands installs a scripted runCommand for the duration of the test
// and returns the slice its invocations are recorded into, plus a lookup by
// command name for scripting per-command results/errors.
func fakeCommands(t *testing.T, results map[string]error) *[]recordedCommand {
	t.Helper()
	var calls []recordedCommand
	orig := runCommand
	runCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, recordedCommand{name: name, args: args})
		if err, ok := results[name]; ok {
			return []byte("fake output for " + name), err
		}
		return []byte("ok"), nil
	}
	t.Cleanup(func() { runCommand = orig })
	return &calls
}

// withEtcTarget redirects etcTargetDir to a temp directory for the duration
// of the test, so /etc restore tests never touch the real live /etc.
func withEtcTarget(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	orig := etcTargetDir
	etcTargetDir = dir
	t.Cleanup(func() { etcTargetDir = orig })
	return dir
}

func mustWriteFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}

func containsCall(calls []recordedCommand, name string, argSubstr string) bool {
	for _, c := range calls {
		if c.name != name {
			continue
		}
		if argSubstr == "" {
			return true
		}
		for _, a := range c.args {
			if strings.Contains(a, argSubstr) {
				return true
			}
		}
	}
	return false
}

func TestRestoreSystemStateUsesCollectorDpkgSelectionsPath(t *testing.T) {
	withEtcTarget(t)
	calls := fakeCommands(t, nil)

	staging := t.TempDir()
	mustWriteFile(t, filepath.Join(staging, "packages", "dpkg.txt"), "vim\tinstall\n")

	r := &linuxRestorer{}
	if err := r.RestoreSystemState(staging); err != nil {
		t.Fatalf("RestoreSystemState: %v", err)
	}

	if !containsCall(*calls, "bash", filepath.Join(staging, "packages", "dpkg.txt")) {
		t.Errorf("expected a dpkg --set-selections command referencing %s, got calls %+v",
			filepath.Join(staging, "packages", "dpkg.txt"), *calls)
	}
	if !containsCall(*calls, "apt-get", "dselect-upgrade") {
		t.Errorf("expected apt-get dselect-upgrade call, got %+v", *calls)
	}
	if containsCall(*calls, "dnf", "") {
		t.Errorf("dpkg present: dnf must not be invoked, got %+v", *calls)
	}
}

func TestRestoreSystemStateFallsBackToRpmList(t *testing.T) {
	withEtcTarget(t)
	calls := fakeCommands(t, nil)

	staging := t.TempDir()
	mustWriteFile(t, filepath.Join(staging, "packages", "rpm.txt"), "vim-8.2.x86_64\n")

	r := &linuxRestorer{}
	if err := r.RestoreSystemState(staging); err != nil {
		t.Fatalf("RestoreSystemState: %v", err)
	}

	if !containsCall(*calls, "dnf", "vim-8.2.x86_64") {
		t.Errorf("expected dnf install call with the rpm package, got %+v", *calls)
	}
}

func TestRestoreSystemStateParsesSystemdServiceTable(t *testing.T) {
	withEtcTarget(t)
	calls := fakeCommands(t, nil)

	staging := t.TempDir()
	mustWriteFile(t, filepath.Join(staging, "services", "systemd.txt"), strings.Join([]string{
		"UNIT FILE                             STATE",
		"acpid.service                         enabled",
		"bluetooth.service                     disabled",
		"",
		"2 unit files listed.",
	}, "\n"))

	r := &linuxRestorer{}
	if err := r.RestoreSystemState(staging); err != nil {
		t.Fatalf("RestoreSystemState: %v", err)
	}

	if !containsCall(*calls, "systemctl", "acpid.service") {
		t.Errorf("expected systemctl enable acpid.service, got %+v", *calls)
	}
	if containsCall(*calls, "systemctl", "bluetooth.service") {
		t.Errorf("bluetooth.service is disabled in the source, must not be enabled, got %+v", *calls)
	}
}

func TestRestoreSystemStateUsesFirewallRulesPath(t *testing.T) {
	withEtcTarget(t)
	calls := fakeCommands(t, nil)

	staging := t.TempDir()
	mustWriteFile(t, filepath.Join(staging, "firewall", "iptables.rules"), "*filter\nCOMMIT\n")

	r := &linuxRestorer{}
	if err := r.RestoreSystemState(staging); err != nil {
		t.Fatalf("RestoreSystemState: %v", err)
	}

	if !containsCall(*calls, "bash", filepath.Join(staging, "firewall", "iptables.rules")) {
		t.Errorf("expected iptables-restore referencing %s, got %+v",
			filepath.Join(staging, "firewall", "iptables.rules"), *calls)
	}
}

func TestRestoreSystemStateRestoresSpoolCrontabsAndIgnoresEtcCrontabCopy(t *testing.T) {
	withEtcTarget(t)
	calls := fakeCommands(t, nil)

	staging := t.TempDir()
	// The redundant /etc/crontab copy — must be ignored.
	mustWriteFile(t, filepath.Join(staging, "crontabs", "crontab"), "# system crontab\n")
	// Debian-nested per-user spool layout.
	mustWriteFile(t, filepath.Join(staging, "crontabs", "spool", "crontabs", "alice"), "* * * * * alice-job\n")

	r := &linuxRestorer{}
	if err := r.RestoreSystemState(staging); err != nil {
		t.Fatalf("RestoreSystemState: %v", err)
	}

	if !crontabUserArgPresent(*calls, "alice") {
		t.Errorf("expected crontab -u alice restore call, got %+v", *calls)
	}
	if crontabUserArgPresent(*calls, "crontab") {
		t.Errorf("the /etc/crontab copy must never be restored as a user crontab named \"crontab\", got %+v", *calls)
	}
	if len(*calls) != 1 {
		t.Errorf("expected exactly one crontab restore call, got %+v", *calls)
	}
}

// crontabUserArgPresent reports whether any recorded `crontab -u <user> ...`
// call used exactly this username — i.e. checks the -u argument itself,
// not a substring anywhere in the full command (which would also match the
// "crontabs" path segment for any recorded call).
func crontabUserArgPresent(calls []recordedCommand, user string) bool {
	for _, c := range calls {
		if c.name != "crontab" {
			continue
		}
		for i, a := range c.args {
			if a == "-u" && i+1 < len(c.args) && c.args[i+1] == user {
				return true
			}
		}
	}
	return false
}

func TestRestoreSystemStateEtcTreeHonoursExcludesAndCopiesTheRest(t *testing.T) {
	target := withEtcTarget(t)
	fakeCommands(t, nil)

	staging := t.TempDir()
	mustWriteFile(t, filepath.Join(staging, "etc", "fstab"), "OLD-UUID / ext4 defaults 0 1\n")
	mustWriteFile(t, filepath.Join(staging, "etc", "hostname"), "old-hostname\n")
	mustWriteFile(t, filepath.Join(staging, "etc", "machine-id"), "abc123\n")
	mustWriteFile(t, filepath.Join(staging, "etc", "netplan", "01-netcfg.yaml"), "network: {}\n")
	mustWriteFile(t, filepath.Join(staging, "etc", "network", "interfaces"), "auto eth0\n")
	mustWriteFile(t, filepath.Join(staging, "etc", "NetworkManager", "system-connections", "eth0.nmconnection"), "[connection]\n")
	mustWriteFile(t, filepath.Join(staging, "etc", "hosts"), "127.0.0.1 localhost\n")
	mustWriteFile(t, filepath.Join(staging, "etc", "ssh", "sshd_config"), "PermitRootLogin no\n")

	var logBuf bytes.Buffer
	origLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, nil)))
	t.Cleanup(func() { slog.SetDefault(origLogger) })

	r := &linuxRestorer{}
	if err := r.RestoreSystemState(staging); err != nil {
		t.Fatalf("RestoreSystemState: %v", err)
	}

	mustNotExist := []string{"fstab", "hostname", "machine-id",
		filepath.Join("netplan", "01-netcfg.yaml"),
		filepath.Join("network", "interfaces"),
		filepath.Join("NetworkManager", "system-connections", "eth0.nmconnection"),
	}
	for _, rel := range mustNotExist {
		if _, err := os.Stat(filepath.Join(target, rel)); err == nil {
			t.Errorf("excluded path %s was restored into target /etc, want skipped", rel)
		}
	}

	mustExist := []string{"hosts", filepath.Join("ssh", "sshd_config")}
	for _, rel := range mustExist {
		if _, err := os.Stat(filepath.Join(target, rel)); err != nil {
			t.Errorf("ordinary path %s was not restored: %v", rel, err)
		}
	}

	if !strings.Contains(logBuf.String(), "fstab") {
		t.Errorf("expected the skip warning to be logged and name the skipped paths, got log: %s", logBuf.String())
	}
}

func TestRestoreEtcTreeRecreatesSymlinksIncludingDangling(t *testing.T) {
	target := withEtcTarget(t)
	fakeCommands(t, nil)

	staging := t.TempDir()
	etcSrc := filepath.Join(staging, "etc")
	if err := os.MkdirAll(etcSrc, 0o755); err != nil {
		t.Fatal(err)
	}

	// A live symlink whose target also exists under the staged /etc — the
	// systemd-resolved stub-resolv.conf pattern.
	mustWriteFile(t, filepath.Join(etcSrc, "resolv-real.conf"), "nameserver 127.0.0.53\n")
	if err := os.Symlink("resolv-real.conf", filepath.Join(etcSrc, "resolv.conf")); err != nil {
		t.Fatal(err)
	}
	// A dangling symlink — the target was never captured (or doesn't exist
	// on this machine), which must not make the restore error out.
	if err := os.Symlink("/usr/bin/vim.basic", filepath.Join(etcSrc, "editor-alt")); err != nil {
		t.Fatal(err)
	}

	r := &linuxRestorer{}
	if err := r.RestoreSystemState(staging); err != nil {
		t.Fatalf("RestoreSystemState: %v", err)
	}

	assertSymlink := func(rel, wantTarget string) {
		t.Helper()
		dst := filepath.Join(target, rel)
		info, err := os.Lstat(dst)
		if err != nil {
			t.Fatalf("Lstat(%s): %v", dst, err)
		}
		if info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("%s was restored as a %s, want a symlink", dst, info.Mode())
		}
		got, err := os.Readlink(dst)
		if err != nil {
			t.Fatalf("Readlink(%s): %v", dst, err)
		}
		if got != wantTarget {
			t.Errorf("Readlink(%s) = %q, want %q", dst, got, wantTarget)
		}
	}

	assertSymlink("resolv.conf", "resolv-real.conf")
	assertSymlink("editor-alt", "/usr/bin/vim.basic") // dangling, still recreated
}

func TestRestoreEtcTreeChmodsExistingDestinationFile(t *testing.T) {
	target := withEtcTarget(t)
	fakeCommands(t, nil)

	// Pre-existing file at the destination with a mode that must NOT
	// survive the restore — os.WriteFile alone only applies perm bits on
	// create, so without an explicit chmod this stays 0644 forever.
	dst := filepath.Join(target, "shadow-like")
	mustWriteFile(t, dst, "old contents\n")
	if err := os.Chmod(dst, 0o644); err != nil {
		t.Fatal(err)
	}

	staging := t.TempDir()
	src := filepath.Join(staging, "etc", "shadow-like")
	mustWriteFile(t, src, "new contents\n")
	if err := os.Chmod(src, 0o640); err != nil {
		t.Fatal(err)
	}

	r := &linuxRestorer{}
	if err := r.RestoreSystemState(staging); err != nil {
		t.Fatalf("RestoreSystemState: %v", err)
	}

	info, err := os.Stat(dst)
	if err != nil {
		t.Fatalf("Stat(%s): %v", dst, err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Errorf("mode of pre-existing destination file = %o, want 0640 (staged mode must replace it)", info.Mode().Perm())
	}
	data, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new contents\n" {
		t.Errorf("content = %q, want the staged content", data)
	}
}

func TestRestoreEtcTreePreservesDirMode(t *testing.T) {
	target := withEtcTarget(t)
	fakeCommands(t, nil)

	staging := t.TempDir()
	srcDir := filepath.Join(staging, "etc", "ssl", "private")
	if err := os.MkdirAll(srcDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(srcDir, 0o700); err != nil {
		t.Fatal(err)
	}

	r := &linuxRestorer{}
	if err := r.RestoreSystemState(staging); err != nil {
		t.Fatalf("RestoreSystemState: %v", err)
	}

	dstDir := filepath.Join(target, "ssl", "private")
	info, err := os.Stat(dstDir)
	if err != nil {
		t.Fatalf("Stat(%s): %v", dstDir, err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Errorf("restored dir mode = %o, want 0700 (must not hardcode 0755)", info.Mode().Perm())
	}
}

func TestRestoreSystemStateOptionalArtifactsMissingIsNotAnError(t *testing.T) {
	withEtcTarget(t)
	calls := fakeCommands(t, nil)

	staging := t.TempDir() // completely empty staging dir

	r := &linuxRestorer{}
	if err := r.RestoreSystemState(staging); err != nil {
		t.Fatalf("RestoreSystemState with no artifacts at all: %v, want nil (all-optional-missing is not a failure)", err)
	}
	if len(*calls) != 0 {
		t.Errorf("expected no commands invoked for an empty staging dir, got %+v", *calls)
	}
}

func TestRestoreSystemStateReturnsErrorNamingFailedArtifact(t *testing.T) {
	withEtcTarget(t)
	fakeCommands(t, map[string]error{
		"apt-get": errTestCommandFailed,
	})

	staging := t.TempDir()
	mustWriteFile(t, filepath.Join(staging, "packages", "dpkg.txt"), "vim\tinstall\n")

	r := &linuxRestorer{}
	err := r.RestoreSystemState(staging)
	if err == nil {
		t.Fatal("RestoreSystemState: want error when apt-get dselect-upgrade fails, got nil")
	}
	if !strings.Contains(err.Error(), "packages") {
		t.Errorf("error %q does not name the failed artifact/step (packages)", err.Error())
	}
}

var errTestCommandFailed = &testCommandError{"exit status 1"}

type testCommandError struct{ msg string }

func (e *testCommandError) Error() string { return e.msg }
