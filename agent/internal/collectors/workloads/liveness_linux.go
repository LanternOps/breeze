package workloads

import "context"

// dockerLiveness requires a live dockerd named in the default pid file.
func dockerLiveness() func(context.Context) liveness {
	return pidFileLiveness("/var/run/docker.pid", "/proc", "dockerd")
}

// podmanLiveness requires a running `podman system service` process.
func podmanLiveness() func(context.Context) liveness { return podmanServiceLiveness("/proc") }
