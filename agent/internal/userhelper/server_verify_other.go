//go:build !linux

package userhelper

import "net"

// platformServerVerifier accepts the server on platforms where the dial path
// has no Unix server check of its own yet: macOS keeps its existing trust
// model, and Windows verifies the pipe server inside its dialIPC.
func platformServerVerifier(net.Conn, string) error { return nil }
