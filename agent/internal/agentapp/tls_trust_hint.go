package agentapp

import (
	"crypto/x509"
	"errors"
	"fmt"
)

// tlsTrustDocsURL documents how to trust a self-hosted server's private /
// self-signed CA on endpoints (Windows, macOS, Linux).
const tlsTrustDocsURL = "https://docs.breezermm.com/deploy/tls/#trusting-the-internal-ca-on-agents"

// certVerificationHint reports whether err is (or wraps) a TLS server
// certificate verification failure and, if so, returns an actionable message
// naming the fix.
//
// The agent verifies the server certificate against the operating system's
// trust store and never offers a way to skip that check — a self-hosted server
// on a self-signed or private-CA certificate works once that CA's root is
// installed in the machine trust store. Without this classification such a
// failure surfaced as "server unreachable — check firewall, DNS", which sent
// admins chasing the network instead of the certificate (#4979).
//
// Go's crypto/tls wraps these as *tls.CertificateVerificationError, which
// unwraps to the x509 error types matched below on every platform (on Windows
// the chain is built by CertGetCertificateChain and mapped onto the same types).
func certVerificationHint(err error, serverURL string) (string, bool) {
	if err == nil {
		return "", false
	}

	var unknownAuth x509.UnknownAuthorityError
	if errors.As(err, &unknownAuth) {
		return fmt.Sprintf(
			"the TLS certificate presented by %s is not trusted by this machine — it is self-signed or issued by a private CA. "+
				"Install that CA's root certificate into this machine's trusted root store (Windows: Local Machine \\ Trusted Root Certification Authorities) and retry; "+
				"see %s. The agent never skips certificate verification",
			serverURL, tlsTrustDocsURL), true
	}

	var hostErr x509.HostnameError
	if errors.As(err, &hostErr) {
		return fmt.Sprintf(
			"the TLS certificate presented by %s does not match that host name — the server URL must use a name the certificate covers (%v)",
			serverURL, hostErr), true
	}

	var invalidErr x509.CertificateInvalidError
	if errors.As(err, &invalidErr) {
		return fmt.Sprintf(
			"the TLS certificate presented by %s is not valid (%v) — renew or replace the server certificate and check this machine's clock",
			serverURL, invalidErr), true
	}

	var rootsErr x509.SystemRootsError
	if errors.As(err, &rootsErr) {
		return fmt.Sprintf(
			"this machine could not load its trusted root certificates to verify %s (%v)",
			serverURL, rootsErr), true
	}

	return "", false
}
