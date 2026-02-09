//go:build darwin

package ipc

/*
#include <sys/sysctl.h>
#include <libproc.h>
#include <string.h>

// getProcPath resolves the binary path for a given PID.
static int getProcPath(int pid, char *buf, int bufsize) {
    return proc_pidpath(pid, buf, bufsize);
}
*/
import "C"

import (
	"fmt"
	"net"
	"strconv"
	"unsafe"

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
// via LOCAL_PEERCRED (xucred) and resolves the binary path via proc_pidpath.
func GetPeerCredentials(conn net.Conn) (*PeerCredentials, error) {
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return nil, fmt.Errorf("ipc: not a unix connection")
	}

	raw, err := uc.SyscallConn()
	if err != nil {
		return nil, fmt.Errorf("ipc: get syscall conn: %w", err)
	}

	var pid int
	var uid, gid uint32
	var credErr error

	err = raw.Control(func(fd uintptr) {
		// Get PID via LOCAL_PEERPID
		pidVal, err := unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, 0x002) // LOCAL_PEERPID = 0x002
		if err != nil {
			credErr = fmt.Errorf("getsockopt LOCAL_PEERPID: %w", err)
			return
		}
		pid = pidVal

		// Get UID/GID via LOCAL_PEERCRED (xucred)
		xcred, err := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if err != nil {
			credErr = fmt.Errorf("getsockopt LOCAL_PEERCRED: %w", err)
			return
		}
		uid = xcred.Uid
		if len(xcred.Groups) > 0 {
			gid = xcred.Groups[0]
		}
	})
	if err != nil {
		return nil, fmt.Errorf("ipc: control: %w", err)
	}
	if credErr != nil {
		return nil, credErr
	}

	// Resolve binary path via proc_pidpath
	buf := make([]byte, C.PROC_PIDPATHINFO_MAXSIZE)
	ret := C.getProcPath(C.int(pid), (*C.char)(unsafe.Pointer(&buf[0])), C.int(len(buf)))
	if ret <= 0 {
		return nil, fmt.Errorf("ipc: proc_pidpath failed for PID %d", pid)
	}
	// Find the null terminator
	exePath := string(buf[:ret])

	return &PeerCredentials{
		PID:        pid,
		UID:        uid,
		GID:        gid,
		BinaryPath: exePath,
	}, nil
}

// IdentityKey returns the platform identity key for this peer.
// On macOS, this is the kernel-verified UID as a string.
func (p *PeerCredentials) IdentityKey() string {
	return strconv.FormatUint(uint64(p.UID), 10)
}

// DefaultSocketPath returns the default IPC socket path for macOS.
func DefaultSocketPath() string {
	return "/Library/Application Support/Breeze/agent.sock"
}
