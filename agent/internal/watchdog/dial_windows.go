//go:build windows

package watchdog

import (
	"fmt"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
)

func dialIPC(socketPath string) (net.Conn, error) {
	timeout := 5 * time.Second
	conn, err := winio.DialPipe(socketPath, &timeout)
	if err != nil {
		return nil, fmt.Errorf("dial pipe %s: %w", socketPath, err)
	}
	return conn, nil
}
