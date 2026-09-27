//go:build windows

package main

import (
	"context"
	"fmt"
	"net"
	"os/user"
	"time"

	"github.com/Microsoft/go-winio"
	"github.com/breeze-rmm/agent/internal/ipc"
)

func dialIPC(socketPath string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Request ipc.PipeClientAccessMask (GENERIC_READ | FILE_WRITE_DATA)
	// rather than go-winio's default GENERIC_WRITE, which would also ask for
	// the pipe-instance-creation right a client never needs (see
	// PipeClientAccessMask).
	conn, err := winio.DialPipeAccess(ctx, socketPath, ipc.PipeClientAccessMask)
	if err != nil {
		return nil, fmt.Errorf("dial pipe %s: %w", socketPath, err)
	}
	// Fail closed: refuse to talk to whatever accepted the connection unless
	// its kernel-verified identity is the agent broker itself. Without this,
	// a pipe of the same name created by another process is indistinguishable
	// from the real one at the point of dialing.
	if err := ipc.VerifyServerIdentity(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("verify pipe server identity: %w", err)
	}
	return conn, nil
}

func fillPlatformIdentity(req *ipc.AuthRequest) {
	cu, err := user.Current()
	if err != nil {
		return
	}
	// On Windows, cu.Uid is the SID string (e.g., "S-1-5-21-...")
	req.SID = cu.Uid
	req.Username = cu.Username
}
