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
	"github.com/breeze-rmm/agent/internal/oemupdates/bitlockerguard"
	"github.com/breeze-rmm/agent/internal/patching"
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
		// Only a kill that landed counts: a process that already exited keeps
		// its own exit code (Kill then returns os.ErrProcessDone).
		err := cmd.Process.Kill()
		if err == nil {
			killed.Store(true)
		}
		return err
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
		Exec:          procExec{},
		Verifier:      authenticodeVerifier{},
		Fetcher:       httpFetcher{client: &http.Client{Timeout: downloadTimeout}},
		Power:         systemPower{},
		Protectors:    systemProtectors{},
		System:        systemInfo{},
		Clock:         wallClock{},
		Store:         DefaultStore(),
		Guard:         flashguard.Default(),
		Preflight:     preflight,
		Elevated:      isElevated,
		Progress:      progress,
		BitLockerHeld: productionBitLockerHeld,
	}
}

// ProductionGuardDeps wires the BitLocker guard to the real machine, with its
// record in the same agent-owned store as the run marker.
func ProductionGuardDeps() bitlockerguard.Deps {
	return bitlockerguard.SystemDeps(DefaultStore(), systemInfo{}.BootTime, detectPendingReboot)
}

// detectPendingReboot is the registry reading the reboot manager uses. It cannot
// fail: a key it cannot open reads as not pending.
func detectPendingReboot() (bool, error) {
	pending, _ := patching.DetectPendingReboot()
	return pending, nil
}

// productionBitLockerHeld treats an unreadable record as not held. That only lets
// the verification go ahead and report the volume as it is, which is true either
// way, where the opposite would hold the report back until it aged out.
func productionBitLockerHeld() bool {
	held, err := bitlockerguard.Held(ProductionGuardDeps())
	if err != nil {
		log.Warn("bitlocker guard record unreadable", "error", err.Error())
		return false
	}
	return held
}
