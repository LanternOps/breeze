package workloads

import (
	"context"
	"os"
	"syscall"
)

// dockerLiveness requires a live dockerd named in the default pid file.
func dockerLiveness() func(context.Context) liveness {
	return pidFileLiveness("/var/run/docker.pid", "/proc", "dockerd")
}

// podmanLiveness requires a running `podman system service` process.
func podmanLiveness() func(context.Context) liveness {
	return podmanServiceLiveness("/proc", defaultPodmanEndpoint, procOwnedByRoot)
}

// procOwnedByRoot reports whether the /proc/<pid> entry belongs to uid 0; the
// kernel sets its owner to the process's effective uid.
func procOwnedByRoot(pidDir string) bool {
	fi, err := os.Stat(pidDir)
	if err != nil {
		return false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && st.Uid == 0
}
