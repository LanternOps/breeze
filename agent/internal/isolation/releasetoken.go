package isolation

import (
	"bytes"
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Signed offline release token (#10102, plan W4c, spec OD6 c).
//
//	token   = base64url(payload) "." base64url(signature)      (RFC 4648 §5, no padding)
//	payload = {"v":1,"iid":"<uuid>","gen":<n>,"dev":"<uuid>","nbf":<unix s>,"exp":<unix s>}
//	signature = Ed25519(key, releaseTokenDomain || base64url(payload))
//
// The payload is exactly that object: those keys in that order, no
// whitespace, lowercase UUIDs. The server signs with a dedicated key
// (NETWORK_ISOLATION_TOKEN_SIGNING_KEY, Gate B decision 5) whose public half
// the agent pins in its journal when it applies the episode, so verification
// needs no connectivity and a token cannot be minted from anything in the
// database. testdata/release_token_vectors.json pins the format to an
// independent implementation; the API's releaseToken.test.ts reads the same
// file.
const (
	releaseTokenDomain = "breeze-isolation-release-token-v1\n"
	// ReleaseTokenMaxLen bounds the token string. A real token is about 230
	// characters.
	ReleaseTokenMaxLen = 512
	// ReleaseTokenMaxValidity is the longest exp − nbf window accepted.
	ReleaseTokenMaxValidity = 24 * time.Hour
	// ReleaseTokenClockSkew is how far ahead of the device's clock nbf may be.
	// Expiry gets no slack.
	ReleaseTokenClockSkew = 5 * time.Minute

	releaseTokenVersion    = 1
	releaseTokenMaxPayload = 256
)

// Why a token was refused: a closed set, journalled as the detail of a
// `release_token_rejected` event. Never the token itself.
const (
	ReleaseTokenUnavailable     = "unavailable" // no usable public key is pinned for this episode
	ReleaseTokenMalformed       = "malformed"
	ReleaseTokenBadSignature    = "bad_signature"
	ReleaseTokenWrongVersion    = "wrong_version"
	ReleaseTokenWrongEpisode    = "wrong_episode"
	ReleaseTokenWrongGeneration = "wrong_generation"
	ReleaseTokenWrongDevice     = "wrong_device"
	ReleaseTokenNotYetValid     = "not_yet_valid"
	ReleaseTokenExpired         = "expired"
	ReleaseTokenValidityTooLong = "validity_too_long"
)

// ErrReleaseTokenInvalid is wrapped by every refusal from VerifyReleaseToken.
var ErrReleaseTokenInvalid = errors.New("the release token was refused")

type releaseTokenError struct{ reason string }

func (e *releaseTokenError) Error() string {
	return fmt.Sprintf("%s: %s", ErrReleaseTokenInvalid.Error(), e.reason)
}
func (e *releaseTokenError) Unwrap() error { return ErrReleaseTokenInvalid }

func rejectToken(reason string) error { return &releaseTokenError{reason: reason} }

// ReleaseTokenRejectReason returns the closed reason of a VerifyReleaseToken
// refusal, or "" for any other error.
func ReleaseTokenRejectReason(err error) string {
	var e *releaseTokenError
	if errors.As(err, &e) {
		return e.reason
	}
	return ""
}

// ReleaseTokenBinding is what a token must name: the episode, its current
// generation and the device, all as the agent journalled them.
type ReleaseTokenBinding struct {
	IsolationID string
	Generation  int
	DeviceID    string
}

// releaseTokenPayload decodes with pointer fields so a missing key is visible;
// the field order is the canonical key order.
type releaseTokenPayload struct {
	V   *int    `json:"v"`
	IID *string `json:"iid"`
	Gen *int    `json:"gen"`
	Dev *string `json:"dev"`
	NBF *int64  `json:"nbf"`
	EXP *int64  `json:"exp"`
}

// smallOrderEd25519Keys are the encodings (canonical or not, either sign bit)
// of the points of order 1, 2, 4 and 8. Under such a key a signature can be
// made for any message without a private key, so it can never be pinned.
// Listed in testdata/release_token_vectors.json (smallOrderPublicKeysHex),
// which was computed independently; the test compares the two.
var smallOrderEd25519Keys = func() [][]byte {
	hexes := []string{
		"0000000000000000000000000000000000000000000000000000000000000000",
		"0000000000000000000000000000000000000000000000000000000000000080",
		"0100000000000000000000000000000000000000000000000000000000000000",
		"0100000000000000000000000000000000000000000000000000000000000080",
		"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
		"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
		"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
		"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
		"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	}
	out := make([][]byte, 0, len(hexes))
	for _, h := range hexes {
		b, err := hex.DecodeString(h)
		if err != nil || len(b) != ed25519.PublicKeySize {
			panic("isolation: bad small-order key literal")
		}
		out = append(out, b)
	}
	return out
}()

// ValidReleaseTokenPublicKey reports whether pk can be pinned: exactly 32
// bytes and not a small-order point.
func ValidReleaseTokenPublicKey(pk []byte) bool {
	if len(pk) != ed25519.PublicKeySize {
		return false
	}
	for _, bad := range smallOrderEd25519Keys {
		if subtle.ConstantTimeCompare(pk, bad) == 1 {
			return false
		}
	}
	return true
}

var releaseTokenB64 = base64.RawURLEncoding.Strict()

// VerifyReleaseToken checks token against the pinned public key and the
// journalled binding. The signature is checked before the payload is parsed.
// now is the device clock; highWater is the journal's highest trusted wall
// time (zero if none), so a clock set back cannot revive an expired token.
// Every refusal wraps ErrReleaseTokenInvalid and carries a closed reason.
func VerifyReleaseToken(token string, publicKey []byte, want ReleaseTokenBinding, now, highWater time.Time) error {
	if !ValidReleaseTokenPublicKey(publicKey) {
		return rejectToken(ReleaseTokenUnavailable)
	}
	if len(token) == 0 || len(token) > ReleaseTokenMaxLen || strings.Count(token, ".") != 1 {
		return rejectToken(ReleaseTokenMalformed)
	}
	encPayload, encSig, _ := strings.Cut(token, ".")
	if encPayload == "" || encSig == "" {
		return rejectToken(ReleaseTokenMalformed)
	}
	payload, err := releaseTokenB64.DecodeString(encPayload)
	if err != nil || len(payload) == 0 || len(payload) > releaseTokenMaxPayload {
		return rejectToken(ReleaseTokenMalformed)
	}
	sig, err := releaseTokenB64.DecodeString(encSig)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return rejectToken(ReleaseTokenMalformed)
	}
	msg := make([]byte, 0, len(releaseTokenDomain)+len(encPayload))
	msg = append(append(msg, releaseTokenDomain...), encPayload...)
	if !ed25519.Verify(ed25519.PublicKey(publicKey), msg, sig) {
		return rejectToken(ReleaseTokenBadSignature)
	}

	var p releaseTokenPayload
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.DisallowUnknownFields()
	if dec.Decode(&p) != nil || dec.More() || p.V == nil || p.IID == nil || p.Gen == nil || p.Dev == nil || p.NBF == nil || p.EXP == nil {
		return rejectToken(ReleaseTokenMalformed)
	}
	// Only the canonical encoding is accepted: no whitespace, reordering,
	// duplicate keys or alternative number forms.
	canonical, err := json.Marshal(p)
	if err != nil || !bytes.Equal(canonical, payload) {
		return rejectToken(ReleaseTokenMalformed)
	}
	nbf, exp := *p.NBF, *p.EXP
	if nbf <= 0 || exp <= nbf {
		return rejectToken(ReleaseTokenMalformed)
	}
	if *p.V != releaseTokenVersion {
		return rejectToken(ReleaseTokenWrongVersion)
	}
	if !equalBinding(*p.IID, want.IsolationID) {
		return rejectToken(ReleaseTokenWrongEpisode)
	}
	if want.Generation < 1 || *p.Gen != want.Generation {
		return rejectToken(ReleaseTokenWrongGeneration)
	}
	if !equalBinding(*p.Dev, want.DeviceID) {
		return rejectToken(ReleaseTokenWrongDevice)
	}
	if time.Duration(exp-nbf)*time.Second > ReleaseTokenMaxValidity {
		return rejectToken(ReleaseTokenValidityTooLong)
	}
	if now.Add(ReleaseTokenClockSkew).Unix() < nbf {
		return rejectToken(ReleaseTokenNotYetValid)
	}
	if laterOf(now, highWater).Unix() >= exp {
		return rejectToken(ReleaseTokenExpired)
	}
	return nil
}

// equalBinding compares a token field with the journalled value exactly (the
// journal holds lowercase UUIDs). An empty journalled value matches nothing.
func equalBinding(got, want string) bool {
	return want != "" && len(got) == len(want) && subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}
