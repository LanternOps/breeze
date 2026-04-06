package mtls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"testing"
	"time"
)

// generateTestCert creates a self-signed PEM certificate and key for testing.
func generateTestCert(t *testing.T, notBefore, notAfter time.Time) (certPEM, keyPEM string) {
	t.Helper()

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test-agent"},
		NotBefore:    notBefore,
		NotAfter:     notAfter,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("failed to create certificate: %v", err)
	}

	certBlock := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})

	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		t.Fatalf("failed to marshal key: %v", err)
	}
	keyBlock := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	return string(certBlock), string(keyBlock)
}

// ---------- LoadClientCert ----------

func TestLoadClientCertValid(t *testing.T) {
	certPEM, keyPEM := generateTestCert(t, time.Now().Add(-1*time.Hour), time.Now().Add(1*time.Hour))

	cert, err := LoadClientCert(certPEM, keyPEM)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cert == nil {
		t.Fatal("expected non-nil certificate")
	}
}

func TestLoadClientCertInvalidPEM(t *testing.T) {
	tests := []struct {
		name    string
		cert    string
		key     string
	}{
		{"empty cert", "", "not-a-key"},
		{"empty key", "not-a-cert", ""},
		{"both empty", "", ""},
		{"garbage cert", "garbage-data", "garbage-key"},
		{"valid cert invalid key", "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----", "bad-key"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := LoadClientCert(tt.cert, tt.key)
			if err == nil {
				t.Fatal("expected error for invalid PEM data")
			}
		})
	}
}

func TestLoadClientCertMismatchedKeyPair(t *testing.T) {
	cert1, _ := generateTestCert(t, time.Now().Add(-1*time.Hour), time.Now().Add(1*time.Hour))
	_, key2 := generateTestCert(t, time.Now().Add(-1*time.Hour), time.Now().Add(1*time.Hour))

	_, err := LoadClientCert(cert1, key2)
	if err == nil {
		t.Fatal("expected error for mismatched cert/key pair")
	}
}

// ---------- BuildTLSConfig ----------

func TestBuildTLSConfigValid(t *testing.T) {
	certPEM, keyPEM := generateTestCert(t, time.Now().Add(-1*time.Hour), time.Now().Add(1*time.Hour))

	cfg, err := BuildTLSConfig(certPEM, keyPEM)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected non-nil TLS config")
	}
	if len(cfg.Certificates) != 1 {
		t.Fatalf("expected 1 certificate, got %d", len(cfg.Certificates))
	}
	if cfg.MinVersion != tls.VersionTLS12 {
		t.Fatalf("MinVersion = %d, want %d (TLS 1.2)", cfg.MinVersion, tls.VersionTLS12)
	}
}

func TestBuildTLSConfigEmptyCertReturnsNil(t *testing.T) {
	tests := []struct {
		name string
		cert string
		key  string
	}{
		{"both empty", "", ""},
		{"cert empty", "", "some-key"},
		{"key empty", "some-cert", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := BuildTLSConfig(tt.cert, tt.key)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if cfg != nil {
				t.Fatal("expected nil TLS config for empty cert/key")
			}
		})
	}
}

func TestBuildTLSConfigInvalidCert(t *testing.T) {
	cfg, err := BuildTLSConfig("bad-cert", "bad-key")
	if err == nil {
		t.Fatal("expected error for invalid cert data")
	}
	if cfg != nil {
		t.Fatal("expected nil config on error")
	}
}

// ---------- parseExpiryTime ----------

func TestParseExpiryTimeRFC3339(t *testing.T) {
	input := "2026-06-15T12:30:00Z"
	got, err := parseExpiryTime(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Year() != 2026 || got.Month() != 6 || got.Day() != 15 {
		t.Fatalf("parsed time = %v, expected 2026-06-15", got)
	}
	if got.Hour() != 12 || got.Minute() != 30 {
		t.Fatalf("parsed time = %v, expected 12:30", got)
	}
}

func TestParseExpiryTimeRFC3339WithOffset(t *testing.T) {
	input := "2026-06-15T12:30:00+05:00"
	got, err := parseExpiryTime(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Year() != 2026 {
		t.Fatalf("parsed year = %d, expected 2026", got.Year())
	}
}

func TestParseExpiryTimeISO8601WithoutTZ(t *testing.T) {
	input := "2026-06-15T12:30:00"
	got, err := parseExpiryTime(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Year() != 2026 || got.Month() != 6 || got.Day() != 15 {
		t.Fatalf("parsed time = %v, expected 2026-06-15", got)
	}
}

func TestParseExpiryTimeInvalidFormat(t *testing.T) {
	tests := []string{
		"not-a-date",
		"2026/06/15",
		"June 15, 2026",
		"1234567890",
		"",
	}
	for _, input := range tests {
		t.Run(input, func(t *testing.T) {
			_, err := parseExpiryTime(input)
			if err == nil {
				t.Fatalf("expected error for input %q", input)
			}
		})
	}
}

// ---------- IsExpired ----------

func TestIsExpiredEmptyReturnsFalse(t *testing.T) {
	if IsExpired("") {
		t.Fatal("IsExpired(\"\") should return false")
	}
}

func TestIsExpiredFutureDate(t *testing.T) {
	future := time.Now().Add(24 * time.Hour).Format(time.RFC3339)
	if IsExpired(future) {
		t.Fatalf("IsExpired(%q) should return false for future date", future)
	}
}

func TestIsExpiredPastDate(t *testing.T) {
	past := time.Now().Add(-24 * time.Hour).Format(time.RFC3339)
	if !IsExpired(past) {
		t.Fatalf("IsExpired(%q) should return true for past date", past)
	}
}

func TestIsExpiredUnparseableReturnsTrueFailClosed(t *testing.T) {
	// Per docs: "Fails closed: returns true for unparseable dates"
	if !IsExpired("not-a-date") {
		t.Fatal("IsExpired should return true for unparseable date (fail closed)")
	}
}

func TestIsExpiredISO8601WithoutTZ(t *testing.T) {
	future := time.Now().Add(24 * time.Hour).Format("2006-01-02T15:04:05")
	if IsExpired(future) {
		t.Fatalf("IsExpired(%q) should return false for future ISO 8601 date", future)
	}
}

// ---------- NeedsRenewal ----------

func TestNeedsRenewalEmptyStringsReturnFalse(t *testing.T) {
	tests := []struct {
		name    string
		issued  string
		expires string
	}{
		{"both empty", "", ""},
		{"issued empty", "", "2026-12-31T00:00:00Z"},
		{"expires empty", "2026-01-01T00:00:00Z", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if NeedsRenewal(tt.issued, tt.expires) {
				t.Fatal("NeedsRenewal should return false for empty strings")
			}
		})
	}
}

func TestNeedsRenewalBeforeThreshold(t *testing.T) {
	// Issued 1 hour ago, expires in 5 hours (6 hour lifetime)
	// 2/3 threshold at 4 hours from issue = 3 hours from now
	// We're at 1 hour into the lifetime = before threshold
	issued := time.Now().Add(-1 * time.Hour).Format(time.RFC3339)
	expires := time.Now().Add(5 * time.Hour).Format(time.RFC3339)

	if NeedsRenewal(issued, expires) {
		t.Fatal("should not need renewal before 2/3 threshold")
	}
}

func TestNeedsRenewalAfterThreshold(t *testing.T) {
	// Issued 3 hours ago, expires in 1 hour (4 hour lifetime)
	// 2/3 threshold at ~2h40m from issue = ~20 min ago
	// We're past the threshold
	issued := time.Now().Add(-3 * time.Hour).Format(time.RFC3339)
	expires := time.Now().Add(1 * time.Hour).Format(time.RFC3339)

	if !NeedsRenewal(issued, expires) {
		t.Fatal("should need renewal after 2/3 threshold")
	}
}

func TestNeedsRenewalExpiredCert(t *testing.T) {
	// Cert that's already expired
	issued := time.Now().Add(-48 * time.Hour).Format(time.RFC3339)
	expires := time.Now().Add(-24 * time.Hour).Format(time.RFC3339)

	if !NeedsRenewal(issued, expires) {
		t.Fatal("should need renewal for expired cert")
	}
}

func TestNeedsRenewalUnparseableIssuedReturnsFalse(t *testing.T) {
	if NeedsRenewal("bad-date", "2026-12-31T00:00:00Z") {
		t.Fatal("should return false for unparseable issued date")
	}
}

func TestNeedsRenewalUnparseableExpiresReturnsFalse(t *testing.T) {
	if NeedsRenewal("2026-01-01T00:00:00Z", "bad-date") {
		t.Fatal("should return false for unparseable expires date")
	}
}

func TestNeedsRenewalISO8601WithoutTZ(t *testing.T) {
	issued := time.Now().Add(-3 * time.Hour).Format("2006-01-02T15:04:05")
	expires := time.Now().Add(1 * time.Hour).Format("2006-01-02T15:04:05")

	if !NeedsRenewal(issued, expires) {
		t.Fatal("should need renewal with ISO 8601 timestamps after 2/3 threshold")
	}
}

func TestNeedsRenewalExactlyAtThreshold(t *testing.T) {
	// 3 hour lifetime, 2/3 = 2 hours from issue
	// Set issued exactly 2 hours ago, expires in 1 hour
	issued := time.Now().Add(-2 * time.Hour)
	expires := issued.Add(3 * time.Hour)

	// time.Now() is at the threshold or very slightly after;
	// the function uses After (strict >), so at exactly the threshold it would be false,
	// but with any clock skew it could be true. We just verify it does not panic.
	_ = NeedsRenewal(issued.Format(time.RFC3339), expires.Format(time.RFC3339))
}

func TestNeedsRenewalBrandNewCert(t *testing.T) {
	// Just issued, expires far in the future
	issued := time.Now().Format(time.RFC3339)
	expires := time.Now().Add(365 * 24 * time.Hour).Format(time.RFC3339)

	if NeedsRenewal(issued, expires) {
		t.Fatal("should not need renewal for brand new cert")
	}
}
