//go:build !windows

package macosuninstall

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// teardownShim stands in for every command the teardown runs. rm and rmdir
// act only inside FIXTURE_ROOT; anything else unexpected exits 91.
const teardownShim = `#!/usr/bin/python3
import os,sys,pathlib
name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]; root=os.environ['FIXTURE_ROOT']; fail=os.environ['FAIL_COMMAND']
with open(root+'/calls','a') as f: f.write(name+' '+' '.join(args)+'\n')
if name=='ps':
 if fail=='ps': sys.exit(1)
 if fail=='no_sessions': sys.exit(0)
 print('100 0 loginwindow\n101 501 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow\n102 502 loginwindow\n101 501 loginwindow\n103 503 unrelated\nBAD 501 loginwindow')
elif name=='launchctl':
 if args[0]=='print': sys.exit(5 if fail=='query' else (0 if fail=='helper' and 'gui/502/' in args[1] else 113))
 if fail in ['absent','query'] or (fail=='helper' and 'gui/502/' in args[1]): sys.exit(1)
elif name=='pkgutil':
 if fail=='receipt_list': sys.exit(1)
 if args[0]=='--pkgs':
  if fail=='many_receipts':
   print('com.breeze.agent\n' + ('com.example.other-receipt\n' * 20000)); sys.exit(0)
  print('com.breeze.helper' if fail=='absent' else 'com.breeze.helper\ncom.breeze.agent'); sys.exit(0)
 if fail=='receipt': sys.exit(1)
elif name=='rm':
 if fail=='rm': sys.exit(1)
 for p in args:
  if p.startswith('-'): continue
  if not p.startswith('/') or '..' in pathlib.Path(p).parts: sys.exit(90)
  target=pathlib.Path(root+p)
  if target.is_file(): target.unlink()
elif name=='rmdir':
 status=0
 for p in args:
  if p.startswith('-'): continue
  if not p.startswith('/') or '..' in pathlib.Path(p).parts: sys.exit(90)
  target=pathlib.Path(root+p)
  try: target.rmdir()
  except OSError: status=1
 sys.exit(status)
else: sys.exit(91)
`

// All teardown commands are intercepted; the rm shim operates only in TempDir.
func TestPackageCleanup(t *testing.T) {
	build, err := os.ReadFile("../../installer/macos/build-pkg.sh")
	if err != nil {
		t.Fatal(err)
	}
	matches := regexp.MustCompile(`\$PAYLOAD(/(?:usr/local/bin|Library/LaunchAgents|Library/LaunchDaemons)/[^"\s]+)`).FindAllStringSubmatch(string(build), -1)
	artifacts := map[string]bool{}
	for _, m := range matches {
		artifacts[m[1]] = true
	}
	// Root-daemon binaries are staged in the payload and postinstall copies
	// them to /usr/local/bin or /Library/Breeze/bin (#7211), so either
	// installed location must be torn down.
	staged := regexp.MustCompile(`\$STAGING/([^"\s/]+)`).FindAllStringSubmatch(string(build), -1)
	for _, m := range staged {
		artifacts["/usr/local/bin/"+m[1]] = true
		artifacts["/Library/Breeze/bin/"+m[1]] = true
	}
	if len(artifacts) != 11 {
		t.Fatalf("package artifacts: %v", artifacts)
	}
	// The socket is volatile runtime state, not part of the pkg payload.
	artifacts["/Library/Application Support/Breeze/agent.sock"] = true
	// A postinstall that failed before clearing its staging directory (#7831).
	artifacts["/Library/Breeze/pkg-staging/breeze-agent"] = true
	for _, failure := range []string{"", "absent", "no_sessions", "many_receipts", "helper", "query", "ps", "receipt", "receipt_list", "rm"} {
		t.Run("failure="+failure, func(t *testing.T) {
			root := t.TempDir()
			bin := filepath.Join(root, "bin")
			if err := os.Mkdir(bin, 0700); err != nil {
				t.Fatal(err)
			}
			kept := []string{"/Library/Application Support/Breeze/config.yaml", "/Library/Application Support/Breeze/secrets.yaml", "/Library/Logs/Breeze/agent.log", "/Library/LaunchDaemons/com.breeze.helper.plist", "/usr/local/bin/unrelated"}
			paths := append([]string{}, kept...)
			for p := range artifacts {
				paths = append(paths, p)
			}
			for _, p := range paths {
				if err := os.MkdirAll(filepath.Dir(root+p), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(root+p, []byte("retained"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			writeTeardownShims(t, bin)
			cmd := exec.Command("/bin/bash", "-o", "pipefail", "-c", Script())
			cmd.Env = append(os.Environ(), "PATH="+bin+":/usr/bin:/bin", "FIXTURE_ROOT="+root, "FAIL_COMMAND="+failure)
			out, err := cmd.CombinedOutput()
			failed := failure != "" && failure != "absent" && failure != "no_sessions" && failure != "many_receipts"
			if (err != nil) != failed {
				t.Fatalf("exit=%v output=%s", err, out)
			}
			calls, _ := os.ReadFile(filepath.Join(root, "calls"))
			log := string(calls)
			for _, p := range kept {
				if b, err := os.ReadFile(root + p); err != nil || string(b) != "retained" {
					t.Errorf("preserved %s changed: %v", p, err)
				}
			}
			if failed {
				return
			}
			for p := range artifacts {
				if _, err := os.Stat(root + p); !os.IsNotExist(err) {
					t.Errorf("survived: %s", p)
				}
			}
			// Nothing else lives under /Library/Breeze, so the tree goes too (#7831).
			if _, err := os.Stat(root + "/Library/Breeze"); !os.IsNotExist(err) {
				t.Errorf("empty /Library/Breeze tree survived: %v", err)
			}
			want := []string{"launchctl bootout system/com.breeze.watchdog", "launchctl bootout gui/501/com.breeze.desktop-helper-user", "launchctl bootout gui/502/com.breeze.desktop-helper-user", "launchctl bootout pid/100/com.breeze.desktop-helper-loginwindow", "launchctl bootout pid/101/com.breeze.desktop-helper-loginwindow", "launchctl bootout pid/102/com.breeze.desktop-helper-loginwindow", "launchctl bootout system/com.breeze.agent"}
			if failure == "no_sessions" {
				want = []string{want[0], want[len(want)-1]}
			}
			prev := -1
			for _, s := range want {
				i := strings.Index(log, s)
				if i <= prev {
					t.Errorf("missing/order %q: %s", s, log)
				}
				prev = i
			}
			if failure != "no_sessions" && strings.Count(log, want[1]) != 1 {
				t.Errorf("duplicate session: %s", log)
			}
			if strings.Contains(log, "gui/503") || strings.Contains(log, "com.breeze.agent-user") || strings.Contains(log, "com.breeze.helper") {
				t.Errorf("unowned job: %s", log)
			}
			if strings.Contains(log, "pkgutil --forget com.breeze.agent") == (failure == "absent") {
				t.Errorf("receipt handling: %s", log)
			}
		})
	}
}

func TestDistributedFunctionsMatchEmbeddedSource(t *testing.T) {
	for _, p := range []string{"../../scripts/install/uninstall.sh", "../../../apps/web/public/scripts/uninstall.sh"} {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(b), Functions) {
			t.Errorf("%s differs from embedded functions", p)
		}
	}
}

func writeTeardownShims(t *testing.T, bin string) {
	t.Helper()
	for _, name := range []string{"launchctl", "ps", "pkgutil", "rm", "rmdir"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(teardownShim), 0700); err != nil {
			t.Fatal(err)
		}
	}
}

// #7831: an install the agent relocated to /Library/Breeze/bin can still have
// a pre-relocation breeze-agent in /usr/local/bin (0.118.0-0.118.2 moved it and
// never cleaned up). Every caller of breeze_remove_auxiliary removes only the
// LIVE agent binary itself, so the auxiliary step must sweep every Breeze
// binary from BOTH directories, drop the now-empty /Library/Breeze tree, and
// clear the launchd disable that self_uninstall leaves behind — which would
// otherwise make the next install fail with "Bootstrap failed: 5".
func TestRemoveAuxiliaryClearsBothInstallLocations(t *testing.T) {
	if _, err := os.Stat("/usr/bin/python3"); err != nil {
		t.Skip("python3 not available")
	}
	binaries := []string{"breeze-agent", "breeze-watchdog", "breeze-backup", "breeze-desktop-helper"}
	for _, foreign := range []bool{false, true} {
		t.Run(map[bool]string{false: "only Breeze files", true: "foreign file under /Library/Breeze"}[foreign], func(t *testing.T) {
			root := t.TempDir()
			bin := filepath.Join(root, "bin")
			if err := os.Mkdir(bin, 0700); err != nil {
				t.Fatal(err)
			}
			writeTeardownShims(t, bin)
			var removed []string
			for _, dir := range []string{"/usr/local/bin", "/Library/Breeze/bin"} {
				for _, b := range binaries {
					removed = append(removed, dir+"/"+b)
				}
			}
			removed = append(removed, "/Library/Breeze/pkg-staging/breeze-agent", "/Library/Breeze/pkg-staging/breeze-backup")
			kept := []string{"/usr/local/bin/unrelated", "/Library/Logs/Breeze/agent.log"}
			if foreign {
				kept = append(kept, "/Library/Breeze/bin/not-ours")
			}
			for _, p := range append(append([]string{}, removed...), kept...) {
				if err := os.MkdirAll(filepath.Dir(root+p), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(root+p, []byte("x"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.Command("/bin/bash", "-o", "pipefail", "-c", Functions+"\nbreeze_remove_auxiliary\n")
			cmd.Env = append(os.Environ(), "PATH="+bin+":/usr/bin:/bin", "FIXTURE_ROOT="+root, "FAIL_COMMAND=")
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("exit=%v output=%s", err, out)
			}
			for _, p := range removed {
				if _, err := os.Stat(root + p); !os.IsNotExist(err) {
					t.Errorf("survived: %s", p)
				}
			}
			for _, p := range kept {
				if _, err := os.Stat(root + p); err != nil {
					t.Errorf("must be kept: %s (%v)", p, err)
				}
			}
			_, err := os.Stat(root + "/Library/Breeze")
			if foreign && err != nil {
				t.Errorf("/Library/Breeze holds a file Breeze did not install and must be kept: %v", err)
			}
			if !foreign && !os.IsNotExist(err) {
				t.Errorf("empty /Library/Breeze must be removed: %v", err)
			}
			calls, _ := os.ReadFile(filepath.Join(root, "calls"))
			for _, want := range []string{"launchctl enable system/com.breeze.agent", "launchctl enable system/com.breeze.watchdog"} {
				if !strings.Contains(string(calls), want) {
					t.Errorf("missing %q in calls:\n%s", want, calls)
				}
			}
		})
	}
}
