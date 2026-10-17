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
// `podman system service` that serves socket. podman.socket is
// socket-activated, so the API socket existing says nothing about whether a
// service process is up. Only a root-owned process counts (rootOwned is given
// the process's procDir entry): a rootless user's service serves that user's
// own socket, and dialing the rootful socket because of it would make systemd
// start the rootful podman.service. A root process serving another URI does not
// count either.
func podmanServiceLiveness(procDir, socket string, rootOwned func(pidDir string) bool) func(context.Context) liveness {
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
			pidDir := filepath.Join(procDir, e.Name())
			f, err := os.Open(filepath.Join(pidDir, "cmdline"))
			if err != nil {
				continue
			}
			raw, _ := io.ReadAll(io.LimitReader(f, 4096))
			_ = f.Close()
			args := strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
			if isPodmanService(args) && podmanServiceServes(args, socket) && rootOwned(pidDir) {
				return livenessRunning
			}
		}
		return livenessStopped
	}
}

// podmanServiceValueFlags are `podman system service` flags that take their
// value as the next argument; that value is not the listen URI.
var podmanServiceValueFlags = map[string]bool{"-t": true, "--time": true, "--cors": true}

// podmanServiceServes reports whether a `podman system service` argv listens on
// socket: either it names no URI (the systemd unit form, which serves the
// socket systemd passes it, the rootful one for a root process) or its URI is
// that socket. Anything unrecognized counts as another socket, so the driver
// errs toward not connecting.
func podmanServiceServes(args []string, socket string) bool {
	i := 0
	for i+1 < len(args) && (args[i] != "system" || args[i+1] != "service") {
		i++
	}
	for j := i + 2; j < len(args); j++ {
		a := args[j]
		if strings.HasPrefix(a, "-") {
			if podmanServiceValueFlags[a] {
				j++
			}
			continue
		}
		return a == "unix://"+socket || a == "unix:"+socket
	}
	return true
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
