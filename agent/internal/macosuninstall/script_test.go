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
	if len(artifacts) != 8 {
		t.Fatalf("package artifacts: %v", artifacts)
	}
	// The socket is volatile runtime state, not part of the pkg payload.
	artifacts["/Library/Application Support/Breeze/agent.sock"] = true
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
			shim := `#!/usr/bin/python3
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
else: sys.exit(91)
`
			for _, name := range []string{"launchctl", "ps", "pkgutil", "rm"} {
				if err := os.WriteFile(filepath.Join(bin, name), []byte(shim), 0700); err != nil {
					t.Fatal(err)
				}
			}
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
