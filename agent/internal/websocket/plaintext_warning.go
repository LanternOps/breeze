package websocket

import (
	"log/slog"
	"sync/atomic"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
)

// plaintextWarningMessage is logged when the agent connects to its server over
// an unencrypted WebSocket (#12729). The agent maps an http:// server_url to
// ws://, so this is what an http:// enrollment looks like on the wire.
const plaintextWarningMessage = "server connection is not encrypted: the agent is connecting over plain ws:// " +
	"because server_url uses http://, so anyone on the network path can read and change this traffic, " +
	"including the agent's credentials. Change server_url to the server's https:// address"

// plaintextWarned is set by the first plaintext dial of this process, so a
// reconnect loop logs the warning once per process start, not once per dial.
var plaintextWarned atomic.Bool

// warnPlaintextDial logs plaintextWarningMessage the first time this process
// dials wsURL over ws:// to a host that is not this machine (the rule is
// config.PlaintextRemoteHost). It returns true only when it logged. It never
// changes or refuses the connection.
func warnPlaintextDial(wsURL string) bool {
	host, plaintext := config.PlaintextRemoteHost(wsURL)
	if !plaintext || !plaintextWarned.CompareAndSwap(false, true) {
		return false
	}
	// Ships regardless of log_level / log_shipping_level, so it reaches the
	// server's agent logs on an agent whose levels are turned down.
	logging.EmitShipAlways(log, slog.LevelWarn, plaintextWarningMessage, "host", host)
	return true
}
