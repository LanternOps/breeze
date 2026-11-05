package authenticode

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"math/big"
	"testing"
	"time"
)

var oidCN = asn1.ObjectIdentifier{2, 5, 4, 3}

func certWithSubject(t *testing.T, names ...pkix.AttributeTypeAndValue) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{ExtraNames: names},
		NotBefore:    time.Unix(1_700_000_000, 0),
		NotAfter:     time.Unix(1_900_000_000, 0),
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func TestSignerFromDERReadsTheCommonName(t *testing.T) {
	der := certWithSubject(t,
		pkix.AttributeTypeAndValue{Type: asn1.ObjectIdentifier{2, 5, 4, 10}, Value: "Some Other Org"},
		pkix.AttributeTypeAndValue{Type: oidCN, Value: "Dell Inc."},
	)
	signer, err := signerFromDER(der)
	if err != nil {
		t.Fatalf("signerFromDER: %v", err)
	}
	if signer.Subject != "Dell Inc." {
		t.Fatalf("Subject = %q, want the CN and nothing else", signer.Subject)
	}
	if signer.ThumbprintSHA256 != thumbprintSHA256(der) {
		t.Fatalf("ThumbprintSHA256 = %q", signer.ThumbprintSHA256)
	}
}

// Each of these could make a certificate read as a publisher it does not name,
// so the signer is refused rather than guessed at.
func TestSignerFromDERFailsClosed(t *testing.T) {
	tests := []struct {
		name string
		der  []byte
	}{
		{"not a certificate", []byte("not der")},
		{"empty", nil},
		{"no common name", certWithSubject(t, pkix.AttributeTypeAndValue{Type: asn1.ObjectIdentifier{2, 5, 4, 10}, Value: "Dell Inc."})},
		{"empty common name", certWithSubject(t, pkix.AttributeTypeAndValue{Type: oidCN, Value: ""})},
		{"two common names", certWithSubject(t,
			pkix.AttributeTypeAndValue{Type: oidCN, Value: "Dell Inc."},
			pkix.AttributeTypeAndValue{Type: oidCN, Value: "Evil Corp"},
		)},
		{"NUL inside the common name", certWithSubject(t, pkix.AttributeTypeAndValue{Type: oidCN, Value: "Dell Inc.\x00.evil.example"})},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			signer, err := signerFromDER(tt.der)
			if err == nil {
				t.Fatalf("signerFromDER accepted it as %+v", signer)
			}
			if signer != (Signer{}) {
				t.Fatalf("a refused certificate must not name a signer, got %+v", signer)
			}
		})
	}
}

func TestPublisherAllowed(t *testing.T) {
	tests := []struct {
		name    string
		subject string
		allowed []string
		want    bool
	}{
		{"exact match", "Dell Inc.", []string{"Dell Inc."}, true},
		{"match anywhere in the list", "HP Inc.", []string{"Dell Inc.", "HP Inc."}, true},
		{"missing trailing dot is a different publisher", "Dell Inc", []string{"Dell Inc."}, false},
		{"extra trailing dot is a different publisher", "Dell Inc.", []string{"Dell Inc"}, false},
		{"allowed name as a prefix of the subject", "Dell Inc Evil", []string{"Dell Inc"}, false},
		{"subject as a substring of the allowed name", "Dell", []string{"Dell Inc."}, false},
		{"case differs", "DELL INC.", []string{"Dell Inc."}, false},
		{"surrounding whitespace differs", " Dell Inc. ", []string{"Dell Inc."}, false},
		{"empty allowlist", "Dell Inc.", []string{}, false},
		{"nil allowlist", "Dell Inc.", nil, false},
		{"empty subject", "", []string{"Dell Inc."}, false},
		{"empty subject never matches an empty allowlist entry", "", []string{""}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := PublisherAllowed(Signer{Subject: tt.subject}, tt.allowed); got != tt.want {
				t.Fatalf("PublisherAllowed(%q, %q) = %v, want %v", tt.subject, tt.allowed, got, tt.want)
			}
		})
	}
}

// The thumbprint identifies a certificate in logs and results, so its shape is
// part of what consumers compare against.
func TestThumbprintIsLowercaseHexOfTheCertificate(t *testing.T) {
	// SHA-256 of the three bytes "abc" (FIPS 180-2 test vector).
	const want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got := thumbprintSHA256([]byte("abc")); got != want {
		t.Fatalf("thumbprintSHA256 = %q, want %q", got, want)
	}
}
