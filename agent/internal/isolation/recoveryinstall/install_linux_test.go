//go:build linux

package recoveryinstall

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

func TestRecoveryExecutableHasNoExeSuffixOnLinux(t *testing.T) {
	if got := recoveryExecutableName(); got != "breeze-isolation-recovery" {
		t.Fatalf("recoveryExecutableName() = %q", got)
	}
}

func TestPublishExclusiveNeverReplaces(t *testing.T) {
	dir := t.TempDir()
	source, target := filepath.Join(dir, "source"), filepath.Join(dir, "target")
	if err := os.WriteFile(source, []byte("new"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := publishExclusive(source, target); err != nil {
		t.Fatalf("first publish: %v", err)
	}
	if err := os.WriteFile(source+"2", []byte("different"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := publishExclusive(source+"2", target); err == nil {
		t.Fatal("a published recovery binary must never be replaced")
	}
	if got, _ := os.ReadFile(target); string(got) != "new" {
		t.Fatalf("target now %q", got)
	}
}

// The injected fetcher and verifier decide everything: nothing is published
// or adopted past a refused artifact.
func TestLinuxInstallerStagesIntoAVersionedDirectory(t *testing.T) {
	root := t.TempDir()
	data := t.TempDir()
	var repointed []string
	i := &Installer{
		InstallDir: root,
		DataDir:    data,
		Fetch: func(_ context.Context, _ string, w io.Writer) error {
			_, err := w.Write([]byte("#!/bin/sh\n"))
			return err
		},
		VerifySignature: func(string) error { return nil },
		SupportedSchema: func(context.Context, string) (int, error) { return journal.SchemaVersion, nil },
		SelfTest:        func(context.Context, string) error { return nil },
		Tasks:           func() ([]Task, error) { return []Task{{Name: "poll"}}, nil },
		Repoint:         func(task Task, path string) error { repointed = append(repointed, task.Name+"="+path); return nil },
	}
	path, err := i.EnsureRecovery(context.Background(), "1.2.3")
	if err != nil {
		t.Fatalf("EnsureRecovery: %v", err)
	}
	want := filepath.Join(root, "isolation-recovery", "1.2.3", "breeze-isolation-recovery")
	if path != want {
		t.Fatalf("path = %q, want %q", path, want)
	}
	if len(repointed) != 1 || !strings.HasSuffix(repointed[0], want) {
		t.Fatalf("repointed = %v", repointed)
	}

	// A refused artifact at a new version changes nothing.
	i.VerifySignature = func(string) error { return errors.New("bad manifest") }
	if _, err := i.EnsureRecovery(context.Background(), "1.2.4"); err == nil {
		t.Fatal("a refused artifact must fail")
	}
	if _, err := os.Stat(filepath.Join(root, "isolation-recovery", "1.2.4", "breeze-isolation-recovery")); !os.IsNotExist(err) {
		t.Fatal("a refused artifact must not be published")
	}
}

func TestVerifyInstalledRefusesAWritableOrForeignFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "recovery")
	if err := os.WriteFile(path, []byte("x"), 0o700); err != nil {
		t.Fatal(err)
	}
	stat := func(mode os.FileMode, uid uint32) func(string) (os.FileMode, uint32, error) {
		return func(string) (os.FileMode, uint32, error) { return mode, uid, nil }
	}
	for _, tc := range []struct {
		name string
		stat func(string) (os.FileMode, uint32, error)
		ok   bool
	}{
		{"root 0700", stat(0o700, 0), true},
		{"root 0755", stat(0o755, 0), true},
		{"not root", stat(0o700, 1000), false},
		{"group writable", stat(0o770, 0), false},
		{"world writable", stat(0o702, 0), false},
		{"not executable", stat(0o600, 0), false},
		{"symlink", stat(os.ModeSymlink|0o777, 0), false},
		{"directory", stat(os.ModeDir|0o700, 0), false},
		{"stat error", func(string) (os.FileMode, uint32, error) { return 0, 0, os.ErrPermission }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := verifyInstalled(path, tc.stat)
			if (err == nil) != tc.ok {
				t.Fatalf("err = %v, ok = %v", err, tc.ok)
			}
		})
	}
	if err := VerifyInstalled(filepath.Join(dir, "absent")); err == nil {
		t.Fatal("a missing file must not verify")
	}
}

// install-linux.sh's recovery step, run for real against a temp directory.
func runInstallRecovery(t *testing.T, script, source, root string) (string, error) {
	t.Helper()
	data, err := os.ReadFile(script)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	const begin, end = "# BEGIN BREEZE ISOLATION RECOVERY INSTALL\n", "# END BREEZE ISOLATION RECOVERY INSTALL\n"
	from, to := strings.Index(text, begin), strings.Index(text, end)
	if from < 0 || to < 0 {
		t.Fatalf("%s lacks the recovery install block", script)
	}
	body := text[from:to] + "\ninstall_isolation_recovery " + shellQuote(source) + " " + shellQuote(root) + "\n"
	out, err := exec.Command("/bin/sh", "-c", "set -eu\n"+body).CombinedOutput()
	return string(out), err
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func fakeRecoveryBinary(t *testing.T, dir, version, marker string) string {
	t.Helper()
	path := filepath.Join(dir, marker)
	body := "#!/bin/sh\n# " + marker + "\n[ \"$1\" = \"--version\" ] && echo " + shellQuote(version) + "\nexit 0\n"
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestInstallLinuxScriptInstallsSideBySideAndNeverOverwrites(t *testing.T) {
	const script = "../../../scripts/install/install-linux.sh"
	dir := t.TempDir()
	root := filepath.Join(dir, "lib")
	first := fakeRecoveryBinary(t, dir, "1.2.3", "first")
	if out, err := runInstallRecovery(t, script, first, root); err != nil {
		t.Fatalf("install: %v\n%s", err, out)
	}
	installed := filepath.Join(root, "isolation-recovery", "1.2.3", "breeze-isolation-recovery")
	if got, err := os.ReadFile(installed); err != nil || !strings.Contains(string(got), "# first") {
		t.Fatalf("installed = %q, %v", got, err)
	}
	info, err := os.Stat(installed)
	if err != nil || info.Mode().Perm()&0o022 != 0 || info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("mode = %v, %v", info.Mode(), err)
	}
	// Same version again, different bytes: never overwritten.
	second := fakeRecoveryBinary(t, dir, "1.2.3", "second")
	if out, err := runInstallRecovery(t, script, second, root); err != nil {
		t.Fatalf("reinstall: %v\n%s", err, out)
	}
	if got, _ := os.ReadFile(installed); !strings.Contains(string(got), "# first") {
		t.Fatalf("an installed recovery binary was overwritten: %q", got)
	}
	// A new version lands beside it.
	third := fakeRecoveryBinary(t, dir, "1.2.4", "third")
	if out, err := runInstallRecovery(t, script, third, root); err != nil {
		t.Fatalf("upgrade: %v\n%s", err, out)
	}
	if got, _ := os.ReadFile(installed); !strings.Contains(string(got), "# first") {
		t.Fatal("an upgrade replaced the old version")
	}
	if _, err := os.Stat(filepath.Join(root, "isolation-recovery", "1.2.4", "breeze-isolation-recovery")); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Join(root, "isolation-recovery", "1.2.3"))
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
	// A copy that fails publishes nothing: the binary vanishes after --version.
	vanishing := filepath.Join(dir, "vanishing")
	if err := os.WriteFile(vanishing, []byte("#!/bin/sh\nrm -f \"$0\"\necho 1.2.5\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := runInstallRecovery(t, script, vanishing, root); err == nil {
		t.Fatalf("a failed copy must fail the step: %s", out)
	}
	if entries, _ := os.ReadDir(filepath.Join(root, "isolation-recovery", "1.2.5")); len(entries) != 0 {
		t.Fatalf("a failed copy left files behind: %v", entries)
	}
	// A version that could escape the directory is refused.
	for _, bad := range []string{"../../etc", "1.2.3/x", "", "a b"} {
		evil := fakeRecoveryBinary(t, dir, bad, "evil")
		if out, err := runInstallRecovery(t, script, evil, filepath.Join(dir, "evil-root")); err == nil {
			t.Errorf("version %q must be refused: %s", bad, out)
		}
	}
}
