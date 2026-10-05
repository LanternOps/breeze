package bmr

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
)

// expectedServerCertPins are the base64 SHA-256 SubjectPublicKeyInfo (SPKI)
// hashes this recovery media was pinned to, set once at console startup
// from a value baked into the recovery media at build time (see
// agent/cmd/breeze-backup/recovery_console_cmd.go and
// agent/recovery-media/build.sh's --trust-pin flag). Empty means "no pin
// configured" — every BMR HTTP client falls back to ordinary TLS
// certificate-chain validation only, exactly as before this existed.
//
// A single --trust-pin value may itself be a comma-separated LIST of
// pins, so an operator can pin a whole set at once (e.g. the outgoing and
// incoming intermediate CA during a planned rotation window, or a leaf
// pin alongside its issuer as a fallback). verifyPinnedServerCert checks
// every certificate the server presents (leaf AND any intermediates it
// sends — not the root, which servers don't normally send) against every
// configured pin, so pinning the SPKI of the issuing intermediate or root
// CA (which rotates far less often than a leaf certificate, typically
// every 60-90 days on a Let's Encrypt-style setup) is the recommended,
// rotation-resilient choice; --trust-pin's own flag help says so.
//
// This is deliberately package-level, not threaded through every call, so
// that newHTTPClient() (the one client every BMR request in this package
// goes through — authenticate, exchange, progress, completion) picks it up
// without every call site needing to know about it.
var (
	expectedServerCertPinsMu sync.RWMutex
	expectedServerCertPins   []string
)

// SetExpectedServerCertPin pins the recovery server's expected
// certificate(s). pinB64 is one base64-encoded SHA-256 SPKI hash, or
// several separated by commas (matches `openssl x509 -pubkey -noout -in
// cert.pem | openssl pkey -pubin -outform der | openssl dgst -sha256
// -binary | openssl base64`, run against the leaf, an intermediate, or a
// root — any certificate in the chain the server will present). An empty
// string clears the pin set (no enforcement).
//
// Calling this does not itself change behavior until a request actually
// runs through newHTTPClient()'s TLS handshake — set it once, early, before
// any BMR HTTP call is made.
func SetExpectedServerCertPin(pinB64 string) {
	expectedServerCertPinsMu.Lock()
	defer expectedServerCertPinsMu.Unlock()
	expectedServerCertPins = parseCertPins(pinB64)
}

func parseCertPins(raw string) []string {
	var pins []string
	for _, p := range strings.Split(raw, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			pins = append(pins, p)
		}
	}
	return pins
}

func currentExpectedServerCertPins() []string {
	expectedServerCertPinsMu.RLock()
	defer expectedServerCertPinsMu.RUnlock()
	return expectedServerCertPins
}

// verifyPinnedServerCert is a tls.Config.VerifyPeerCertificate callback. It
// runs IN ADDITION TO normal certificate-chain verification (this package
// never sets InsecureSkipVerify, so Go always populates verifiedChains
// before calling this), so a pin mismatch is one more way for the
// handshake to fail closed — it never loosens the default trust-store
// check, only tightens it when a pin has been configured.
//
// The pin is checked ONLY against verifiedChains — the chain(s) Go's own
// certificate verification already built and validated up to a trusted
// root — never against rawCerts, which is the peer-supplied, UNVERIFIED
// list of certificates exactly as the server sent them on the wire. A
// server (or an on-path host terminating TLS with its own
// certificate) can append arbitrary extra certificates to that raw list;
// none of them chain to anything unless Go's verifier says so, so
// matching a pin against rawCerts would let an unrelated, non-issuing
// certificate that merely happens to match a configured pin wrongly
// authorize a connection to a host it has nothing to do with. Checking
// verifiedChains instead means a match can only come from a certificate
// Go itself placed on an actually-verified path.
//
// Every certificate in every verified chain (leaf and each issuer up to
// the trusted root) is checked against every configured pin; the
// handshake proceeds if ANY certificate in ANY verified chain matches ANY
// pin. This is what makes pinning an intermediate or root SPKI (rather
// than only the leaf) work, and what makes a pin SET (a comma-separated
// --trust-pin) useful across a rotation window.
//
// Fails closed: any error here (no verified chain at all, or nothing in
// any verified chain matching any configured pin) aborts the handshake.
// If no pin was ever configured (the common case today, until recovery
// media build tooling is updated to bake one in — see the fixer record),
// this is a no-op and behavior is unchanged from before this existed.
func verifyPinnedServerCert(_ [][]byte, verifiedChains [][]*x509.Certificate) error {
	pins := currentExpectedServerCertPins()
	if len(pins) == 0 {
		return nil
	}
	if len(verifiedChains) == 0 {
		return fmt.Errorf("%w: no verified certificate chain to check against the pinned recovery-media fingerprint(s) — refusing connection", ErrServerCertPinMismatch)
	}
	for _, chain := range verifiedChains {
		for _, cert := range chain {
			sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
			got := base64.StdEncoding.EncodeToString(sum[:])
			for _, pin := range pins {
				if got == pin {
					return nil
				}
			}
		}
	}
	return fmt.Errorf("%w: no certificate in the server's verified chain matches the fingerprint(s) baked into this recovery media — refusing connection", ErrServerCertPinMismatch)
}
