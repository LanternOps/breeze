//go:build windows

package authenticode

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestVerifyRefusesAPathWithEmbeddedNUL(t *testing.T) {
	if err := VerifyChain("bad\x00path"); err == nil {
		t.Fatal("VerifyChain accepted an embedded NUL")
	}
	if _, err := Verify("bad\x00path"); err == nil {
		t.Fatal("Verify accepted an embedded NUL")
	}
}

func TestVerifyRefusesAnUnsignedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unsigned.exe")
	if err := os.WriteFile(path, []byte("MZ not a signed binary"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyChain(path); err == nil {
		t.Fatal("VerifyChain accepted an unsigned file")
	}
	signer, err := Verify(path)
	if err == nil {
		t.Fatal("Verify accepted an unsigned file")
	}
	if signer != (Signer{}) {
		t.Fatalf("a refused file must not name a signer, got %+v", signer)
	}
}

// The only test that exercises the provider-data walk against a real signature.
// PowerShell 7 ships embedded-signed by Microsoft on hosted Windows runners;
// skipped where it is not installed rather than depending on a specific image.
func TestVerifyReadsTheLeafSigner(t *testing.T) {
	path := filepath.Join(os.Getenv("ProgramFiles"), "PowerShell", "7", "pwsh.exe")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("no embedded-signed binary to verify: %v", err)
	}
	signer, err := Verify(path)
	if err != nil {
		t.Fatalf("Verify(%s): %v", path, err)
	}
	if signer.Subject != "Microsoft Corporation" {
		t.Fatalf("Subject = %q, want the leaf CN %q", signer.Subject, "Microsoft Corporation")
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(signer.ThumbprintSHA256) {
		t.Fatalf("ThumbprintSHA256 = %q, want 64 lowercase hex characters", signer.ThumbprintSHA256)
	}
	if !PublisherAllowed(signer, []string{"Microsoft Corporation"}) {
		t.Fatal("the signer that just verified must match its own pinned name")
	}
	if PublisherAllowed(signer, []string{"Dell Inc."}) {
		t.Fatal("a Microsoft signature must not satisfy a Dell pin")
	}
}
