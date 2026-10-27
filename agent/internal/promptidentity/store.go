// Package promptidentity caches the MSP identity every on-device prompt is
// drawn under (#10190, spec §3.6, plan Task 3.3). The server resolves it
// (`resolvePromptIdentity`) and sends it as the heartbeat response block
// `promptIdentity` to agents that report
// securityCapabilities.promptIdentityProtocolVersion = ProtocolVersion. The
// block shape is packages/shared/src/promptCatalog/identity.ts, pinned by
// fixtures/prompt-catalog/heartbeat-identity.*.json.
//
// Semantics:
//   - state "set" stores the identity; "cleared" deletes it; an absent block
//     keeps the last-known one, so a device keeps its MSP name offline and
//     across restarts.
//   - A scopeId change (org move, partner change) runs Options.OnScopeChange
//     with the old scope (the prompt list purges entries created under it)
//     before the new identity is stored. A re-enrolment calls Clear, which
//     remembers the scope it dropped, so the next "set" under the new
//     enrolment purges the old scope even though the enrol command ran in
//     another process.
//   - The partner name is sanitized again here (promptcatalog.SanitizeIdentityName);
//     an empty result means the localized generic name.
//   - Logo bytes come only from FetchLogo over the agent's authenticated API
//     channel, are checked against the announced sha256, size and type, and
//     a failure keeps the last-known logo of the same scope.
//
// Files: <data dir>/branding/identity.json and logo.bin, written atomically,
// SYSTEM/root-owned and readable by users (config.WriteUserReadableFile).
package promptidentity

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
)

// ProtocolVersion is reported as securityCapabilities.promptIdentityProtocolVersion.
const ProtocolVersion = 1

// MaxLogoBytes caps the logo (spec §3.6: 256 KB).
const MaxLogoBytes = 262144

// Block states.
const (
	StateSet     = "set"
	StateCleared = "cleared"
)

// On-disk layout under the agent data directory.
const (
	DirName      = "branding"
	IdentityFile = "identity.json"
	LogoFile     = "logo.bin"
)

var (
	// ErrInvalidBlock: the heartbeat block failed validation; nothing changed.
	ErrInvalidBlock = errors.New("promptidentity: invalid promptIdentity block")
	// ErrStaleLogo: the sha is not the current identity's logo.
	ErrStaleLogo = errors.New("promptidentity: logo sha is not current")
	// ErrLogoMismatch: the fetched bytes do not match the announced logo.
	ErrLogoMismatch = errors.New("promptidentity: fetched logo does not match")
	// ErrNoFetcher: the store was opened without a logo fetcher.
	ErrNoFetcher = errors.New("promptidentity: no logo fetcher")
)

var (
	scopeIDRE = regexp.MustCompile(`^[0-9a-f]{32}$`)
	colorRE   = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
	sha256RE  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	logoMimes = map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true}
)

// LogoMeta describes a logo (heartbeat block `logo`; no bytes).
type LogoMeta struct {
	Sha256 string `json:"sha256"`
	Mime   string `json:"mime"`
	Bytes  int    `json:"bytes"`
}

// HeartbeatBlock is the heartbeat response block `promptIdentity`.
type HeartbeatBlock struct {
	State        string    `json:"state"`
	ScopeID      string    `json:"scopeId,omitempty"`
	PartnerName  string    `json:"partnerName,omitempty"`
	PrimaryColor string    `json:"primaryColor,omitempty"`
	Logo         *LogoMeta `json:"logo,omitempty"`
}

// DecodeBlock decodes the raw block. Absent or null returns (nil, nil): keep
// the last-known identity. Unknown keys are ignored.
func DecodeBlock(raw []byte) (*HeartbeatBlock, error) {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || bytes.Equal(t, []byte("null")) {
		return nil, nil
	}
	var b HeartbeatBlock
	if err := json.Unmarshal(t, &b); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidBlock, err)
	}
	return &b, nil
}

func (b *HeartbeatBlock) validate() error {
	switch b.State {
	case StateCleared:
		return nil
	case StateSet:
	default:
		return fmt.Errorf("%w: unknown state %q", ErrInvalidBlock, b.State)
	}
	if !scopeIDRE.MatchString(b.ScopeID) {
		return fmt.Errorf("%w: scopeId is not 32 lowercase hex characters", ErrInvalidBlock)
	}
	if b.PrimaryColor != "" && !colorRE.MatchString(b.PrimaryColor) {
		return fmt.Errorf("%w: primaryColor is not #RRGGBB", ErrInvalidBlock)
	}
	if l := b.Logo; l != nil {
		if !sha256RE.MatchString(l.Sha256) || !logoMimes[l.Mime] || l.Bytes < 1 || l.Bytes > MaxLogoBytes {
			return fmt.Errorf("%w: logo metadata", ErrInvalidBlock)
		}
	}
	return nil
}

// Logo is a verified logo.
type Logo struct {
	Sha256 string
	Mime   string
	Data   []byte
}

// Identity is the cached MSP identity.
type Identity struct {
	ScopeID string
	// PartnerName is sanitized; "" means the localized generic name.
	PartnerName  string
	PrimaryColor string
	// Logo is the last-known verified logo of this scope (nil = none yet).
	Logo *Logo
}

// Options configure a store.
type Options struct {
	// Fetch returns the logo bytes for sha over the authenticated API
	// channel (nil = FetchLogo fails with ErrNoFetcher).
	Fetch func(ctx context.Context, sha string) ([]byte, error)
	// OnScopeChange runs with the old scope before an identity under another
	// scope is stored. It must not call back into the store.
	OnScopeChange func(oldScope string)
	Log           *slog.Logger

	// Test seams; production uses the config package's user-readable writers.
	writeFile func(path string, data []byte) error
	prepDir   func(dir string) error
}

// persisted is identity.json.
type persisted struct {
	Version  int                `json:"version"`
	Identity *persistedIdentity `json:"identity,omitempty"`
	// PreviousScopeID is the scope last dropped by Clear or "cleared", so a
	// later identity under another scope still purges it.
	PreviousScopeID string `json:"previousScopeId,omitempty"`
}

type persistedIdentity struct {
	ScopeID      string `json:"scopeId"`
	PartnerName  string `json:"partnerName,omitempty"`
	PrimaryColor string `json:"primaryColor,omitempty"`
	// Logo is the logo the server announced; StoredLogo the one in logo.bin.
	Logo       *LogoMeta `json:"logo,omitempty"`
	StoredLogo *LogoMeta `json:"storedLogo,omitempty"`
}

// Store is the identity cache. Safe for concurrent use.
type Store struct {
	dir  string
	opts Options
	log  *slog.Logger

	mu     sync.Mutex
	cur    *persistedIdentity
	prev   string
	logo   []byte // bytes of cur.StoredLogo, verified
	onDisk bool   // identity.json exists (Clear writes only when it does)
	// dirty: the last write failed; the in-memory state is retried on the
	// next Apply (dirtyLogo: logo.bin still has to be removed).
	dirty     bool
	dirtyLogo bool
	fetchMu   sync.Mutex
}

// Open loads the cache from <dataDir>/branding. A missing, unreadable or
// corrupt file is an empty cache (logged); the next write replaces it.
func Open(dataDir string, opts Options) *Store {
	if opts.writeFile == nil {
		opts.writeFile = config.WriteUserReadableFile
	}
	if opts.prepDir == nil {
		opts.prepDir = config.EnsureUserReadableDir
	}
	s := &Store{dir: filepath.Join(dataDir, DirName), opts: opts, log: opts.Log}
	if s.log == nil {
		s.log = logging.L("promptidentity")
	}
	s.load()
	return s
}

func (s *Store) load() {
	raw, err := os.ReadFile(filepath.Join(s.dir, IdentityFile))
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			s.log.Warn("prompt identity cache unreadable; starting without one", "error", err.Error())
		}
		return
	}
	s.onDisk = true
	var p persisted
	if err := json.Unmarshal(raw, &p); err != nil {
		// Keep the scope the file held, if one is still legible, so the next
		// identity under another scope still purges its prompt entries.
		s.prev = salvageScope(raw)
		s.log.Warn("prompt identity cache corrupt; starting without one", "error", err.Error(), "recoveredScopeId", s.prev)
		return
	}
	if scopeIDRE.MatchString(p.PreviousScopeID) {
		s.prev = p.PreviousScopeID
	} else if p.PreviousScopeID != "" {
		s.log.Warn("prompt identity cache has an invalid previousScopeId; ignoring it")
	}
	id := p.Identity
	if id == nil {
		return
	}
	if !scopeIDRE.MatchString(id.ScopeID) {
		s.log.Warn("prompt identity cache has an invalid scopeId; starting without an identity")
		return
	}
	// Re-sanitize on load too: the file is user-readable, not user-writable,
	// but the name is a spoofing control.
	id.PartnerName = promptcatalog.SanitizeIdentityName(id.PartnerName)
	if id.PrimaryColor != "" && !colorRE.MatchString(id.PrimaryColor) {
		id.PrimaryColor = ""
	}
	s.cur = id
	if sl := id.StoredLogo; sl != nil {
		data, err := os.ReadFile(filepath.Join(s.dir, LogoFile))
		if err == nil {
			err = verifyLogo(data, sl.Sha256, sl.Mime)
		}
		if err == nil {
			s.logo = data
		} else {
			s.log.Warn("stored MSP logo did not load; showing no logo until it is fetched again", "error", err.Error())
			id.StoredLogo = nil
		}
	}
}

// salvageRE finds a scope id in a damaged identity.json (identity.scopeId or
// previousScopeId).
var salvageRE = regexp.MustCompile(`"(?:scopeId|previousScopeId)"\s*:\s*"([0-9a-f]{32})"`)

func salvageScope(raw []byte) string {
	if m := salvageRE.FindSubmatch(raw); m != nil {
		return string(m[1])
	}
	return ""
}

// Current returns the cached identity, or false when there is none.
func (s *Store) Current() (Identity, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur == nil {
		return Identity{}, false
	}
	id := Identity{ScopeID: s.cur.ScopeID, PartnerName: s.cur.PartnerName, PrimaryColor: s.cur.PrimaryColor}
	if sl := s.cur.StoredLogo; sl != nil && s.logo != nil {
		id.Logo = &Logo{Sha256: sl.Sha256, Mime: sl.Mime, Data: append([]byte(nil), s.logo...)}
	}
	return id, true
}

// LastScopeID is the scope of the current identity, or the scope last
// dropped by Clear / "cleared" ("" = none ever).
func (s *Store) LastScopeID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastScopeLocked()
}

func (s *Store) lastScopeLocked() string {
	if s.cur != nil {
		return s.cur.ScopeID
	}
	return s.prev
}

// NeedsLogo returns the announced logo sha when its bytes are not stored yet.
func (s *Store) NeedsLogo() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur == nil || s.cur.Logo == nil {
		return "", false
	}
	if s.cur.StoredLogo != nil && s.cur.StoredLogo.Sha256 == s.cur.Logo.Sha256 {
		return "", false
	}
	return s.cur.Logo.Sha256, true
}

// Apply applies a heartbeat block: set stores, cleared deletes, nil keeps.
// changed reports a difference in the effective identity; scopeChanged that
// an identity under another scope replaced the last one (OnScopeChange ran
// with the old scope first). A block that fails validation changes nothing
// and returns ErrInvalidBlock. A write failure is returned with the flags of
// the change, which is in force in memory.
func (s *Store) Apply(b *HeartbeatBlock) (changed, scopeChanged bool, err error) {
	if b == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		return false, false, s.retryLocked()
	}
	if err := b.validate(); err != nil {
		return false, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if b.State == StateCleared {
		if s.cur == nil {
			return false, false, s.retryLocked()
		}
		s.prev = s.cur.ScopeID
		s.cur = nil
		s.logo = nil
		return true, false, s.saveLocked(true)
	}

	next := &persistedIdentity{
		ScopeID:      b.ScopeID,
		PartnerName:  promptcatalog.SanitizeIdentityName(b.PartnerName),
		PrimaryColor: b.PrimaryColor,
	}
	if b.Logo != nil {
		l := *b.Logo
		next.Logo = &l
	}
	last := s.lastScopeLocked()
	scopeChanged = last != "" && last != next.ScopeID
	if scopeChanged && s.opts.OnScopeChange != nil {
		s.opts.OnScopeChange(last)
	}

	// Keep the stored logo only within the same scope and while the server
	// still announces a logo; a new sha keeps the last-known one until its
	// bytes are fetched.
	dropLogo := true
	if !scopeChanged && s.cur != nil && s.cur.StoredLogo != nil && next.Logo != nil && s.logo != nil {
		sl := *s.cur.StoredLogo
		next.StoredLogo = &sl
		dropLogo = false
	}
	changed = s.cur == nil || !sameIdentity(s.cur, next)
	if !changed {
		return false, false, s.retryLocked()
	}
	s.cur = next
	s.prev = ""
	if dropLogo {
		s.logo = nil
	}
	return true, scopeChanged, s.saveLocked(dropLogo)
}

func sameIdentity(a, b *persistedIdentity) bool {
	return a.ScopeID == b.ScopeID && a.PartnerName == b.PartnerName && a.PrimaryColor == b.PrimaryColor &&
		sameMeta(a.Logo, b.Logo) && sameMeta(a.StoredLogo, b.StoredLogo)
}

func sameMeta(a, b *LogoMeta) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// Clear drops the identity and its logo (re-enrolment). The dropped scope
// is remembered so the next identity under another scope purges it. A store
// that never held anything writes nothing.
func (s *Store) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur == nil && !s.onDisk {
		return nil
	}
	if s.cur != nil {
		s.prev = s.cur.ScopeID
	}
	s.cur = nil
	s.logo = nil
	return s.saveLocked(true)
}

// FetchLogo fetches the current identity's logo, verifies it (sha256, at
// most MaxLogoBytes, PNG / JPEG / WebP magic matching the announced type)
// and stores it. Any failure keeps the last-known logo.
func (s *Store) FetchLogo(ctx context.Context, sha string) error {
	s.fetchMu.Lock()
	defer s.fetchMu.Unlock()

	s.mu.Lock()
	if s.cur == nil || s.cur.Logo == nil || s.cur.Logo.Sha256 != sha {
		s.mu.Unlock()
		return ErrStaleLogo
	}
	want := *s.cur.Logo
	scope := s.cur.ScopeID
	s.mu.Unlock()

	if s.opts.Fetch == nil {
		return ErrNoFetcher
	}
	data, err := s.opts.Fetch(ctx, sha)
	if err != nil {
		return fmt.Errorf("promptidentity: fetch logo: %w", err)
	}
	if err := verifyLogo(data, want.Sha256, want.Mime); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	// The identity may have moved on while the fetch ran.
	if s.cur == nil || s.cur.ScopeID != scope || s.cur.Logo == nil || *s.cur.Logo != want {
		return ErrStaleLogo
	}
	if err := s.prepDirLocked(); err != nil {
		return err
	}
	if err := s.opts.writeFile(filepath.Join(s.dir, LogoFile), data); err != nil {
		return fmt.Errorf("promptidentity: write logo: %w", err)
	}
	stored := want
	stored.Bytes = len(data)
	s.cur.StoredLogo = &stored
	s.logo = append([]byte(nil), data...)
	return s.saveLocked(false)
}

func verifyLogo(data []byte, sha, mime string) error {
	if len(data) == 0 || len(data) > MaxLogoBytes {
		return fmt.Errorf("%w: %d bytes", ErrLogoMismatch, len(data))
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != sha {
		return fmt.Errorf("%w: sha256", ErrLogoMismatch)
	}
	if sniffLogoMime(data) != mime {
		return fmt.Errorf("%w: not %s", ErrLogoMismatch, mime)
	}
	return nil
}

// sniffLogoMime reads the magic bytes the server checked (spec §3.6).
func sniffLogoMime(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}):
		return "image/png"
	case bytes.HasPrefix(b, []byte{0xff, 0xd8, 0xff}):
		return "image/jpeg"
	case len(b) >= 12 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp"
	}
	return ""
}

func (s *Store) prepDirLocked() error {
	if err := s.opts.prepDir(s.dir); err != nil {
		return fmt.Errorf("promptidentity: prepare %s: %w", DirName, err)
	}
	return nil
}

// retryLocked re-writes the in-memory state when an earlier write failed
// (an identical heartbeat block reports no change, so it would otherwise
// never be persisted).
func (s *Store) retryLocked() error {
	if !s.dirty {
		return nil
	}
	return s.saveLocked(false)
}

// saveLocked writes identity.json (and removes logo.bin when removeLogo, or
// when an earlier failed save still owes the removal). A failure marks the
// store dirty for retryLocked.
func (s *Store) saveLocked(removeLogo bool) error {
	removeLogo = removeLogo || s.dirtyLogo
	if err := s.writeLocked(removeLogo); err != nil {
		s.dirty, s.dirtyLogo = true, removeLogo
		return err
	}
	s.dirty, s.dirtyLogo = false, false
	return nil
}

func (s *Store) writeLocked(removeLogo bool) error {
	if err := s.prepDirLocked(); err != nil {
		return err
	}
	raw, err := json.Marshal(persisted{Version: 1, Identity: s.cur, PreviousScopeID: s.prev})
	if err != nil {
		return err
	}
	if err := s.opts.writeFile(filepath.Join(s.dir, IdentityFile), raw); err != nil {
		return fmt.Errorf("promptidentity: write identity: %w", err)
	}
	s.onDisk = true
	if removeLogo {
		if err := os.Remove(filepath.Join(s.dir, LogoFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("promptidentity: remove logo: %w", err)
		}
	}
	return nil
}
