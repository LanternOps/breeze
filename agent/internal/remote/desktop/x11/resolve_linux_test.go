//go:build linux

package x11

import (
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
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
	}{
		{"gdm displayfd", "1", "/tmp/.X11-unix/X1", "socket:[12345]", false, false, 100},
		{"abstract socket", "1", "@/tmp/.X11-unix/X1", "socket:[12345]", false, false, 100},
		{"argv first choice", "0", "/tmp/.X11-unix/X0", "socket:[12345]", true, false, 200},
		{"no matching inode", "1", "/tmp/.X11-unix/X1", "socket:[99999]", false, false, 0},
		{"other display", "1", "/tmp/.X11-unix/X10", "socket:[12345]", false, false, 0},
		{"non X server", "1", "/tmp/.X11-unix/X1", "socket:[12345]", false, true, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
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
			write("net/unix", "Num RefCount Protocol Flags Type St Inode Path\n"+
				"0000000000000000: 00000002 00000000 00010000 0001 01 12345 "+tc.path+"\n")
			fdRoot := filepath.Join(root, "100", "fd")
			if err := os.MkdirAll(fdRoot, 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(tc.link, filepath.Join(fdRoot, "3")); err != nil {
				t.Fatal(err)
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
			if !ok {
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
