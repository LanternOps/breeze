//go:build linux

package x11

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
)

func TestFindXServerProcAt(t *testing.T) {
	gdmArgs := strings.Fields("/usr/lib/xorg/Xorg vt2 -displayfd 3 -auth /run/user/1000/gdm/Xauthority -nolisten tcp -background none -noreset -keeptty -novtswitch -verbose 3")
	for _, tc := range []struct {
		name      string
		display   string
		path      string
		link      string
		argvMatch bool
		nonServer bool
		wantPID   int
		readError string
	}{
		{"gdm displayfd", "1", "/tmp/.X11-unix/X1", "socket:[12345]", false, false, 100, ""},
		{"abstract socket", "1", "@/tmp/.X11-unix/X1", "socket:[12345]", false, false, 100, ""},
		{"argv first choice", "0", "/tmp/.X11-unix/X0", "socket:[12345]", true, false, 200, ""},
		{"no matching inode", "1", "/tmp/.X11-unix/X1", "socket:[99999]", false, false, 0, ""},
		{"other display", "1", "/tmp/.X11-unix/X10", "socket:[12345]", false, false, 0, ""},
		{"non X server", "1", "/tmp/.X11-unix/X1", "socket:[12345]", false, true, 0, ""},
		{"missing net/unix", "1", "/tmp/.X11-unix/X1", "socket:[12345]", false, false, 0, "net/unix"},
		{"unreadable fd directory", "1", "/tmp/.X11-unix/X1", "socket:[12345]", false, false, 0, "fd"},
		{"unreadable candidate beside a readable non-match", "1", "/tmp/.X11-unix/X1", "socket:[12345]", false, false, 0, "fd+other"},
		{"one unreadable fd among readable ones", "1", "/tmp/.X11-unix/X1", "socket:[99999]", false, false, 0, "fd/4"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			logging.Init("text", "debug", &logs)
			t.Cleanup(func() { logging.Init("text", "info", nil) })
			root := t.TempDir()
			write := func(name, contents string) {
				t.Helper()
				path := filepath.Join(root, name)
				if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
					t.Fatal(err)
				}
			}
			args := append([]string(nil), gdmArgs...)
			if tc.nonServer {
				args[0] = "/usr/bin/other"
			}
			write("100/cmdline", strings.Join(args, "\x00")+"\x00")
			write("100/net/unix", "Num RefCount Protocol Flags Type St Inode Path\n"+
				"0000000000000000: 00000002 00000000 00010000 0001 01 12345 "+tc.path+"\n")
			fdRoot := filepath.Join(root, "100", "fd")
			if err := os.MkdirAll(fdRoot, 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(tc.link, filepath.Join(fdRoot, "3")); err != nil {
				t.Fatal(err)
			}
			if tc.readError == "fd/4" {
				// Not a symlink, so Readlink fails for this one descriptor only.
				write("100/fd/4", "not a link")
			} else if tc.readError == "fd+other" {
				if err := os.RemoveAll(fdRoot); err != nil {
					t.Fatal(err)
				}
				write("100/fd", "not a directory")
				// A second X server, readable, listening on no requested socket.
				write("300/cmdline", strings.Join(gdmArgs, "\x00")+"\x00")
				write("300/net/unix", "Num RefCount Protocol Flags Type St Inode Path\n")
				if err := os.MkdirAll(filepath.Join(root, "300", "fd"), 0755); err != nil {
					t.Fatal(err)
				}
			} else if tc.readError != "" {
				if err := os.RemoveAll(filepath.Join(root, "100", tc.readError)); err != nil {
					t.Fatal(err)
				}
				if tc.readError == "fd" {
					write("100/fd", "not a directory")
				}
			}
			wantArgs := args
			if tc.argvMatch {
				wantArgs = []string{"/usr/bin/Xorg", ":0", "-auth", "/tmp/test.Xauthority"}
				write("200/cmdline", strings.Join(wantArgs, "\x00")+"\x00")
			}
			pid, argv, uid, ok := findXServerProcAt(root, tc.display)
			if pid != tc.wantPID || ok != (tc.wantPID != 0) {
				t.Fatalf("findXServerProcAt = (%d, %v), want (%d, %v)", pid, ok, tc.wantPID, tc.wantPID != 0)
			}
			// Only a candidate that could not be read leaves the debug trace; a
			// plain non-match stays quiet.
			traced := strings.Contains(logs.String(), "some candidates could not be read")
			wantTrace := tc.readError != ""
			if traced != wantTrace {
				t.Fatalf("debug trace logged = %v, want %v; logs:\n%s", traced, wantTrace, logs.String())
			}
			if wantTrace {
				candidates, cause := "1", "not a directory"
				if tc.readError == "fd+other" {
					candidates = "2"
				}
				if tc.readError == "net/unix" {
					cause = "no such file or directory"
				}
				if tc.readError == "fd/4" {
					cause = "invalid argument"
				}
				for _, field := range []string{"display=:" + tc.display, "unreadable=1", "candidates=" + candidates, cause + `"`} {
					if !strings.Contains(logs.String(), field) {
						t.Fatalf("debug trace missing %q; logs:\n%s", field, logs.String())
					}
				}
			}
			if !ok {
				if pid != 0 || argv != nil || uid != 0 {
					t.Fatalf("findXServerProcAt must report not found with zero values, got (%d, %v, %d, %v)", pid, argv, uid, ok)
				}
				return
			}
			if !reflect.DeepEqual(argv, wantArgs) {
				t.Fatalf("argv = %v, want %v", argv, wantArgs)
			}
			fi, err := os.Stat(filepath.Join(root, strconv.Itoa(pid)))
			if err != nil {
				t.Fatal(err)
			}
			if uid != statUID(fi) {
				t.Fatalf("uid = %d, want %d", uid, statUID(fi))
			}
			if got := parseAuthArg(argv); got != parseAuthArg(wantArgs) {
				t.Fatalf("auth = %q, want %q", got, parseAuthArg(wantArgs))
			}
		})
	}
}
