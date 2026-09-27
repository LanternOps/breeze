//go:build windows

package userhelper

import (
	"context"
	"fmt"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
	"github.com/breeze-rmm/agent/internal/ipc"
)

func (c *Client) dialIPC() (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Request ipc.PipeClientAccessMask (GENERIC_READ | FILE_WRITE_DATA)
	// rather than go-winio's default GENERIC_WRITE, which would also ask for
	// the pipe-instance-creation right a client never needs (see
	// PipeClientAccessMask).
	conn, err := winio.DialPipeAccess(ctx, c.socketPath, ipc.PipeClientAccessMask)
	if err != nil {
		return nil, fmt.Errorf("dial pipe %s: %w", c.socketPath, err)
	}
	// Fail closed: never send anything (including the auth request that
	// carries our session material) to a pipe unless the kernel-verified
	// identity of the process on the other end is the agent broker itself.
	// A pipe of the same name created by another process would otherwise be
	// indistinguishable from the real one at the point of dialing.
	if err := ipc.VerifyServerIdentity(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("verify pipe server identity: %w", err)
	}
	return conn, nil
}
