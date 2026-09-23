package agentapp

import (
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/pkg/api"
)

// A self-hosted Breeze server running on Caddy's internal CA (or any
// self-signed certificate) that the endpoint does not trust must produce an
// actionable "trust the CA" message — not the generic "server unreachable,
// check firewall and DNS" that sends the admin chasing the network (#4979).

func TestClassifyEnrollError_UntrustedCertificate_RealTLSServer(t *testing.T) {
	// httptest.NewTLSServer serves a self-signed certificate that is NOT in
	// the system trust store — exactly the self-host-with-internal-CA case.
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("request reached the handler — certificate verification was skipped")
	}))
	defer srv.Close()

	client := api.NewClient(srv.URL, "", "")
	_, err := client.Enroll(&api.EnrollRequest{EnrollmentKey: "k", Hostname: "h"})
	if err == nil {
		t.Fatal("Enroll against an untrusted self-signed server succeeded; certificate verification must never be skipped")
	}

	cat, friendly := classifyEnrollError(err, srv.URL)
	if cat != catNetwork {
		t.Errorf("category = %v, want catNetwork (exit code must stay 10 for already-shipped MSI log parsing)", cat)
	}
	if strings.Contains(friendly, "check firewall") {
		t.Errorf("friendly = %q — a certificate trust failure must not be reported as a firewall/DNS problem", friendly)
	}
	for _, want := range []string{"not trusted", "root certificate", srv.URL, "docs.breezermm.com/deploy/tls/"} {
		if !strings.Contains(friendly, want) {
			t.Errorf("friendly = %q, missing %q", friendly, want)
		}
	}
}

func TestRedeemBootstrapToken_UntrustedCertificateHint(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("bootstrap token reached an unverified server")
	}))
	defer srv.Close()

	_, err := redeemBootstrapToken(srv.URL, "ABCDE12345")
	if err == nil {
		t.Fatal("redeem against an untrusted self-signed server succeeded; certificate verification must never be skipped")
	}
	hint, ok := certVerificationHint(err, srv.URL)
	if !ok {
		t.Fatalf("certVerificationHint did not recognise %v as a certificate failure", err)
	}
	if !strings.Contains(hint, "not trusted") {
		t.Errorf("hint = %q, want the untrusted-CA message", hint)
	}
}

func TestCertVerificationHint_Kinds(t *testing.T) {
	wrap := func(e error) error {
		return fmt.Errorf("failed to send request: %w", &url.Error{Op: "Post", URL: "https://rmm.lan", Err: e})
	}
	tests := []struct {
		name string
		err  error
		ok   bool
		want string
	}{
		{"unknown authority", wrap(x509.UnknownAuthorityError{}), true, "not trusted"},
		{"hostname mismatch", wrap(x509.HostnameError{Host: "rmm.lan", Certificate: &x509.Certificate{}}), true, "does not match"},
		{"expired", wrap(x509.CertificateInvalidError{Reason: x509.Expired, Cert: &x509.Certificate{}}), true, "is not valid"},
		{"plain dial error", wrap(errors.New("dial tcp: connection refused")), false, ""},
		{"nil", nil, false, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := certVerificationHint(tc.err, "https://rmm.lan")
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v (hint %q)", ok, tc.ok, got)
			}
			if tc.ok && !strings.Contains(got, tc.want) {
				t.Errorf("hint = %q, want it to contain %q", got, tc.want)
			}
			if tc.ok && !strings.Contains(got, "https://rmm.lan") {
				t.Errorf("hint = %q, should echo the server URL", got)
			}
		})
	}
}

// The MSI's BootstrapEnroll custom action is a plain EXE action: Windows
// Installer shows only "a program run as part of the setup did not finish"
// and does not capture the agent's stderr. The redeem failure must therefore
// land in the durable sinks an admin can find (enroll-last-error.txt and the
// Windows Event Log), carrying the certificate hint (#4979).
func TestRunBootstrap_UntrustedCertificate_RecordsHintInDurableSinks(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("bootstrap token reached an unverified server")
	}))
	defer srv.Close()

	dir := t.TempDir()
	origCfg, origData, origQuiet := cfgFile, bootstrapInstallData, quietEnroll
	t.Cleanup(func() { cfgFile, bootstrapInstallData, quietEnroll = origCfg, origData, origQuiet })
	cfgFile, quietEnroll = filepath.Join(dir, "agent.yaml"), true
	bootstrapInstallData = `C:\dl\breeze-agent.msi|TESTTOKEN1|` + srv.URL

	lastErr, eventMsg := stubBootstrapFailureSinks(t)

	exitCode := -1
	origExit := osExit
	osExit = func(code int) { exitCode = code }
	t.Cleanup(func() { osExit = origExit })

	runBootstrap()

	if exitCode != 1 {
		t.Errorf("exit code = %d, want 1 (hard fail so the MSI rolls back)", exitCode)
	}
	for name, got := range map[string]string{"enroll-last-error.txt": *lastErr, "event log": *eventMsg} {
		if !strings.Contains(got, "not trusted by this machine") {
			t.Errorf("%s = %q, want the untrusted-certificate hint", name, got)
		}
	}
}

// stubBootstrapFailureSinks captures reportBootstrapFailure's durable sinks so
// tests neither write the real enroll-last-error.txt nor the Windows Event Log.
func stubBootstrapFailureSinks(t *testing.T) (lastErr, eventMsg *string) {
	t.Helper()
	var le, em string
	origWrite, origEvent := writeLastErrorFile, eventLogError
	writeLastErrorFile = func(line string) { le = line }
	eventLogError = func(_, message string) { em = message }
	t.Cleanup(func() { writeLastErrorFile, eventLogError = origWrite, origEvent })
	return &le, &em
}
