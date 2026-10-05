package agentapp

import (
	"errors"
	"os"

	breezeeventlog "github.com/breeze-rmm/agent/internal/eventlog"
)

const (
	mainAgentLockFile      = "agent.lock"
	exitAlreadyRunning     = 17
	exitInstanceGuardError = 18
	// exitConfigDirUntrusted: the config folder is a link, or another
	// account's ownership of it or of a config file in it could not be taken
	// back (config.ReclaimConfigDir).
	exitConfigDirUntrusted = 19
)

var ErrMainAgentAlreadyRunning = errors.New("main agent already running")

type mainAgentGuard interface {
	Close() error
}

var (
	acquireMainAgentGuardFn    = acquireMainAgentGuard
	mainAgentExitFn            = os.Exit
	writeInstanceGuardMarkerFn = writeInstanceGuardMarker
	writeInstanceGuardEventFn  = breezeeventlog.WriteError
)
