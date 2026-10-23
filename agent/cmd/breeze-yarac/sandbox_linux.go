//go:build linux && (amd64 || arm64)

package main

import (
	"debug/elf"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// The `match` sandbox (#6267 W04-2, Todd D1/D2). yaraxwasm mounts host `/`
// into the guest and the child runs as the API's own user, so an engine bug
// triggered by a crafted sample must not reach the API container's files,
// network or processes. ANY failed step ends in exit 3 with no scan.
//
// Landlock and no_new_privs are PER-THREAD and a Go process is multithreaded
// before main() runs. syscall.AllThreadsSyscall cannot be used: breeze-yarac
// links purego's fakecgo (internal/security → remote/tools → remote/desktop →
// go-openh264), which marks the binary as cgo, and the runtime then never
// installs the per-thread-syscall signal handler. So the sandbox is applied
// in two stages, relying only on kernel inheritance:
//
// Stage 1 (enterSandbox, the process the API spawned), on one locked thread:
//  1. oom_score_adj = 1000 (process-wide, survives exec): a container OOM
//     kills this child, never the API;
//  2. PR_SET_NO_NEW_PRIVS on this thread;
//  3. a Landlock ruleset that handles every filesystem right the kernel's ABI
//     knows (+ TCP bind/connect at ABI ≥ 4, signal and abstract-unix scoping
//     at ABI ≥ 6) and allows NOTHING except reading and executing this binary
//     and the ELF loader/libraries it needs to start; restrict_self;
//  4. execve(this binary, "__sandboxed", …) from that thread. The new process
//     starts with one thread carrying the Landlock domain and no_new_privs,
//     so every thread the runtime creates inherits both.
//
// Stage 2 (finishSandbox, in the re-executed process):
//  5. proves the domain is in effect (opening "/" must fail with EACCES) and
//     no_new_privs is set — so `__sandboxed` invoked directly fails closed;
//  6. installs a seccomp-bpf filter on every thread (TSYNC) returning EPERM
//     for what Landlock does not cover: sockets (UDP, unix), cross-process
//     access (ptrace, process_vm_*, kcmp, pidfd_*), exec (which also makes
//     the binary/loader exec right of step 3 unusable), io_uring, and signals
//     to any process but this one;
//  7. only then reads the sample from stdin and starts the engine. The engine
//     needs no file: the guest wasm is embedded, the sample is in memory, and
//     stdin/stdout/stderr are pipes opened by the API.

const sandboxedSubcommand = "__sandboxed"

// enterSandbox is stage 1. On success it does not return (the process is
// replaced by stage 2); any error means nothing was scanned.
func enterSandbox(sub string, args []string) error {
	fail := func(step string, err error) error {
		return fmt.Errorf("%w: %s: %v", errSandboxUnavailable, step, err)
	}
	// Every per-thread step and the execve must run on the same OS thread.
	runtime.LockOSThread()

	exe, err := os.Executable()
	if err != nil {
		return fail("executable", err)
	}

	if err := os.WriteFile("/proc/self/oom_score_adj", []byte("1000"), 0); err != nil {
		return fail("oom_score_adj", err)
	}
	raw, err := os.ReadFile("/proc/self/oom_score_adj")
	if err != nil {
		return fail("oom_score_adj read-back", err)
	}
	oom, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || oom != 1000 {
		return fail("oom_score_adj read-back", fmt.Errorf("value %q", strings.TrimSpace(string(raw))))
	}

	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return fail("no_new_privs", err)
	}

	abi, err := landlockABI()
	if err != nil {
		return fail("landlock abi", err)
	}
	if abi < 1 {
		return fail("landlock abi", fmt.Errorf("abi %d", abi))
	}
	attr, size := landlockRuleset(abi)
	r, _, e := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, uintptr(unsafe.Pointer(&attr)), size, 0)
	if e != 0 {
		return fail("landlock_create_ruleset", e)
	}
	rulesetFd := int(r)
	defer func() { _ = unix.Close(rulesetFd) }()
	startFiles, err := startupFiles(exe)
	if err != nil {
		return fail("loader files", err)
	}
	for _, f := range startFiles {
		if err := landlockAllowFile(rulesetFd, f, unix.LANDLOCK_ACCESS_FS_EXECUTE|unix.LANDLOCK_ACCESS_FS_READ_FILE); err != nil {
			return fail("landlock_add_rule "+f, err)
		}
	}
	if _, _, e := unix.Syscall(unix.SYS_LANDLOCK_RESTRICT_SELF, uintptr(rulesetFd), 0, 0); e != 0 {
		return fail("landlock_restrict_self", e)
	}

	argv := append([]string{exe, sandboxedSubcommand, "--abi", strconv.Itoa(abi), "--oom", strconv.Itoa(oom), "--", sub}, args...)
	err = syscall.Exec(exe, argv, os.Environ())
	return fail("re-exec", err) // only reached when execve failed
}

// finishSandbox is stage 2: verify what stage 1 applied, then seccomp.
func finishSandbox() error {
	fail := func(step string, err error) error {
		return fmt.Errorf("%w: %s: %v", errSandboxUnavailable, step, err)
	}
	if nnp, err := unix.PrctlRetInt(unix.PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0); err != nil || nnp != 1 {
		return fail("no_new_privs check", fmt.Errorf("value %d err %v", nnp, err))
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err == nil {
		_ = unix.Close(fd)
		return fail("landlock check", errors.New(`"/" is readable: this process is not inside the Landlock domain`))
	}
	if !errors.Is(err, unix.EACCES) {
		return fail("landlock check", err)
	}
	if err := installSeccomp(); err != nil {
		return fail("seccomp", err)
	}
	return nil
}

// cmdSandboxed is stage 2's entry point (`breeze-yarac __sandboxed …`, only
// ever exec'd by enterSandbox).
func cmdSandboxed(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet(sandboxedSubcommand, flag.ContinueOnError)
	fs.SetOutput(stderr)
	abi := fs.Int("abi", 0, "Landlock ABI stage 1 used")
	oom := fs.Int("oom", 0, "oom_score_adj stage 1 set")
	if err := fs.Parse(args); err != nil || fs.NArg() == 0 {
		return exitUsage
	}
	if err := finishSandbox(); err != nil {
		return sandboxUnavailable(err, stdout, stderr)
	}
	st := sandboxState{Sandboxed: true, LandlockABI: *abi, OOMScoreAdj: *oom}
	rest := fs.Args()
	switch rest[0] {
	case "match":
		opts, code := parseMatchFlags(rest[1:], stderr)
		if code != exitOK {
			return code
		}
		return runMatch(opts, stdin, stdout, stderr)
	case "sandbox-check":
		return reportProbes(st, stdout, stderr)
	default:
		_, _ = fmt.Fprintf(stderr, "%s: unknown subcommand %q\n", sandboxedSubcommand, rest[0])
		return exitUsage
	}
}

// startupFiles: what execve and the ELF loader open to start this binary —
// the binary, its PT_INTERP loader and its DT_NEEDED libraries (resolved in
// the standard library directories), plus ld.so.cache when present. They are
// system/own code, readable by any user; seccomp denies exec in stage 2.
func startupFiles(exe string) ([]string, error) {
	files := []string{exe}
	f, err := elf.Open(exe)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	var interp string
	for _, p := range f.Progs {
		if p.Type != elf.PT_INTERP {
			continue
		}
		b, err := io.ReadAll(p.Open())
		if err != nil {
			return nil, err
		}
		interp = strings.TrimRight(string(b), "\x00")
	}
	if interp == "" {
		return files, nil // statically linked
	}
	files = append(files, interp)
	libs, err := f.ImportedLibraries()
	if err != nil {
		return nil, err
	}
	dirs := []string{filepath.Dir(interp), "/lib", "/usr/lib", "/lib64", "/usr/lib64"}
	if triplet := map[string]string{"amd64": "x86_64-linux-gnu", "arm64": "aarch64-linux-gnu"}[runtime.GOARCH]; triplet != "" {
		dirs = append(dirs, "/lib/"+triplet, "/usr/lib/"+triplet)
	}
	for _, lib := range libs {
		for _, d := range dirs {
			p := filepath.Join(d, lib)
			if _, err := os.Stat(p); err == nil {
				files = append(files, p)
				break
			}
		}
	}
	if _, err := os.Stat("/etc/ld.so.cache"); err == nil {
		files = append(files, "/etc/ld.so.cache")
	}
	return files, nil
}

func landlockAllowFile(rulesetFd int, path string, access uint64) error {
	fd, err := unix.Open(path, unix.O_PATH|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer func() { _ = unix.Close(fd) }()
	attr := unix.LandlockPathBeneathAttr{Allowed_access: access, Parent_fd: int32(fd)}
	if _, _, e := unix.Syscall6(unix.SYS_LANDLOCK_ADD_RULE, uintptr(rulesetFd), unix.LANDLOCK_RULE_PATH_BENEATH,
		uintptr(unsafe.Pointer(&attr)), 0, 0, 0); e != 0 {
		return e
	}
	return nil
}

// landlockABI is the kernel's Landlock ABI version (an error when Landlock
// is absent, disabled, or the syscall is blocked).
func landlockABI() (int, error) {
	r, _, e := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, 0, 0, unix.LANDLOCK_CREATE_RULESET_VERSION)
	if e != 0 {
		return 0, e
	}
	return int(r), nil
}

// landlockRuleset handles every right the ABI knows, and passes the struct
// size the ABI understands (a larger struct with non-zero tail is E2BIG on an
// older kernel).
func landlockRuleset(abi int) (unix.LandlockRulesetAttr, uintptr) {
	fs := uint64(unix.LANDLOCK_ACCESS_FS_EXECUTE | unix.LANDLOCK_ACCESS_FS_WRITE_FILE | unix.LANDLOCK_ACCESS_FS_READ_FILE |
		unix.LANDLOCK_ACCESS_FS_READ_DIR | unix.LANDLOCK_ACCESS_FS_REMOVE_DIR | unix.LANDLOCK_ACCESS_FS_REMOVE_FILE |
		unix.LANDLOCK_ACCESS_FS_MAKE_CHAR | unix.LANDLOCK_ACCESS_FS_MAKE_DIR | unix.LANDLOCK_ACCESS_FS_MAKE_REG |
		unix.LANDLOCK_ACCESS_FS_MAKE_SOCK | unix.LANDLOCK_ACCESS_FS_MAKE_FIFO | unix.LANDLOCK_ACCESS_FS_MAKE_BLOCK |
		unix.LANDLOCK_ACCESS_FS_MAKE_SYM)
	if abi >= 2 {
		fs |= unix.LANDLOCK_ACCESS_FS_REFER
	}
	if abi >= 3 {
		fs |= unix.LANDLOCK_ACCESS_FS_TRUNCATE
	}
	if abi >= 5 {
		fs |= unix.LANDLOCK_ACCESS_FS_IOCTL_DEV
	}
	attr := unix.LandlockRulesetAttr{Handled_access_fs: fs}
	size := unsafe.Sizeof(attr.Handled_access_fs)
	if abi >= 4 {
		attr.Handled_access_net = unix.LANDLOCK_ACCESS_NET_BIND_TCP | unix.LANDLOCK_ACCESS_NET_CONNECT_TCP
		size += unsafe.Sizeof(attr.Handled_access_net)
	}
	if abi >= 6 {
		attr.Scoped = unix.LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | unix.LANDLOCK_SCOPE_SIGNAL
		size += unsafe.Sizeof(attr.Scoped)
	}
	return attr, size
}

// deniedSyscalls get EPERM. socket/socketpair cover UDP and unix sockets
// (Landlock's network rules are TCP-only); the rest close cross-process and
// escape paths Landlock does not cover for a same-uid sibling of the API.
var deniedSyscalls = []uint32{
	unix.SYS_SOCKET, unix.SYS_SOCKETPAIR, unix.SYS_CONNECT, unix.SYS_BIND, unix.SYS_LISTEN,
	unix.SYS_PTRACE, unix.SYS_PROCESS_VM_READV, unix.SYS_PROCESS_VM_WRITEV, unix.SYS_KCMP,
	unix.SYS_PIDFD_OPEN, unix.SYS_PIDFD_GETFD, unix.SYS_PIDFD_SEND_SIGNAL, unix.SYS_PROCESS_MADVISE,
	unix.SYS_EXECVE, unix.SYS_EXECVEAT,
	unix.SYS_IO_URING_SETUP, unix.SYS_IO_URING_ENTER, unix.SYS_IO_URING_REGISTER,
	unix.SYS_TKILL, unix.SYS_RT_SIGQUEUEINFO, unix.SYS_RT_TGSIGQUEUEINFO,
	// Same-uid knobs on ANOTHER process (the API): priority, CPU placement,
	// I/O priority, NUMA pages, robust futex list.
	unix.SYS_SETPRIORITY, unix.SYS_SCHED_SETAFFINITY, unix.SYS_SCHED_SETATTR, unix.SYS_SCHED_SETPARAM,
	unix.SYS_SCHED_SETSCHEDULER, unix.SYS_IOPRIO_SET, unix.SYS_MOVE_PAGES, unix.SYS_MIGRATE_PAGES,
	unix.SYS_GET_ROBUST_LIST, unix.SYS_PROCESS_MRELEASE,
	// Kernel attack surface nothing in match needs.
	unix.SYS_PERF_EVENT_OPEN, unix.SYS_BPF, unix.SYS_USERFAULTFD, unix.SYS_KEYCTL, unix.SYS_ADD_KEY,
	unix.SYS_REQUEST_KEY, unix.SYS_UNSHARE, unix.SYS_SETNS,
	// File metadata / events Landlock does not mediate.
	unix.SYS_INOTIFY_INIT1, unix.SYS_INOTIFY_ADD_WATCH, unix.SYS_FANOTIFY_INIT,
	unix.SYS_NAME_TO_HANDLE_AT, unix.SYS_OPEN_BY_HANDLE_AT,
}

// cloneNamespaceFlags: CLONE_NEW* — a new namespace is never needed to scan
// (clone3 returns ENOSYS so libc falls back to the checked clone).
// CLONE_NEWTIME (0x80) is absent: in clone() that bit is part of the CSIGNAL
// byte, and a time namespace can only be made with clone3/unshare, both denied.
const cloneNamespaceFlags = unix.CLONE_NEWNS | unix.CLONE_NEWCGROUP | unix.CLONE_NEWUTS | unix.CLONE_NEWIPC |
	unix.CLONE_NEWUSER | unix.CLONE_NEWPID | unix.CLONE_NEWNET

// seccomp_data offsets (include/uapi/linux/seccomp.h); args are 64-bit, and
// both supported arches are little-endian.
const (
	seccompDataNr      = 0
	seccompDataArch    = 4
	seccompDataArg0Lo  = 16
	seccompDataArg0Hi  = 20
	x32SyscallBit      = 0x40000000
	seccompRetEPERM    = unix.SECCOMP_RET_ERRNO | uint32(unix.EPERM)
	seccompRetENOSYS   = unix.SECCOMP_RET_ERRNO | uint32(unix.ENOSYS)
	seccompRetAllow    = unix.SECCOMP_RET_ALLOW
	labelDeny          = "deny"
	labelAllow         = "allow"
	labelSelfOrZero    = "self_or_zero"
	labelOwnPid        = "ownpid"
	labelOwnPidAllowed = "ownpid_ok"
	labelCloneFlags    = "clone_flags"
	labelENOSYS        = "enosys"
)

type bpfInsn struct {
	code   uint16
	k      uint32
	jt, jf string // label names; "" = fall through
	label  string // label of THIS instruction
}

// seccompProgram builds the filter for this process. kill/tgkill stay
// allowed only with this process's own pid as the first argument: the Go
// runtime signals its own threads (tgkill) and itself (kill), and nothing in
// match needs to signal anyone else — least of all the API that spawned it.
func seccompProgram(pid int) ([]unix.SockFilter, error) {
	var arch uint32
	switch runtime.GOARCH {
	case "amd64":
		arch = unix.AUDIT_ARCH_X86_64
	case "arm64":
		arch = unix.AUDIT_ARCH_AARCH64
	default:
		return nil, fmt.Errorf("unsupported arch %s", runtime.GOARCH)
	}
	ld := func(off uint32) bpfInsn { return bpfInsn{code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, k: off} }
	jeq := func(k uint32, jt, jf string) bpfInsn {
		return bpfInsn{code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, k: k, jt: jt, jf: jf}
	}
	ret := func(k uint32, label string) bpfInsn {
		return bpfInsn{code: unix.BPF_RET | unix.BPF_K, k: k, label: label}
	}

	// A syscall from another ABI (i386 compat on amd64, aarch32 on arm64)
	// would be checked against the wrong numbers: deny everything there.
	prog := []bpfInsn{ld(seccompDataArch), jeq(arch, "", labelDeny), ld(seccompDataNr)}
	if runtime.GOARCH == "amd64" {
		// x32 syscalls are nr | 0x40000000 and would slip past a denylist.
		prog = append(prog, bpfInsn{code: unix.BPF_JMP | unix.BPF_JGE | unix.BPF_K, k: x32SyscallBit, jt: labelDeny})
	}
	for _, nr := range deniedSyscalls {
		prog = append(prog, jeq(nr, labelDeny, ""))
	}
	prog = append(prog,
		jeq(unix.SYS_KILL, labelOwnPid, ""),
		jeq(unix.SYS_TGKILL, labelOwnPid, ""),
		jeq(unix.SYS_PRLIMIT64, labelSelfOrZero, ""), // pid 0 = self
		jeq(unix.SYS_CLONE, labelCloneFlags, ""),
		jeq(unix.SYS_CLONE3, labelENOSYS, ""),
		ret(seccompRetAllow, labelAllow),
		// arg0 (a pid) must be 0 or this process.
		bpfInsn{code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, k: seccompDataArg0Lo, label: labelSelfOrZero},
		jeq(0, labelOwnPid+"_hi", ""),
		// arg0 (a pid) must be this process.
		bpfInsn{code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, k: seccompDataArg0Lo, label: labelOwnPid},
		jeq(uint32(pid), "", labelDeny),
		bpfInsn{code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, k: seccompDataArg0Hi, label: labelOwnPid + "_hi"},
		jeq(0, labelOwnPidAllowed, labelDeny),
		ret(seccompRetAllow, labelOwnPidAllowed),
		// clone(flags, …): no namespace flags (flags is arg0 on both arches).
		bpfInsn{code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, k: seccompDataArg0Lo, label: labelCloneFlags},
		bpfInsn{code: unix.BPF_JMP | unix.BPF_JSET | unix.BPF_K, k: cloneNamespaceFlags, jt: labelDeny},
		ret(seccompRetAllow, ""),
		ret(seccompRetENOSYS, labelENOSYS),
		ret(seccompRetEPERM, labelDeny),
	)

	at := map[string]int{}
	for i, in := range prog {
		if in.label != "" {
			at[in.label] = i
		}
	}
	out := make([]unix.SockFilter, len(prog))
	for i, in := range prog {
		f := unix.SockFilter{Code: in.code, K: in.k}
		for _, j := range []struct {
			label string
			dst   *uint8
		}{{in.jt, &f.Jt}, {in.jf, &f.Jf}} {
			if j.label == "" {
				continue
			}
			off := at[j.label] - (i + 1)
			if _, ok := at[j.label]; !ok || off < 0 || off > 255 {
				return nil, fmt.Errorf("bad jump to %q from %d", j.label, i)
			}
			*j.dst = uint8(off)
		}
		out[i] = f
	}
	return out, nil
}

func installSeccomp() error {
	filter, err := seccompProgram(os.Getpid())
	if err != nil {
		return err
	}
	prog := unix.SockFprog{Len: uint16(len(filter)), Filter: &filter[0]}
	r, _, e := unix.Syscall(unix.SYS_SECCOMP, unix.SECCOMP_SET_MODE_FILTER, unix.SECCOMP_FILTER_FLAG_TSYNC, uintptr(unsafe.Pointer(&prog)))
	runtime.KeepAlive(filter)
	if e != 0 {
		return e
	}
	if r != 0 { // TSYNC: the id of a thread that could not be synchronised
		return fmt.Errorf("thread %d could not be synchronised", r)
	}
	return nil
}

// runProbes attempts what a compromised engine would try and reports each
// outcome (`breeze-yarac sandbox-check`). Every probe is harmless when it
// succeeds; control mode (unsandboxed) skips the ptrace attach.
func runProbes(control bool) []probeResult {
	ppid := os.Getppid()
	tmp := fmt.Sprintf("/tmp/breeze-yarac-sandbox-probe-%d", os.Getpid())
	probes := []struct {
		name string
		fn   func() error
	}{
		{"read /etc/hostname", func() error { _, err := os.ReadFile("/etc/hostname"); return err }},
		{"read /proc/self/environ", func() error { _, err := os.ReadFile("/proc/self/environ"); return err }},
		{"write /tmp", func() error {
			err := os.WriteFile(tmp, []byte("x"), 0o600)
			if err == nil {
				_ = os.Remove(tmp)
			}
			return err
		}},
		{"dial udp", func() error { return closeConn(net.Dial("udp", "127.0.0.1:9")) }},
		{"dial unix", func() error { return closeConn(net.Dial("unix", tmp+".sock")) }},
		{"process_vm_readv parent", func() error {
			buf := make([]byte, 1)
			local := []unix.Iovec{{Base: &buf[0], Len: 1}}
			remote := []unix.RemoteIovec{{Base: 0x1000, Len: 1}}
			_, err := unix.ProcessVMReadv(ppid, local, remote, 0)
			return err
		}},
		{"signal parent", func() error { return unix.Kill(ppid, 0) }},
		{"prlimit parent", func() error {
			var old unix.Rlimit // read-only: nothing is changed even when allowed
			return unix.Prlimit(ppid, unix.RLIMIT_NOFILE, nil, &old)
		}},
		{"perf_event_open", func() error {
			attr := unix.PerfEventAttr{Type: unix.PERF_TYPE_SOFTWARE, Config: unix.PERF_COUNT_SW_CPU_CLOCK}
			attr.Size = uint32(unsafe.Sizeof(attr))
			fd, err := unix.PerfEventOpen(&attr, 0, -1, -1, unix.PERF_FLAG_FD_CLOEXEC)
			if err == nil {
				_ = unix.Close(fd)
			}
			return err
		}},
		{"exec /bin/sh", func() error {
			// Raw ForkExec with inherited fds: os/exec would first open
			// /dev/null (a Landlock denial), and this probe must reach execve.
			pid, err := syscall.ForkExec("/bin/sh", []string{"/bin/sh", "-c", "exit 0"}, &syscall.ProcAttr{Files: []uintptr{2, 2, 2}})
			if err == nil {
				var ws syscall.WaitStatus
				_, _ = syscall.Wait4(pid, &ws, 0, nil)
			}
			return err
		}},
	}
	if !control {
		probes = append(probes, []struct {
			name string
			fn   func() error
		}{
			{"ptrace parent", func() error {
				err := unix.PtraceAttach(ppid)
				if err == nil {
					_ = unix.PtraceDetach(ppid) // the sandbox failed; let the parent go at once
				}
				return err
			}},
			{"unshare user namespace", func() error { return unix.Unshare(unix.CLONE_NEWUSER) }},
		}...)
	}
	out := make([]probeResult, 0, len(probes))
	for _, p := range probes {
		err := p.fn()
		r := probeResult{Name: p.name, Denied: err != nil, Errno: errnoName(err)}
		if err != nil {
			r.Error = err.Error()
		}
		out = append(out, r)
	}
	return out
}

func closeConn(c net.Conn, err error) error {
	if err == nil {
		_ = c.Close()
	}
	return err
}

// errnoName is the symbolic name of the errno inside err ("" when none).
func errnoName(err error) string {
	var en syscall.Errno
	if !errors.As(err, &en) {
		return ""
	}
	switch en {
	case syscall.EACCES:
		return "EACCES"
	case syscall.EPERM:
		return "EPERM"
	default:
		return unix.ErrnoName(en)
	}
}
