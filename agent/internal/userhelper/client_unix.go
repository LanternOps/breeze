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
	return conn, nil
}
