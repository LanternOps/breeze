package heartbeat

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
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
// Every beat now reports the identity this process holds, with a fresh random
// nonce. When the row disagrees, the server answers with an assertion of the
// row's org and site that echoes the nonce, signed by the deployment key this
// agent pinned from its own server — the same key and pin set that verify
// diagnostic authorizations, under its own domain. It is accepted only as the
// answer to this agent's own latest beat (the nonce; no clock involved, so it
// cannot be replayed and a skewed clock cannot block it), for this agent's own
// agentId + deviceId (a device id never changes through this path). It is
// then persisted and applied by a service restart (updater.RestartSelf):
// those ids are read without locking all over the agent, so a restart is the
// one way every component reloads them consistently.

const (
	identitySyncProtocolVersion = 1
	identityAssertionDomain     = "breeze-agent-identity-v1"
	// Structural bound on the window the server may state. The nonce, not
	// the clock, is what makes an assertion fresh.
	identityAssertionMaxLifetime = time.Hour
	// A persisted identity that did not take effect after a restart (an
	// environment override of org/site, say) must not turn every beat into
	// another restart.
	identityRestartCooldown = 30 * time.Minute
	// The restart waits for commands already dispatched from the same beat.
	identityRestartMaxWait = 5 * time.Minute
	// Spread the restarts when a whole org is re-homed at once (org merge).
	identityRestartMaxJitter  = time.Minute
	identityRestartMarkerFile = "identity-sync-restart.json"
	// A restart that was requested but never came (RestartSelf reported
	// success and the process kept running) must not hold back forever the
	// upgrades, credential rotation and cert renewal it gates.
	identityRestartPendingMax = identityRestartMaxJitter + identityRestartMaxWait + 9*time.Minute
	// Restarts tried for one identity before this agent stops trying for the
	// life of the process: a real BREEZE_ORG_ID / BREEZE_SITE_ID override
	// never lets the persisted identity take effect.
	identityRestartMaxAttempts = 2
)

var (
	identityUUIDPattern  = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	identityNoncePattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

// ReportedIdentity is the identity this process loaded from agent.yaml, plus
// the nonce a server assertion for this beat must echo.
type ReportedIdentity struct {
	DeviceID string `json:"deviceId"`
	OrgID    string `json:"orgId"`
	SiteID   string `json:"siteId"`
	Nonce    string `json:"nonce"`
}

// IdentityAssertion is the server-signed identity of the row this agent
// authenticates as.
type IdentityAssertion struct {
	Version   int    `json:"v"`
	AgentID   string `json:"agentId"`
	DeviceID  string `json:"deviceId"`
	OrgID     string `json:"orgId"`
	SiteID    string `json:"siteId"`
	Nonce     string `json:"nonce"`
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
		a.Nonce,
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
	Nonce    string
	Pinned   []string
}

// verifyIdentityAssertion accepts an assertion only when it answers this
// agent's latest beat (nonce), is for this exact agent and device, and is
// signed by a deployment key this agent already pinned.
func verifyIdentityAssertion(a *IdentityAssertion, local identitySyncLocal) error {
	canonical, err := a.canonicalBytes()
	if err != nil {
		return err
	}
	if local.Nonce == "" || a.Nonce != local.Nonce {
		return errors.New("assertion does not answer this agent's latest heartbeat")
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
	sig, err := base64.StdEncoding.DecodeString(a.Signature)
	if err != nil {
		return errors.New("assertion signature is not base64")
	}
	if err := verifyWithPinnedDeploymentKey(local.Pinned, a.KeyID, canonical, sig); err != nil {
		return fmt.Errorf("assertion signature: %w", err)
	}
	return nil
}

// identityRestartMarker records the identity the last restart was for and how
// many restarts it took, so a persisted identity that does not take effect
// cannot trigger a restart loop. It is removed once the identity is in effect.
type identityRestartMarker struct {
	RestartedAt time.Time `json:"restartedAt"`
	OrgID       string    `json:"orgId"`
	SiteID      string    `json:"siteId"`
	Attempts    int       `json:"attempts"`
}

// Seams for tests.
var (
	persistServerIdentityFn   = config.PersistServerIdentity
	restartForIdentityFn      = updater.RestartSelf
	identitySyncNow           = time.Now
	identityRestartMarkerPath = func() string {
		return filepath.Join(config.GetDataDir(), identityRestartMarkerFile)
	}
	identityRestartJitter = func() time.Duration {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(identityRestartMaxJitter)))
		if err != nil {
			return 0
		}
		return time.Duration(n.Int64())
	}
	identityRestartPollInterval = time.Second
)

// identitySync holds the per-process state: the nonce of the latest beat, the
// restart latch and when it was set, the identity given up on, and the bounded
// log of the last failure.
type identitySync struct {
	nonce              atomic.Pointer[string]
	restartRequested   atomic.Bool
	restartRequestedAt atomic.Int64
	gaveUpOn           atomic.Pointer[string]
	failureLogged      atomic.Pointer[string]
	markerChecked      sync.Once
}

func newIdentityNonce() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return hex.EncodeToString(b[:])
}

// reportIdentityForBeat returns the identity to send on this beat with a
// fresh nonce, and remembers the nonce for the response. Nil until all three
// ids are known, so a half-configured agent never asks for an assertion.
func (h *Heartbeat) reportIdentityForBeat() *ReportedIdentity {
	if h == nil || h.config == nil {
		return nil
	}
	if h.config.DeviceID == "" || h.config.OrgID == "" || h.config.SiteID == "" {
		return nil
	}
	h.identitySync.markerChecked.Do(h.clearAppliedIdentityRestartMarker)
	nonce := newIdentityNonce()
	if nonce == "" {
		return nil
	}
	h.identitySync.nonce.Store(&nonce)
	return &ReportedIdentity{DeviceID: h.config.DeviceID, OrgID: h.config.OrgID, SiteID: h.config.SiteID, Nonce: nonce}
}

// logIdentitySyncFailure logs once per distinct reason, so a server that
// keeps sending something this agent cannot use does not log on every beat.
func (h *Heartbeat) logIdentitySyncFailure(level string, msg, reason string) {
	key := msg + ": " + reason
	if prev := h.identitySync.failureLogged.Load(); prev != nil && *prev == key {
		return
	}
	h.identitySync.failureLogged.Store(&key)
	if level == "error" {
		log.Error(msg, "reason", reason)
		return
	}
	log.Warn(msg, "reason", reason)
}

// clearAppliedIdentityRestartMarker removes the restart marker once the
// identity it was written for is the one this process loaded: the restart
// worked, so a later move to that same identity starts with a clean count.
func (h *Heartbeat) clearAppliedIdentityRestartMarker() {
	path := identityRestartMarkerPath()
	m, ok := readIdentityRestartMarker(path)
	if !ok || m.OrgID != h.config.OrgID || m.SiteID != h.config.SiteID {
		return
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		log.Warn("failed to remove the identity restart marker", "error", err.Error())
	}
}

func readIdentityRestartMarker(path string) (identityRestartMarker, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return identityRestartMarker{}, false
	}
	var m identityRestartMarker
	if err := json.Unmarshal(raw, &m); err != nil {
		return identityRestartMarker{}, false
	}
	return m, true
}

// writeIdentityRestartMarker writes the marker atomically (temp file and
// rename), so a crash mid-write cannot leave a marker that fails to parse and
// silently resets the attempt count.
func writeIdentityRestartMarker(path string, m identityRestartMarker) error {
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), identityRestartMarkerFile+".*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}

// applyIdentityAssertion verifies a server identity assertion and, when it
// names a different org or site, persists it and schedules one restart. It
// reports whether a restart is pending, so the caller can hold back work this
// process should not start any more (binary swaps, credential rotation).
func (h *Heartbeat) applyIdentityAssertion(a *IdentityAssertion) bool {
	if h == nil || h.config == nil {
		return false
	}
	if h.identitySync.restartRequested.Load() {
		requestedAt := time.Unix(0, h.identitySync.restartRequestedAt.Load())
		if identitySyncNow().Sub(requestedAt) < identityRestartPendingMax {
			return true
		}
		h.identitySync.restartRequested.Store(false)
		h.logIdentitySyncFailure("error", "the restart for the server-assigned identity never happened; resuming normal work",
			"the new identity applies on the next start")
	}
	if a == nil {
		return false
	}
	nonce := ""
	if p := h.identitySync.nonce.Load(); p != nil {
		nonce = *p
	}
	local := identitySyncLocal{
		AgentID:  h.config.AgentID,
		DeviceID: h.config.DeviceID,
		Nonce:    nonce,
		Pinned:   h.pinnedManifestPubKeys(),
	}
	if err := verifyIdentityAssertion(a, local); err != nil {
		h.logIdentitySyncFailure("warn", "ignoring server identity assertion", err.Error())
		return false
	}
	fromOrg, fromSite := h.config.OrgID, h.config.SiteID
	if a.OrgID == fromOrg && a.SiteID == fromSite {
		return false
	}

	target := a.OrgID + "|" + a.SiteID
	if p := h.identitySync.gaveUpOn.Load(); p != nil && *p == target {
		return false
	}
	markerPath := identityRestartMarkerPath()
	now := identitySyncNow()
	attempts := 1
	if m, ok := readIdentityRestartMarker(markerPath); ok && m.OrgID == a.OrgID && m.SiteID == a.SiteID {
		previous := max(m.Attempts, 1)
		if previous >= identityRestartMaxAttempts {
			h.identitySync.gaveUpOn.Store(&target)
			log.Error("server-assigned identity did not take effect after restarting for it; not restarting for it again in this process",
				"orgId", a.OrgID, "siteId", a.SiteID, "attempts", previous,
				"hint", "org_id/site_id may be overridden by the environment (BREEZE_ORG_ID / BREEZE_SITE_ID)")
			return false
		}
		if now.Sub(m.RestartedAt) < identityRestartCooldown {
			h.logIdentitySyncFailure("error", "server-assigned identity did not take effect after a restart; waiting before one more attempt",
				"org_id/site_id may be overridden by the environment (BREEZE_ORG_ID / BREEZE_SITE_ID)")
			return false
		}
		attempts = previous + 1
	}

	if !h.identitySync.restartRequested.CompareAndSwap(false, true) {
		return true
	}
	h.identitySync.restartRequestedAt.Store(now.UnixNano())
	if err := persistServerIdentityFn(config.ActiveConfigFile(), a.OrgID, a.SiteID); err != nil {
		h.identitySync.restartRequested.Store(false)
		h.logIdentitySyncFailure("error", "failed to persist the server-assigned identity; keeping the enrolled one", err.Error())
		return false
	}
	if err := writeIdentityRestartMarker(markerPath, identityRestartMarker{RestartedAt: now, OrgID: a.OrgID, SiteID: a.SiteID, Attempts: attempts}); err != nil {
		// The marker is the only thing bounding these restarts across
		// processes: without it a new process counts attempt 1 again, so an
		// identity that never takes effect would restart the agent forever.
		// The identity is already on disk and applies on the next start.
		h.identitySync.gaveUpOn.Store(&target)
		h.identitySync.restartRequested.Store(false)
		log.Error("failed to record the identity restart marker; not restarting, the new identity applies on the next start",
			"error", err.Error())
		return false
	}
	log.Info("device was reassigned by the server; restarting to load the new identity",
		"fromOrgId", fromOrg, "toOrgId", a.OrgID, "fromSiteId", fromSite, "toSiteId", a.SiteID)
	go h.restartForIdentity()
	return true
}

// restartForIdentity waits a random jitter and for the commands already
// running to finish (bounded), then restarts the service. The identity is
// already on disk, so a restart that fails still applies it on the next start.
func (h *Heartbeat) restartForIdentity() {
	if jitter := identityRestartJitter(); jitter > 0 {
		time.Sleep(jitter)
	}
	deadline := identitySyncNow().Add(identityRestartMaxWait)
	for {
		inFlight, _ := h.inFlightCommandStats(identitySyncNow())
		if inFlight == 0 || !identitySyncNow().Before(deadline) {
			break
		}
		time.Sleep(identityRestartPollInterval)
	}
	if err := restartForIdentityFn(); err != nil {
		// Release the gate: the upgrades, credential rotation and mTLS cert
		// renewal it holds back must not wait for a restart that will not
		// come (a lapsed cert takes the device offline). The marker keeps
		// the next try behind the cooldown.
		h.identitySync.restartRequested.Store(false)
		log.Error("restart after identity change failed; resuming normal work, the new identity applies on the next start", "error", err.Error())
	}
}
