//go:build linux

package cgroup

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

const (
	cgroupRoot    = "/sys/fs/cgroup"
	agentLeaf     = "agent"
	childrenLeaf  = "children"
	serviceSuffix = ".service"
)

// system is every OS boundary SetupSelf touches, so tests run it against a
// fake tree on a temp dir.
type system struct {
	root      string
	pid       int
	readSelf  func() ([]byte, error)
	isCgroup2 func(string) (bool, error)
	delegated func(dir, unit string) (bool, error)
	mkdir     func(string, os.FileMode) error
	writeFile func(string, []byte) error
	openDir   func(string) (int, error)
}

// SetupSelf splits the agent's unit cgroup and moves this process into
// `<unit>/agent`. It reads the unit from /proc/self/cgroup (never a hard-coded
// path) and is idempotent: a process already in `<unit>/agent` keeps its
// place. The caller owns the returned ChildrenFD.
//
// Refusals are *Error values: ReasonV1 (cgroup v1 or hybrid),
// ReasonNotDelegated (no Delegate=yes, or EACCES/EPERM creating or migrating)
// and ReasonUnavailable. A refusal leaves the process where it was.
func SetupSelf() (Layout, error) {
	return (&system{
		root:      cgroupRoot,
		pid:       os.Getpid(),
		readSelf:  func() ([]byte, error) { return os.ReadFile("/proc/self/cgroup") },
		isCgroup2: isCgroup2Mount,
		delegated: unitDelegated,
		mkdir:     os.Mkdir,
		writeFile: writeCgroupFile,
		openDir: func(p string) (int, error) {
			return unix.Open(p, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
		},
	}).setup()
}

func (s *system) setup() (Layout, error) {
	data, err := s.readSelf()
	if err != nil {
		return Layout{}, &Error{Reason: ReasonUnavailable, Detail: "read /proc/self/cgroup", Err: err}
	}
	current, err := parseSelf(data)
	if err != nil {
		return Layout{}, err
	}
	if ok, err := s.isCgroup2(s.root); err != nil {
		return Layout{}, &Error{Reason: ReasonUnavailable, Detail: "inspect " + s.root, Err: err}
	} else if !ok {
		return Layout{}, &Error{Reason: ReasonV1, Detail: s.root + " is not a cgroup v2 (unified) mount"}
	}

	unit := current
	if path.Base(unit) == agentLeaf {
		unit = path.Dir(unit) // already split by an earlier call in this process
	}
	unitName := path.Base(unit)
	if !strings.HasSuffix(unitName, serviceSuffix) || unit == "/" {
		return Layout{}, &Error{Reason: ReasonNotDelegated, Detail: fmt.Sprintf("the agent is not running in its own service unit (cgroup %q)", current)}
	}
	unitDir := filepath.Join(s.root, filepath.FromSlash(unit))
	delegated, err := s.delegated(unitDir, unitName)
	if err != nil {
		return Layout{}, &Error{Reason: ReasonNotDelegated, Detail: "cannot confirm Delegate=yes on " + unitName, Err: err}
	}
	if !delegated {
		return Layout{}, &Error{Reason: ReasonNotDelegated, Detail: unitName + " does not delegate its cgroup"}
	}

	agentDir := filepath.Join(unitDir, agentLeaf)
	childrenDir := filepath.Join(unitDir, childrenLeaf)
	for _, dir := range []string{agentDir, childrenDir} {
		if err := s.mkdir(dir, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
			return Layout{}, classify("create "+dir, err)
		}
	}
	// cgroup.procs migrates every thread of the process (a v2 domain cgroup).
	if current != unit+"/"+agentLeaf {
		if err := s.writeFile(filepath.Join(agentDir, "cgroup.procs"), []byte(strconv.Itoa(s.pid))); err != nil {
			return Layout{}, classify("move the agent into "+agentDir, err)
		}
	}
	data, err = s.readSelf()
	if err != nil {
		return Layout{}, &Error{Reason: ReasonUnavailable, Detail: "re-read /proc/self/cgroup", Err: err}
	}
	if moved, err := parseSelf(data); err != nil || moved != unit+"/"+agentLeaf {
		return Layout{}, &Error{Reason: ReasonUnavailable, Detail: fmt.Sprintf("the agent did not land in %s/%s (now %q)", unit, agentLeaf, moved), Err: err}
	}
	fd, err := s.openDir(childrenDir)
	if err != nil {
		return Layout{}, classify("open "+childrenDir, err)
	}
	rel := strings.TrimPrefix(unit, "/")
	return Layout{
		AgentPath:    rel + "/" + agentLeaf,
		ChildrenPath: rel + "/" + childrenLeaf,
		Level:        strings.Count(rel, "/") + 2,
		ChildrenFD:   fd,
	}, nil
}

// classify maps a permission failure to the Delegate remedy; root can only be
// refused here when systemd (or an LSM) has not handed the subtree over.
func classify(what string, err error) error {
	if errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EROFS) {
		return &Error{Reason: ReasonNotDelegated, Detail: what, Err: err}
	}
	return &Error{Reason: ReasonUnavailable, Detail: what, Err: err}
}

// parseSelf returns the unified-hierarchy path from /proc/self/cgroup. Any
// v1 controller line (pure v1 or hybrid) is a refusal: a hybrid host's socket
// cgroup ids are not the ones nft's `socket cgroupv2` compares.
func parseSelf(data []byte) (string, error) {
	unified := ""
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			return "", &Error{Reason: ReasonUnavailable, Detail: fmt.Sprintf("malformed /proc/self/cgroup line %q", line)}
		}
		if parts[0] != "0" || parts[1] != "" {
			return "", &Error{Reason: ReasonV1, Detail: "cgroup v1 controllers are mounted (v1 or hybrid hierarchy)"}
		}
		unified = parts[2]
	}
	if unified == "" || !strings.HasPrefix(unified, "/") {
		return "", &Error{Reason: ReasonV1, Detail: "no cgroup v2 (unified) membership in /proc/self/cgroup"}
	}
	return path.Clean(unified), nil
}

func isCgroup2Mount(p string) (bool, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(p, &st); err != nil {
		return false, err
	}
	return st.Type == unix.CGROUP2_SUPER_MAGIC, nil
}

// unitDelegated asks systemd's own record first: systemd ≥ 251 tags a
// delegated cgroup with the trusted.delegate (and, from 252, user.delegate)
// xattr. Older systemd is asked through systemctl.
func unitDelegated(dir, unit string) (bool, error) {
	for _, attr := range []string{"trusted.delegate", "user.delegate"} {
		buf := make([]byte, 8)
		n, err := unix.Getxattr(dir, attr, buf)
		if err == nil {
			return strings.TrimSpace(string(buf[:n])) == "1", nil
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := procspawn.CommandContext(ctx, "systemctl", "show", "--property=Delegate", "--value", "--", unit).Output()
	if err != nil {
		return false, fmt.Errorf("systemctl show %s: %w", unit, err)
	}
	return strings.TrimSpace(string(out)) == "yes", nil
}

// writeCgroupFile writes without O_CREAT or O_TRUNC: cgroup interface files
// already exist, and a missing one must fail rather than create a plain file.
func writeCgroupFile(p string, data []byte) error {
	f, err := os.OpenFile(p, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	_, werr := f.Write(data)
	cerr := f.Close()
	return errors.Join(werr, cerr)
}
