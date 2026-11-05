package authenticode

import "testing"

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
