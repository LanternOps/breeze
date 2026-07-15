package agentapp

import (
	"errors"
	"os"
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
	acquireMainAgentGuardFn = acquireMainAgentGuard
	mainAgentExitFn         = os.Exit
)
