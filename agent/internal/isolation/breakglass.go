package isolation

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base32"
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// Offline break-glass code (spec §3.6 item 3, plan "Break-glass code"):
//
//	code = base32(HMAC-SHA256(secret, "<isolationId lowercase>|<generation>|<hourBucket>")[0:5])
//
// hourBucket = floor(unixSeconds / 3600); base32 is RFC 4648 without padding,
// so the 5 bytes are exactly 8 characters. Mirrors
// apps/api/src/services/networkIsolation/breakGlass.ts; both are pinned to
// testdata/breakglass_vectors.json.

const (
	breakGlassSecretBytes = 32
	breakGlassCodeBytes   = 5
)

var uuidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func breakGlassMessage(isolationID string, generation int, hourBucket int64) string {
	return strings.ToLower(isolationID) + "|" + strconv.Itoa(generation) + "|" + strconv.FormatInt(hourBucket, 10)
}

// BreakGlassCode computes the code for one hour bucket.
func BreakGlassCode(secret []byte, isolationID string, generation int, hourBucket int64) (string, error) {
	if len(secret) != breakGlassSecretBytes {
		return "", errors.New("break-glass secret must be exactly 32 bytes")
	}
	if !uuidRE.MatchString(strings.ToLower(isolationID)) {
		return "", errors.New("isolationId must be a UUID")
	}
	if generation < 1 {
		return "", errors.New("generation must be a positive integer")
	}
	if hourBucket < 0 {
		return "", errors.New("hourBucket must be non-negative")
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(breakGlassMessage(isolationID, generation, hourBucket)))
	sum := mac.Sum(nil)
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:breakGlassCodeBytes]), nil
}
