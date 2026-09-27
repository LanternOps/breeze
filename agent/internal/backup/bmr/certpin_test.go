package bmr

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"math/big"
	"testing"
	"time"
)

// testChain is a real, self-contained CA + leaf pair built with
// crypto/x509, plus the DER bytes and SPKI pin for each, so tests can
// exercise verifyPinnedServerCert against an actual verified chain
// (as tls.Config.VerifyPeerCertificate would build it) rather than an
// arbitrary list of unrelated certificates.
type testChain struct {
	caCert, leafCert     *x509.Certificate
	caDER, leafDER       []byte
	caPinB64, leafPinB64 string
	verifiedChain        []*x509.Certificate // leaf, then CA — as Go's chain builder orders it
}

func spkiPin(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return base64.StdEncoding.EncodeToString(sum[:])
}

// newTestChain generates a fresh, self-signed CA and a leaf certificate
// actually issued (signed) by that CA, and returns everything needed to
// exercise verifyPinnedServerCert with a real verified chain.
func newTestChain(t *testing.T, commonName string) testChain {
	t.Helper()

	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate CA key: %v", err)
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: commonName + " CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("create CA certificate: %v", err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatalf("parse CA certificate: %v", err)
	}

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate leaf key: %v", err)
	}
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTmpl, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("create leaf certificate signed by CA: %v", err)
	}
	leafCert, err := x509.ParseCertificate(leafDER)
	if err != nil {
		t.Fatalf("parse leaf certificate: %v", err)
	}

	return testChain{
		caCert:        caCert,
		leafCert:      leafCert,
		caDER:         caDER,
		leafDER:       leafDER,
		caPinB64:      spkiPin(caCert),
		leafPinB64:    spkiPin(leafCert),
		verifiedChain: []*x509.Certificate{leafCert, caCert},
	}
}

func TestVerifyPinnedServerCert_NoPinConfiguredAllowsAnyCert(t *testing.T) {
	SetExpectedServerCertPin("")
	chain := newTestChain(t, "no-pin.example")
	if err := verifyPinnedServerCert([][]byte{chain.leafDER}, [][]*x509.Certificate{chain.verifiedChain}); err != nil {
		t.Fatalf("expected no error with no pin configured, got %v", err)
	}
}

// TestVerifyPinnedServerCert_MatchesIntermediateNotJustLeaf: a valid,
// verified chain whose pinned certificate is the issuing intermediate
// (not the leaf) must be accepted — pinning the intermediate/CA (which
// rotates far less often than a leaf) is the recommended, rotation-
// resilient use of --trust-pin.
func TestVerifyPinnedServerCert_MatchesIntermediateNotJustLeaf(t *testing.T) {
	chain := newTestChain(t, "pinned-intermediate.example")
	SetExpectedServerCertPin(chain.caPinB64)
	t.Cleanup(func() { SetExpectedServerCertPin("") })

	if err := verifyPinnedServerCert([][]byte{chain.leafDER}, [][]*x509.Certificate{chain.verifiedChain}); err != nil {
		t.Fatalf("expected a pin matching the verified chain's intermediate to succeed, got %v", err)
	}
}

// TestVerifyPinnedServerCert_PinMatchesLeafOfValidChain: a pin naming the
// leaf certificate of an otherwise-valid, verified chain must be
// accepted.
func TestVerifyPinnedServerCert_PinMatchesLeafOfValidChain(t *testing.T) {
	chain := newTestChain(t, "pinned-leaf.example")
	SetExpectedServerCertPin(chain.leafPinB64)
	t.Cleanup(func() { SetExpectedServerCertPin("") })

	if err := verifyPinnedServerCert([][]byte{chain.leafDER}, [][]*x509.Certificate{chain.verifiedChain}); err != nil {
		t.Fatalf("expected a pin matching the verified chain's leaf to succeed, got %v", err)
	}
}

// TestVerifyPinnedServerCert_NoPinnedCertInChainFailsClosed: a valid,
// verified chain that contains no certificate matching any configured
// pin must be refused.
func TestVerifyPinnedServerCert_NoPinnedCertInChainFailsClosed(t *testing.T) {
	chain := newTestChain(t, "unpinned.example")
	unrelated := newTestChain(t, "unrelated.example")
	SetExpectedServerCertPin(unrelated.leafPinB64)
	t.Cleanup(func() { SetExpectedServerCertPin("") })

	err := verifyPinnedServerCert([][]byte{chain.leafDER}, [][]*x509.Certificate{chain.verifiedChain})
	if err == nil {
		t.Fatal("expected a verified chain with no pinned certificate to be refused, got nil error")
	}
}

// TestVerifyPinnedServerCert_UnrelatedCertAppendedToRawListIsRejected: an
// unrelated certificate that is present in the peer-supplied, unverified
// rawCerts list (any server can append extra certificates there) must NOT
// cause acceptance just because its SPKI matches a configured pin. Only certificates Go's own chain verification actually
// placed in verifiedChains may satisfy a pin. Here the real, valid chain
// carries no pinned certificate, but the raw list also carries a second,
// wholly unrelated certificate (never verified, not part of any chain)
// whose SPKI does match the configured pin — this must still be refused.
func TestVerifyPinnedServerCert_UnrelatedCertAppendedToRawListIsRejected(t *testing.T) {
	chain := newTestChain(t, "real-chain.example")
	unrelated := newTestChain(t, "appended-unrelated.example")
	SetExpectedServerCertPin(unrelated.leafPinB64)
	t.Cleanup(func() { SetExpectedServerCertPin("") })

	// rawCerts: the real leaf plus an unrelated cert appended to the raw,
	// unverified peer list. verifiedChains: only the real, actually-
	// verified chain (the unrelated cert was never verified into any
	// chain, since it doesn't chain to anything real).
	rawCerts := [][]byte{chain.leafDER, unrelated.leafDER}
	verifiedChains := [][]*x509.Certificate{chain.verifiedChain}

	err := verifyPinnedServerCert(rawCerts, verifiedChains)
	if err == nil {
		t.Fatal("expected a pin matching only an unrelated raw (unverified) certificate to be refused, got nil error")
	}
}

// TestVerifyPinnedServerCert_NoVerifiedChainFailsClosed: with a pin
// configured, an empty verifiedChains (e.g. because normal certificate
// verification did not run, or found nothing) must fail closed rather
// than fall back to trusting anything in the raw peer list.
func TestVerifyPinnedServerCert_NoVerifiedChainFailsClosed(t *testing.T) {
	chain := newTestChain(t, "no-verified-chain.example")
	SetExpectedServerCertPin(chain.leafPinB64)
	t.Cleanup(func() { SetExpectedServerCertPin("") })

	err := verifyPinnedServerCert([][]byte{chain.leafDER}, nil)
	if err == nil {
		t.Fatal("expected an empty verified-chain list to be refused when a pin is configured")
	}
}

// TestVerifyPinnedServerCert_PinSetSupportsRotationOverlap proves a
// single --trust-pin value can carry a comma-separated SET of pins, so an
// operator can pin both the outgoing and incoming certificate during a
// planned rotation window instead of every existing recovery bundle
// breaking the instant the server rotates.
func TestVerifyPinnedServerCert_PinSetSupportsRotationOverlap(t *testing.T) {
	oldChain := newTestChain(t, "old.example")
	newChain := newTestChain(t, "new.example")
	SetExpectedServerCertPin(oldChain.leafPinB64 + "," + newChain.leafPinB64)
	t.Cleanup(func() { SetExpectedServerCertPin("") })

	if err := verifyPinnedServerCert([][]byte{oldChain.leafDER}, [][]*x509.Certificate{oldChain.verifiedChain}); err != nil {
		t.Fatalf("expected the still-valid old pin to match, got %v", err)
	}
	if err := verifyPinnedServerCert([][]byte{newChain.leafDER}, [][]*x509.Certificate{newChain.verifiedChain}); err != nil {
		t.Fatalf("expected the new pin to match after rotation, got %v", err)
	}
}
