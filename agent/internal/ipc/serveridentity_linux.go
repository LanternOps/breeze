//go:build linux

package ipc

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// peerUcredOnly reads SO_PEERCRED for the other end of conn. Unlike
// GetPeerCredentials it does not read /proc/<pid>/exe, which an unprivileged
// client cannot do for a root server.
func peerUcredOnly(conn *net.UnixConn) (uid uint32, pid int32, err error) {
	if conn == nil {
		return 0, 0, errors.New("ipc: nil unix connection")
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, 0, fmt.Errorf("ipc: get syscall conn: %w", err)
	}
	var cred *unix.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return 0, 0, fmt.Errorf("ipc: control: %w", err)
	}
	if credErr != nil {
		return 0, 0, fmt.Errorf("ipc: getsockopt SO_PEERCRED: %w", credErr)
	}
	return cred.Uid, cred.Pid, nil
}

// GatherUnixServerEvidence collects what CheckUnixServerIdentity decides on:
// the server end's kernel uid and the owner and mode of every directory from
// the socket's canonical parent up to "/". Symlinks in the socket path are
// resolved first, so /var/run is checked as /run.
func GatherUnixServerEvidence(conn *net.UnixConn, socketPath string) (UnixServerEvidence, error) {
	uid, _, err := peerUcredOnly(conn)
	if err != nil {
		return UnixServerEvidence{}, err
	}
	abs, err := filepath.Abs(filepath.Dir(socketPath))
	if err != nil {
		return UnixServerEvidence{}, fmt.Errorf("ipc: socket dir: %w", err)
	}
	dir, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return UnixServerEvidence{}, fmt.Errorf("ipc: resolve socket dir: %w", err)
	}
	ev := UnixServerEvidence{PeerUID: uid}
	for p := dir; ; p = filepath.Dir(p) {
		var st unix.Stat_t
		if err := unix.Lstat(p, &st); err != nil {
			return UnixServerEvidence{}, fmt.Errorf("ipc: stat %s: %w", p, err)
		}
		ev.DirChain = append(ev.DirChain, DirEvidence{Path: p, UID: st.Uid, Mode: statModeToFileMode(st.Mode)})
		if p == filepath.Dir(p) { // reached "/"
			break
		}
	}
	return ev, nil
}

// statModeToFileMode maps a raw st_mode onto the fs.FileMode bits
// CheckUnixServerIdentity reads: the permission bits and whether the entry is
// a directory. Anything that is not a directory is marked irregular so it can
// never pass for one.
func statModeToFileMode(m uint32) fs.FileMode {
	mode := fs.FileMode(m & 0o777)
	if m&unix.S_IFMT == unix.S_IFDIR {
		return mode | fs.ModeDir
	}
	return mode | fs.ModeIrregular
}
