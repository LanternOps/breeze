package heartbeat

import (
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// The signed `rebind` directive (#8318 wave 1b, spec §6.2). While this
// install is the SOURCE of an open reattach intent, the main and the parked
// heartbeat responses carry it on every beat. It is signed with the
// deployment key, under its own domain, over the canonical lines below. The
// source agent id is signed but not sent, so a directive copied to another
// install never verifies there: verifying it with THIS agent's id is what
// proves it names this install.

const (
	// rebindProtocolVersion is securityCapabilities.rebindProtocolVersion.
	rebindProtocolVersion = 1
	rebindDirectiveDomain = "breeze-agent-rebind-v1"
)

// RebindProtocolVersion is the rebind protocol this build speaks, declared at
// enrollment and on every main and parked heartbeat.
const RebindProtocolVersion = rebindProtocolVersion

// RebindDirective is the heartbeat response's `rebind` object.
type RebindDirective struct {
	IntentID       string `json:"intentId"`
	Nonce          string `json:"nonce"`
	TargetDeviceID string `json:"targetDeviceId"`
	TargetOrgID    string `json:"targetOrgId"`
	TargetSiteID   string `json:"targetSiteId"`
	// ExpiresAt is second precision, `YYYY-MM-DDTHH:MM:SSZ`, signed verbatim.
	ExpiresAt string `json:"expiresAt"`
	KeyID     string `json:"keyId"`
	Signature string `json:"signature"`
}

var errRebindDirectiveExpired = errors.New("rebind directive has expired")

// rebindCanonicalBytes is the exact byte string the server signed: the domain
// and one field per line, joined by "\n", no trailing newline. An empty field
// or one containing a control character (U+0000–U+001F, U+007F) is refused,
// as the server refuses to sign one.
func rebindCanonicalBytes(d *RebindDirective, sourceAgentID string) ([]byte, error) {
	lines := []string{
		rebindDirectiveDomain,
		d.IntentID,
		sourceAgentID,
		d.TargetDeviceID,
		d.TargetOrgID,
		d.TargetSiteID,
		d.Nonce,
		d.ExpiresAt,
		d.KeyID,
	}
	for i, line := range lines {
		if line == "" {
			return nil, fmt.Errorf("rebind directive line %d is empty", i)
		}
		for _, r := range line {
			if r < 0x20 || r == 0x7f {
				return nil, fmt.Errorf("rebind directive line %d contains a control character", i)
			}
		}
	}
	return []byte(strings.Join(lines, "\n")), nil
}

// rebindExpiresAtPattern is the server's wire format for expiresAt.
var rebindExpiresAtPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`)

// verifyRebindDirective accepts a directive only when it is signed by a
// deployment key this agent pinned (the #8320 pin set and discipline), over
// this agent's own agent id, is unexpired, and names a well-formed intent
// and target.
func verifyRebindDirective(d *RebindDirective, sourceAgentID string, pinned []string, now time.Time) error {
	if d == nil {
		return errors.New("no rebind directive")
	}
	if sourceAgentID == "" {
		return errors.New("this agent has no agent id")
	}
	canonical, err := rebindCanonicalBytes(d, sourceAgentID)
	if err != nil {
		return err
	}
	if !identityUUIDPattern.MatchString(d.IntentID) {
		return errors.New("rebind directive intent id is not a UUID")
	}
	if !identityUUIDPattern.MatchString(d.TargetDeviceID) || !identityUUIDPattern.MatchString(d.TargetOrgID) ||
		!identityUUIDPattern.MatchString(d.TargetSiteID) {
		return errors.New("rebind directive target device, org or site is not a UUID")
	}
	if !rebindExpiresAtPattern.MatchString(d.ExpiresAt) {
		return errors.New("rebind directive expiresAt is not second-precision UTC")
	}
	expiresAt, err := time.Parse(time.RFC3339, d.ExpiresAt)
	if err != nil {
		return fmt.Errorf("rebind directive expiresAt: %w", err)
	}
	sig, err := base64.StdEncoding.DecodeString(d.Signature)
	if err != nil {
		return errors.New("rebind directive signature is not base64")
	}
	if err := verifyWithPinnedDeploymentKey(pinned, d.KeyID, canonical, sig); err != nil {
		return fmt.Errorf("rebind directive signature: %w", err)
	}
	// After the signature: an expired directive that verified is worth
	// telling apart (a skewed clock) from a forged one.
	if !now.Before(expiresAt) {
		return errRebindDirectiveExpired
	}
	return nil
}
