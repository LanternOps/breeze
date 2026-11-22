//go:build !linux

package ipc

import "net"

// VerifyUnixBrokerServer accepts the server off Linux: macOS keeps its
// existing trust model for now, and Windows clients verify the pipe server
// with VerifyServerIdentity instead.
func VerifyUnixBrokerServer(net.Conn, string) error { return nil }
