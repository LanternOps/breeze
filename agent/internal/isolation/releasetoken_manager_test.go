package isolation

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

const tokenDevice = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

// testTokenKey is a generated TEST key derived from a public string.
func testTokenKey(label string) ed25519.PrivateKey {
	seed := sha256.Sum256([]byte("breeze release token manager test key " + label))
	return ed25519.NewKeyFromSeed(seed[:])
}

func signTestToken(priv ed25519.PrivateKey, payload string) string {
	p := base64.RawURLEncoding.EncodeToString([]byte(payload))
	sig := ed25519.Sign(priv, []byte(releaseTokenDomain+p))
	return p + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func mintTestToken(priv ed25519.PrivateKey, id string, gen int, dev string, nbf, exp time.Time) string {
	return signTestToken(priv, fmt.Sprintf(`{"v":1,"iid":"%s","gen":%d,"dev":"%s","nbf":%d,"exp":%d}`, id, gen, dev, nbf.Unix(), exp.Unix()))
}

func (h *harness) goodToken(priv ed25519.PrivateKey, gen int) string {
	now := h.clock.Now()
	return mintTestToken(priv, idA, gen, tokenDevice, now.Add(-time.Minute), now.Add(2*time.Hour))
}

func pubB64(priv ed25519.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))
}

// tokenPayload is the isolate command for an agent the server pinned a key for.
func (h *harness) tokenPayload(id string, gen int, priv ed25519.PrivateKey, required bool) map[string]any {
	p := h.payload(id, gen, 72*time.Hour)
	params(p)["releaseTokenPublicKey"] = pubB64(priv)
	params(p)["releaseTokenDeviceId"] = tokenDevice
	if required {
		params(p)["requireSignedReleaseToken"] = true
	}
	return p
}

func (h *harness) mustIsolateWithToken(priv ed25519.PrivateKey, required bool) {
	h.t.Helper()
	out := h.m.HandleIsolate(context.Background(), h.tokenPayload(idA, 1, priv, required))
	if out.Failed() || out.Result == nil || out.Result.State != StateVerified {
		h.t.Fatalf("isolate with token key: %+v (result %+v)", out, out.Result)
	}
}

func (h *harness) tokenDesired(gen int, priv ed25519.PrivateKey, required bool) *DesiredBlock {
	d := h.desired(idA, gen, DesiredIsolated, 72*time.Hour, true)
	d.NetworkIsolation.ReleaseTokenPublicKey = priv.Public().(ed25519.PublicKey)
	d.NetworkIsolation.ReleaseTokenDeviceID = tokenDevice
	d.NetworkIsolation.RequireSignedReleaseToken = required
	return d
}

func countEvents(j *journal.Journal, typ string) (n int, details []string) {
	for _, e := range j.Events {
		if e.Type == typ {
			n++
			details = append(details, e.Detail)
		}
	}
	return n, details
}

func TestManagerReleaseTokenReleasesLocally(t *testing.T) {
	h := newHarness(t)
	key := testTokenKey("a")
	h.mustIsolateWithToken(key, false)
	j := h.journal()
	if string(j.Episode.ReleaseTokenPublicKey) != string(key.Public().(ed25519.PublicKey)) || j.Episode.ReleaseTokenDeviceID != tokenDevice {
		t.Fatalf("key not pinned at apply: %+v", j.Episode)
	}
	if err := h.m.LocalReleaseToken(context.Background(), h.goodToken(key, 1)); err != nil {
		t.Fatalf("LocalReleaseToken: %v", err)
	}
	j = h.journal()
	if j.Episode.State != StateReleasedLocally || j.Episode.ReleaseKind != ReleaseLocalCode {
		t.Fatalf("state %q kind %q", j.Episode.State, j.Episode.ReleaseKind)
	}
	if n, _ := countEvents(j, "release_token_accepted"); n != 1 || !containsStr(eventTypes(j), "released_local_code") {
		t.Fatalf("events %v", eventTypes(j))
	}
	if installed, _, _ := h.iso.state(); installed {
		t.Fatal("rules still installed")
	}
	// The same token cannot be used again: the episode it names has ended.
	if err := h.m.LocalReleaseToken(context.Background(), h.goodToken(key, 1)); !errors.Is(err, ErrNoActiveIsolation) {
		t.Fatalf("replay: err = %v, want ErrNoActiveIsolation", err)
	}
}

func TestManagerReleaseTokenRefusalsKeepIsolation(t *testing.T) {
	key, other := testTokenKey("a"), testTokenKey("b")
	cases := []struct {
		name   string
		token  func(h *harness) string
		reason string
	}{
		{"wrong key", func(h *harness) string { return h.goodToken(other, 1) }, ReleaseTokenBadSignature},
		{"wrong generation", func(h *harness) string { return h.goodToken(key, 2) }, ReleaseTokenWrongGeneration},
		{"wrong episode", func(h *harness) string {
			now := h.clock.Now()
			return mintTestToken(key, idB, 1, tokenDevice, now.Add(-time.Minute), now.Add(time.Hour))
		}, ReleaseTokenWrongEpisode},
		{"wrong device", func(h *harness) string {
			now := h.clock.Now()
			return mintTestToken(key, idA, 1, "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e", now.Add(-time.Minute), now.Add(time.Hour))
		}, ReleaseTokenWrongDevice},
		{"expired", func(h *harness) string {
			now := h.clock.Now()
			return mintTestToken(key, idA, 1, tokenDevice, now.Add(-3*time.Hour), now.Add(-time.Second))
		}, ReleaseTokenExpired},
		{"tampered", func(h *harness) string {
			good := []byte(h.goodToken(key, 1))
			i := len(good) - 20 // inside the signature
			if good[i] == 'B' {
				good[i] = 'C'
			} else {
				good[i] = 'B'
			}
			return string(good)
		}, ReleaseTokenBadSignature},
		{"garbage", func(*harness) string { return "not-a-token" }, ReleaseTokenMalformed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.mustIsolateWithToken(key, false)
			err := h.m.LocalReleaseToken(context.Background(), tc.token(h))
			if !errors.Is(err, ErrReleaseTokenInvalid) || ReleaseTokenRejectReason(err) != tc.reason {
				t.Fatalf("err = %v, want reason %q", err, tc.reason)
			}
			if !h.m.Active() {
				t.Fatal("a refused token released the isolation")
			}
			if installed, _, _ := h.iso.state(); !installed {
				t.Fatal("rules removed")
			}
			if n, details := countEvents(h.journal(), "release_token_rejected"); n != 1 || details[0] != tc.reason {
				t.Fatalf("rejection journal: %d %v", n, details)
			}
		})
	}
}

func TestManagerReleaseTokenWithoutPinnedKey(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1) // the server sent no key: tokens are not available
	err := h.m.LocalReleaseToken(context.Background(), h.goodToken(testTokenKey("a"), 1))
	if ReleaseTokenRejectReason(err) != ReleaseTokenUnavailable {
		t.Fatalf("err = %v, want reason unavailable", err)
	}
	if !h.m.Active() {
		t.Fatal("released without a pinned key")
	}
}

func TestManagerRequireSignedReleaseTokenRefusesCode(t *testing.T) {
	h := newHarness(t)
	key := testTokenKey("a")
	h.mustIsolateWithToken(key, true)
	code := codeAt(t, h, h.clock.Now(), 1)
	if err := h.m.LocalRelease(context.Background(), code, false); !errors.Is(err, ErrReleaseTokenRequired) {
		t.Fatalf("code: err = %v, want ErrReleaseTokenRequired", err)
	}
	if !h.m.Active() {
		t.Fatal("a refused code released the isolation")
	}
	if len(h.journal().BreakGlassAttempts) != 0 {
		t.Fatal("a refused code consumed a break-glass attempt")
	}
	if err := h.m.LocalReleaseToken(context.Background(), h.goodToken(key, 1)); err != nil {
		t.Fatalf("token refused while required: %v", err)
	}
}

func TestManagerRequireSignedReleaseTokenStillAllowsForce(t *testing.T) {
	h := newHarness(t)
	h.mustIsolateWithToken(testTokenKey("a"), true)
	if err := h.m.LocalRelease(context.Background(), "", true); err != nil {
		t.Fatalf("--force: %v", err)
	}
	if h.journal().Episode.ReleaseKind != ReleaseLocalForced {
		t.Fatal("not recorded as forced")
	}
}

func TestManagerCodeStillWorksWhenTokenNotRequired(t *testing.T) {
	h := newHarness(t)
	h.mustIsolateWithToken(testTokenKey("a"), false)
	if err := h.m.LocalRelease(context.Background(), codeAt(t, h, h.clock.Now(), 1), false); err != nil {
		t.Fatalf("code refused: %v", err)
	}
}

// The pinned key is journalled, so it survives an agent restart or upgrade
// (a new binary reading the same journal) and a journal rewrite.
func TestManagerPinnedReleaseTokenKeySurvivesUpgrade(t *testing.T) {
	h := newHarness(t)
	key := testTokenKey("a")
	h.mustIsolateWithToken(key, true)
	path := filepath.Join(h.dir, journal.FileName)
	j, err := journal.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := journal.Save(path, j); err != nil {
		t.Fatal(err)
	}
	h.m = h.newManager()
	h.m.Startup(context.Background())
	if err := h.m.LocalRelease(context.Background(), codeAt(t, h, h.clock.Now(), 1), false); !errors.Is(err, ErrReleaseTokenRequired) {
		t.Fatalf("requirement lost across restart: %v", err)
	}
	if err := h.m.LocalReleaseToken(context.Background(), h.goodToken(key, 1)); err != nil {
		t.Fatalf("token after restart: %v", err)
	}
}

// A later block for the same episode never replaces the pinned key or the
// requirement, not even at a new generation.
func TestManagerPinnedReleaseTokenKeyIsNotReplaced(t *testing.T) {
	h := newHarness(t)
	key, other := testTokenKey("a"), testTokenKey("b")
	h.mustIsolateWithToken(key, true)
	h.m.Reconcile(context.Background(), h.tokenDesired(1, other, false))
	h.m.Reconcile(context.Background(), h.tokenDesired(2, other, false))
	j := h.journal()
	if j.Episode.Generation != 2 {
		t.Fatalf("extend not applied: generation %d", j.Episode.Generation)
	}
	if string(j.Episode.ReleaseTokenPublicKey) != string(key.Public().(ed25519.PublicKey)) || !j.Episode.RequireSignedReleaseToken {
		t.Fatal("pinned key or requirement replaced")
	}
	if err := h.m.LocalReleaseToken(context.Background(), h.goodToken(other, 2)); ReleaseTokenRejectReason(err) != ReleaseTokenBadSignature {
		t.Fatalf("token under the replacement key: %v", err)
	}
	if err := h.m.LocalReleaseToken(context.Background(), h.goodToken(key, 1)); ReleaseTokenRejectReason(err) != ReleaseTokenWrongGeneration {
		t.Fatalf("token for the old generation: %v", err)
	}
	if err := h.m.LocalReleaseToken(context.Background(), h.goodToken(key, 2)); err != nil {
		t.Fatalf("token for the current generation: %v", err)
	}
}

// An episode first applied without a key takes one from a later heartbeat
// block for the same episode, as it does a late break-glass secret.
func TestManagerReleaseTokenKeyPinnedLateFromHeartbeat(t *testing.T) {
	h := newHarness(t)
	key := testTokenKey("a")
	h.mustIsolate(idA, 1)
	h.m.Reconcile(context.Background(), h.tokenDesired(1, key, true))
	j := h.journal()
	if string(j.Episode.ReleaseTokenPublicKey) != string(key.Public().(ed25519.PublicKey)) || !j.Episode.RequireSignedReleaseToken || j.Episode.ReleaseTokenDeviceID != tokenDevice {
		t.Fatalf("late key not pinned: %+v", j.Episode)
	}
	if n, _ := countEvents(j, "release_token_key_pinned"); n != 1 {
		t.Fatalf("events %v", eventTypes(j))
	}
	if h.iso.applies != 1 {
		t.Fatal("pinning the key re-applied the rules")
	}
	h.m.Reconcile(context.Background(), h.tokenDesired(1, key, true))
	if n, _ := countEvents(h.journal(), "release_token_key_pinned"); n != 1 {
		t.Fatal("a repeated block pinned again")
	}
}

func TestManagerRejectsMalformedReleaseTokenFields(t *testing.T) {
	small := make([]byte, 32)
	small[0] = 1 // the identity point: small order
	cases := map[string]func(p map[string]any){
		"key without device": func(p map[string]any) { delete(params(p), "releaseTokenDeviceId") },
		"device without key": func(p map[string]any) { delete(params(p), "releaseTokenPublicKey") },
		"required without key": func(p map[string]any) {
			delete(params(p), "releaseTokenPublicKey")
			delete(params(p), "releaseTokenDeviceId")
		},
		"short key": func(p map[string]any) {
			params(p)["releaseTokenPublicKey"] = base64.StdEncoding.EncodeToString(make([]byte, 31))
		},
		"small-order key":   func(p map[string]any) { params(p)["releaseTokenPublicKey"] = base64.StdEncoding.EncodeToString(small) },
		"device not uuid":   func(p map[string]any) { params(p)["releaseTokenDeviceId"] = "device-1" },
		"key not base64":    func(p map[string]any) { params(p)["releaseTokenPublicKey"] = "!!!!" },
		"required not bool": func(p map[string]any) { params(p)["requireSignedReleaseToken"] = "yes" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			p := h.tokenPayload(idA, 1, testTokenKey("a"), true)
			mutate(p)
			if out := h.m.HandleIsolate(context.Background(), p); !out.Failed() {
				t.Fatalf("accepted: %+v", out)
			}
			if h.m.Active() {
				t.Fatal("isolated on a malformed spec")
			}
		})
	}
}

func TestManagerRejectedTokensJournalBounded(t *testing.T) {
	h := newHarness(t)
	h.mustIsolateWithToken(testTokenKey("a"), false)
	for i := 0; i < 3*BreakGlassAttemptsPerHour; i++ {
		_ = h.m.LocalReleaseToken(context.Background(), "garbage")
	}
	if n, _ := countEvents(h.journal(), "release_token_rejected"); n != BreakGlassAttemptsPerHour {
		t.Fatalf("journalled %d rejections, want %d", n, BreakGlassAttemptsPerHour)
	}
	// A refused token never blocks a valid one (tokens are not rate-limited).
	if err := h.m.LocalReleaseToken(context.Background(), h.goodToken(testTokenKey("a"), 1)); err != nil {
		t.Fatalf("valid token after refusals: %v", err)
	}
}

func TestAdvertisedVersionIncludesReleaseToken(t *testing.T) {
	if got := (Capability{Version: 1}).AdvertisedVersion(); got != CapabilityReleaseToken {
		t.Fatalf("advertised %d, want %d", got, CapabilityReleaseToken)
	}
	if got := (Capability{Version: 0}).AdvertisedVersion(); got != 0 {
		t.Fatalf("capability 0 advertised %d", got)
	}
}
