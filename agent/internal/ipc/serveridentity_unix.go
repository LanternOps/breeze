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
	"path/filepath"
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
	Mode fs.FileMode
}

// UnixServerEvidence is what an unprivileged client can learn about whoever
// accepted its connection on a Unix socket.
type UnixServerEvidence struct {
	// PeerUID is the kernel-reported uid of the server end (SO_PEERCRED).
	PeerUID uint32
	// DirChain lists every directory from the socket's canonical parent up to
	// "/": the socket directory first, "/" last.
	DirChain []DirEvidence
}

// CheckUnixServerIdentity decides whether a Unix socket server is the root
// broker. The server must be uid 0, and every directory above the socket must
// be a root-owned directory that neither group nor others can write. It fails
// closed on missing evidence.
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
	for _, d := range ev.DirChain {
		if !d.Mode.IsDir() {
			return fmt.Errorf("%w: %s is not a directory (mode %v)", ErrUnixSocketDirUnsafe, d.Path, d.Mode)
		}
		if d.UID != 0 {
			return fmt.Errorf("%w: %s is owned by uid %d", ErrUnixSocketDirUnsafe, d.Path, d.UID)
		}
		if d.Mode.Perm()&0o022 != 0 {
			return fmt.Errorf("%w: %s is writable by group or others (mode %v)", ErrUnixSocketDirUnsafe, d.Path, d.Mode)
		}
	}
	if last := ev.DirChain[len(ev.DirChain)-1].Path; filepath.Clean(last) != "/" {
		return fmt.Errorf("%w: directory evidence stops at %s, not /", ErrUnixSocketDirUnsafe, last)
	}
	return nil
}
