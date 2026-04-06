//go:build !windows

package watchdog

import (
	"fmt"
	"net"
	"time"
)

func dialIPC(socketPath string) (net.Conn, error) {
	conn, err := net.DialTimeout("unix", socketPath, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("dial unix %s: %w", socketPath, err)
	}
	return conn, nil
}
