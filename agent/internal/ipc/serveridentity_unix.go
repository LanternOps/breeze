package ipc

// Unix server verification for unprivileged helpers (#12117).
//
// Deliberately untagged (a "_unix" filename suffix is not a build constraint):
// the decision is pure data, so `go test` covers it on every dev host. Only
// the evidence gathering (serveridentity_linux.go) touches the kernel.

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"slices"
)

// ErrUnixServerNotRoot means the process that accepted the connection does
// not run as uid 0, so it cannot be the agent's broker.
var ErrUnixServerNotRoot = errors.New("ipc: unix socket server is not root")

// ErrUnixSocketDirUnsafe means a directory on the socket's path could have
// been changed by a non-root user, so the socket at that path is not proven
// to be the one the root broker created.
var ErrUnixSocketDirUnsafe = errors.New("ipc: unix socket directory is not root-controlled")

// DirEvidence is one directory on the canonical path to the socket.
type DirEvidence struct {
	Path string
	UID  uint32
	GID  uint32
	Mode fs.FileMode
}

// IPCGroupName is the group the shipped install gives the broker's socket
// and, on Linux, its directory (sessionbroker.IPCGroupName).
const IPCGroupName = "breeze"

// UnixServerEvidence is what an unprivileged client can learn about whoever
// accepted its connection on a Unix socket.
type UnixServerEvidence struct {
	// PeerUID is the kernel-reported uid of the server end (SO_PEERCRED).
	PeerUID uint32
	// DirChain lists every directory from the socket's canonical parent up to
	// "/": the socket directory first, "/" last.
	DirChain []DirEvidence
	// TrustedGroupIDs are the groups, besides root's (gid 0), that may hold
	// write access to the socket's own directory: the IPC group, when it
	// resolves.
	TrustedGroupIDs []uint32
}

// CheckUnixServerIdentity decides whether a Unix socket server is the root
// broker. The server must be uid 0, and every directory above the socket must
// be a root-owned directory that others cannot write. Group write is refused
// too, with one exception: the socket's own directory may be group-writable
// when its group is root's or the IPC group, because the shipped install
// creates /run/breeze as 0770 root:breeze and the agent only narrows it to
// 0755 when it starts. A member of the IPC group could swap the socket entry
// there, but cannot make a server answer as uid 0. It fails closed on
// missing evidence.
//
// uid 0 proves the server is privileged, not specifically that it is Breeze.
// That is the strongest anchor an unprivileged client has (it cannot read
// /proc/<pid>/exe of a root process), and it stops a non-root impostor.
func CheckUnixServerIdentity(ev UnixServerEvidence) error {
	if ev.PeerUID != 0 {
		return fmt.Errorf("%w: peer uid %d", ErrUnixServerNotRoot, ev.PeerUID)
	}
	if len(ev.DirChain) == 0 {
		return fmt.Errorf("%w: no directory evidence", ErrUnixSocketDirUnsafe)
	}
	for i, d := range ev.DirChain {
		if !d.Mode.IsDir() {
			return fmt.Errorf("%w: %s is not a directory (mode %v)", ErrUnixSocketDirUnsafe, d.Path, d.Mode)
		}
		if d.UID != 0 {
			return fmt.Errorf("%w: %s is owned by uid %d", ErrUnixSocketDirUnsafe, d.Path, d.UID)
		}
		if d.Mode.Perm()&0o002 != 0 {
			return fmt.Errorf("%w: %s is writable by others (mode %v)", ErrUnixSocketDirUnsafe, d.Path, d.Mode)
		}
		if d.Mode.Perm()&0o020 != 0 && (i != 0 || !trustedSocketDirGroup(d.GID, ev.TrustedGroupIDs)) {
			return fmt.Errorf("%w: %s is writable by group %d (mode %v)", ErrUnixSocketDirUnsafe, d.Path, d.GID, d.Mode)
		}
	}
	// path, not filepath: the evidence is a Linux path on every host, and
	// filepath.Clean("/") is `\` on Windows.
	if last := ev.DirChain[len(ev.DirChain)-1].Path; path.Clean(last) != "/" {
		return fmt.Errorf("%w: directory evidence stops at %s, not /", ErrUnixSocketDirUnsafe, last)
	}
	return nil
}

func trustedSocketDirGroup(gid uint32, trusted []uint32) bool {
	return gid == 0 || slices.Contains(trusted, gid)
}
