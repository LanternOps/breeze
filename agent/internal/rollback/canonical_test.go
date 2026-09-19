package rollback

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestCanonicalBytesMatchesControllerGolden(t *testing.T) {
	var fixture struct {
		Directive       Directive `json:"directive"`
		PublicKeyB64    string    `json:"publicKeyB64"`
		CanonicalSHA256 string    `json:"canonicalSha256"`
	}
	payload, err := os.ReadFile("testdata/agent-rollback-directive-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload, &fixture); err != nil {
		t.Fatal(err)
	}
	canonical, err := CanonicalBytes(fixture.Directive)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(canonical)
	if got := hex.EncodeToString(digest[:]); got != fixture.CanonicalSHA256 {
		t.Fatalf("canonical digest = %s, want %s", got, fixture.CanonicalSHA256)
	}
	key, _ := base64.StdEncoding.DecodeString(fixture.PublicKeyB64)
	signature, _ := base64.StdEncoding.DecodeString(fixture.Directive.DirectiveSignature)
	if !ed25519.Verify(key, canonical, signature) {
		t.Fatal("controller golden signature did not verify")
	}
}
