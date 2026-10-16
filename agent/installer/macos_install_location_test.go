package installer

// Tests for installer/macos/install-location.sh, the function library the
// macOS .pkg postinstall sources to decide where the agent binaries go
// (#7211). They run the real shell functions under bash, so they need no
// macOS: the library sticks to POSIX tools (ls -ldn, sed) on purpose, which
// keeps this coverage in the required Linux agent test job.

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const installLocationLib = "macos/install-location.sh"

// runLib sources the library, applies overrides (plain shell assignments),
// then runs body; it returns trimmed stdout and the exit status.
func runLib(t *testing.T, overrides, body string) (string, int) {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}
	lib, err := filepath.Abs(installLocationLib)
	if err != nil {
		t.Fatal(err)
	}
	script := "set -eu\n. '" + lib + "'\n" + overrides + "\n" + body + "\n"
	cmd := exec.Command(bash, "-c", script)
	out, err := cmd.Output()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("bash: %v", err)
	}
	return strings.TrimSpace(string(out)), code
}

func isRoot() bool { return os.Geteuid() == 0 }

// TestLegacyDirIsSafeDecisionTable mirrors the Go-side
// securefs.VerifyTrustedExecutablePathChain table: the .pkg must reach the
// same verdict the running agent will, or a pkg install and the next agent
// start would move the binary back and forth.
func TestLegacyDirIsSafeDecisionTable(t *testing.T) {
	if isRoot() {
		t.Skip("fixtures below rely on the test process not being root")
	}
	userOwned := t.TempDir()
	groupWritable := filepath.Join(t.TempDir(), "bin")
	if err := os.Mkdir(groupWritable, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(groupWritable, 0o775); err != nil {
		t.Fatal(err)
	}
	linkTarget := t.TempDir()
	symlinked := filepath.Join(t.TempDir(), "bin")
	if err := os.Symlink(linkTarget, symlinked); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name     string
		dir      string
		wantSafe bool
	}{
		// /usr/bin: root-owned 0755 all the way up on both macOS and Linux.
		{"root-owned 0755 chain is safe", "/usr/bin", true},
		{"user-owned dir is unsafe", userOwned, false},
		{"group-writable dir is unsafe", groupWritable, false},
		{"symlinked dir is unsafe", symlinked, false},
		// A fresh Mac may have no /usr/local/bin yet; postinstall creates
		// it root:wheel 0755, so only the existing ancestors decide.
		{"missing dir under a safe parent is safe", "/usr/bin/breeze-no-such-dir/bin", true},
		{"missing dir under a user-owned parent is unsafe", filepath.Join(userOwned, "missing", "bin"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// An explicit verdict on stdout, not just the exit status: a
			// library that failed to load must not read as "unsafe".
			got, code := runLib(t, "", "if legacy_dir_is_safe '"+tc.dir+"'; then echo safe; else echo unsafe; fi")
			want := "unsafe"
			if tc.wantSafe {
				want = "safe"
			}
			if code != 0 || got != want {
				t.Fatalf("legacy_dir_is_safe(%q) = %q (exit %d), want %q", tc.dir, got, code, want)
			}
		})
	}
}

// TestLsLineIsRootSafe pins the ownership/mode parse on synthetic ls -ldn
// lines, so each rule is exercised on its own. (The real-filesystem rows
// above can go unsafe through an ancestor — /var is a symlink on macOS and
// /tmp is 1777 on Linux — which would hide a broken leaf check.)
func TestLsLineIsRootSafe(t *testing.T) {
	cases := []struct {
		line     string
		wantSafe bool
	}{
		{"drwxr-xr-x  8 0  0  256 Sep  1 23:43 /usr/local/bin", true},
		{"drwxr-xr-x@ 8 0  0  256 Sep  1 23:43 /usr/local/bin", true},
		{"drwxr-xr-x+ 8 0  0  256 Sep  1 23:43 /usr/local/bin", true},
		{"drwxr-xr-x  8 501 80 256 Sep  1 23:43 /usr/local/bin", false}, // user-owned (Homebrew on Intel)
		{"drwxrwxr-x  8 0  80 256 Sep  1 23:43 /usr/local/bin", false},  // root:admin group-writable
		{"drwxr-xrwx  8 0  0  256 Sep  1 23:43 /usr/local/bin", false},  // world-writable
		{"drwxrwxrwt  8 0  0  256 Sep  1 23:43 /tmp", false},            // sticky still writable
		{"", false},
	}
	for _, tc := range cases {
		got, code := runLib(t, "", "if ls_line_is_root_safe '"+tc.line+"'; then echo safe; else echo unsafe; fi")
		want := "unsafe"
		if tc.wantSafe {
			want = "safe"
		}
		if code != 0 || got != want {
			t.Errorf("ls_line_is_root_safe(%q) = %q (exit %d), want %q", tc.line, got, code, want)
		}
	}
}

// TestChooseBinDir is the canonical-path rule both the .pkg and the running
// agent follow: an install already in the trusted dir stays there (so a pkg
// reinstall never flips it back and re-triggers a relocation), otherwise a
// safe legacy dir is kept (preserving path-keyed Full Disk Access), and only
// an unsafe one goes to the trusted dir.
func TestChooseBinDir(t *testing.T) {
	if isRoot() {
		t.Skip("fixtures below rely on the test process not being root")
	}
	unsafeLegacy := t.TempDir() // owned by the test user
	cases := []struct {
		name          string
		legacy        string
		trustedHasBin bool
		wantTrusted   bool
	}{
		{"fresh install, safe legacy -> legacy", "/usr/bin", false, false},
		{"fresh install, unsafe legacy -> trusted", unsafeLegacy, false, true},
		{"already relocated, safe legacy -> stays trusted", "/usr/bin", true, true},
		{"already relocated, unsafe legacy -> stays trusted", unsafeLegacy, true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			trusted := filepath.Join(t.TempDir(), "Breeze", "bin")
			if err := os.MkdirAll(trusted, 0o755); err != nil {
				t.Fatal(err)
			}
			if tc.trustedHasBin {
				if err := os.WriteFile(filepath.Join(trusted, "breeze-agent"), []byte("x"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			overrides := "LEGACY_BIN_DIR='" + tc.legacy + "'\nTRUSTED_BIN_DIR='" + trusted + "'"
			got, code := runLib(t, overrides, "choose_bin_dir")
			if code != 0 {
				t.Fatalf("choose_bin_dir exited %d", code)
			}
			want := tc.legacy
			if tc.wantTrusted {
				want = trusted
			}
			if got != want {
				t.Fatalf("choose_bin_dir = %q, want %q", got, want)
			}
		})
	}
}

// TestPointPlistAtRewritesShippedPlists runs the rewrite against the plists
// the .pkg actually ships, so a template path change that the rewrite no
// longer matches fails here instead of leaving a daemon pointed at a binary
// that was never installed.
func TestPointPlistAtRewritesShippedPlists(t *testing.T) {
	cases := []struct {
		src  string
		name string
	}{
		{"../service/launchd/com.breeze.agent.plist", "breeze-agent"},
		{"macos/com.breeze.watchdog.plist", "breeze-watchdog"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			orig, err := os.ReadFile(tc.src)
			if err != nil {
				t.Fatal(err)
			}
			legacy := "<string>/usr/local/bin/" + tc.name + "</string>"
			trusted := "<string>/Library/Breeze/bin/" + tc.name + "</string>"
			if !strings.Contains(string(orig), legacy) {
				t.Fatalf("%s no longer names %s; update install-location.sh and this test together", tc.src, legacy)
			}
			plist := filepath.Join(t.TempDir(), "p.plist")
			if err := os.WriteFile(plist, orig, 0o644); err != nil {
				t.Fatal(err)
			}
			if _, code := runLib(t, "", "point_plist_at '"+plist+"' /usr/local/bin /Library/Breeze/bin "+tc.name); code != 0 {
				t.Fatalf("point_plist_at exited %d", code)
			}
			got, _ := os.ReadFile(plist)
			if strings.Contains(string(got), legacy) || !strings.Contains(string(got), trusted) {
				t.Fatalf("rewritten plist:\n%s", got)
			}
			// Nothing but that one element may change.
			if strings.Replace(string(orig), legacy, trusted, 1) != string(got) {
				t.Fatalf("rewrite touched more than the ProgramArguments path:\n%s", got)
			}
		})
	}
}

// The desktop-helper LaunchAgents are not relocated (the helper runs as the
// logged-in user and keeps its Screen Recording / Accessibility grants at
// /usr/local/bin); pin that the pkg's rewrite never targets them.
func TestPostinstallRewritesOnlyDaemonPlists(t *testing.T) {
	data, err := os.ReadFile("macos/postinstall")
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	for _, want := range []string{
		`point_plist_at "$DAEMON_PLIST"`,
		`point_plist_at "$WATCHDOG_PLIST"`,
		". \"$(dirname \"$0\")/install-location.sh\"",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("postinstall missing %q", want)
		}
	}
	if strings.Contains(s, `point_plist_at "$DESKTOP_`) {
		t.Error("postinstall must not repoint the desktop-helper plists")
	}
}

// build-pkg.sh must stage the root-daemon binaries outside /usr/local/bin:
// the installer would otherwise write them into a directory that, on the
// hosts that need relocating, a non-root identity can tamper with before
// postinstall copies them out. It must also ship the sourced library.
func TestBuildPkgStagesDaemonBinariesAndShipsLibrary(t *testing.T) {
	data, err := os.ReadFile("macos/build-pkg.sh")
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	for _, name := range []string{"breeze-agent", "breeze-watchdog", "breeze-backup"} {
		if strings.Contains(s, `"$PAYLOAD/usr/local/bin/`+name+`"`) {
			t.Errorf("build-pkg.sh still puts %s in the /usr/local/bin payload", name)
		}
		if !strings.Contains(s, `"$STAGING/`+name+`"`) {
			t.Errorf("build-pkg.sh does not stage %s", name)
		}
	}
	if !strings.Contains(s, "install-location.sh") {
		t.Error("build-pkg.sh does not ship install-location.sh with the scripts")
	}
}

// #8058: preinstall boots out the legacy com.breeze.agent-user LaunchAgent
// (`breeze-agent user-helper`) but nothing deleted its plist, so launchd
// loaded it again at the next login and it ran the TCC check loop alongside
// the desktop helper. postinstall must delete it.
func TestPostinstallRemovesLegacyAgentUserLaunchAgent(t *testing.T) {
	s := readRepoFile(t, "macos/postinstall")
	const plist = `LEGACY_AGENT_USER_PLIST="/Library/LaunchAgents/com.breeze.agent-user.plist"`
	if !strings.Contains(s, plist) {
		t.Fatalf("postinstall does not name the legacy plist (%s)", plist)
	}
	// A top-level, uncommented line: not commented out, not inside a branch.
	if !regexp.MustCompile(`(?m)^rm -f "\$LEGACY_AGENT_USER_PLIST"$`).MatchString(s) {
		t.Fatal("postinstall does not delete the legacy com.breeze.agent-user plist at top level")
	}
	pre := readRepoFile(t, "macos/preinstall")
	if !strings.Contains(pre, "com.breeze.agent-user") {
		t.Fatal("preinstall no longer boots out the legacy agent; keep the bootout with the delete")
	}
}
