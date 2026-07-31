package mtls

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("mtls")

// LoadClientCert parses a PEM-encoded certificate and private key pair.
func LoadClientCert(certPEM, keyPEM string) (*tls.Certificate, error) {
	cert, err := tls.X509KeyPair([]byte(certPEM), []byte(keyPEM))
	if err != nil {
		return nil, fmt.Errorf("failed to parse mTLS key pair: %w", err)
	}
	return &cert, nil
}

// BuildTLSConfig returns a TLS config with the client certificate loaded.
// Returns nil if certPEM or keyPEM is empty.
func BuildTLSConfig(certPEM, keyPEM string) (*tls.Config, error) {
	if certPEM == "" || keyPEM == "" {
		return nil, nil
	}

	cert, err := LoadClientCert(certPEM, keyPEM)
	if err != nil {
		return nil, err
	}

	return &tls.Config{
		Certificates: []tls.Certificate{*cert},
		MinVersion:   tls.VersionTLS12,
	}, nil
}

// parseExpiryTime parses an expiry timestamp in RFC 3339 or ISO 8601 format.
func parseExpiryTime(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		// Try ISO 8601 without timezone offset (literal Z or bare)
		t, err = time.Parse("2006-01-02T15:04:05", s)
	}
	return t, err
}

// IsExpired checks if the cert has passed its expiry time.
// Returns false for empty strings (no cert configured).
// Fails closed: returns true for unparseable dates so the agent attempts renewal.
func IsExpired(expiresStr string) bool {
	if expiresStr == "" {
		return false
	}
	t, err := parseExpiryTime(expiresStr)
	if err != nil {
		log.Warn("unable to parse mTLS cert expiry, treating as expired for safety",
			"expires", expiresStr, "error", err)
		return true
	}
	return time.Now().After(t)
}

// ExpiresWithin reports whether the cert expires inside the given lead time
// (or has already expired). Returns false for an empty string (no cert
// configured) and, like IsExpired, fails closed to true on an unparseable
// date so the agent attempts renewal rather than silently running to expiry.
//
// Used by the agent's self-initiated renewal path (Wave 5 final review, I2):
// an agent must not depend solely on the server's `renewCert` heartbeat signal
// to learn it needs a new certificate, because in `enforce` an expired
// certificate causes the heartbeat itself to be denied and the signal can
// never arrive.
func ExpiresWithin(expiresStr string, lead time.Duration) bool {
	if expiresStr == "" {
		return false
	}
	t, err := parseExpiryTime(expiresStr)
	if err != nil {
		log.Warn("unable to parse mTLS cert expiry, treating as due for renewal for safety",
			"expires", expiresStr, "error", err)
		return true
	}
	return time.Now().Add(lead).After(t)
}

// NeedsRenewal checks if the cert has passed 2/3 of its lifetime.
// Returns false if either timestamp is empty or unparseable.
func NeedsRenewal(issuedStr, expiresStr string) bool {
	if issuedStr == "" || expiresStr == "" {
		return false
	}
	issued, err := parseExpiryTime(issuedStr)
	if err != nil {
		return false
	}
	expires, err := parseExpiryTime(expiresStr)
	if err != nil {
		return false
	}

	lifetime := expires.Sub(issued)
	threshold := issued.Add(lifetime * 2 / 3)
	return time.Now().After(threshold)
}

// ParseExpiryTime is the exported form of parseExpiryTime, for callers
// (security remediation Wave 5 Task 5's two-phase mTLS renewal) that need the
// actual time.Time — e.g. to compare against a server-issued
// activationExpiresAt deadline — rather than just IsExpired's boolean.
func ParseExpiryTime(s string) (time.Time, error) {
	return parseExpiryTime(s)
}

// CertificateNotAfter parses a single PEM-encoded leaf certificate and
// returns its X.509 NotAfter (true validity expiry). Used at mTLS renewal
// promotion time to derive the newly-active certificate's expiry directly
// from the certificate body itself, rather than requiring a fifth persisted
// field to survive a crash between staging and promotion — the pending
// certificate PEM is already durably on disk, and NotAfter is recoverable
// from it deterministically.
func CertificateNotAfter(certPEM string) (time.Time, error) {
	block, _ := pem.Decode([]byte(certPEM))
	if block == nil {
		return time.Time{}, fmt.Errorf("failed to decode PEM certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return time.Time{}, fmt.Errorf("failed to parse certificate: %w", err)
	}
	return cert.NotAfter, nil
}

// RenewalProofCanonicalPrefix must match RENEWAL_PROOF_CANONICAL_PREFIX in
// apps/api/src/services/mtlsRenewalProof.ts byte-for-byte.
const RenewalProofCanonicalPrefix = "breeze-mtls-renew-v1"

// BuildRenewalProofCanonicalBytes reproduces the API's canonical signed byte
// sequence for expired-certificate mTLS renewal recovery
// (buildRenewalProofCanonicalBytes in mtlsRenewalProof.ts):
//
//	['breeze-mtls-renew-v1', deviceId, challengeId, String(expiresUnix)].join('\n')
//
// encoded as UTF-8. deviceId is the server's devices.id (the value the
// /renew-cert/challenge and /renew-cert/confirm routes key the challenge on),
// NOT the agent's own agentId.
func BuildRenewalProofCanonicalBytes(deviceID, challengeID string, expiresUnix int64) []byte {
	return []byte(strings.Join(
		[]string{RenewalProofCanonicalPrefix, deviceID, challengeID, strconv.FormatInt(expiresUnix, 10)},
		"\n",
	))
}

// SignRenewalProof signs the canonical renewal-recovery challenge bytes with
// keyPEM (the OLD/current certificate's private key — proof of possession of
// the certificate being replaced), returning the base64-encoded signature the
// API expects in recoveryProof.signatureBase64.
//
// Encodings are chosen to match node:crypto's verify('sha256', ...) defaults
// exactly (see mtlsRenewalProof.ts): an ECDSA (P-256) key signs the SHA-256
// digest as an ASN.1 DER signature; an RSA key signs it PKCS#1 v1.5. Any
// other key type is rejected rather than guessed at.
//
// SECURITY: never log keyPEM, the signature, or the canonical bytes — callers
// must treat both the argument and the return value as sensitive.
func SignRenewalProof(keyPEM, deviceID, challengeID string, expiresUnix int64) (string, error) {
	block, _ := pem.Decode([]byte(keyPEM))
	if block == nil {
		return "", fmt.Errorf("failed to decode PEM private key")
	}

	priv, err := parsePrivateKeyBlock(block)
	if err != nil {
		return "", err
	}

	digest := sha256.Sum256(BuildRenewalProofCanonicalBytes(deviceID, challengeID, expiresUnix))

	var sig []byte
	switch key := priv.(type) {
	case *ecdsa.PrivateKey:
		sig, err = ecdsa.SignASN1(rand.Reader, key, digest[:])
	case *rsa.PrivateKey:
		sig, err = rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	default:
		return "", fmt.Errorf("unsupported private key type %T for renewal proof", priv)
	}
	if err != nil {
		return "", fmt.Errorf("failed to sign renewal proof: %w", err)
	}

	return base64.StdEncoding.EncodeToString(sig), nil
}

// parsePrivateKeyBlock parses a PEM block holding an RSA or ECDSA private key
// in any of the three encodings Go/OpenSSL commonly produce (PKCS#1, PKCS#8,
// SEC1/EC), mirroring what crypto/tls.X509KeyPair accepts internally (that
// logic isn't exported, so it's reimplemented narrowly here for signing).
func parsePrivateKeyBlock(block *pem.Block) (any, error) {
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	if key, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		switch key.(type) {
		case *rsa.PrivateKey, *ecdsa.PrivateKey:
			return key, nil
		default:
			return nil, fmt.Errorf("unsupported PKCS8 private key type %T", key)
		}
	}
	return nil, fmt.Errorf("unable to parse private key: unrecognized format")
}
