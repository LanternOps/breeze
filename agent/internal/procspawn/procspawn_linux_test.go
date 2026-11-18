//go:build linux

package procspawn

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestPrepareMergesPlacementIntoExistingAttributes(t *testing.T) {
	SetChildrenCgroup(17)
	defer SetChildrenCgroup(-1)

	c := Command("true")
	if c.SysProcAttr == nil || !c.SysProcAttr.UseCgroupFD || c.SysProcAttr.CgroupFD != 17 {
		t.Fatalf("Command placement = %+v", c.SysProcAttr)
	}
	// The executor and terminal set their own attributes; Prepare keeps them.
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	Prepare(c)
	if !c.SysProcAttr.Setpgid || c.SysProcAttr.Pdeathsig != syscall.SIGKILL || !c.SysProcAttr.UseCgroupFD || c.SysProcAttr.CgroupFD != 17 {
		t.Fatalf("Prepare lost attributes: %+v", c.SysProcAttr)
	}
	Prepare(c)
	if c.SysProcAttr.CgroupFD != 17 {
		t.Fatal("Prepare is not idempotent")
	}
	attr := &os.ProcAttr{Sys: &syscall.SysProcAttr{Setsid: true}}
	prepareAttr(attr)
	if !attr.Sys.Setsid || !attr.Sys.UseCgroupFD || attr.Sys.CgroupFD != 17 {
		t.Fatalf("StartProcess placement = %+v", attr.Sys)
	}
}

// A probe that cannot place its child leaves placement off: turning it on
// anyway would make every later spawn fail.
func TestEnableRefusesWhenTheProbeFails(t *testing.T) {
	SetChildrenCgroup(-1)
	dir := t.TempDir() // a plain directory is not a cgroup
	fd, err := syscall.Open(dir, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = syscall.Close(fd) }()
	if err := Enable(fd, "system.slice/breeze-agent.service/children"); err == nil {
		t.Fatal("Enable must fail when the probe child cannot be placed")
	}
	if _, ok := ChildrenCgroup(); ok {
		t.Fatal("a failed probe must leave placement off")
	}
	if c := Command("true"); c.SysProcAttr != nil {
		t.Fatal("spawns must stay unplaced after a failed probe")
	}
}

func TestEnableInAgentCgroupIsANoOpOutsideTheSplit(t *testing.T) {
	SetChildrenCgroup(-1)
	if err := EnableInAgentCgroup(); err != nil {
		t.Fatalf("outside <unit>/agent: %v", err)
	}
	if _, ok := ChildrenCgroup(); ok {
		t.Fatal("placement must stay off outside the split")
	}
}

func TestPlacementOffLeavesCommandsUntouched(t *testing.T) {
	SetChildrenCgroup(-1)
	if _, ok := ChildrenCgroup(); ok {
		t.Fatal("placement must be off by default")
	}
	if c := Command("true"); c.SysProcAttr != nil {
		t.Fatalf("unconfigured Command set %+v", c.SysProcAttr)
	}
}

// The real kernel check: a spawned child's /proc/self/cgroup is the children
// cgroup. It needs a writable cgroup v2 subtree (a delegated unit, or root in
// a private cgroup namespace); CI runners and unprivileged containers skip,
// and the L2 lab leg proves it on the shipped unit.
func TestSpawnedChildLandsInChildrenCgroup(t *testing.T) {
	data, err := os.ReadFile("/proc/self/cgroup")
	if err != nil || !strings.HasPrefix(string(data), "0::/") || strings.Count(string(data), "\n") > 1 {
		t.Skip("not a pure cgroup v2 process")
	}
	self := strings.TrimSpace(strings.TrimPrefix(string(data), "0::"))
	base := filepath.Join("/sys/fs/cgroup", self, fmt.Sprintf("procspawn-test-%d", os.Getpid()))
	if err := os.Mkdir(base, 0o755); err != nil {
		t.Skipf("cgroup subtree not writable here (%v); the L2 lab leg covers placement", err)
	}
	defer func() { _ = os.Remove(base) }()
	fd, err := syscall.Open(base, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = syscall.Close(fd) }()
	SetChildrenCgroup(fd)
	defer SetChildrenCgroup(-1)
	out, err := Command("cat", "/proc/self/cgroup").Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			t.Fatalf("child failed: %v", err)
		}
		t.Skipf("kernel refused CLONE_INTO_CGROUP here: %v", err)
	}
	want := "0::" + filepath.Join(self, filepath.Base(base))
	if strings.TrimSpace(string(out)) != want {
		t.Fatalf("child cgroup %q, want %q", strings.TrimSpace(string(out)), want)
	}
}

func TestSiblingChildrenCgroup(t *testing.T) {
	for _, tc := range []struct {
		self, want string
		ok         bool
	}{
		{"0::/system.slice/breeze-agent.service/agent\n", "system.slice/breeze-agent.service/children", true},
		{"0::/custom.slice/breeze-agent.service/agent", "custom.slice/breeze-agent.service/children", true},
		{"0::/system.slice/breeze-agent.service\n", "", false},
		{"0::/user.slice/user-1000.slice/session-2.scope/agent\n", "", false},
		{"0::/agent\n", "", false},
		{"0::/x/agent\n", "", false},
		{"12:pids:/system.slice/breeze-agent.service/agent\n0::/system.slice/breeze-agent.service/agent\n", "", false},
		{"", "", false},
	} {
		got, ok := siblingChildrenCgroup(tc.self)
		if got != tc.want || ok != tc.ok {
			t.Errorf("siblingChildrenCgroup(%q) = %q, %v; want %q, %v", tc.self, got, ok, tc.want, tc.ok)
		}
	}
}
