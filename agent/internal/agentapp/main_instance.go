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
