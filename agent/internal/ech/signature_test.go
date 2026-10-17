package ech

import (
	"crypto/tls"
	"io"
	"net/url"
	"testing"
)

func TestIsFilterSignature_PlaintextHTTP(t *testing.T) {
	err := &url.Error{Op: "Get", URL: "https://example.test", Err: tls.RecordHeaderError{
		RecordHeader: [5]byte{'H', 'T', 'T', 'P', '/'},
	}}
	if !IsFilterSignature(err) {
		t.Fatal("expected plaintext HTTP record header to be a filter signature")
	}
}

func TestIsFilterSignature_OtherRecordHeader(t *testing.T) {
	err := &url.Error{Err: tls.RecordHeaderError{RecordHeader: [5]byte{'S', 'S', 'H', '-', '2'}}}
	if IsFilterSignature(err) {
		t.Fatal("non-HTTP record header must not be a filter signature")
	}
}

func TestIsFilterSignature_NilAndUnrelated(t *testing.T) {
	for _, err := range []error{nil, io.EOF, &tls.CertificateVerificationError{}} {
		if IsFilterSignature(err) {
			t.Fatalf("IsFilterSignature(%v) = true, want false", err)
		}
	}
}

func TestIsFilterSignature_RealListener(t *testing.T) {
	addr, _ := startFilterListener(t)
	_, err := tls.Dial("tcp", addr, &tls.Config{ServerName: "example.test", InsecureSkipVerify: true})
	if err == nil {
		t.Fatal("expected TLS dial error")
	}
	if !IsFilterSignature(err) {
		t.Fatalf("IsFilterSignature(%T %v) = false, want true", err, err)
	}
}
