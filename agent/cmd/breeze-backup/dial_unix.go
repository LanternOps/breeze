//go:build !windows

package main

import (
	"fmt"
	"net"
	"os/user"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func dialIPC(socketPath string) (net.Conn, error) {
	conn, err := net.DialTimeout("unix", socketPath, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("connect to %s: %w", socketPath, err)
	}
	// Verify the server before the auth request goes out, as the Windows
	// dialer does for the pipe (#12117).
	if err := ipc.VerifyUnixBrokerServer(conn, socketPath); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("verify broker at %s: %w", socketPath, err)
	}
	return conn, nil
}

func fillPlatformIdentity(req *ipc.AuthRequest) {
	cu, err := user.Current()
	if err != nil {
		return
	}
	uid, err := strconv.ParseUint(cu.Uid, 10, 32)
	if err != nil {
		return
	}
	req.UID = uint32(uid)
	req.Username = cu.Username
}
