//go:build linux

package userhelper

import (
	"net"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// platformServerVerifier refuses a broker that is not uid 0 or whose socket
// sits under a directory a non-root user could change (#12117). An
// unprivileged helper cannot read the root broker's /proc/<pid>/exe, so uid
// 0 plus a root-controlled path is the strongest identity it can check. A dev
// agent run as a normal user is refused by design.
func platformServerVerifier(conn net.Conn, socketPath string) error {
	return ipc.VerifyUnixBrokerServer(conn, socketPath)
}
