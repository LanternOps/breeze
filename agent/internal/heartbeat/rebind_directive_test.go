package heartbeat

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

// Cross-language vector pinned in apps/api/src/services/deviceReattach/
// rebindDirective.test.ts (#8318 wave 1b-2): Ed25519 seed bytes 1..32 (the
// identity assertion's seed, identityTestPrivateKey), these canonical lines,
// and the signature the TypeScript signer produced (Ed25519 is
// deterministic).
const (
	rebindGoldenIntent    = "00000000-0000-4000-8000-0000000000a1"
	rebindGoldenDevice    = "00000000-0000-4000-8000-000000000004"
	rebindGoldenOrg       = "00000000-0000-4000-8000-000000000001"
	rebindGoldenSite      = "00000000-0000-4000-8000-000000000003"
	rebindGoldenNonce     = "0123456789abcdef0123456789abcdef"
	rebindGoldenExpiresAt = "2026-10-09T19:15:00Z"
	rebindGoldenSignature = "ZQ6AjOV4eLvuSx4kBzwByFeCYBe38VTpclN5DYfmEbtiaSlHAqJ86OjyQrPJIf7WSgLCFileFEYqs9kwYwigDg=="
)

var rebindGoldenSource = strings.Repeat("b", 64)

// Before the golden directive's expiresAt.
var rebindGoldenNow = time.Date(2026, 10, 9, 19, 0, 0, 0, time.UTC)

func goldenRebindDirective() *RebindDirective {
	return &RebindDirective{
		IntentID:       rebindGoldenIntent,
		Nonce:          rebindGoldenNonce,
		TargetDeviceID: rebindGoldenDevice,
		TargetOrgID:    rebindGoldenOrg,
		TargetSiteID:   rebindGoldenSite,
		ExpiresAt:      rebindGoldenExpiresAt,
		KeyID:          identityTestKeyID,
		Signature:      rebindGoldenSignature,
	}
}

// signRebindTestDirective signs d for sourceAgentID with the vector key.
func signRebindTestDirective(t *testing.T, d *RebindDirective, sourceAgentID string) *RebindDirective {
	t.Helper()
	canonical, err := rebindCanonicalBytes(d, sourceAgentID)
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	d.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(identityTestPrivateKey(), canonical))
	return d
}

func TestRebindCanonicalBytesMatchTypeScript(t *testing.T) {
	got, err := rebindCanonicalBytes(goldenRebindDirective(), rebindGoldenSource)
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{
		"breeze-agent-rebind-v1",
		rebindGoldenIntent,
		rebindGoldenSource,
		rebindGoldenDevice,
		rebindGoldenOrg,
		rebindGoldenSite,
		rebindGoldenNonce,
		rebindGoldenExpiresAt,
		identityTestKeyID,
	}, "\n")
	if string(got) != want {
		t.Fatalf("canonical bytes\n got %q\nwant %q", got, want)
	}
	if len(got) != 316 {
		t.Fatalf("canonical bytes are %d long, want the hand-off's 316", len(got))
	}
	if strings.HasSuffix(string(got), "\n") {
		t.Fatal("canonical bytes end with a newline")
	}
	if pub := base64.StdEncoding.EncodeToString(identityTestPrivateKey().Public().(ed25519.PublicKey)); pub != identityTestPubB64 {
		t.Fatalf("test seed derives %s, not the pinned vector key", pub)
	}
}

// The Go verifier accepts exactly the signature the TypeScript signer made,
// and only for the source agent id it was signed over (not on the wire).
func TestVerifyRebindDirectiveAcceptsTheTypeScriptSignature(t *testing.T) {
	if err := verifyRebindDirective(goldenRebindDirective(), rebindGoldenSource, identityTestPinned(), rebindGoldenNow); err != nil {
		t.Fatalf("TypeScript-signed directive rejected: %v", err)
	}
	err := verifyRebindDirective(goldenRebindDirective(), strings.Repeat("c", 64), identityTestPinned(), rebindGoldenNow)
	if err == nil {
		t.Fatal("the golden signature verified for another install's agent id")
	}
}

func TestVerifyRebindDirectiveRefusals(t *testing.T) {
	otherKey := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	cases := []struct {
		name   string
		mutate func(*RebindDirective) *RebindDirective
		source string
		pinned []string
		now    time.Time
		is     error
	}{
		{name: "unpinned key id", mutate: func(d *RebindDirective) *RebindDirective { d.KeyID = "deploy-2026-10-09-ffffffff"; return d }, is: errDiagKeyNotPinned},
		{name: "nothing pinned", pinned: []string{}, is: errDiagKeyNotPinned},
		{name: "signature by another key", mutate: func(d *RebindDirective) *RebindDirective {
			canonical, _ := rebindCanonicalBytes(d, rebindGoldenSource)
			d.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(otherKey, canonical))
			return d
		}},
		{name: "a signed field changed", mutate: func(d *RebindDirective) *RebindDirective {
			d.TargetOrgID = "00000000-0000-4000-8000-000000000002"
			return d
		}},
		{name: "expired at its second", now: time.Date(2026, 10, 9, 19, 15, 0, 0, time.UTC), is: errRebindDirectiveExpired},
		{name: "expired", now: time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC), is: errRebindDirectiveExpired},
		{name: "target device not a UUID", mutate: func(d *RebindDirective) *RebindDirective {
			d.TargetDeviceID = "device-4"
			return signRebindTestDirective(t, d, rebindGoldenSource)
		}},
		{name: "intent not a UUID", mutate: func(d *RebindDirective) *RebindDirective {
			d.IntentID = "intent-a1"
			return signRebindTestDirective(t, d, rebindGoldenSource)
		}},
		{name: "expiresAt with milliseconds", mutate: func(d *RebindDirective) *RebindDirective {
			d.ExpiresAt = "2026-10-09T19:15:00.000Z"
			return signRebindTestDirective(t, d, rebindGoldenSource)
		}},
		{name: "control character in a field", mutate: func(d *RebindDirective) *RebindDirective { d.Nonce = "0123\n4567"; return d }},
		{name: "DEL in a field", mutate: func(d *RebindDirective) *RebindDirective { d.KeyID = "deploy\x7f"; return d }},
		{name: "empty field", mutate: func(d *RebindDirective) *RebindDirective { d.TargetSiteID = ""; return d }},
		{name: "empty source agent id", source: "-"},
		{name: "signature not base64", mutate: func(d *RebindDirective) *RebindDirective { d.Signature = "%%%"; return d }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := goldenRebindDirective()
			if tc.mutate != nil {
				d = tc.mutate(d)
			}
			source := rebindGoldenSource
			if tc.source == "-" {
				source = ""
			}
			pinned := identityTestPinned()
			if tc.pinned != nil {
				pinned = tc.pinned
			}
			now := rebindGoldenNow
			if !tc.now.IsZero() {
				now = tc.now
			}
			err := verifyRebindDirective(d, source, pinned, now)
			if err == nil {
				t.Fatal("directive accepted")
			}
			if tc.is != nil && !errors.Is(err, tc.is) {
				t.Fatalf("error = %v, want %v", err, tc.is)
			}
		})
	}
}

// A directive the agent signs here with the vector key verifies too, so the
// flow tests below can mint directives for any intent.
func TestSignRebindTestDirectiveRoundTrips(t *testing.T) {
	d := goldenRebindDirective()
	d.IntentID = "00000000-0000-4000-8000-0000000000b2"
	signRebindTestDirective(t, d, rebindGoldenSource)
	if err := verifyRebindDirective(d, rebindGoldenSource, identityTestPinned(), rebindGoldenNow); err != nil {
		t.Fatal(err)
	}
}
