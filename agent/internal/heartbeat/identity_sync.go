package heartbeat

import (
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/updater"
)

// Signed identity sync (#8317).
//
// The agent writes org_id/site_id to agent.yaml once, at enrollment, and the
// identity-bound handlers (peripheral policy v2, PAM lifetime, diagnostic
// access, signed rollback) compare every server payload against that copy.
// Moving the device to another org or site changed the row but never this
// copy, so those handlers rejected every new payload as wrong_identity until
// the agent was re-enrolled.
//
// The heartbeat now reports the identity this process holds. When the row
// disagrees, the server answers with an assertion of the row's org and site,
// signed by the deployment key this agent pinned from its own server — the
// same key and pin set that verify diagnostic authorizations, under its own
// domain. It is accepted only for this agent's own agentId + deviceId (a
// device id never changes through this path), persisted, and applied by a
// service restart (updater.RestartSelf): those ids are read without locking
// all over the agent, so a restart is the one way every component reloads
// them consistently.

const (
	identitySyncProtocolVersion = 1
	identityAssertionDomain     = "breeze-agent-identity-v1"
	// Tolerated agent clock skew either side of the assertion's window.
	identityAssertionClockSkew = 5 * time.Minute
	// Upper bound on a window the agent will honour, whatever the server says.
	identityAssertionMaxLifetime = time.Hour
)

var identityUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// ReportedIdentity is the identity this process loaded from agent.yaml.
type ReportedIdentity struct {
	DeviceID string `json:"deviceId"`
	OrgID    string `json:"orgId"`
	SiteID   string `json:"siteId"`
}

// IdentityAssertion is the server-signed identity of the row this agent
// authenticates as.
type IdentityAssertion struct {
	Version   int    `json:"v"`
	AgentID   string `json:"agentId"`
	DeviceID  string `json:"deviceId"`
	OrgID     string `json:"orgId"`
	SiteID    string `json:"siteId"`
	IssuedAt  string `json:"issuedAt"`
	ExpiresAt string `json:"expiresAt"`
	KeyID     string `json:"keyId"`
	Signature string `json:"signature"`
}

// canonicalBytes is the exact byte string the server signed: the domain and
// one field per line. Empty fields and control characters are rejected so no
// field can smuggle a line break into a neighbour's position.
func (a *IdentityAssertion) canonicalBytes() ([]byte, error) {
	if a.Version != 1 {
		return nil, fmt.Errorf("unsupported identity assertion version %d", a.Version)
	}
	lines := []string{
		identityAssertionDomain,
		a.AgentID,
		a.DeviceID,
		a.OrgID,
		a.SiteID,
		a.IssuedAt,
		a.ExpiresAt,
		a.KeyID,
	}
	for i, line := range lines {
		if line == "" {
			return nil, fmt.Errorf("identity assertion line %d is empty", i)
		}
		for _, r := range line {
			if r < 0x20 || r == 0x7f {
				return nil, fmt.Errorf("identity assertion line %d contains a control character", i)
			}
		}
	}
	return []byte(strings.Join(lines, "\n")), nil
}

// identitySyncLocal is what the verifier checks an assertion against.
type identitySyncLocal struct {
	AgentID  string
	DeviceID string
	Pinned   []string
	Now      time.Time
}

// verifyIdentityAssertion accepts an assertion only when it is for this exact
// agent and device, within its validity window, and signed by a deployment key
// this agent already pinned.
func verifyIdentityAssertion(a *IdentityAssertion, local identitySyncLocal) error {
	canonical, err := a.canonicalBytes()
	if err != nil {
		return err
	}
	if local.AgentID == "" || a.AgentID != local.AgentID {
		return errors.New("assertion is for a different agent")
	}
	if local.DeviceID == "" || a.DeviceID != local.DeviceID {
		return errors.New("assertion is for a different device")
	}
	if !identityUUIDPattern.MatchString(a.OrgID) || !identityUUIDPattern.MatchString(a.SiteID) {
		return errors.New("assertion org or site is not a UUID")
	}
	issuedAt, err := time.Parse(time.RFC3339, a.IssuedAt)
	if err != nil {
		return fmt.Errorf("assertion issuedAt: %w", err)
	}
	expiresAt, err := time.Parse(time.RFC3339, a.ExpiresAt)
	if err != nil {
		return fmt.Errorf("assertion expiresAt: %w", err)
	}
	if !expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > identityAssertionMaxLifetime {
		return errors.New("assertion validity window is invalid")
	}
	if local.Now.Before(issuedAt.Add(-identityAssertionClockSkew)) {
		return errors.New("assertion is not yet valid")
	}
	if local.Now.After(expiresAt.Add(identityAssertionClockSkew)) {
		return errors.New("assertion has expired")
	}
	sig, err := base64.StdEncoding.DecodeString(a.Signature)
	if err != nil {
		return errors.New("assertion signature is not base64")
	}
	if err := verifyWithPinnedDeploymentKey(local.Pinned, a.KeyID, canonical, sig); err != nil {
		return fmt.Errorf("assertion signature: %w", err)
	}
	return nil
}

// Seams for tests.
var (
	persistServerIdentityFn = config.PersistServerIdentity
	restartForIdentityFn    = updater.RestartSelf
	identitySyncNow         = time.Now
)

// identitySync holds the one-shot latch: once a new identity is persisted and
// a restart requested, further assertions are ignored until the process
// restarts. If the restart itself fails, the persisted identity still takes
// effect on the next start, and the latch keeps a failing restart from being
// retried on every beat.
type identitySync struct {
	restartRequested atomic.Bool
	rejectionLogged  atomic.Pointer[string]
}

// reportedIdentity is sent on every beat. Nil until all three ids are known,
// so a half-configured agent never asks the server for an assertion.
func (h *Heartbeat) reportedIdentity() *ReportedIdentity {
	if h == nil || h.config == nil {
		return nil
	}
	if h.config.DeviceID == "" || h.config.OrgID == "" || h.config.SiteID == "" {
		return nil
	}
	return &ReportedIdentity{DeviceID: h.config.DeviceID, OrgID: h.config.OrgID, SiteID: h.config.SiteID}
}

// applyIdentityAssertion verifies a server identity assertion and, when it
// names a different org or site, persists it and restarts the agent.
func (h *Heartbeat) applyIdentityAssertion(a *IdentityAssertion) {
	if a == nil || h == nil || h.config == nil {
		return
	}
	if h.identitySync.restartRequested.Load() {
		return
	}
	local := identitySyncLocal{
		AgentID:  h.config.AgentID,
		DeviceID: h.config.DeviceID,
		Pinned:   h.pinnedManifestPubKeys(),
		Now:      identitySyncNow(),
	}
	if err := verifyIdentityAssertion(a, local); err != nil {
		// Bounded per distinct reason: a server that keeps sending an
		// assertion this agent cannot verify would otherwise log every beat.
		reason := err.Error()
		if prev := h.identitySync.rejectionLogged.Load(); prev == nil || *prev != reason {
			h.identitySync.rejectionLogged.Store(&reason)
			log.Warn("ignoring server identity assertion", "reason", reason)
		}
		return
	}
	h.identitySync.rejectionLogged.Store(nil)
	fromOrg, fromSite := h.config.OrgID, h.config.SiteID
	if a.OrgID == fromOrg && a.SiteID == fromSite {
		return
	}
	if !h.identitySync.restartRequested.CompareAndSwap(false, true) {
		return
	}
	if err := persistServerIdentityFn(config.ActiveConfigFile(), a.OrgID, a.SiteID); err != nil {
		h.identitySync.restartRequested.Store(false)
		log.Error("failed to persist the server-assigned identity; keeping the enrolled one", "error", err.Error())
		return
	}
	log.Info("device was reassigned by the server; restarting to load the new identity",
		"fromOrgId", fromOrg, "toOrgId", a.OrgID, "fromSiteId", fromSite, "toSiteId", a.SiteID)
	go func() {
		if err := restartForIdentityFn(); err != nil {
			log.Error("restart after identity change failed; the new identity applies on the next start", "error", err.Error())
		}
	}()
}
