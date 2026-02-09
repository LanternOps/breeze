//go:build windows

package userhelper

import (
	"fmt"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
)

func (c *Client) dialIPC() (net.Conn, error) {
	timeout := 5 * time.Second
	conn, err := winio.DialPipe(c.socketPath, &timeout)
	if err != nil {
		return nil, fmt.Errorf("dial pipe %s: %w", c.socketPath, err)
	}
	return conn, nil
}
