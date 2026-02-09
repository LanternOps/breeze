//go:build linux

package ipc

import (
	"fmt"
	"net"
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

// PeerCredentials holds the verified identity of an IPC peer.
type PeerCredentials struct {
	PID        int
	UID        uint32
	GID        uint32
	BinaryPath string
}

// GetPeerCredentials returns the kernel-verified PID/UID/GID of the peer
// via SO_PEERCRED and resolves the binary path from /proc/<pid>/exe.
func GetPeerCredentials(conn net.Conn) (*PeerCredentials, error) {
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return nil, fmt.Errorf("ipc: not a unix connection")
	}

	raw, err := uc.SyscallConn()
	if err != nil {
		return nil, fmt.Errorf("ipc: get syscall conn: %w", err)
	}

	var cred *unix.Ucred
	var credErr error
	err = raw.Control(func(fd uintptr) {
		cred, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	})
	if err != nil {
		return nil, fmt.Errorf("ipc: control: %w", err)
	}
	if credErr != nil {
		return nil, fmt.Errorf("ipc: getsockopt SO_PEERCRED: %w", credErr)
	}

	// Read the binary path from /proc/<pid>/exe
	exePath, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", cred.Pid))
	if err != nil {
		return nil, fmt.Errorf("ipc: readlink /proc/%d/exe: %w", cred.Pid, err)
	}

	return &PeerCredentials{
		PID:        int(cred.Pid),
		UID:        cred.Uid,
		GID:        cred.Gid,
		BinaryPath: exePath,
	}, nil
}

// IdentityKey returns the platform identity key for this peer.
// On Linux, this is the kernel-verified UID as a string.
func (p *PeerCredentials) IdentityKey() string {
	return strconv.FormatUint(uint64(p.UID), 10)
}

// DefaultSocketPath returns the default IPC socket path for Linux.
func DefaultSocketPath() string {
	return "/var/run/breeze/agent.sock"
}
