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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
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
//
// Protocol v2 (PAM ownership epochs, #8202 W4) adds the device's ownership
// epoch to the signed bytes, under the domain breeze-agent-identity-v2. The
// agent advertises identitySyncProtocolVersion 2, reports the epoch it loaded,
// and accepts a v2 assertion only when the epoch does not go backwards and an
// org change comes with a higher epoch. The epoch is persisted with org/site
// by the same PersistServerIdentity call and applied by the same restart; the
// heartbeat after the restart reports it, which is how the server learns the
// agent holds the new epoch's identity (devices.agent_identity_epoch_ack).
// A v1 assertion (a server that does not sign v2) is still accepted and
// leaves the stored epoch alone.

const (
	identitySyncProtocolVersion = 2
	identityAssertionDomain     = "breeze-agent-identity-v1"
	identityAssertionDomainV2   = "breeze-agent-identity-v2"
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
	// Once the restart is scheduled this process takes no new work (#8382):
	// it sends no heartbeat, which is what delivers queued commands (they
	// stay queued for the restarted process, as during a self-update), and
	// it refuses WebSocket commands that start work. So the bounded wait
	// above only ever covers what was already running. The pause covers the
	// jitter and that wait plus time for the restart to land, and ends on its
	// own so an agent whose restart never comes heartbeats again. With
	// nothing in flight it lasts only the jitter (at most a minute).
	identityIntakePauseMax = identityRestartMaxJitter + identityRestartMaxWait + 2*time.Minute
	// The message a WebSocket command gets while the pause holds.
	identityRestartRefusal = "agent is restarting to apply a new org/site assignment; retry in a few minutes"
	// #8623 — a failed write of agent.yaml or of the restart marker is a
	// local problem that usually passes: a full disk, or on Windows an
	// antivirus or backup scan holding the file. It is not a refusal of the
	// identity, so it is never reported to the server (which would hold back
	// assertions for an hour) and this process never gives up on it. It tries
	// again after a backoff: about one beat at first, doubling to the restart
	// cooldown, so a disk that stays broken is retried a few times an hour.
	identityWriteRetryMin = 30 * time.Second
	identityWriteRetryMax = identityRestartCooldown
)

// Why this agent refused an identity assertion (#8382), reported on its next
// beat so the server stops signing one per beat for a target it will not
// adopt. The server validates this closed set (apps/api/src/routes/agents/schemas.ts).
// Refusals it will retry by itself (a cooldown, a rollback in progress, a
// failed write of agent.yaml or of the restart marker, an assertion for an
// earlier beat) are not reported.
const (
	// Gave up, and BREEZE_ORG_ID / BREEZE_SITE_ID are set: the environment
	// overrides agent.yaml on every start, so no restart can apply it.
	identityRejectionEnvOverride = "env_override"
	// Gave up for the life of the process: restarting did not apply the
	// identity. (Before #8623 a failed restart-marker write was reported this
	// way too; it is now retried instead.)
	identityRejectionGaveUp = "gave_up"
	// Signed with a key this agent never pinned.
	identityRejectionUnpinnedKey = "unpinned_key"
	// Did not verify for any other lasting reason.
	identityRejectionInvalid = "invalid"
)

var errIdentityAssertionStale = errors.New("assertion does not answer this agent's latest heartbeat")

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
	// OwnershipEpoch is the epoch this process loaded (#8206); omitted while
	// the agent has never received one.
	OwnershipEpoch uint64 `json:"ownershipEpoch,omitempty"`
}

// IdentityAssertion is the server-signed identity of the row this agent
// authenticates as.
type IdentityAssertion struct {
	Version  int    `json:"v"`
	AgentID  string `json:"agentId"`
	DeviceID string `json:"deviceId"`
	OrgID    string `json:"orgId"`
	SiteID   string `json:"siteId"`
	// OwnershipEpoch is signed in v2 only; a v1 assertion must not carry it.
	OwnershipEpoch uint64 `json:"ownershipEpoch,omitempty"`
	Nonce          string `json:"nonce"`
	IssuedAt       string `json:"issuedAt"`
	ExpiresAt      string `json:"expiresAt"`
	KeyID          string `json:"keyId"`
	Signature      string `json:"signature"`
}

// canonicalBytes is the exact byte string the server signed: the domain and
// one field per line. Empty fields and control characters are rejected so no
// field can smuggle a line break into a neighbour's position.
//
// v1: domain, agentId, deviceId, orgId, siteId, nonce, issuedAt, expiresAt,
// keyId. v2: the v2 domain and the same lines with the ownership epoch (a
// positive decimal, no sign or leading zeros) inserted after siteId.
func (a *IdentityAssertion) canonicalBytes() ([]byte, error) {
	var lines []string
	switch a.Version {
	case 1:
		if a.OwnershipEpoch != 0 {
			return nil, errors.New("v1 identity assertion carries an unsigned ownership epoch")
		}
		lines = []string{
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
	case 2:
		if a.OwnershipEpoch == 0 {
			return nil, errors.New("v2 identity assertion has no ownership epoch")
		}
		lines = []string{
			identityAssertionDomainV2,
			a.AgentID,
			a.DeviceID,
			a.OrgID,
			a.SiteID,
			strconv.FormatUint(a.OwnershipEpoch, 10),
			a.Nonce,
			a.IssuedAt,
			a.ExpiresAt,
			a.KeyID,
		}
	default:
		return nil, fmt.Errorf("unsupported identity assertion version %d", a.Version)
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
		return errIdentityAssertionStale
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
//
// OwnershipEpoch (#8206) is the epoch the restart was for, 0 for a v1
// assertion. It is part of the identity the marker matches and clears on, so
// an epoch-only restart is bounded by the same cooldown and attempt cap.
type identityRestartMarker struct {
	RestartedAt    time.Time `json:"restartedAt"`
	OrgID          string    `json:"orgId"`
	SiteID         string    `json:"siteId"`
	OwnershipEpoch uint64    `json:"ownershipEpoch,omitempty"`
	Attempts       int       `json:"attempts"`
}

// appliedBy reports whether the identity this marker was written for is the
// one in cfg: org and site equal and the epoch reached.
func (m identityRestartMarker) appliedBy(orgID, siteID string, epoch uint64) bool {
	return m.OrgID == orgID && m.SiteID == siteID && epoch >= m.OwnershipEpoch
}

func (m identityRestartMarker) isFor(orgID, siteID string, epoch uint64) bool {
	return m.OrgID == orgID && m.SiteID == siteID && m.OwnershipEpoch == epoch
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
// restart latch and when it was set, until when new work is refused, the
// identity given up on, the refusal to report on the next beat, the backoff
// after a failed local write, and the bounded log of the last failure.
type identitySync struct {
	nonce              atomic.Pointer[string]
	restartRequested   atomic.Bool
	restartRequestedAt atomic.Int64
	// Until when new work is refused; nil = taking work. A time.Time from
	// time.Now keeps its monotonic reading, so a clock step cannot stretch
	// the pause.
	intakePausedUntil atomic.Pointer[time.Time]
	gaveUpOn          atomic.Pointer[string]
	rejection         atomic.Pointer[IdentityAssertionRejection]
	// #8623 — failed writes of agent.yaml or the restart marker in a row,
	// and the earliest time to try again (nil = no backoff). Monotonic, like
	// intakePausedUntil.
	writeFailures atomic.Int32
	writeRetryAt  atomic.Pointer[time.Time]
	failureLogged atomic.Pointer[string]
	markerChecked sync.Once
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
	return &ReportedIdentity{
		DeviceID: h.config.DeviceID, OrgID: h.config.OrgID, SiteID: h.config.SiteID, Nonce: nonce,
		OwnershipEpoch: h.config.OwnershipEpoch,
	}
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
	if !ok || !m.appliedBy(h.config.OrgID, h.config.SiteID, h.config.OwnershipEpoch) {
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
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
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
		h.releaseIdentityRestart()
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
		h.noteIdentityRejection(identityRejectionCode(err), a.OrgID, a.SiteID)
		return false
	}
	fromOrg, fromSite, fromEpoch := h.config.OrgID, h.config.SiteID, h.config.OwnershipEpoch
	// toEpoch is what PersistServerIdentity stores: the asserted epoch for v2,
	// 0 (unchanged) for v1, whose bytes do not cover an epoch.
	toEpoch := uint64(0)
	if a.Version >= 2 {
		toEpoch = a.OwnershipEpoch
		if toEpoch < fromEpoch {
			h.logIdentitySyncFailure("warn", "ignoring server identity assertion",
				fmt.Sprintf("ownership epoch %d is lower than the loaded epoch %d", toEpoch, fromEpoch))
			h.noteIdentityRejection(identityRejectionInvalid, a.OrgID, a.SiteID)
			return false
		}
		if toEpoch == fromEpoch && a.OrgID != fromOrg {
			// Also what an org pinned by BREEZE_ORG_ID looks like after the
			// restart: the epoch loaded from disk, the org from the environment.
			h.logIdentitySyncFailure("warn", "ignoring server identity assertion",
				"org change without an ownership epoch advance; org_id may be overridden by the environment (BREEZE_ORG_ID)")
			h.noteIdentityRejection(identityEpochRefusalCode(), a.OrgID, a.SiteID)
			return false
		}
	}
	epochChanged := toEpoch != 0 && toEpoch != fromEpoch
	if a.OrgID == fromOrg && a.SiteID == fromSite && !epochChanged {
		return false
	}

	target := a.OrgID + "|" + a.SiteID + "|" + strconv.FormatUint(toEpoch, 10)
	if p := h.identitySync.gaveUpOn.Load(); p != nil && *p == target {
		h.noteIdentityRejection(identityGiveUpCode(), a.OrgID, a.SiteID)
		return false
	}
	// #8382 — a rollback restarts the agent through its own helper (on
	// Windows it swaps binaries); a restart for the identity must not race
	// it. Nothing is persisted or scheduled; the server re-signs every beat,
	// so the identity applies on the first beat after the rollback.
	if h.rollbackInProgress() {
		h.logIdentitySyncFailure("warn", "deferring the server-assigned identity while an agent rollback is in progress",
			"the next heartbeat re-evaluates it")
		return false
	}
	markerPath := identityRestartMarkerPath()
	now := identitySyncNow()
	attempts := 1
	previousMarker, hadMarker := readIdentityRestartMarker(markerPath)
	if m := previousMarker; hadMarker && m.isFor(a.OrgID, a.SiteID, toEpoch) {
		previous := max(m.Attempts, 1)
		if previous >= identityRestartMaxAttempts {
			h.identitySync.gaveUpOn.Store(&target)
			log.Error("server-assigned identity did not take effect after restarting for it; not restarting for it again in this process",
				"orgId", a.OrgID, "siteId", a.SiteID, "ownershipEpoch", toEpoch, "attempts", previous,
				"hint", "org_id/site_id may be overridden by the environment (BREEZE_ORG_ID / BREEZE_SITE_ID)")
			h.noteIdentityRejection(identityGiveUpCode(), a.OrgID, a.SiteID)
			return false
		}
		if now.Sub(m.RestartedAt) < identityRestartCooldown {
			h.logIdentitySyncFailure("error", "server-assigned identity did not take effect after a restart; waiting before one more attempt",
				"org_id/site_id may be overridden by the environment (BREEZE_ORG_ID / BREEZE_SITE_ID)")
			return false
		}
		attempts = previous + 1
	}
	// #8623 — a write failed recently: wait out the backoff. Nothing is
	// reported, so the server keeps signing, and the first beat after the
	// backoff tries again.
	if retryAt := h.identitySync.writeRetryAt.Load(); retryAt != nil && now.Before(*retryAt) {
		return false
	}

	if !h.identitySync.restartRequested.CompareAndSwap(false, true) {
		return true
	}
	h.identitySync.restartRequestedAt.Store(now.UnixNano())
	if err := persistServerIdentityFn(config.ActiveConfigFile(), a.OrgID, a.SiteID, toEpoch); err != nil {
		h.noteIdentityWriteFailure(now, "failed to persist the server-assigned identity; keeping the enrolled one for now", err)
		h.identitySync.restartRequested.Store(false)
		return false
	}
	if err := writeIdentityRestartMarker(markerPath, identityRestartMarker{RestartedAt: now, OrgID: a.OrgID, SiteID: a.SiteID, OwnershipEpoch: toEpoch, Attempts: attempts}); err != nil {
		// The marker is the only thing bounding these restarts across
		// processes: without it a new process counts attempt 1 again, so an
		// identity that never takes effect would restart the agent forever.
		// So no marker, no restart. But the failure is local and usually
		// passes (#8623): this process neither gives up on the identity nor
		// reports a refusal; it tries again after the backoff. The identity is
		// already on disk and applies on the next start either way.
		h.noteIdentityWriteFailure(now, "failed to record the identity restart marker; not restarting yet, the new identity applies on the next start", err)
		h.identitySync.restartRequested.Store(false)
		return false
	}
	h.identitySync.writeFailures.Store(0)
	h.identitySync.writeRetryAt.Store(nil)
	pausedUntil := now.Add(identityIntakePauseMax)
	h.identitySync.intakePausedUntil.Store(&pausedUntil)
	log.Info("device was reassigned by the server; restarting to load the new identity",
		"fromOrgId", fromOrg, "toOrgId", a.OrgID, "fromSiteId", fromSite, "toSiteId", a.SiteID,
		"fromOwnershipEpoch", fromEpoch, "toOwnershipEpoch", toEpoch)
	var restore *identityRestartMarker
	if hadMarker {
		restore = &previousMarker
	}
	go h.restartForIdentity(restore)
	return true
}

// restartForIdentity waits a random jitter and for the commands already
// running to finish (bounded), then restarts the service. The identity is
// already on disk, so a restart that fails still applies it on the next start.
// previousMarker is the restart marker as it was before this attempt was
// recorded (nil if there was none), put back if the restart yields.
func (h *Heartbeat) restartForIdentity(previousMarker *identityRestartMarker) {
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
	// #8382 — a rollback can start during the wait (its command may have
	// come in the response that carried the assertion). It owns the restart.
	if h.rollbackInProgress() {
		h.yieldIdentityRestart(previousMarker)
		return
	}
	if err := restartForIdentityFn(); err != nil {
		// Release the gate: the upgrades, credential rotation and mTLS cert
		// renewal it holds back must not wait for a restart that will not
		// come (a lapsed cert takes the device offline), and beats and
		// commands resume. The marker keeps the next try behind the cooldown.
		h.releaseIdentityRestart()
		log.Error("restart after identity change failed; resuming normal work, the new identity applies on the next start", "error", err.Error())
	}
}

// noteIdentityWriteFailure records a failed write of agent.yaml or the restart
// marker and schedules the next try (#8623). Called while the restart latch is
// held, before it is released, so the next beat sees the backoff. Logged on
// every failure: the backoff already spaces them, and the error text names a
// random temp file, so logIdentitySyncFailure would not dedupe it anyway.
func (h *Heartbeat) noteIdentityWriteFailure(now time.Time, msg string, err error) {
	failures := int(h.identitySync.writeFailures.Add(1))
	delay := identityWriteRetryDelay(failures)
	retryAt := now.Add(delay)
	h.identitySync.writeRetryAt.Store(&retryAt)
	log.Warn(msg, "error", err.Error(), "failures", failures, "retryIn", delay.String())
}

// identityWriteRetryDelay is the wait after the given number of failed writes
// in a row: identityWriteRetryMin, doubling, capped at identityWriteRetryMax.
func identityWriteRetryDelay(failures int) time.Duration {
	delay := identityWriteRetryMin
	for i := 1; i < failures && delay < identityWriteRetryMax; i++ {
		delay *= 2
	}
	return min(delay, identityWriteRetryMax)
}

// releaseIdentityRestart reopens everything a pending identity restart holds
// back: beats, new commands, upgrades, credential rotation, cert renewal.
func (h *Heartbeat) releaseIdentityRestart() {
	h.identitySync.intakePausedUntil.Store(nil)
	h.identitySync.restartRequested.Store(false)
}

// yieldIdentityRestart abandons a scheduled restart in favour of a rollback.
// The restart never happened, so it must not count as an attempt: the marker
// goes back to what it was, and the next beat's assertion is evaluated afresh
// instead of waiting out a cooldown (or giving up) for a restart that never
// was. The identity stays persisted; whichever restart comes next applies it.
func (h *Heartbeat) yieldIdentityRestart(previousMarker *identityRestartMarker) {
	path := identityRestartMarkerPath()
	var err error
	if previousMarker == nil {
		if err = os.Remove(path); os.IsNotExist(err) {
			err = nil
		}
	} else {
		err = writeIdentityRestartMarker(path, *previousMarker)
	}
	if err != nil {
		log.Warn("failed to restore the identity restart marker after yielding to a rollback", "error", err.Error())
	}
	h.releaseIdentityRestart()
	log.Warn("an agent rollback started while the restart for the server-assigned identity was pending; not restarting, the next heartbeat re-evaluates it")
}

func (h *Heartbeat) rollbackInProgress() bool {
	return h.rollbackController != nil && h.rollbackController.Active()
}

// identityIntakePaused reports whether this process has stopped taking new
// work because it is about to restart for a new identity. The pause ends on
// its own after identityIntakePauseMax.
func (h *Heartbeat) identityIntakePaused() bool {
	if h == nil {
		return false
	}
	until := h.identitySync.intakePausedUntil.Load()
	if until == nil {
		return false
	}
	if identitySyncNow().Before(*until) {
		return true
	}
	if h.identitySync.intakePausedUntil.CompareAndSwap(until, nil) {
		log.Error("the restart for the server-assigned identity has not happened; taking new work again",
			"pausedFor", identityIntakePauseMax.String())
	}
	return false
}

// admittedDuringIdentityRestart reports whether a WebSocket command is still
// taken while the identity restart is pending: one that stops work (cancelling
// a script, a diagnostic or a scheduled reboot, stopping a backup the restart
// would otherwise wait on), or that carries on a terminal, desktop or tunnel
// session already open. Anything that starts new work is refused, since the
// restart would cut it off.
func admittedDuringIdentityRestart(cmdType string) bool {
	if isLifecycleCommand(cmdType) {
		return true
	}
	switch cmdType {
	case tools.CmdTerminalData, tools.CmdTerminalResize, tools.CmdTerminalStop,
		tools.CmdStopDesktop, tools.CmdDesktopStreamStop, tools.CmdDesktopInput, tools.CmdDesktopConfig,
		tools.CmdTunnelData, tools.CmdTunnelClose,
		tools.CmdCancelReboot, tools.CmdBackupStop:
		return true
	}
	return false
}

// identityRejectionCode classifies a verification failure: a lasting one gets
// a code, an answer to an earlier beat (transient) gets none.
func identityRejectionCode(err error) string {
	switch {
	case errors.Is(err, errIdentityAssertionStale):
		return ""
	case errors.Is(err, errDiagKeyNotPinned):
		return identityRejectionUnpinnedKey
	default:
		return identityRejectionInvalid
	}
}

// identityGiveUpCode names why this agent gave up on an identity. viper reads
// BREEZE_ORG_ID / BREEZE_SITE_ID over agent.yaml (AutomaticEnv, prefix
// BREEZE), which is the usual reason a persisted identity never applies.
func identityGiveUpCode() string {
	if os.Getenv("BREEZE_ORG_ID") != "" || os.Getenv("BREEZE_SITE_ID") != "" {
		return identityRejectionEnvOverride
	}
	return identityRejectionGaveUp
}

// identityEpochRefusalCode names an org change refused because the epoch did
// not advance: an environment override when one is set (the org loaded from
// BREEZE_ORG_ID while the epoch came from agent.yaml), otherwise invalid.
func identityEpochRefusalCode() string {
	if os.Getenv("BREEZE_ORG_ID") != "" || os.Getenv("BREEZE_SITE_ID") != "" {
		return identityRejectionEnvOverride
	}
	return identityRejectionInvalid
}

// noteIdentityRejection records a refusal for the next beat to report. Only
// for an org/site the server could have signed (UUIDs).
func (h *Heartbeat) noteIdentityRejection(code, orgID, siteID string) {
	if code == "" || !identityUUIDPattern.MatchString(orgID) || !identityUUIDPattern.MatchString(siteID) {
		return
	}
	h.identitySync.rejection.Store(&IdentityAssertionRejection{Code: code, OrgID: orgID, SiteID: siteID})
}

// identityRejectionForBeat hands the latest refusal to exactly one beat. If
// that beat is lost the server signs again, this agent refuses again, and the
// following beat reports it.
func (h *Heartbeat) identityRejectionForBeat() *IdentityAssertionRejection {
	if h == nil {
		return nil
	}
	return h.identitySync.rejection.Swap(nil)
}

// IdentityAssertionRejection is why this agent refused an identity assertion,
// and the org/site that assertion named.
type IdentityAssertionRejection struct {
	Code   string `json:"code"`
	OrgID  string `json:"orgId"`
	SiteID string `json:"siteId"`
}
