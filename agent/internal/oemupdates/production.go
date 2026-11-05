package oemupdates

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os/exec"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/authenticode"
	"github.com/breeze-rmm/agent/internal/flashguard"
	"github.com/breeze-rmm/agent/internal/procspawn"
)

// processWaitDelay bounds how long Run waits for output pipes after a kill.
const processWaitDelay = 10 * time.Second

// procExec is the production Exec. It starts the exact path it was given (no
// shell, no PATH lookup) through procspawn, discards output (raw tool output is
// never uploaded), and kills the process when ctx ends.
type procExec struct {
	// onExit runs after the process ends and before its result is read; a test
	// seam for a context that ends just after the process did.
	onExit func()
}

func (p procExec) Run(ctx context.Context, spec ExecSpec) (ExecResult, error) {
	if spec.Path == "" {
		return ExecResult{}, errors.New("no executable path")
	}
	cmd := procspawn.CommandContext(ctx, spec.Path, spec.Args...)
	cmd.Stdout, cmd.Stderr, cmd.Stdin = io.Discard, io.Discard, nil
	cmd.WaitDelay = processWaitDelay
	// Record whether the context killed the process. A process that ended on
	// its own keeps its exit code, even if the context ended a moment later;
	// on Windows a killed process also "exits" (code 1), so its state alone
	// cannot tell the two apart.
	var killed atomic.Bool
	cmd.Cancel = func() error {
		killed.Store(true)
		return cmd.Process.Kill()
	}
	err := cmd.Run()
	if p.onExit != nil {
		p.onExit()
	}
	if killed.Load() {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ExecResult{}, ctxErr
		}
		return ExecResult{}, errors.New("process killed")
	}
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) {
		return ExecResult{}, err
	}
	if cmd.ProcessState == nil {
		return ExecResult{}, errors.New("process did not run")
	}
	return ExecResult{ExitCode: exitCodeOf(cmd.ProcessState)}, nil
}

type authenticodeVerifier struct{}

func (authenticodeVerifier) Verify(path string) (authenticode.Signer, error) {
	return authenticode.Verify(path)
}

type wallClock struct{}

func (wallClock) Now() time.Time { return time.Now() }

// ProductionDeps wires every seam to the real machine. preflight and progress
// come from the caller, which owns the config and the websocket.
func ProductionDeps(preflight func() error, progress func(stage string)) Deps {
	return Deps{
		Exec:       procExec{},
		Verifier:   authenticodeVerifier{},
		Fetcher:    httpFetcher{client: &http.Client{Timeout: downloadTimeout}},
		Power:      systemPower{},
		Protectors: systemProtectors{},
		System:     systemInfo{},
		Clock:      wallClock{},
		Store:      DefaultStore(),
		Guard:      flashguard.Default(),
		Preflight:  preflight,
		Elevated:   isElevated,
		Progress:   progress,
	}
}
