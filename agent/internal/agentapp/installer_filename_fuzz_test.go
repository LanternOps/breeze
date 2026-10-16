package agentapp

import (
	"net/url"
	"regexp"
	"strings"
	"testing"
)

var fuzzTokenRe = regexp.MustCompile(`^[A-Z0-9]{10}$`)

// FuzzInstallerFilenameToken checks the parser that turns an installer file
// name into a bootstrap token and control-plane host. Anyone can rename an
// installer, so the name is attacker-controlled. Properties: a parsed token is
// exactly 10 uppercase alphanumerics, and the server URL built from the host
// parses back to the same hostname. A mismatch would let the hosted-build host
// allowlist and the HTTP client disagree about which server the token goes to.
func FuzzInstallerFilenameToken(f *testing.F) {
	f.Add(`Breeze Agent (ABCDE12345@api.example.com).msi`)
	f.Add(`C:\Users\x\Downloads\Breeze Agent (ABCDE12345@api.example.com_8443) (1).msi`)
	f.Add(`Breeze Agent [ABCDE12345@host].app`)
	f.Add(`Breeze Agent (support@acme.com).msi`)
	f.Add(`(ABCDE12345@a.b@evil.com)`)

	f.Fuzz(func(t *testing.T, name string) {
		token, host, err := parseInstallerFilenameToken(name)
		if err != nil {
			return
		}
		if !fuzzTokenRe.MatchString(token) {
			t.Fatalf("token %q is not 10 uppercase alphanumerics", token)
		}
		u, perr := url.Parse("https://" + host)
		if perr != nil {
			t.Fatalf("host %q does not form a parseable URL: %v", host, perr)
		}
		want := host
		if i := strings.LastIndex(host, ":"); i >= 0 {
			want = host[:i]
		}
		if u.Hostname() != want {
			t.Fatalf("URL hostname %q differs from parsed host %q", u.Hostname(), want)
		}
		if u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			t.Fatalf("host %q smuggled URL parts: %#v", host, u)
		}
	})
}

// FuzzResolveBootstrapInputs covers the full --install-data string
// ("path|token|server"). A filename-derived server is always https.
func FuzzResolveBootstrapInputs(f *testing.F) {
	f.Add(`C:\x\Breeze Agent (ABCDE12345@api.example.com).msi||`)
	f.Add(`C:\x\Breeze Agent.msi|TOKEN|https://api.example.com`)
	f.Add(`C:\x\Breeze Agent (abcde12345@).msi||`)
	f.Add(`||`)

	f.Fuzz(func(t *testing.T, data string) {
		token, server, err := resolveBootstrapInputs(data)
		if err != nil {
			if token != "" || server != "" {
				t.Fatalf("error %v returned alongside token/server", err)
			}
			return
		}
		if token == "" || server == "" {
			t.Fatalf("success with empty token or server: %q %q", token, server)
		}
		parts := strings.SplitN(data, "|", 3)
		explicit := len(parts) == 3 && strings.TrimSpace(parts[1]) != "" && strings.TrimSpace(parts[2]) != ""
		if !explicit && !strings.HasPrefix(server, "https://") {
			t.Fatalf("filename-derived server %q is not https", server)
		}
	})
}
