package oemupdates

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os/exec"
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
type procExec struct{}

func (procExec) Run(ctx context.Context, spec ExecSpec) (ExecResult, error) {
	if spec.Path == "" {
		return ExecResult{}, errors.New("no executable path")
	}
	cmd := procspawn.CommandContext(ctx, spec.Path, spec.Args...)
	cmd.Stdout, cmd.Stderr, cmd.Stdin = io.Discard, io.Discard, nil
	cmd.WaitDelay = processWaitDelay
	err := cmd.Run()
	if ctx.Err() != nil {
		return ExecResult{}, ctx.Err()
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
