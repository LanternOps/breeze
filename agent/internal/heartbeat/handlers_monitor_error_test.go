package heartbeat

import (
	"fmt"
	"net"
	"strings"
	"testing"
)

// The error text of a failed HTTP check is stored and shown to operators. A
// monitor URL can carry credentials (userinfo, query token, path segment), so
// the reported error describes the failure without quoting the URL.
func TestHandleNetworkHttpCheck_ErrorOmitsRequestURL(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	ln.Close() // nothing listens here any more: the request is refused

	tests := []struct {
		name string
		url  string
	}{
		{"query token", fmt.Sprintf("http://%s/status?token=secret-query-value", addr)},
		{"userinfo and path", fmt.Sprintf("http://ops:secret-password@%s/hooks/secret-path-value", addr)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := runHttpCheck(t, map[string]any{"monitorId": "m1", "url": tt.url, "timeout": 2})
			msg, _ := out["error"].(string)
			if msg == "" {
				t.Fatalf("expected an error for a refused connection, got %v", out)
			}
			for _, fragment := range []string{"secret-query-value", "secret-password", "secret-path-value", "token=", "/hooks/"} {
				if strings.Contains(msg, fragment) {
					t.Fatalf("error %q contains %q", msg, fragment)
				}
			}
			if !strings.Contains(msg, "connection refused") && !strings.Contains(msg, "refused") {
				t.Fatalf("error %q lost the underlying cause", msg)
			}
		})
	}
}
