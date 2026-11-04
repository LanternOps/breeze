package installer

// Tests for the pkg's network-isolation recovery blocks (#10099). Like the other
// macOS installer tests they run the real shell under bash with launchctl,
// chown, xattr and sleep replaced by recorders, so nothing touches launchd or
// needs root, and they run in the Linux agent test job too.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type isolationRun struct {
	out, calls, root string
	code             int
}

// runIsolationShell runs body after sourcing install-location.sh under `set -e`,
// as postinstall does. root is a scratch directory standing in for /.
func runIsolationShell(t *testing.T, body string) isolationRun {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}
	lib, err := filepath.Abs(installLocationLib)
	if err != nil {
		t.Fatal(err)
	}
	bin, state, root := t.TempDir(), t.TempDir(), t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(content), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write("launchctl", fakeAgentLaunchctl)
	recorder := "#!/bin/sh\necho \"${0##*/} $*\" >> \"$FAKE_STATE/calls\"\n"
	for _, name := range []string{"sleep", "chown", "xattr"} {
		write(name, recorder)
	}
	cmd := exec.Command(bash, "-c", "set -e\n. '"+lib+"'\n"+body+"\n")
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "FAKE_STATE="+state, "SCENARIO=ok", "ROOT="+root)
	out, err := cmd.CombinedOutput()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("bash: %v", err)
	}
	calls, _ := os.ReadFile(filepath.Join(state, "calls"))
	return isolationRun{out: string(out), calls: string(calls), root: root, code: code}
}

func stageRecovery(t *testing.T, root, version, content string) {
	t.Helper()
	dir := filepath.Join(root, "staging", "isolation-recovery", version)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "breeze-isolation-recovery"), []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
}

const installRecoveryBody = `ISOLATION_RECOVERY=$(install_isolation_recovery "$ROOT/staging/isolation-recovery" "$ROOT/Library/Breeze/isolation-recovery")
echo "result=$ISOLATION_RECOVERY"`

// Every shipped pkg today: build-pkg.sh bundles no recovery binary, so the
// blocks must do nothing at all. No file, no daemon, no launchd call.
func TestIsolationRecoveryIsInertWithoutABundledBinary(t *testing.T) {
	r := runIsolationShell(t, `mkdir -p "$ROOT/staging"
`+installRecoveryBody+`
load_isolation_recovery_daemon "" "$ROOT/template.plist" "$ROOT/Library/LaunchDaemons/com.breeze.isolation.plist" "/data"`)
	if r.code != 0 || !strings.Contains(r.out, "result=\n") {
		t.Fatalf("exit %d\n%s", r.code, r.out)
	}
	if r.calls != "" {
		t.Fatalf("an inert pkg touched the system:\n%s", r.calls)
	}
	if _, err := os.Stat(filepath.Join(r.root, "Library")); !os.IsNotExist(err) {
		t.Fatalf("an inert pkg created files: %v", err)
	}
}

func TestInstallIsolationRecoveryInstallsAVersionedCopy(t *testing.T) {
	r := runIsolationShell(t, `mkdir -p "$ROOT/staging/isolation-recovery/1.2.3"
printf 'signed recovery' > "$ROOT/staging/isolation-recovery/1.2.3/breeze-isolation-recovery"
`+installRecoveryBody)
	want := filepath.Join(r.root, "Library/Breeze/isolation-recovery/1.2.3/breeze-isolation-recovery")
	if r.code != 0 || !strings.Contains(r.out, "result="+want+"\n") {
		t.Fatalf("exit %d\n%s", r.code, r.out)
	}
	b, err := os.ReadFile(want)
	if err != nil || string(b) != "signed recovery" {
		t.Fatalf("installed %q err %v", b, err)
	}
	info, _ := os.Stat(want)
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("mode %v", info.Mode())
	}
	for _, wantCall := range []string{"chown root:wheel " + filepath.Join(r.root, "Library/Breeze/isolation-recovery"), "chown -R root:wheel"} {
		if !strings.Contains(r.calls, wantCall) {
			t.Errorf("missing %q:\n%s", wantCall, r.calls)
		}
	}
	if entries, _ := os.ReadDir(filepath.Join(r.root, "Library/Breeze/isolation-recovery")); len(entries) != 1 {
		t.Fatalf("left a temporary directory: %v", entries)
	}
}

// An unresolved episode pins the recovery path inside an existing version
// directory, and its jobs run that file. The pkg must never rewrite it.
func TestInstallIsolationRecoveryNeverOverwritesAnExistingVersion(t *testing.T) {
	r := runIsolationShell(t, `mkdir -p "$ROOT/staging/isolation-recovery/1.2.3" "$ROOT/Library/Breeze/isolation-recovery/1.2.3"
printf 'new bytes' > "$ROOT/staging/isolation-recovery/1.2.3/breeze-isolation-recovery"
printf 'running recovery' > "$ROOT/Library/Breeze/isolation-recovery/1.2.3/breeze-isolation-recovery"
`+installRecoveryBody)
	path := filepath.Join(r.root, "Library/Breeze/isolation-recovery/1.2.3/breeze-isolation-recovery")
	if r.code != 0 || !strings.Contains(r.out, "result="+path+"\n") {
		t.Fatalf("exit %d\n%s", r.code, r.out)
	}
	if b, _ := os.ReadFile(path); string(b) != "running recovery" {
		t.Fatalf("existing version overwritten: %q", b)
	}
	if !strings.Contains(r.out, "already installed") {
		t.Fatalf("say why nothing was copied:\n%s", r.out)
	}
}

func TestInstallIsolationRecoveryRefusesUnsafeInput(t *testing.T) {
	t.Run("a version name that is not a version", func(t *testing.T) {
		r := runIsolationShell(t, `mkdir -p "$ROOT/staging/isolation-recovery/1.2.3 x"
printf x > "$ROOT/staging/isolation-recovery/1.2.3 x/breeze-isolation-recovery"
`+installRecoveryBody)
		if r.code == 0 {
			t.Fatalf("accepted:\n%s", r.out)
		}
		if _, err := os.Stat(filepath.Join(r.root, "Library/Breeze/isolation-recovery/1.2.3 x")); !os.IsNotExist(err) {
			t.Fatalf("installed it: %v", err)
		}
	})
	t.Run("a hidden directory is never a version", func(t *testing.T) {
		r := runIsolationShell(t, `mkdir -p "$ROOT/staging/isolation-recovery/.hidden"
printf x > "$ROOT/staging/isolation-recovery/.hidden/breeze-isolation-recovery"
`+installRecoveryBody)
		if r.code != 0 || !strings.Contains(r.out, "result=\n") {
			t.Fatalf("exit %d\n%s", r.code, r.out)
		}
	})
	t.Run("a symlinked install root", func(t *testing.T) {
		r := runIsolationShell(t, `mkdir -p "$ROOT/staging/isolation-recovery/1.2.3" "$ROOT/elsewhere" "$ROOT/Library/Breeze"
printf x > "$ROOT/staging/isolation-recovery/1.2.3/breeze-isolation-recovery"
ln -s "$ROOT/elsewhere" "$ROOT/Library/Breeze/isolation-recovery"
`+installRecoveryBody)
		if r.code == 0 {
			t.Fatalf("installed through a symlink:\n%s", r.out)
		}
		if entries, _ := os.ReadDir(filepath.Join(r.root, "elsewhere")); len(entries) != 0 {
			t.Fatalf("wrote through the symlink: %v", entries)
		}
	})
}

func TestLoadIsolationRecoveryDaemon(t *testing.T) {
	template, err := os.ReadFile("../service/launchd/com.breeze.isolation.plist")
	if err != nil {
		t.Fatal(err)
	}
	setup := `mkdir -p "$ROOT/Library/LaunchDaemons"
cp '` + mustAbs(t, "../service/launchd/com.breeze.isolation.plist") + `' "$ROOT/template.plist"
`
	load := `load_isolation_recovery_daemon /Library/Breeze/isolation-recovery/1.2.3/breeze-isolation-recovery "$ROOT/template.plist" "$ROOT/Library/LaunchDaemons/com.breeze.isolation.plist" "/Library/Application Support/Breeze/data"`
	t.Run("first install renders and loads it", func(t *testing.T) {
		r := runIsolationShell(t, setup+load)
		if r.code != 0 {
			t.Fatalf("exit %d\n%s", r.code, r.out)
		}
		got, err := os.ReadFile(filepath.Join(r.root, "Library/LaunchDaemons/com.breeze.isolation.plist"))
		if err != nil {
			t.Fatal(err)
		}
		want := strings.NewReplacer("__RECOVERY_PATH__", "/Library/Breeze/isolation-recovery/1.2.3/breeze-isolation-recovery", "__DATA_DIR__", "/Library/Application Support/Breeze/data").Replace(string(template))
		if string(got) != want {
			t.Fatalf("rendered:\n%s\nwant:\n%s", got, want)
		}
		// A system-domain LaunchDaemon, never a per-user agent.
		if !strings.Contains(r.calls, "launchctl bootstrap system "+filepath.Join(r.root, "Library/LaunchDaemons/com.breeze.isolation.plist")) || strings.Contains(r.calls, "gui/") {
			t.Fatalf("calls:\n%s", r.calls)
		}
		if !strings.Contains(r.calls, "chown root:wheel") {
			t.Fatalf("plist not chowned:\n%s", r.calls)
		}
	})
	// An existing daemon may be pinned to the recovery path of an unresolved
	// episode. The agent repoints it when idle; the pkg never does.
	t.Run("upgrade leaves an existing daemon alone", func(t *testing.T) {
		r := runIsolationShell(t, setup+`printf 'pinned' > "$ROOT/Library/LaunchDaemons/com.breeze.isolation.plist"
`+load)
		if r.code != 0 || r.calls != "" {
			t.Fatalf("exit %d calls:\n%s", r.code, r.calls)
		}
		if b, _ := os.ReadFile(filepath.Join(r.root, "Library/LaunchDaemons/com.breeze.isolation.plist")); string(b) != "pinned" {
			t.Fatalf("rewritten: %q", b)
		}
	})
}

func mustAbs(t *testing.T, p string) string {
	t.Helper()
	abs, err := filepath.Abs(p)
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

// The postinstall wiring: stage before the staging directory is deleted, load
// only after the agent is up, never fatal, and outside the #10868 helper block.
func TestPostinstallIsolationBlocksAreAdditive(t *testing.T) {
	b, err := os.ReadFile("macos/postinstall")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	stage := strings.Index(s, "install_isolation_recovery ")
	rmStaging := strings.Index(s, `rm -rf "$STAGING_DIR"`)
	agentLoad := strings.Index(s, "bootstrap_system_daemon com.breeze.agent")
	load := strings.Index(s, "load_isolation_recovery_daemon ")
	helpers := strings.Index(s, "# Load the user helper LaunchAgent")
	if stage < 0 || rmStaging < stage || load < agentLoad || helpers < load {
		t.Fatalf("stage=%d rm=%d agent=%d load=%d helpers=%d", stage, rmStaging, agentLoad, load, helpers)
	}
	for _, call := range []string{"install_isolation_recovery ", "load_isolation_recovery_daemon "} {
		line := s[strings.LastIndex(s[:strings.Index(s, call)], "\n")+1:]
		line = line[:strings.Index(line, "\n")]
		if !strings.HasPrefix(strings.TrimSpace(line), "if ! ") {
			t.Errorf("%s must not be able to fail the install (set -e): %q", call, line)
		}
	}
	if strings.Contains(postinstallHelperBlock(t), "isolation") {
		t.Fatal("the isolation blocks must stay out of the #10868 helper block")
	}
	pkg, err := os.ReadFile("macos/build-pkg.sh")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(pkg), `cp "$SCRIPT_DIR/../../service/launchd/com.breeze.isolation.plist" "$SCRIPTS/com.breeze.isolation.plist"`) {
		t.Fatal("build-pkg.sh must ship the daemon template with the install scripts")
	}
	// The template travels with the scripts, never in the payload: launchd
	// would load a payload LaunchDaemon at every boot, binary or not.
	if strings.Contains(string(pkg), `$PAYLOAD/Library/LaunchDaemons/com.breeze.isolation`) {
		t.Fatal("the isolation daemon must not be in the payload")
	}
}
