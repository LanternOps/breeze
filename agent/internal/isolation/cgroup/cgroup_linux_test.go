//go:build linux

package cgroup

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

const unitCgroup = "/system.slice/breeze-agent.service"

// fakeTree is a cgroup v2 hierarchy on a temp dir. /proc/self/cgroup reflects
// whichever cgroup.procs file last received this pid, exactly like the kernel.
type fakeTree struct {
	root      string
	pid       int
	start     string // the cgroup the process starts in
	selfData  string // when set, returned verbatim (v1 / hybrid fixtures)
	cgroup2   bool
	delegated bool
	mkdirErr  error
	writeErr  error
}

func newFakeTree(t *testing.T) *fakeTree {
	t.Helper()
	ft := &fakeTree{root: t.TempDir(), pid: 4242, start: unitCgroup, cgroup2: true, delegated: true}
	if err := os.MkdirAll(filepath.Join(ft.root, unitCgroup), 0o755); err != nil {
		t.Fatal(err)
	}
	return ft
}

func (ft *fakeTree) current() string {
	for _, sub := range []string{"agent", "children"} {
		data, err := os.ReadFile(filepath.Join(ft.root, unitCgroup, sub, "cgroup.procs"))
		if err == nil && strings.TrimSpace(string(data)) == strconv.Itoa(ft.pid) {
			return unitCgroup + "/" + sub
		}
	}
	return ft.start
}

func (ft *fakeTree) system() *system {
	return &system{
		root: ft.root,
		pid:  ft.pid,
		readSelf: func() ([]byte, error) {
			if ft.selfData != "" {
				return []byte(ft.selfData), nil
			}
			return []byte("0::" + ft.current() + "\n"), nil
		},
		isCgroup2: func(string) (bool, error) { return ft.cgroup2, nil },
		delegated: func(dir, unit string) (bool, error) {
			if dir != filepath.Join(ft.root, unitCgroup) || unit != "breeze-agent.service" {
				return false, errors.New("delegation asked about the wrong cgroup")
			}
			return ft.delegated, nil
		},
		mkdir: func(path string, mode os.FileMode) error {
			if ft.mkdirErr != nil {
				return ft.mkdirErr
			}
			if err := os.Mkdir(path, mode); err != nil {
				return err
			}
			// The kernel creates the interface files with the directory.
			return os.WriteFile(filepath.Join(path, "cgroup.procs"), nil, 0o644)
		},
		writeFile: func(path string, data []byte) error {
			if ft.writeErr != nil {
				return ft.writeErr
			}
			return os.WriteFile(path, data, 0o644)
		},
		openDir: func(path string) (int, error) {
			return syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
		},
	}
}

func TestParseSelfCgroup(t *testing.T) {
	for _, tc := range []struct {
		name, data, want string
		v1               bool
	}{
		{"unified", "0::/system.slice/breeze-agent.service\n", "/system.slice/breeze-agent.service", false},
		{"unified no newline", "0::/system.slice/breeze-agent.service", "/system.slice/breeze-agent.service", false},
		{"pure v1", "12:pids:/system.slice/breeze-agent.service\n1:name=systemd:/system.slice/breeze-agent.service\n", "", true},
		{"hybrid", "12:pids:/system.slice/breeze-agent.service\n1:name=systemd:/system.slice/breeze-agent.service\n0::/system.slice/breeze-agent.service\n", "", true},
		{"empty", "", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseSelf([]byte(tc.data))
			if tc.v1 {
				var ce *Error
				if !errors.As(err, &ce) || ce.Reason != ReasonV1 {
					t.Fatalf("parseSelf(%q) err = %v, want %s", tc.data, err, ReasonV1)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("parseSelf(%q) = %q, %v; want %q", tc.data, got, err, tc.want)
			}
		})
	}
}

func TestSetupSelfDerivesPathAndLevelFromProcSelf(t *testing.T) {
	ft := newFakeTree(t)
	layout, err := ft.system().setup()
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	defer func() { _ = syscall.Close(layout.ChildrenFD) }()
	if layout.AgentPath != "system.slice/breeze-agent.service/agent" || layout.ChildrenPath != "system.slice/breeze-agent.service/children" {
		t.Fatalf("paths = %q, %q", layout.AgentPath, layout.ChildrenPath)
	}
	if layout.Level != 3 {
		t.Fatalf("level = %d, want 3 (the depth of the agent cgroup)", layout.Level)
	}
	if layout.ChildrenFD < 0 {
		t.Fatalf("ChildrenFD = %d", layout.ChildrenFD)
	}
	if got := ft.current(); got != unitCgroup+"/agent" {
		t.Fatalf("agent process now in %q, want the agent sub-cgroup", got)
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(layout.ChildrenFD, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		t.Fatalf("ChildrenFD is not the children directory: %v", err)
	}
}

func TestSetupSelfFollowsANonStandardUnitPath(t *testing.T) {
	ft := newFakeTree(t)
	// A renamed slice: the path is derived, never hard-coded.
	ft.start = "/custom.slice/breeze-agent.service"
	if err := os.MkdirAll(filepath.Join(ft.root, ft.start), 0o755); err != nil {
		t.Fatal(err)
	}
	s := ft.system()
	s.delegated = func(string, string) (bool, error) { return true, nil }
	s.readSelf = func() ([]byte, error) {
		data, _ := os.ReadFile(filepath.Join(ft.root, ft.start, "agent", "cgroup.procs"))
		if strings.TrimSpace(string(data)) == strconv.Itoa(ft.pid) {
			return []byte("0::" + ft.start + "/agent\n"), nil
		}
		return []byte("0::" + ft.start + "\n"), nil
	}
	layout, err := s.setup()
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	defer func() { _ = syscall.Close(layout.ChildrenFD) }()
	if layout.AgentPath != "custom.slice/breeze-agent.service/agent" || layout.Level != 3 {
		t.Fatalf("layout = %+v", layout)
	}
}

func TestSetupSelfIsIdempotentInsideTheAgentCgroup(t *testing.T) {
	ft := newFakeTree(t)
	first, err := ft.system().setup()
	if err != nil {
		t.Fatal(err)
	}
	_ = syscall.Close(first.ChildrenFD)
	second, err := ft.system().setup()
	if err != nil {
		t.Fatalf("second setup: %v", err)
	}
	defer func() { _ = syscall.Close(second.ChildrenFD) }()
	if second.AgentPath != first.AgentPath || second.Level != first.Level {
		t.Fatalf("second layout %+v differs from first %+v", second, first)
	}
}

func TestSetupSelfRefusesCgroupV1AndHybrid(t *testing.T) {
	for _, tc := range []struct {
		name    string
		self    string
		cgroup2 bool
	}{
		{"v1 proc self", "4:pids:/system.slice/breeze-agent.service\n1:name=systemd:/system.slice/breeze-agent.service\n", true},
		{"hybrid proc self", "4:pids:/system.slice/breeze-agent.service\n0::/system.slice/breeze-agent.service\n", true},
		{"root not cgroup2", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ft := newFakeTree(t)
			ft.selfData, ft.cgroup2 = tc.self, tc.cgroup2
			_, err := ft.system().setup()
			var ce *Error
			if !errors.As(err, &ce) || ce.Reason != ReasonV1 {
				t.Fatalf("err = %v, want reason %s", err, ReasonV1)
			}
			if ce.FailureCode() != "mechanism_unavailable" {
				t.Fatalf("failure code = %q", ce.FailureCode())
			}
			if _, statErr := os.Stat(filepath.Join(ft.root, unitCgroup, "agent")); !os.IsNotExist(statErr) {
				t.Fatal("a refused setup must not create sub-cgroups")
			}
		})
	}
}

func TestSetupSelfRequiresDelegation(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(*fakeTree)
	}{
		{"unit not delegated", func(ft *fakeTree) { ft.delegated = false }},
		{"mkdir EACCES", func(ft *fakeTree) { ft.mkdirErr = &os.PathError{Op: "mkdir", Err: syscall.EACCES} }},
		{"mkdir EPERM", func(ft *fakeTree) { ft.mkdirErr = &os.PathError{Op: "mkdir", Err: syscall.EPERM} }},
		{"migrate EACCES", func(ft *fakeTree) { ft.writeErr = &os.PathError{Op: "write", Err: syscall.EACCES} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ft := newFakeTree(t)
			tc.setup(ft)
			_, err := ft.system().setup()
			var ce *Error
			if !errors.As(err, &ce) || ce.Reason != ReasonNotDelegated {
				t.Fatalf("err = %v, want reason %s", err, ReasonNotDelegated)
			}
			if ce.FailureCode() != "mechanism_unavailable" {
				t.Fatalf("failure code = %q", ce.FailureCode())
			}
			if !strings.Contains(err.Error(), "agent unit lacks Delegate=yes (reinstall the agent)") {
				t.Fatalf("message %q does not tell the operator to reinstall", err.Error())
			}
			if ft.current() != unitCgroup {
				t.Fatal("a refused setup must leave the agent where it was")
			}
		})
	}
}

func TestSetupSelfRefusesAProcessOutsideAServiceUnit(t *testing.T) {
	ft := newFakeTree(t)
	ft.selfData = "0::/user.slice/user-1000.slice/session-2.scope\n"
	_, err := ft.system().setup()
	var ce *Error
	if !errors.As(err, &ce) || ce.Reason != ReasonNotDelegated {
		t.Fatalf("err = %v, want reason %s", err, ReasonNotDelegated)
	}
}

func TestSetupSelfFailsWhenTheMoveDidNotTakeEffect(t *testing.T) {
	ft := newFakeTree(t)
	s := ft.system()
	s.readSelf = func() ([]byte, error) { return []byte("0::" + unitCgroup + "\n"), nil }
	if _, err := s.setup(); err == nil {
		t.Fatal("setup must verify the agent actually moved into the agent cgroup")
	}
}
