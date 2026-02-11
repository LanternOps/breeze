package mtls

import (
	"crypto/tls"
	"fmt"
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
