package heartbeat

import (
	"strings"
	"testing"
)

// Finding I5: the "dev_update received" log line logged the FULL downloadUrl at
// Info, unconditionally. Log shipping defaults to warn, but Info lines still
// reach the local shipped log, and a dev_update URL is routinely a presigned
// S3/CDN link whose query string IS the capability. downloadOrigin keeps the
// operator-useful part (which host the binary came from) and drops the rest.
func TestDownloadOrigin(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"presigned url loses query and path", "https://cdn.example.com/builds/breeze-agent?X-Amz-Signature=SECRET", "https://cdn.example.com"},
		{"port is kept", "https://files.corp.internal:8443/pkg.exe?token=abc", "https://files.corp.internal:8443"},
		{"fragment dropped", "https://cdn.example.com/a#frag", "https://cdn.example.com"},
		{"userinfo dropped", "https://user:pass@cdn.example.com/a", "https://cdn.example.com"},
		{"surrounding whitespace tolerated", "  https://cdn.example.com/a  ", "https://cdn.example.com"},
		{"empty", "", "unparseable"},
		{"no scheme", "cdn.example.com/a", "unparseable"},
		{"no host", "https:///path", "unparseable"},
		{"garbage is not echoed back", "://%%bad", "unparseable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := downloadOrigin(tc.in); got != tc.want {
				t.Fatalf("downloadOrigin(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// The whole point: nothing that could be a capability survives.
func TestDownloadOriginDropsEverySecretBearingComponent(t *testing.T) {
	const raw = "https://alice:s3cr3t@cdn.example.com/builds/x?X-Amz-Signature=CAPABILITY&t=1#frag"
	got := downloadOrigin(raw)
	for _, forbidden := range []string{"s3cr3t", "alice", "CAPABILITY", "X-Amz-Signature", "builds", "frag"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("downloadOrigin(%q) = %q, which still carries %q", raw, got, forbidden)
		}
	}
}
