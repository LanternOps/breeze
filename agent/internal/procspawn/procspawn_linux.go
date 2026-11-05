//go:build linux

package procspawn

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// childrenFD is the CLONE_INTO_CGROUP target, or -1 before the split.
var childrenFD atomic.Int64

func init() { childrenFD.Store(-1) }

// SetChildrenCgroup makes every later spawn land in the cgroup whose
// directory fd is given (cgroup.Layout.ChildrenFD); -1 turns placement off.
// The caller keeps fd open for the life of the process.
func SetChildrenCgroup(fd int) { childrenFD.Store(int64(fd)) }

// Enable turns placement on only after proving it: a probe child must start
// with CLONE_INTO_CGROUP and report childrenPath (relative to the cgroup root)
// as its own cgroup. Without the proof a kernel older than 5.7, or a seccomp
// policy that answers clone3 with ENOSYS (Docker's default profile does),
// would make every later spawn fail. On error placement stays as it was.
func Enable(fd int, childrenPath string) error {
	cat, err := exec.LookPath("cat")
	if err != nil {
		cat = "/bin/cat"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	//procspawn:exempt the placement probe itself sets the cgroup fd explicitly
	probe := exec.CommandContext(ctx, cat, "/proc/self/cgroup")
	probe.SysProcAttr = &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: fd}
	out, err := probe.Output()
	if err != nil {
		return fmt.Errorf("cgroup placement probe: %w", err)
	}
	want := "0::/" + strings.TrimPrefix(childrenPath, "/")
	if got := strings.TrimSpace(string(out)); got != want {
		return fmt.Errorf("cgroup placement probe landed in %q, want %q", got, want)
	}
	SetChildrenCgroup(fd)
	return nil
}

// EnableInAgentCgroup is for a Breeze helper the agent starts exempt, so that
// it shares the agent's permit (breeze-backup): when this process runs in
// `<unit>/agent`, its own children go to the sibling `<unit>/children`.
// Anywhere else (no split, other units, the inert build) it does nothing.
func EnableInAgentCgroup() error {
	data, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return err
	}
	children, ok := siblingChildrenCgroup(string(data))
	if !ok {
		return nil
	}
	fd, err := syscall.Open(path.Join("/sys/fs/cgroup", children), syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open children cgroup: %w", err)
	}
	if err := Enable(fd, children); err != nil {
		_ = syscall.Close(fd)
		return err
	}
	return nil
}

// siblingChildrenCgroup maps a /proc/self/cgroup of exactly
// `0::/<...>/<name>.service/agent` (pure cgroup v2) to its `children` sibling.
func siblingChildrenCgroup(content string) (string, bool) {
	self := strings.TrimSpace(content)
	if !strings.HasPrefix(self, "0::/") || strings.Contains(self, "\n") {
		return "", false
	}
	self = strings.TrimPrefix(self, "0::/")
	unit := path.Dir(self)
	if path.Base(self) != "agent" || !strings.HasSuffix(path.Base(unit), ".service") {
		return "", false
	}
	return path.Join(unit, "children"), true
}

// ChildrenCgroup returns the configured fd and whether placement is on.
func ChildrenCgroup() (int, bool) {
	fd := childrenFD.Load()
	return int(fd), fd >= 0
}

func placement() (*syscall.SysProcAttr, bool) {
	fd, ok := ChildrenCgroup()
	if !ok {
		return nil, false
	}
	return &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: fd}, true
}

func prepare(cmd *exec.Cmd) {
	p, ok := placement()
	if !ok {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = p
		return
	}
	cmd.SysProcAttr.UseCgroupFD, cmd.SysProcAttr.CgroupFD = p.UseCgroupFD, p.CgroupFD
}

func prepareAttr(attr *os.ProcAttr) {
	p, ok := placement()
	if !ok {
		return
	}
	if attr.Sys == nil {
		attr.Sys = p
		return
	}
	attr.Sys.UseCgroupFD, attr.Sys.CgroupFD = p.UseCgroupFD, p.CgroupFD
}
