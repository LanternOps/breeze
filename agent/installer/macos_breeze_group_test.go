package installer

// Wiring tests for the breeze-group rule (#7829). The rule itself lives in
// internal/sessionbroker/ensure_ipc_group.sh and is behaviour-tested there
// (TestEnsureIPCGroupScript). These pin that every macOS install path uses
// that one file instead of carrying its own copy: two hand-maintained copies
// had already drifted apart — postinstall silently accepted a GID-less group,
// install-darwin.sh meant to refuse one, and neither could see it because
// `dscl -read <rec> PrimaryGroupID` exits 0 when the key is missing.

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const breezeGroupLib = "../internal/sessionbroker/ensure_ipc_group.sh"

func readRepoFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

var definesEnsureBreezeGroup = regexp.MustCompile(`(?m)^\s*(function\s+)?ensure_breeze_group\s*\(\)`)

func TestMacInstallPathsUseSharedBreezeGroupLib(t *testing.T) {
	if _, err := os.Stat(breezeGroupLib); err != nil {
		t.Fatalf("shared breeze-group library missing: %v", err)
	}
	cases := []struct {
		path   string
		source string
		// call is the line that runs the rule. The .pkg postinstall must not
		// abort on a group failure: it is also the unattended self-update
		// path, the agent daemon is not bootstrapped yet at that point, and
		// the daemon retries the group on every start. The dev installer is
		// run by hand, so it fails loudly instead.
		call string
	}{
		{"macos/postinstall", `. "$(dirname "$0")/ensure_ipc_group.sh"`, `(?m)^if ! ensure_breeze_group; then$`},
		{"../scripts/install/install-darwin.sh", `. "$(dirname "$0")/../../internal/sessionbroker/ensure_ipc_group.sh"`, `(?m)^ensure_breeze_group\s*$`},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			s := readRepoFile(t, tc.path)
			if definesEnsureBreezeGroup.MatchString(s) {
				t.Fatalf("%s defines its own ensure_breeze_group; source %s instead", tc.path, breezeGroupLib)
			}
			src := strings.Index(s, tc.source)
			if src < 0 {
				t.Fatalf("%s does not source the shared library (%s)", tc.path, tc.source)
			}
			call := regexp.MustCompile(tc.call).FindStringIndex(s)
			if call == nil {
				t.Fatalf("%s never calls ensure_breeze_group as %s", tc.path, tc.call)
			}
			if call[0] < src {
				t.Fatalf("%s calls ensure_breeze_group before sourcing it", tc.path)
			}
		})
	}
}

// The source path in install-darwin.sh is relative to the script, so it must
// resolve to the library from the script's own directory.
func TestInstallDarwinBreezeGroupLibPathResolves(t *testing.T) {
	p := filepath.Join("../scripts/install", "../../internal/sessionbroker/ensure_ipc_group.sh")
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("install-darwin.sh sources %s, which does not exist: %v", p, err)
	}
}

// postinstall sources the library from its own directory, which inside the
// .pkg is the flat scripts dir build-pkg.sh assembles — so the copy is what
// makes the fix ship. Run build-pkg.sh's script-staging lines for real.
func TestBuildPkgStagesBreezeGroupLib(t *testing.T) {
	s := readRepoFile(t, "macos/build-pkg.sh")
	want := `cp "$SCRIPT_DIR/../../internal/sessionbroker/ensure_ipc_group.sh" "$SCRIPTS/ensure_ipc_group.sh"`
	if !strings.Contains(s, want) {
		t.Fatalf("build-pkg.sh does not stage the breeze-group library into the pkg scripts dir (want %q)", want)
	}

	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}
	scriptDir, err := filepath.Abs("macos")
	if err != nil {
		t.Fatal(err)
	}
	scripts := t.TempDir()
	// The staged copy must be the library itself, readable by the installer.
	cmd := exec.Command(bash, "-c", "set -e\nSCRIPT_DIR='"+scriptDir+"'\nSCRIPTS='"+scripts+"'\n"+want+"\n")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("staging copy failed: %v: %s", err, out)
	}
	if got := readRepoFile(t, filepath.Join(scripts, "ensure_ipc_group.sh")); got != readRepoFile(t, breezeGroupLib) {
		t.Fatal("staged ensure_ipc_group.sh differs from the shared library")
	}
}
