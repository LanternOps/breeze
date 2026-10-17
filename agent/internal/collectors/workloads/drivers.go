package workloads

import (
	"context"
	"errors"
	"io/fs"
	"os"
)

func endpointFor(path string) DialFunc {
	if path == "" {
		return nil
	}
	return endpointDialer(path)
}

// newDockerDriver never connects unless dockerd is already running: on Linux a
// live pid in /var/run/docker.pid, on Windows a running `docker` service.
func newDockerDriver() Driver {
	return newEngineDriver(RuntimeDocker, endpointFor(defaultDockerEndpoint),
		withSocketPath(socketPathFor(defaultDockerEndpoint)), withLiveness(dockerLiveness()))
}

// newPodmanDriver reads Podman's rootful API socket through the same
// Docker-compatible endpoints, and only while a `podman system service` process
// is already running (podman.socket is socket-activated). Rootless per-user
// sockets are out of scope: the agent runs as root and does not impersonate users.
func newPodmanDriver() Driver {
	return newEngineDriver(RuntimePodman, endpointFor(defaultPodmanEndpoint),
		withSocketPath(socketPathFor(defaultPodmanEndpoint)), withLiveness(podmanLiveness()))
}

// containerdDriver is detect-only in v1: it marks a host as a containerd (for
// example Kubernetes) node and never enumerates containers.
type containerdDriver struct {
	socket       string
	dockerSocket string
	stat         func(string) (fs.FileInfo, error)
}

func newContainerdDriver() Driver {
	return &containerdDriver{socket: defaultContainerdEndpoint, dockerSocket: defaultDockerEndpoint, stat: os.Stat}
}

func (d *containerdDriver) Runtime() Runtime { return RuntimeContainerd }

// Detect reports present when the containerd socket exists and no Docker socket
// does; Docker bundles its own containerd and is reported as docker instead.
func (d *containerdDriver) Detect(context.Context) Detection {
	if d.socket == "" {
		return Detection{State: DetectionAbsent}
	}
	if _, err := d.stat(d.socket); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Detection{State: DetectionAbsent}
		}
		return Detection{State: DetectionUnknown, Reason: ReasonUnreachable}
	}
	if d.dockerSocket != "" {
		if _, err := d.stat(d.dockerSocket); err == nil {
			return Detection{State: DetectionAbsent}
		}
	}
	return Detection{State: DetectionPresent}
}

func (d *containerdDriver) Collect(context.Context, Detection) Result {
	return Result{Collection: CollectionUnsupported, Complete: true}
}
