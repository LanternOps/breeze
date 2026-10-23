//go:build linux && (amd64 || arm64)

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"golang.org/x/sys/unix"
)

// The sandbox is proven against a REAL breeze-yarac binary built with
// CGO_ENABLED=0 — the API image's build. It cannot run in this process: the
// sandbox is irreversible, and stage 1 re-executes os.Executable() (here the
// test binary) as stage 2.
//
//	docker run --rm -v "$PWD":/src -w /src/agent golang:1.26.10-alpine \
//	  go test -run Sandbox -v ./cmd/breeze-yarac/
func buildCgoFreeYarac(t *testing.T) string {
	t.Helper()
	abi, err := landlockABI()
	if err != nil || abi < 1 {
		t.Skipf("kernel has no usable Landlock (abi=%d err=%v): the sandbox cannot be proven on this host", abi, err)
	}
	goBin, err := exec.LookPath("go")
	if err != nil {
		goBin = filepath.Join(runtime.GOROOT(), "bin", "go")
	}
	out := filepath.Join(t.TempDir(), "breeze-yarac")
	cmd := exec.Command(goBin, "build", "-o", out, ".")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build breeze-yarac: %v\n%s", err, b)
	}
	return out
}

type probeOut struct {
	OK          bool `json:"ok"`
	Sandboxed   bool `json:"sandboxed"`
	LandlockABI int  `json:"landlockAbi"`
	OOMScoreAdj int  `json:"oomScoreAdj"`
	Probes      []struct {
		Name   string `json:"name"`
		Denied bool   `json:"denied"`
		Errno  string `json:"errno"`
	} `json:"probes"`
}

func runProbe(t *testing.T, bin string, args ...string) (int, probeOut, string) {
	t.Helper()
	cmd := exec.Command(bin, append([]string{"sandbox-check"}, args...)...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	var p probeOut
	if jerr := json.Unmarshal(stdout.Bytes(), &p); jerr != nil {
		t.Fatalf("sandbox-check output is not JSON (exit %d): %q stderr=%q", code, stdout.String(), stderr.String())
	}
	return code, p, stderr.String()
}

func TestSandboxDeniesFilesNetworkPtraceSignalsAndExec(t *testing.T) {
	bin := buildCgoFreeYarac(t)
	code, p, stderr := runProbe(t, bin)
	if code != exitOK || !p.OK || !p.Sandboxed {
		t.Fatalf("sandbox-check must apply the sandbox and deny every probe: exit=%d out=%+v stderr=%s", code, p, stderr)
	}
	if p.OOMScoreAdj != 1000 {
		t.Fatalf("oom_score_adj must be 1000 before Landlock applies, got %d", p.OOMScoreAdj)
	}
	want := map[string]string{
		"read /etc/hostname":      "EACCES",
		"read /proc/self/environ": "EACCES",
		"write /tmp":              "EACCES",
		"dial udp":                "EPERM",
		"dial unix":               "EPERM",
		"ptrace parent":           "EPERM",
		"process_vm_readv parent": "EPERM",
		"signal parent":           "EPERM",
		"exec /bin/sh":            "EPERM",
		"prlimit parent":          "EPERM",
		"perf_event_open":         "EPERM",
		"unshare user namespace":  "EPERM",
		"truncate":                "EPERM",
		"chmod":                   "EPERM",
	}
	got := map[string]string{}
	for _, pr := range p.Probes {
		if !pr.Denied {
			t.Errorf("probe %q was NOT denied", pr.Name)
		}
		got[pr.Name] = pr.Errno
	}
	for name, errno := range want {
		if got[name] != errno {
			t.Errorf("probe %q: want %s, got %q", name, errno, got[name])
		}
	}
}

// Control: the same probes WITHOUT the sandbox succeed, so the denials above
// are the sandbox's doing and not an artefact of the environment.
func TestSandboxProbesSucceedWithoutSandbox(t *testing.T) {
	bin := buildCgoFreeYarac(t)
	_, p, stderr := runProbe(t, bin, "--control")
	if p.Sandboxed {
		t.Fatalf("--control must not sandbox: %+v", p)
	}
	allowed := map[string]bool{}
	for _, pr := range p.Probes {
		allowed[pr.Name] = !pr.Denied
	}
	for _, name := range []string{"read /etc/hostname", "read /proc/self/environ", "write /tmp", "dial udp", "signal parent", "prlimit parent", "exec /bin/sh"} {
		if !allowed[name] {
			t.Errorf("control probe %q should succeed unsandboxed: %+v stderr=%s", name, p, stderr)
		}
	}
}

func TestSandboxMatchStillScans(t *testing.T) {
	bin := buildCgoFreeYarac(t)
	golden, err := os.ReadFile(iocGoldenPath)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "match", "--filename", "sample.bin")
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")} // what the API passes in production
	cmd.Stdin = bytes.NewReader(frame(golden, []byte("xx breeze_ioc_golden_marker xx")))
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("sandboxed match failed: %v stdout=%s stderr=%s", err, stdout.String(), stderr.String())
	}
	m := parseMatch(t, stdout.String())
	if !m.OK || len(m.Matches) != 1 || len(m.Matches[0].MatchedStrings) != 1 {
		t.Fatalf("sandboxed match must still find the golden marker: %s", stdout.String())
	}
}

// evalSeccomp interprets the classic-BPF subset seccompProgram emits against
// one synthetic seccomp_data, so the filter's branches are checked on any
// Linux host without installing it.
func evalSeccomp(t *testing.T, prog []unix.SockFilter, arch, nr uint32, arg0 uint64) uint32 {
	t.Helper()
	data := make([]byte, 64)
	binary.LittleEndian.PutUint32(data[seccompDataNr:], nr)
	binary.LittleEndian.PutUint32(data[seccompDataArch:], arch)
	binary.LittleEndian.PutUint64(data[seccompDataArg0Lo:], arg0)
	var acc uint32
	for pc := 0; pc < len(prog); pc++ {
		in := prog[pc]
		switch in.Code {
		case unix.BPF_LD | unix.BPF_W | unix.BPF_ABS:
			acc = binary.LittleEndian.Uint32(data[in.K:])
		case unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K:
			pc += int(map[bool]uint8{true: in.Jt, false: in.Jf}[acc == in.K])
		case unix.BPF_JMP | unix.BPF_JGE | unix.BPF_K:
			pc += int(map[bool]uint8{true: in.Jt, false: in.Jf}[acc >= in.K])
		case unix.BPF_JMP | unix.BPF_JSET | unix.BPF_K:
			pc += int(map[bool]uint8{true: in.Jt, false: in.Jf}[acc&in.K != 0])
		case unix.BPF_RET | unix.BPF_K:
			return in.K
		default:
			t.Fatalf("unexpected BPF opcode %#x at %d", in.Code, pc)
		}
	}
	t.Fatal("filter fell off the end without RET")
	return 0
}

func TestSeccompProgramLogic(t *testing.T) {
	const pid = 4321
	prog, err := seccompProgram(pid)
	if err != nil {
		t.Fatal(err)
	}
	if len(prog) > 255 {
		t.Fatalf("filter has %d instructions; jumps are 8-bit", len(prog))
	}
	arch := map[string]uint32{"amd64": unix.AUDIT_ARCH_X86_64, "arm64": unix.AUDIT_ARCH_AARCH64}[runtime.GOARCH]
	threadClone := uint64(unix.CLONE_VM | unix.CLONE_FS | unix.CLONE_FILES | unix.CLONE_SIGHAND | unix.CLONE_SYSVSEM | unix.CLONE_THREAD)
	neg1 := uint64(0xffffffffffffffff)
	cases := []struct {
		name string
		arch uint32
		nr   uint32
		arg0 uint64
		want uint32
	}{
		{"read is allowed", arch, unix.SYS_READ, 0, seccompRetAllow},
		{"mmap is allowed", arch, unix.SYS_MMAP, 0, seccompRetAllow},
		{"socket is denied", arch, unix.SYS_SOCKET, 0, seccompRetEPERM},
		{"execve is denied", arch, unix.SYS_EXECVE, 0, seccompRetEPERM},
		{"perf_event_open is denied", arch, unix.SYS_PERF_EVENT_OPEN, 0, seccompRetEPERM},
		{"setpriority is denied", arch, unix.SYS_SETPRIORITY, 0, seccompRetEPERM},
		{"kill self is allowed", arch, unix.SYS_KILL, pid, seccompRetAllow},
		{"kill another pid is denied", arch, unix.SYS_KILL, pid + 1, seccompRetEPERM},
		{"kill 0 (process group) is denied", arch, unix.SYS_KILL, 0, seccompRetEPERM},
		{"kill -1 (every process) is denied", arch, unix.SYS_KILL, neg1, seccompRetEPERM},
		{"kill pid with high bits set is denied", arch, unix.SYS_KILL, pid | 1<<32, seccompRetEPERM},
		{"tgkill self is allowed", arch, unix.SYS_TGKILL, pid, seccompRetAllow},
		{"tgkill another tgid is denied", arch, unix.SYS_TGKILL, 1, seccompRetEPERM},
		{"prlimit self (0) is allowed", arch, unix.SYS_PRLIMIT64, 0, seccompRetAllow},
		{"prlimit self (pid) is allowed", arch, unix.SYS_PRLIMIT64, pid, seccompRetAllow},
		{"prlimit another pid is denied", arch, unix.SYS_PRLIMIT64, 1, seccompRetEPERM},
		{"clone of a thread is allowed", arch, unix.SYS_CLONE, threadClone, seccompRetAllow},
		{"clone with SIGCHLD (fork) is allowed", arch, unix.SYS_CLONE, uint64(unix.SIGCHLD), seccompRetAllow},
		{"clone into a new user namespace is denied", arch, unix.SYS_CLONE, uint64(unix.CLONE_NEWUSER | unix.SIGCHLD), seccompRetEPERM},
		{"clone into a new net namespace is denied", arch, unix.SYS_CLONE, threadClone | unix.CLONE_NEWNET, seccompRetEPERM},
		{"clone into a new mount namespace is denied", arch, unix.SYS_CLONE, uint64(unix.CLONE_NEWNS | unix.SIGCHLD), seccompRetEPERM},
		{"clone into a new pid namespace is denied", arch, unix.SYS_CLONE, uint64(unix.CLONE_NEWPID | unix.SIGCHLD), seccompRetEPERM},
		{"clone into a new ipc namespace is denied", arch, unix.SYS_CLONE, uint64(unix.CLONE_NEWIPC | unix.SIGCHLD), seccompRetEPERM},
		{"clone into a new uts namespace is denied", arch, unix.SYS_CLONE, uint64(unix.CLONE_NEWUTS | unix.SIGCHLD), seccompRetEPERM},
		{"clone into a new cgroup namespace is denied", arch, unix.SYS_CLONE, uint64(unix.CLONE_NEWCGROUP | unix.SIGCHLD), seccompRetEPERM},
		{"truncate is denied", arch, unix.SYS_TRUNCATE, 0, seccompRetEPERM},
		{"fchmodat is denied", arch, unix.SYS_FCHMODAT, 0, seccompRetEPERM},
		{"setxattr is denied", arch, unix.SYS_SETXATTR, 0, seccompRetEPERM},
		{"clone3 is ENOSYS (libc falls back to clone)", arch, unix.SYS_CLONE3, 0, seccompRetENOSYS},
		{"a foreign ABI is denied wholesale", arch ^ 1, unix.SYS_READ, 0, seccompRetEPERM},
	}
	if runtime.GOARCH == "amd64" {
		cases = append(cases, struct {
			name string
			arch uint32
			nr   uint32
			arg0 uint64
			want uint32
		}{"an x32 syscall is denied", arch, x32SyscallBit | unix.SYS_READ, 0, seccompRetEPERM})
	}
	for _, tc := range cases {
		if got := evalSeccomp(t, prog, tc.arch, tc.nr, tc.arg0); got != tc.want {
			t.Errorf("%s: got %#x, want %#x", tc.name, got, tc.want)
		}
	}
	for _, nr := range append(append([]uint32{}, deniedSyscalls...), legacyDeniedSyscalls[runtime.GOARCH]...) {
		if got := evalSeccomp(t, prog, arch, nr, 0); got != seccompRetEPERM {
			t.Errorf("denied syscall %d: got %#x", nr, got)
		}
	}
}
