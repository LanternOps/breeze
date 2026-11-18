package heartbeat

import (
	"encoding/base64"
	"testing"
	"time"
)

// The isolate command is decoded strictly. A release-token build must accept
// the fields the server sends at capability releaseToken (#10102), and still
// refuse a field it does not know.
func TestContainmentPayloadAcceptsReleaseTokenFields(t *testing.T) {
	now := time.Now()
	key := make([]byte, 32)
	key[0], key[31] = 0x5a, 0x11
	p := containmentPayload(now)
	q := p["parameters"].(map[string]any)
	q["releaseTokenPublicKey"] = base64.StdEncoding.EncodeToString(key)
	q["releaseTokenDeviceId"] = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
	q["requireSignedReleaseToken"] = true
	if err := validateContainmentPayload(p, "https://control.example.test", now); err != nil {
		t.Fatalf("release-token fields refused: %v", err)
	}
	q["releaseTokenKeyId"] = "k1"
	if validateContainmentPayload(p, "https://control.example.test", now) == nil {
		t.Fatal("an unknown field was accepted")
	}
}
