package ech

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"
)

var evT0 = time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)

func TestParsePlaintextReply_Comcast302(t *testing.T) {
	reply := "HTTP/1.1 302 Found\r\nLocation: https://warn.filter-a.example/warn.html?url=http://cp.example/&token=abc\r\nContent-Length: 0\r\n\r\n"
	got := plaintextEvidence([]byte(reply), evT0)
	want := BlockEvidence{Kind: BlockWebFilter, HTTPStatus: 302, LocationHost: "warn.filter-a.example", SeenAt: evT0}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParsePlaintextReply_Spectrum302(t *testing.T) {
	reply := "HTTP/1.1 302 Found\r\nLocation: https://block.filter-b.example/warn.html?url=http://cp.example/&token=abc\r\nConnection: close\r\n\r\n"
	got := plaintextEvidence([]byte(reply), evT0)
	want := BlockEvidence{Kind: BlockWebFilter, HTTPStatus: 302, LocationHost: "block.filter-b.example", SeenAt: evT0}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParsePlaintextReply_511IsCaptivePortal(t *testing.T) {
	reply := "HTTP/1.1 511 Network Authentication Required\r\nContent-Length: 0\r\n\r\n"
	got := plaintextEvidence([]byte(reply), evT0)
	if got.Kind != BlockCaptivePortal || got.HTTPStatus != 511 || got.LocationHost != "" {
		t.Fatalf("got %+v, want captive_portal 511", got)
	}
}

func TestParsePlaintextReply_RedactsLocation(t *testing.T) {
	reply := "HTTP/1.1 302 Found\r\nLocation: https://User:pw@WARN.Filter.EXAMPLE:8443/p/a?token=x#f\r\n\r\n"
	got := plaintextEvidence([]byte(reply), evT0)
	if got.LocationHost != "warn.filter.example" {
		t.Fatalf("LocationHost = %q, want warn.filter.example", got.LocationHost)
	}
	all := fmt.Sprintf("%+v", got)
	for _, secret := range []string{"token", "pw", "/p/a", "User", "8443"} {
		if strings.Contains(all, secret) {
			t.Fatalf("evidence %s leaks %q", all, secret)
		}
	}
}

func TestParsePlaintextReply_Unparseable(t *testing.T) {
	cases := map[string]string{
		"header only":     "HTTP/",
		"garbage status":  "HTTP/1.1 abc Nope\r\n\r\n",
		"truncated":       "HTTP/1.1 302",
		"status too high": "HTTP/1.1 999 Nope\r\n\r\n",
	}
	for name, reply := range cases {
		t.Run(name, func(t *testing.T) {
			got := plaintextEvidence([]byte(reply), evT0)
			if got.Kind != BlockPlaintextUnknown || got.HTTPStatus != 0 || got.LocationHost != "" {
				t.Fatalf("got %+v, want plaintext_unknown with no status/host", got)
			}
			if !got.SeenAt.Equal(evT0) {
				t.Fatalf("SeenAt = %v", got.SeenAt)
			}
		})
	}
	t.Run("relative location", func(t *testing.T) {
		got := plaintextEvidence([]byte("HTTP/1.1 302 Found\r\nLocation: /warn?token=x\r\n\r\n"), evT0)
		if got.Kind != BlockWebFilter || got.HTTPStatus != 302 || got.LocationHost != "" {
			t.Fatalf("got %+v, want web_filter 302 with no host", got)
		}
	})
	t.Run("bad host chars", func(t *testing.T) {
		got := plaintextEvidence([]byte("HTTP/1.1 302 Found\r\nLocation: https://bad_host!.example/\r\n\r\n"), evT0)
		if got.LocationHost != "" {
			t.Fatalf("LocationHost = %q, want dropped", got.LocationHost)
		}
	})
}

func TestBlockKind_PlaintextSignature(t *testing.T) {
	for k, want := range map[BlockKind]bool{
		BlockWebFilter: true, BlockCaptivePortal: true, BlockPlaintextUnknown: true,
		BlockUntrustedCertificate: false, "": false,
	} {
		if got := k.PlaintextSignature(); got != want {
			t.Errorf("%q.PlaintextSignature() = %v, want %v", k, got, want)
		}
	}
}

func TestSanitizeHost(t *testing.T) {
	for in, want := range map[string]string{
		"CP.Example":             "cp.example",
		"cp.example:443":         "cp.example",
		" cp.example ":           "cp.example",
		"cp.example.":            "cp.example",
		"":                       "",
		"bad host.example":       "",
		"-lead.example":          "",
		"[::1]:443":              "",
		strings.Repeat("a", 254): "",
		"10.0.0.1":               "10.0.0.1",
	} {
		if got := SanitizeHost(in); got != want {
			t.Errorf("SanitizeHost(%q) = %q, want %q", in, got, want)
		}
	}
}

// selfSignedCert returns a self-signed leaf with the given issuer/subject.
func selfSignedCert(t *testing.T, subject pkix.Name, notAfter time.Time) *x509.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(7),
		Subject:      subject,
		NotBefore:    notAfter.Add(-48 * time.Hour),
		NotAfter:     notAfter,
		DNSNames:     []string{"cp.example"},
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// verifyErr runs a real verification of leaf and wraps the result the way
// crypto/tls does.
func verifyErr(t *testing.T, leaf *x509.Certificate, dnsName string, at time.Time) error {
	t.Helper()
	_, err := leaf.Verify(x509.VerifyOptions{DNSName: dnsName, Roots: x509.NewCertPool(), CurrentTime: at})
	if err == nil {
		t.Fatal("verify unexpectedly succeeded")
	}
	return fmt.Errorf("tls dial: %w", &tls.CertificateVerificationError{UnverifiedCertificates: []*x509.Certificate{leaf}, Err: err})
}

func TestCertEvidence_UnknownAuthority(t *testing.T) {
	leaf := selfSignedCert(t, pkix.Name{Organization: []string{"Example Inspect CA"}, CommonName: "ignored"}, time.Now().Add(24*time.Hour))
	err := verifyErr(t, leaf, "cp.example", time.Now())
	var uae x509.UnknownAuthorityError
	if !errors.As(err, &uae) {
		t.Fatalf("precondition: err %v is not UnknownAuthorityError", err)
	}
	got, ok := certEvidence(err, evT0)
	if !ok {
		t.Fatal("certEvidence ok = false, want true")
	}
	want := BlockEvidence{Kind: BlockUntrustedCertificate, CertIssuer: "Example Inspect CA", SeenAt: evT0}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}

	t.Run("common name fallback", func(t *testing.T) {
		leaf := selfSignedCert(t, pkix.Name{CommonName: "Example Root"}, time.Now().Add(24*time.Hour))
		got, ok := certEvidence(verifyErr(t, leaf, "cp.example", time.Now()), evT0)
		if !ok || got.CertIssuer != "Example Root" {
			t.Fatalf("got %+v ok=%v, want issuer Example Root", got, ok)
		}
	})
	t.Run("bare UnknownAuthorityError", func(t *testing.T) {
		got, ok := certEvidence(x509.UnknownAuthorityError{Cert: leaf}, evT0)
		if !ok || got.CertIssuer != "Example Inspect CA" {
			t.Fatalf("got %+v ok=%v", got, ok)
		}
	})
	t.Run("hostname error is not evidence", func(t *testing.T) {
		if _, ok := certEvidence(verifyErr(t, leaf, "other.example", time.Now()), evT0); ok {
			t.Fatal("HostnameError reported as evidence")
		}
	})
	t.Run("expired is not evidence", func(t *testing.T) {
		if _, ok := certEvidence(verifyErr(t, leaf, "cp.example", time.Now().Add(72*time.Hour)), evT0); ok {
			t.Fatal("expired certificate reported as evidence")
		}
	})
	t.Run("unrelated error", func(t *testing.T) {
		if _, ok := certEvidence(errors.New("connection reset"), evT0); ok {
			t.Fatal("plain error reported as evidence")
		}
		if _, ok := certEvidence(nil, evT0); ok {
			t.Fatal("nil reported as evidence")
		}
	})
	t.Run("issuer sanitized", func(t *testing.T) {
		leaf := selfSignedCert(t, pkix.Name{Organization: []string{"  Exämple\x07 CA  "}}, time.Now().Add(24*time.Hour))
		got, ok := certEvidence(verifyErr(t, leaf, "cp.example", time.Now()), evT0)
		if !ok || got.CertIssuer != "Exmple CA" {
			t.Fatalf("got %q ok=%v, want %q", got.CertIssuer, ok, "Exmple CA")
		}
		long := selfSignedCert(t, pkix.Name{Organization: []string{strings.Repeat("A", 80)}}, time.Now().Add(24*time.Hour))
		got, ok = certEvidence(verifyErr(t, long, "cp.example", time.Now()), evT0)
		if !ok || len(got.CertIssuer) != 64 {
			t.Fatalf("issuer %q (len %d), want 64 chars", got.CertIssuer, len(got.CertIssuer))
		}
		blank := selfSignedCert(t, pkix.Name{Organization: []string{"éé"}}, time.Now().Add(24*time.Hour))
		got, ok = certEvidence(verifyErr(t, blank, "cp.example", time.Now()), evT0)
		if !ok || got.CertIssuer != "" {
			t.Fatalf("issuer %q ok=%v, want kind kept with issuer dropped", got.CertIssuer, ok)
		}
	})
}

func TestErrorEvidence(t *testing.T) {
	sig := fmt.Errorf("post: %w", tls.RecordHeaderError{Msg: "first record does not look like a TLS handshake", RecordHeader: [5]byte{'H', 'T', 'T', 'P', '/'}})
	got, ok := ErrorEvidence(sig, evT0)
	if !ok || got.Kind != BlockPlaintextUnknown || !got.SeenAt.Equal(evT0) {
		t.Fatalf("signature: got %+v ok=%v, want plaintext_unknown", got, ok)
	}
	leaf := selfSignedCert(t, pkix.Name{Organization: []string{"Example Inspect CA"}}, time.Now().Add(24*time.Hour))
	got, ok = ErrorEvidence(verifyErr(t, leaf, "cp.example", time.Now()), evT0)
	if !ok || got.Kind != BlockUntrustedCertificate {
		t.Fatalf("cert: got %+v ok=%v", got, ok)
	}
	if _, ok := ErrorEvidence(errors.New("i/o timeout"), evT0); ok {
		t.Fatal("timeout reported as evidence")
	}
}
