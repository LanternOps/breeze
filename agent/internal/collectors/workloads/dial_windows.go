//go:build windows

package workloads

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

const (
	defaultDockerEndpoint     = `\\.\pipe\docker_engine`
	defaultPodmanEndpoint     = ""
	defaultContainerdEndpoint = ""
)

// socketPathFor returns "": a named pipe is not statted (opening it is a
// connection); the service-state check in liveness_windows.go decides instead.
func socketPathFor(string) string { return "" }

// endpointDialer dials a named pipe. winio.DialPipeContext opens it with
// read/write access, which the Docker engine pipe requires; the transport
// still only ever sends GET requests over it.
func endpointDialer(path string) DialFunc {
	return func(ctx context.Context) (net.Conn, error) {
		return winio.DialPipeContext(ctx, path)
	}
}
