package sessionbroker

import (
	"errors"
	"fmt"
	"io"
	"testing"
)

// #12808: the disconnect line says who ended a helper session, so a helper
// that keeps hanging up (Assist after a framing error) reads differently from
// the agent closing it (keepalive, shutdown) or a broken frame.
func TestRecvEndedBy(t *testing.T) {
	for _, tc := range []struct {
		name          string
		closedByAgent bool
		err           error
		want          string
	}{
		{"helper hung up between frames", false, fmt.Errorf("ipc: read header: %w", io.EOF), "helper"},
		{"connection cut inside a frame", false, fmt.Errorf("ipc: read payload: %w", io.ErrUnexpectedEOF), "helper_mid_frame"},
		{"agent closed it", true, errors.New("ipc: read header: file already closed"), "agent"},
		{"agent closed it, read saw EOF", true, fmt.Errorf("ipc: read header: %w", io.EOF), "agent"},
		{"framing or HMAC failure", false, errors.New("ipc: HMAC mismatch"), "error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := recvEndedBy(tc.closedByAgent, tc.err); got != tc.want {
				t.Fatalf("recvEndedBy = %q, want %q", got, tc.want)
			}
		})
	}
}
