package workloads

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// liveness is what Detect learns about a runtime's daemon without opening a
// connection. A connection to a socket-activated engine starts the engine, so a
// stopped daemon must be recognized before anything dials.
type liveness int

const (
	livenessRunning liveness = iota // the daemon process exists; connecting is safe
	livenessStopped                 // installed, not running: report unavailable, never connect
	livenessAbsent                  // not installed
)

// pidFileLiveness reports livenessRunning only when pidFile names a process that
// exists under procDir and whose command name is comm. A missing, malformed or
// stale pid file, or a pid reused by another program, means "stopped".
func pidFileLiveness(pidFile, procDir, comm string) func(context.Context) liveness {
	return func(context.Context) liveness {
		raw, err := os.ReadFile(pidFile)
		if err != nil || len(raw) > 32 {
			return livenessStopped
		}
		pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
		if err != nil || pid <= 0 {
			return livenessStopped
		}
		name, err := os.ReadFile(filepath.Join(procDir, strconv.Itoa(pid), "comm"))
		if err != nil || strings.TrimSpace(string(name)) != comm {
			return livenessStopped
		}
		return livenessRunning
	}
}

// podmanServiceLiveness scans procDir/*/cmdline for a running
// `podman system service`. podman.socket is socket-activated, so the API socket
// existing says nothing about whether a service process is up.
func podmanServiceLiveness(procDir string) func(context.Context) liveness {
	return func(ctx context.Context) liveness {
		entries, err := os.ReadDir(procDir)
		if err != nil {
			return livenessStopped
		}
		for _, e := range entries {
			if ctx.Err() != nil {
				return livenessStopped
			}
			if _, err := strconv.Atoi(e.Name()); err != nil {
				continue
			}
			f, err := os.Open(filepath.Join(procDir, e.Name(), "cmdline"))
			if err != nil {
				continue
			}
			raw, _ := io.ReadAll(io.LimitReader(f, 4096))
			_ = f.Close()
			if isPodmanService(strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")) {
				return livenessRunning
			}
		}
		return livenessStopped
	}
}

// isPodmanService matches argv of `podman [global flags] system service ...`.
func isPodmanService(args []string) bool {
	if len(args) < 3 || filepath.Base(args[0]) != "podman" {
		return false
	}
	for i := 1; i+1 < len(args); i++ {
		if args[i] == "system" && args[i+1] == "service" {
			return true
		}
	}
	return false
}

// serviceState is the result of a read-only Windows service query.
type serviceState int

const (
	serviceUnknown serviceState = iota // the query itself failed
	serviceMissing
	serviceStopped
	serviceRunning
)

// livenessFromService maps a service query to a liveness. An unknown state is
// treated as stopped: when in doubt, do not connect.
func livenessFromService(state serviceState) liveness {
	switch state {
	case serviceRunning:
		return livenessRunning
	case serviceMissing:
		return livenessAbsent
	default:
		return livenessStopped
	}
}
