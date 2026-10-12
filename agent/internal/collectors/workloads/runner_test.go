package workloads

import (
	"context"
	"errors"
	"io/fs"
	"runtime"
	"strings"
	"testing"
	"time"
)

const testPowerShell = `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`

func TestAllowedCommandAcceptsOnlyTheFixedReadOnlyCommands(t *testing.T) {
	pvesh := func(args ...string) []string { return args }
	cases := []struct {
		name string
		path string
		args []string
		want bool
	}{
		{"hyper-v script", testPowerShell, hypervArgs, true},
		{"hyper-v script, other Windows dir", `D:\WinNT\System32\WindowsPowerShell\v1.0\powershell.exe`, hypervArgs, true},
		{"proxmox qemu list", proxmoxPvesh, pvesh("get", "/nodes/pve-a/qemu", "--output-format", "json"), true},
		{"proxmox lxc list", proxmoxPvesh, pvesh("get", "/nodes/pve-a/lxc", "--output-format", "json"), true},

		{"powershell relative path", "powershell.exe", hypervArgs, false},
		{"powershell other script", testPowerShell, []string{"-NoProfile", "-NonInteractive", "-Command", "Get-Process"}, false},
		{"powershell extra arg", testPowerShell, append(append([]string(nil), hypervArgs...), "-x"), false},
		{"pwsh 7", `C:\Program Files\PowerShell\7\pwsh.exe`, hypervArgs, false},
		{"pvesh relative path", "pvesh", pvesh("get", "/nodes/pve-a/qemu", "--output-format", "json"), false},
		{"pvesh write verb", proxmoxPvesh, pvesh("set", "/nodes/pve-a/qemu", "--output-format", "json"), false},
		{"pvesh create", proxmoxPvesh, pvesh("create", "/nodes/pve-a/qemu", "--output-format", "json"), false},
		{"pvesh other path", proxmoxPvesh, pvesh("get", "/nodes/pve-a/qemu/100/config", "--output-format", "json"), false},
		{"pvesh traversal", proxmoxPvesh, pvesh("get", "/nodes/../qemu", "--output-format", "json"), false},
		{"pvesh option smuggling", proxmoxPvesh, pvesh("get", "/nodes/-x/qemu", "--output-format", "json"), false},
		{"pvesh extra arg", proxmoxPvesh, pvesh("get", "/nodes/pve-a/qemu", "--output-format", "json", "--noproxy"), false},
		{"pvesh other format", proxmoxPvesh, pvesh("get", "/nodes/pve-a/qemu", "--output-format", "text"), false},
		{"qm", "/usr/sbin/qm", pvesh("list"), false},
		{"shell", "/bin/sh", pvesh("-c", "true"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := allowedCommand(tc.path, tc.args); got != tc.want {
				t.Fatalf("allowedCommand(%q, %q) = %v, want %v", tc.path, tc.args, got, tc.want)
			}
		})
	}
}

// A refused command must fail before anything is executed: /usr/bin/pvesh does
// not exist on a developer machine, so an exec attempt would surface as
// ErrNotExist instead of errCommandRefused.
func TestRunReadOnlyRefusesBeforeExec(t *testing.T) {
	_, err := runReadOnly(context.Background(), proxmoxPvesh, "delete", "/nodes/pve-a/qemu/100", "--output-format", "json")
	if !errors.Is(err, errCommandRefused) {
		t.Fatalf("err = %v, want errCommandRefused", err)
	}
}

func TestExecBounded(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	ctx := context.Background()
	t.Run("stdout and exit code", func(t *testing.T) {
		out, err := execBounded(ctx, 5*time.Second, 1024, "/bin/sh", "-c", "printf ok; printf warn >&2; exit 3")
		if err != nil {
			t.Fatal(err)
		}
		if string(out.Stdout) != "ok" || string(out.Stderr) != "warn" || out.ExitCode != 3 {
			t.Fatalf("out = %+v", out)
		}
	})
	t.Run("oversize output", func(t *testing.T) {
		_, err := execBounded(ctx, 5*time.Second, 16, "/bin/sh", "-c", "printf '%040d' 0")
		if !errors.Is(err, errTooLarge) {
			t.Fatalf("err = %v, want errTooLarge", err)
		}
	})
	t.Run("timeout", func(t *testing.T) {
		start := time.Now()
		_, err := execBounded(ctx, 200*time.Millisecond, 1024, "/bin/sh", "-c", "sleep 10")
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("err = %v, want DeadlineExceeded", err)
		}
		if time.Since(start) > 8*time.Second {
			t.Fatalf("timeout did not stop the process promptly: %s", time.Since(start))
		}
	})
	t.Run("missing tool", func(t *testing.T) {
		_, err := execBounded(ctx, time.Second, 1024, "/nonexistent/tool")
		if !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("err = %v, want ErrNotExist", err)
		}
	})
	t.Run("cancelled parent", func(t *testing.T) {
		cctx, cancel := context.WithCancel(ctx)
		cancel()
		_, err := execBounded(cctx, time.Second, 1024, "/bin/sh", "-c", "true")
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want Canceled", err)
		}
	})
}

func TestExecFailureCodes(t *testing.T) {
	cases := []struct {
		err        error
		collection string
		code       string
	}{
		{&fs.PathError{Op: "fork/exec", Path: "/x", Err: fs.ErrNotExist}, CollectionUnavailable, "tool_missing"},
		{&fs.PathError{Op: "fork/exec", Path: "/x", Err: fs.ErrPermission}, CollectionPermissionDenied, ReasonPermissionDenied},
		{context.DeadlineExceeded, CollectionUnavailable, ReasonTimeout},
		{errTooLarge, CollectionError, "response_too_large"},
		{errCommandRefused, CollectionError, "command_refused"},
		{errors.New("something else: with raw output"), CollectionError, "exec_failed"},
	}
	for _, tc := range cases {
		res := execFailure(tc.err)
		if res.Collection != tc.collection || res.Error != tc.code {
			t.Errorf("execFailure(%v) = %+v, want %s/%s", tc.err, res, tc.collection, tc.code)
		}
		if strings.Contains(res.Error, " ") {
			t.Errorf("error code %q is not a machine code", res.Error)
		}
	}
}
