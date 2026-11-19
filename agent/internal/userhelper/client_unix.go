//go:build !windows

package userhelper

import (
	"fmt"
	"net"
	"time"
)

func (c *Client) dialIPC() (net.Conn, error) {
	conn, err := net.DialTimeout("unix", c.socketPath, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("connect to %s: %w", c.socketPath, err)
	}
	// Verify the server before the auth request goes out: the request names
	// this helper's identity and the reply carries the session key, so a
	// helper must never authenticate to a process that is not the broker.
	// A nil verifier is a programming error (NewWithOptions always sets
	// one), so it fails closed rather than skipping the check.
	verify := c.serverVerifier
	if verify == nil {
		_ = conn.Close()
		return nil, fmt.Errorf("verify broker at %s: no server verifier configured", c.socketPath)
	}
	if err := verify(conn, c.socketPath); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("verify broker at %s: %w", c.socketPath, err)
	}
	return conn, nil
}
