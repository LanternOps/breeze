package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

// Reinstall reattach, the bounded rebind (#8318 wave 1b, spec §6.3, §6.6).
//
// A reinstalled machine enrolls as a new device (the SOURCE). When a human
// decides it replaces an existing record (the TARGET), the server signs a
// `rebind` directive on the source's heartbeat; the agent generates a fresh
// credential set for the target, persists it HERE before any call, stages
// its hashes (phase 1), confirms, and then swaps its identity.
//
// The staged set lives in its own file beside secrets.yaml, at the same file
// mode (0600 / the secrets DACL), and is never logged. It is NOT kept in
// secrets.yaml: SaveTo rebuilds that file from a fixed key list and would
// drop it, and its life cycle (one set per intent, kept until the source
// credentials are proven current) is unrelated to token rotation's.
//
// The swap (ApplyRebindIdentity) writes secrets.yaml BEFORE agent.yaml, so a
// crash between the two never leaves the new agent id with the old tokens.
// The staged set stays on disk, in phase "confirmed", until the restarted
// process has authenticated as the target once (the heartbeat removes it).
// Until then every start compares the identity on disk with the swap
// (RebindIdentityIntact) and re-applies it if anything is missing or was
// reverted (FinishConfirmedRebind), before anything reads the identity. No
// token rotation runs while the set exists, so a difference is never a
// legitimate later change.

const rebindStagedFileName = "rebind-staged.json"

// RebindStagedVersion is the on-disk format version of the staged set.
const RebindStagedVersion = 1

// Phases of a staged set.
const (
	// RebindPhaseGenerated: the set is on disk; phase 1 has not answered 200.
	RebindPhaseGenerated = "generated"
	// RebindPhaseStaged: phase 1 answered 200; the staged agent id, the
	// target and the pending certificate are on disk with the set.
	RebindPhaseStaged = "staged"
	// RebindPhaseConfirmed: confirm (or a probe as the target) succeeded; the
	// identity swap is owed.
	RebindPhaseConfirmed = "confirmed"
	// RebindPhaseEnded: the server said the intent is over. Kept until a call
	// authenticated with the source credentials returns 2xx, then discarded.
	RebindPhaseEnded = "ended"
)

// RebindTarget is the target device's identity as the server stated it.
type RebindTarget struct {
	DeviceID string `json:"deviceId"`
	OrgID    string `json:"orgId"`
	SiteID   string `json:"siteId"`
}

// Equal reports whether both name the same device, org and site.
func (t RebindTarget) Equal(o RebindTarget) bool {
	return t.DeviceID == o.DeviceID && t.OrgID == o.OrgID && t.SiteID == o.SiteID
}

// RebindCertificate is the target's next mTLS certificate from phase 1.
type RebindCertificate struct {
	Certificate  string `json:"certificate"`
	PrivateKey   string `json:"privateKey"`
	ExpiresAt    string `json:"expiresAt"`
	SerialNumber string `json:"serialNumber"`
}

// RebindConfirmedIdentity is the identity confirm (or the probe) established.
type RebindConfirmedIdentity struct {
	DeviceID string `json:"deviceId"`
	OrgID    string `json:"orgId"`
	SiteID   string `json:"siteId"`
	AgentID  string `json:"agentId"`
}

// RebindStagedSet is the durable record of one reattach intent, from the
// generated secrets to the confirmed identity.
type RebindStagedSet struct {
	Version  int    `json:"version"`
	Phase    string `json:"phase"`
	IntentID string `json:"intentId"`
	// SourceAgentID is the agent id this install had when the set was
	// generated: the `:id` of phase 1 and of rebind-confirm.
	SourceAgentID string `json:"sourceAgentId"`
	// DirectiveTarget is what the verified directive named.
	DirectiveTarget RebindTarget `json:"directiveTarget"`
	CreatedAt       time.Time    `json:"createdAt"`

	AuthToken         string `json:"authToken"`
	WatchdogAuthToken string `json:"watchdogAuthToken"`
	HelperAuthToken   string `json:"helperAuthToken"`
	ConfirmationToken string `json:"confirmationToken"`

	// Phase 1's answer (phases staged and later).
	StagedAgentID   string             `json:"stagedAgentId,omitempty"`
	Target          *RebindTarget      `json:"target,omitempty"`
	StagedExpiresAt string             `json:"stagedExpiresAt,omitempty"`
	Certificate     *RebindCertificate `json:"certificate,omitempty"`

	// Confirm's answer (phase confirmed).
	Confirmed *RebindConfirmedIdentity `json:"confirmed,omitempty"`

	// Why the intent is over (phase ended).
	EndedState string     `json:"endedState,omitempty"`
	EndedCode  string     `json:"endedCode,omitempty"`
	EndedAt    *time.Time `json:"endedAt,omitempty"`
}

var (
	rebindAgentTokenPattern        = regexp.MustCompile(`^brz_[0-9a-f]{64}$`)
	rebindConfirmationTokenPattern = regexp.MustCompile(`^brz_rbc_[0-9a-f]{64}$`)
	rebindUUIDPattern              = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

func validRebindTarget(t *RebindTarget) bool {
	return t != nil && rebindUUIDPattern.MatchString(t.DeviceID) &&
		rebindUUIDPattern.MatchString(t.OrgID) && rebindUUIDPattern.MatchString(t.SiteID)
}

// Validate checks the structure every phase requires. It never includes a
// secret in its error.
func (s *RebindStagedSet) Validate() error {
	if s == nil {
		return errors.New("staged set is nil")
	}
	if s.Version != RebindStagedVersion {
		return fmt.Errorf("staged set version %d is not supported", s.Version)
	}
	if !rebindUUIDPattern.MatchString(s.IntentID) {
		return errors.New("staged set intent id is not a UUID")
	}
	if s.SourceAgentID == "" {
		return errors.New("staged set has no source agent id")
	}
	if !validRebindTarget(&s.DirectiveTarget) {
		return errors.New("staged set directive target is incomplete")
	}
	if !rebindAgentTokenPattern.MatchString(s.AuthToken) ||
		!rebindAgentTokenPattern.MatchString(s.WatchdogAuthToken) ||
		!rebindAgentTokenPattern.MatchString(s.HelperAuthToken) {
		return errors.New("staged set agent, watchdog or helper token is malformed")
	}
	if !rebindConfirmationTokenPattern.MatchString(s.ConfirmationToken) {
		return errors.New("staged set confirmation token is malformed")
	}
	switch s.Phase {
	case RebindPhaseGenerated, RebindPhaseEnded:
	case RebindPhaseStaged:
		if s.StagedAgentID == "" || !validRebindTarget(s.Target) {
			return errors.New("staged set in phase staged lacks the staged agent id or the target")
		}
	case RebindPhaseConfirmed:
		if _, err := s.Identity(); err != nil {
			return err
		}
	default:
		return fmt.Errorf("staged set phase %q is unknown", s.Phase)
	}
	if s.Certificate != nil && (s.Certificate.Certificate == "" || s.Certificate.PrivateKey == "") {
		return errors.New("staged set certificate is incomplete")
	}
	return nil
}

// RebindIdentity is the identity and credential set a confirmed reattach
// swaps in.
type RebindIdentity struct {
	// IntentID is recorded in agent.yaml (reattach_intent_id): from then on
	// the identity in the file wins over BREEZE_* environment values.
	IntentID          string
	AgentID           string
	DeviceID          string
	OrgID             string
	SiteID            string
	AuthToken         string
	WatchdogAuthToken string
	HelperAuthToken   string
	// Certificate is the target's certificate; nil clears the client
	// certificate (the source's belongs to the retired source device).
	Certificate *RebindCertificate
}

// Identity is the swap a confirmed set owes.
func (s *RebindStagedSet) Identity() (RebindIdentity, error) {
	c := s.Confirmed
	if c == nil || c.AgentID == "" || !rebindUUIDPattern.MatchString(c.DeviceID) ||
		!rebindUUIDPattern.MatchString(c.OrgID) || !rebindUUIDPattern.MatchString(c.SiteID) {
		return RebindIdentity{}, errors.New("staged set has no complete confirmed identity")
	}
	return RebindIdentity{
		IntentID:          s.IntentID,
		AgentID:           c.AgentID,
		DeviceID:          c.DeviceID,
		OrgID:             c.OrgID,
		SiteID:            c.SiteID,
		AuthToken:         s.AuthToken,
		WatchdogAuthToken: s.WatchdogAuthToken,
		HelperAuthToken:   s.HelperAuthToken,
		Certificate:       s.Certificate,
	}, nil
}

// rebindStagedMu serializes the staged file's read-modify-write cycles.
var rebindStagedMu sync.Mutex

// Seams for tests: the staged-file read and write (I/O faults) and the
// swap's two saves.
var (
	rebindReadFileFn    = readConfigFileBytes
	rebindAtomicWriteFn = atomicWriteFile
	rebindSaveFn        = saveToLockedWithIdentity
)

// RebindStagedPath is the staged set's path for the agent.yaml cfgFile names
// ("" = the default config file).
func RebindStagedPath(cfgFile string) string {
	return filepath.Join(filepath.Dir(ResolveSavePath(cfgFile)), rebindStagedFileName)
}

// WriteRebindStaged durably writes s (temp file, fsync, rename, directory
// fsync) at the secrets file's mode, then reads it back: a write that
// returned nil but does not hold s is reported, so no caller ever makes a
// call that relies on a set the disk does not hold.
func WriteRebindStaged(cfgFile string, s *RebindStagedSet) error {
	if err := s.Validate(); err != nil {
		return fmt.Errorf("refusing to persist an invalid staged set: %w", err)
	}
	path := RebindStagedPath(cfgFile)
	if err := checkConfigTarget(path); err != nil {
		return err
	}
	data, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("encoding the staged set: %w", err)
	}

	rebindStagedMu.Lock()
	defer rebindStagedMu.Unlock()
	if err := prepareSaveDir(ResolveSavePath(cfgFile)); err != nil {
		return err
	}
	if err := rebindAtomicWriteFn(path, data, 0600); err != nil {
		return fmt.Errorf("writing the staged set: %w", err)
	}
	if err := enforceSecretFilePermissions(path); err != nil {
		return fmt.Errorf("securing the staged set: %w", err)
	}
	back, err := readRebindStagedLocked(path)
	if err != nil {
		return fmt.Errorf("verifying the staged set: %w", err)
	}
	if back == nil {
		return errors.New("verifying the staged set: the file is missing after the write")
	}
	again, err := json.Marshal(back)
	if err != nil || string(again) != string(data) {
		return errors.New("the staged set failed readback verification")
	}
	return nil
}

// ErrRebindStagedUnusable reports a staged-set file that was read completely
// and is provably corrupt: not JSON, or a version-1 set that fails validation
// (this build validates every set before writing it). It has been moved aside
// (only the newest such copy is kept), so the caller proceeds as if there
// were none.
var ErrRebindStagedUnusable = errors.New("the staged reattach set on disk is corrupt")

// ErrRebindStagedUnreadable reports a staged-set file that exists but could
// not be used now: an I/O, sharing-violation or permission error, an owner the
// trust check could not verify, or a format version newer than this build's
// (an agent rolled back). The file is left in place, since it may hold a
// confirmed set, and the caller retries later.
var ErrRebindStagedUnreadable = errors.New("the staged reattach set could not be read")

// errRebindStagedCorrupt marks content that is provably corrupt.
var errRebindStagedCorrupt = errors.New("corrupt staged set")

// ReadRebindStaged returns the staged set, or nil when there is none. Only a
// provably corrupt file is moved aside (rebind-staged.json.unusable-<time>,
// ErrRebindStagedUnusable); older copies set aside before it are deleted, so
// at most one (which may hold plaintext tokens) is kept for diagnosis. Every
// other failure returns an error wrapping ErrRebindStagedUnreadable and
// leaves the file where it is.
func ReadRebindStaged(cfgFile string) (*RebindStagedSet, error) {
	path := RebindStagedPath(cfgFile)
	if err := checkConfigTarget(path); err != nil {
		return nil, err
	}
	rebindStagedMu.Lock()
	defer rebindStagedMu.Unlock()
	s, err := readRebindStagedLocked(path)
	if err == nil || !errors.Is(err, errRebindStagedCorrupt) {
		return s, err
	}
	aside := fmt.Sprintf("%s.unusable-%s", path, time.Now().UTC().Format("20060102T150405Z"))
	if renameErr := renameWithRetry(path, aside); renameErr != nil {
		return nil, fmt.Errorf("%w: corrupt (%v) and could not be moved aside: %v", ErrRebindStagedUnreadable, err, renameErr)
	}
	pruneRebindStagedAsides(filepath.Dir(path), filepath.Base(aside))
	return nil, fmt.Errorf("%w (moved to %s): %v", ErrRebindStagedUnusable, filepath.Base(aside), err)
}

// rebindStagedAsidePrefix names the copies ReadRebindStaged moves aside.
const rebindStagedAsidePrefix = rebindStagedFileName + ".unusable-"

// isRebindStagedAside reports whether a config-folder entry is a corrupt
// staged set moved aside: the agent's own file, holding the same kind of
// secrets as the staged set, so the folder reclaim treats it as one.
func isRebindStagedAside(name string) bool {
	return strings.HasPrefix(strings.ToLower(name), rebindStagedAsidePrefix)
}

// pruneRebindStagedAsides deletes every set-aside copy in dir but keep. A
// failure is logged (names only) and retried on the next set-aside.
func pruneRebindStagedAsides(dir, keep string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		log.Warn("could not list older corrupt staged reattach sets to delete", "error", err.Error())
		return
	}
	for _, e := range entries {
		if e.Name() == keep || !isRebindStagedAside(e.Name()) || !e.Type().IsRegular() {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Warn("could not delete an older corrupt staged reattach set", "file", e.Name(), "error", err.Error())
		}
	}
}

func readRebindStagedLocked(path string) (*RebindStagedSet, error) {
	data, err := rebindReadFileFn(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrRebindStagedUnreadable, err)
	}
	return parseRebindStaged(data)
}

// parseRebindStaged decodes a staged file read completely. The version is
// read first, so a newer build's format is never mistaken for corruption.
func parseRebindStaged(data []byte) (*RebindStagedSet, error) {
	var head struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, fmt.Errorf("%w: not valid JSON", errRebindStagedCorrupt)
	}
	if head.Version > RebindStagedVersion {
		return nil, fmt.Errorf("%w: format version %d is newer than this build's %d", ErrRebindStagedUnreadable, head.Version, RebindStagedVersion)
	}
	var s RebindStagedSet
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("%w: not a staged set", errRebindStagedCorrupt)
	}
	if err := s.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", errRebindStagedCorrupt, err)
	}
	return &s, nil
}

// RemoveRebindStaged deletes the staged set. Removing one that is not there
// is not an error.
func RemoveRebindStaged(cfgFile string) error {
	path := RebindStagedPath(cfgFile)
	if err := checkConfigTarget(path); err != nil {
		return err
	}
	rebindStagedMu.Lock()
	defer rebindStagedMu.Unlock()
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	syncConfigDir(filepath.Dir(path))
	return nil
}

func (id RebindIdentity) validate() error {
	if id.IntentID == "" || id.AgentID == "" || id.DeviceID == "" || id.OrgID == "" || id.SiteID == "" {
		return errors.New("reattached identity is incomplete")
	}
	if id.AuthToken == "" || id.WatchdogAuthToken == "" || id.HelperAuthToken == "" {
		return errors.New("reattached credential set is incomplete")
	}
	if id.Certificate != nil && (id.Certificate.Certificate == "" || id.Certificate.PrivateKey == "") {
		return errors.New("reattached certificate is incomplete")
	}
	return nil
}

// RebindIdentityIntact reports whether the swap id describes is wholly on
// disk: agent.yaml names its agent and device, secrets.yaml holds its three
// tokens and no staged rotation, and the client certificate is its own (none
// when it has none). Org and site are not compared: the #8320 identity sync
// owns them once the target is online.
func RebindIdentityIntact(cfgFile string, id RebindIdentity) (bool, error) {
	persistMu.Lock()
	defer persistMu.Unlock()
	return rebindIdentityIntactLocked(ResolveSavePath(cfgFile), id)
}

func rebindIdentityIntactLocked(cfgPath string, id RebindIdentity) (bool, error) {
	onDisk, err := readAgentIdentityAt(cfgPath)
	if err != nil {
		return false, err
	}
	if onDisk.AgentID != id.AgentID || onDisk.DeviceID != id.DeviceID {
		return false, nil
	}
	creds, err := readPersistedCredentialsAt(cfgPath)
	if err != nil {
		return false, err
	}
	if creds.AuthToken != id.AuthToken || creds.WatchdogAuthToken != id.WatchdogAuthToken ||
		creds.HelperAuthToken != id.HelperAuthToken || creds.PendingAuthToken != "" {
		return false, nil
	}
	sv, err := readSecretsFile(secretsFilePathFor(cfgPath))
	if err != nil {
		return false, err
	}
	certOnDisk := ""
	if sv != nil {
		certOnDisk = sv.GetString("mtls_cert_pem")
	}
	wantCert := ""
	if id.Certificate != nil {
		wantCert = id.Certificate.Certificate
	}
	return certOnDisk == wantCert, nil
}

type agentIdentityOnDisk struct {
	AgentID          string `yaml:"agent_id"`
	DeviceID         string `yaml:"device_id"`
	OrgID            string `yaml:"org_id"`
	SiteID           string `yaml:"site_id"`
	ReattachIntentID string `yaml:"reattach_intent_id"`
}

// reattachIntentKey records, in agent.yaml, the reattach whose identity the
// file holds (#8318). Cleared by enrollment.
const reattachIntentKey = "reattach_intent_id"

// reattachPinWarned is the last set of overridden fields warned about.
var reattachPinWarned atomic.Pointer[string]

// pinReattachedIdentity keeps, for a config whose agent.yaml holds a
// reattached identity, the file's agent id, device id, org and site over
// BREEZE_AGENT_ID / BREEZE_DEVICE_ID / BREEZE_ORG_ID / BREEZE_SITE_ID
// (viper's AutomaticEnv). Such values were set for the install as it was
// before the reattach; letting them win would pair the retired identity
// with the reattached credentials. It warns once per set of overridden
// fields, as identity_sync.go does for a pinned BREEZE_ORG_ID, and keeps
// the persisted identity. Without a reattach the environment still wins.
func pinReattachedIdentity(cfg *Config, agentYAML []byte) {
	var onDisk agentIdentityOnDisk
	if len(agentYAML) == 0 || yaml.Unmarshal(agentYAML, &onDisk) != nil || onDisk.ReattachIntentID == "" {
		return
	}
	var overridden []string
	keep := func(field *string, fromFile, env string) {
		if fromFile != "" && *field != fromFile {
			*field = fromFile
			overridden = append(overridden, env)
		}
	}
	keep(&cfg.AgentID, onDisk.AgentID, "BREEZE_AGENT_ID")
	keep(&cfg.DeviceID, onDisk.DeviceID, "BREEZE_DEVICE_ID")
	keep(&cfg.OrgID, onDisk.OrgID, "BREEZE_ORG_ID")
	keep(&cfg.SiteID, onDisk.SiteID, "BREEZE_SITE_ID")
	if len(overridden) == 0 {
		return
	}
	key := strings.Join(overridden, ",")
	if prev := reattachPinWarned.Swap(&key); prev == nil || *prev != key {
		log.Warn("this install was reattached to an existing device; ignoring environment values for its identity and keeping the one in agent.yaml",
			"ignored", key, "intentId", onDisk.ReattachIntentID)
	}
}

func readAgentIdentityAt(cfgPath string) (agentIdentityOnDisk, error) {
	var onDisk agentIdentityOnDisk
	raw, err := readConfigFileBytes(cfgPath)
	if err != nil {
		return onDisk, err
	}
	if err := yaml.Unmarshal(raw, &onDisk); err != nil {
		return onDisk, fmt.Errorf("parsing %s: %w", filepath.Base(cfgPath), err)
	}
	return onDisk, nil
}

// ApplyRebindIdentity swaps the agent's identity to a confirmed reattach
// (#8318 §6.4 "On 200"): agent id, device id, org, site, the three tokens and
// the client certificate. Every other setting is kept from disk. Any staged
// token rotation and pending certificate renewal belonged to the source and
// are dropped. The ownership epoch is left unset: neither the source's
// (another device's) nor an invented one. 0 is Config's "none received",
// which the heartbeat omits from its report, so the server's #8320 v2
// identity assertion supplies the target's real epoch on the first beat.
//
// Two saves, each write-new-then-rename: the first writes the NEW
// credentials (secrets.yaml, the helper token file) beside the OLD agent.yaml
// identity, the second the new agent.yaml identity, so agent_id changes last
// and never names the target beside the source's tokens. A crash in between
// leaves the staged set (still on disk) to re-apply the swap. Verified by
// reading both files back.
func ApplyRebindIdentity(cfgFile string, id RebindIdentity) error {
	if err := id.validate(); err != nil {
		return err
	}
	cfgPath := ResolveSavePath(cfgFile)

	persistMu.Lock()
	defer persistMu.Unlock()

	cfg, err := loadLocked(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	cfg.AuthToken = id.AuthToken
	cfg.WatchdogAuthToken = id.WatchdogAuthToken
	cfg.HelperAuthToken = id.HelperAuthToken
	cfg.PendingAuthToken, cfg.PendingWatchdogAuthToken, cfg.PendingHelperAuthToken = "", "", ""
	if id.Certificate != nil {
		cfg.MtlsCertPEM = id.Certificate.Certificate
		cfg.MtlsKeyPEM = id.Certificate.PrivateKey
		cfg.MtlsCertExpires = id.Certificate.ExpiresAt
	} else {
		cfg.MtlsCertPEM, cfg.MtlsKeyPEM, cfg.MtlsCertExpires = "", "", ""
	}
	cfg.PendingMTLSCertificate, cfg.PendingMTLSPrivateKey, cfg.PendingMTLSCertificateID = "", "", ""
	cfg.PendingMTLSExpiresAt = time.Time{}

	// Save 1: the new credentials; agent.yaml keeps the identity on disk.
	if err := rebindSaveFn(cfg, cfgPath, credentialsFromConfig, identityFromDisk); err != nil {
		return fmt.Errorf("writing the reattached credentials: %w", err)
	}

	// Save 2: the new identity, recorded as a reattach so the loader keeps
	// it over BREEZE_* environment values (reattachedIdentityPin). The marker
	// is set in viper for this save only: if it fails, it is put back, or a
	// later save would record it beside the source's ids and pin those.
	prevIntent := viper.Get(reattachIntentKey)
	viper.Set(reattachIntentKey, id.IntentID)
	cfg.AgentID = id.AgentID
	cfg.DeviceID = id.DeviceID
	cfg.OrgID = id.OrgID
	cfg.SiteID = id.SiteID
	cfg.OwnershipEpoch = 0 // unset: the server's v2 assertion sets it
	if err := rebindSaveFn(cfg, cfgPath, credentialsFromConfig, identityFromConfig); err != nil {
		viper.Set(reattachIntentKey, prevIntent)
		return fmt.Errorf("writing the reattached identity: %w", err)
	}

	return verifyRebindIdentityLocked(cfgPath, id)
}

func verifyRebindIdentityLocked(cfgPath string, id RebindIdentity) error {
	intact, err := rebindIdentityIntactLocked(cfgPath, id)
	if err != nil {
		return fmt.Errorf("verifying the reattached identity: %w", err)
	}
	if !intact {
		return errors.New("the reattached identity failed readback verification")
	}
	onDisk, err := readAgentIdentityAt(cfgPath)
	if err != nil {
		return fmt.Errorf("verifying the reattached identity: %w", err)
	}
	if onDisk.OrgID != id.OrgID || onDisk.SiteID != id.SiteID {
		return errors.New("the reattached org or site failed readback verification")
	}
	return nil
}

// FinishConfirmedRebind completes, at start-up and before anything reads the
// identity, a swap a previous process confirmed (spec §6.6, "Crash during the
// local swap"), and re-applies it when anything reverted it since (a write of
// an older process that landed after the swap). It reports whether the
// identity on disk changed, in which case the caller reloads its config.
//
// The staged set is not removed here: it stays until this process has
// authenticated as the target once (the heartbeat removes it then). A staged
// set in any other phase is left for the heartbeat to resume.
func FinishConfirmedRebind(cfgFile string) (bool, error) {
	s, err := ReadRebindStaged(cfgFile)
	if err != nil || s == nil || s.Phase != RebindPhaseConfirmed {
		return false, err
	}
	id, err := s.Identity()
	if err != nil {
		return false, err
	}
	intact, err := RebindIdentityIntact(cfgFile, id)
	if err != nil || intact {
		return false, err
	}
	if err := ApplyRebindIdentity(cfgFile, id); err != nil {
		return false, err
	}
	return true, nil
}
