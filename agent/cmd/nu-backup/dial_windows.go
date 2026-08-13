//go:build windows

package main

import (
	"fmt"
	"net"
	"os/user"
	"time"

	"github.com/Microsoft/go-winio"
	"github.com/breeze-rmm/agent/internal/ipc"
)

func dialIPC(socketPath string) (net.Conn, error) {
	timeout := 5 * time.Second
	conn, err := winio.DialPipe(socketPath, &timeout)
	if err != nil {
		return nil, fmt.Errorf("dial pipe %s: %w", socketPath, err)
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
