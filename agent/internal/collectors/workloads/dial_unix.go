//go:build !windows

package workloads

import (
	"context"
	"net"
)

const (
	defaultDockerEndpoint     = "/var/run/docker.sock"
	defaultPodmanEndpoint     = "/run/podman/podman.sock"
	defaultContainerdEndpoint = "/run/containerd/containerd.sock"
)

// socketPathFor returns the endpoint when it is a filesystem socket Detect can
// stat before connecting.
func socketPathFor(endpoint string) string { return endpoint }

// endpointDialer dials a unix socket.
func endpointDialer(path string) DialFunc {
	return func(ctx context.Context) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", path)
	}
}
