// Package fakeserver is a minimal, test-only stand-in for the Breeze API's
// bare-metal recovery surface (POST /bmr/recover/exchange, /authenticate,
// /progress, and a GET download endpoint), used by the QEMU end-to-end
// proof (W04b Task 4). It is deliberately NOT the real server: no auth,
// one hardcoded recovery code, and a plain local-disk object store. Its
// only job is to give the recovery console and rebuild engine, running for
// real inside a QEMU guest, something to talk to.
//
// Wire formats mirror agent/internal/backup/bmr exactly (session.go,
// bootstrap.go, progress.go, download_provider.go) — see each handler's
// comment for the corresponding client-side code.
package fakeserver

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
)

// Config configures one fake recovery server instance.
type Config struct {
	// Code is the one-time recovery code the console must present to
	// /recover/exchange — analogous to the plaintext code a real operator
	// types in, normally minted by POST /backup/bmr/recoveries.
	Code string
	// SnapshotID is the id under StoreDir/snapshots/<id>/... that the
	// minted token's bootstrap points at.
	SnapshotID string
	// StoreDir is the object store root: StoreDir/snapshots/<id>/manifest.json,
	// layout.json, and files/... — see agent/recovery-media/e2e/seed-snapshot.sh.
	StoreDir string
	// RecoveryID/Nonce/Identity populate BootstrapResponse.Recovery exactly
	// like a real POST /bmr/recover/exchange does (bmr.RecoveryBinding).
	// Identity "original" requires a non-empty Nonce (the console/rebuild
	// marker check); "new" does not.
	RecoveryID string
	Nonce      string
	Identity   string
	// ProbeToken, when set, is pre-registered as an authenticated download
	// token so an out-of-band client (run-qemu.sh on the host) can issue
	// real /recover/download requests and prove the scope refusal fires over
	// the wire. Fake server only — never mirrored by the real API.
	ProbeToken string
	// MinHelperVersion is echoed on BootstrapResponse.MinHelperVersion —
	// the console's version gate compares its own version against this.
	MinHelperVersion string
	// ProgressLogPath is where every accepted /recover/progress status is
	// appended, one JSON line per call, in call order. run-qemu.sh reads
	// this back (as a JSON array of `status` values) to assert the console
	// drove the recovery through every expected phase.
	ProgressLogPath string
	// Capabilities are the capability strings this fake server GRANTS when
	// the client requests them (subset semantics, mirroring the real
	// server's negotiateRecoveryCapabilities). Empty means "grants
	// nothing" — a client that needs the membership capability (because
	// ReferencedSnapshotIDs is non-empty) is refused.
	Capabilities []string
	// ReferencedSnapshotIDs, when non-empty, makes bootstrapFor emit a
	// "complete" fileIndex computed from the manifest.json this fake
	// server already has on disk for SnapshotID, and makes
	// handleAuthenticate/handleExchange require the membership capability
	// from the client (409 client_capability_required otherwise).
	ReferencedSnapshotIDs []string
	// FaultTransportOnceKey, when non-empty, makes the FIRST /recover/download
	// whose key contains this substring fail at the TRANSPORT layer: the
	// response starts as a 200 with Content-Length, a partial body is sent,
	// and the connection is dropped — so the client sees an unexpected EOF
	// / reset with no HTTP status to branch on. Every later request for the
	// same key is served normally. This is the e2e stand-in for D-W09-3
	// (#6491 KIT lab: one presigned GET timed out at the transport 97,296
	// files into a 4-hour rebuild and the file was recorded failed without
	// a retry). run-qemu.sh points it at a referenced external key and
	// asserts the key was requested at least twice and the run still
	// validated. Fake server only — never mirrored by the real API.
	FaultTransportOnceKey string
}

// Server is the fake recovery server. Create with New, then serve its
// Handler (e.g. via http.ListenAndServe).
type Server struct {
	cfg    Config
	mu     sync.Mutex
	tokens map[string]bool // minted, not-yet-expired tokens

	manifestOnce sync.Once
	manifestSet  map[string]struct{} // backupPath set of the token snapshot's manifest

	faultMu    sync.Mutex
	faultFired bool
}

// TransportFaultFired reports whether the one-shot transport fault
// (Config.FaultTransportOnceKey) has already been injected.
func (s *Server) TransportFaultFired() bool {
	s.faultMu.Lock()
	defer s.faultMu.Unlock()
	return s.faultFired
}

// New builds a Server for cfg. Panics on an unusable config (test-only code
// — a misconfigured fake server should fail loudly and immediately, not
// serve wrong answers to a QEMU guest for 20 minutes before anyone notices).
func New(cfg Config) *Server {
	if cfg.Code == "" || cfg.SnapshotID == "" || cfg.StoreDir == "" || cfg.ProgressLogPath == "" {
		panic("fakeserver: Code, SnapshotID, StoreDir and ProgressLogPath are required")
	}
	if cfg.Identity == "" {
		cfg.Identity = "new"
	}
	if cfg.MinHelperVersion == "" {
		cfg.MinHelperVersion = "0.0.0"
	}
	if cfg.RecoveryID == "" {
		cfg.RecoveryID = "e2e-recovery-1"
	}
	srv := &Server{cfg: cfg, tokens: map[string]bool{}}
	if cfg.ProbeToken != "" {
		srv.tokens[cfg.ProbeToken] = true
	}
	return srv
}

// Handler returns the http.Handler serving every route this fake
// implements.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/backup/bmr/recover/exchange", s.handleExchange)
	mux.HandleFunc("/api/v1/backup/bmr/recover/authenticate", s.handleAuthenticate)
	mux.HandleFunc("/api/v1/backup/bmr/recover/progress", s.handleProgress)
	mux.HandleFunc("/api/v1/backup/bmr/recover/download", s.handleDownload)
	mux.HandleFunc("/api/v1/backup/bmr/recover/complete", s.handleComplete)
	return loggingMiddleware(mux)
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("fakeserver: %s %s", r.Method, r.URL.String())
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

// bootstrapPayload mirrors bmr.BootstrapResponse field-for-field (session.go
// imports that type directly in the real agent; the fake server can't
// import it back without a cyclic-ish test-only dependency, so this is a
// hand-kept mirror — see bmr.BootstrapResponse's own doc comment for the
// authoritative shape).
type bootstrapPayload struct {
	Version          int            `json:"version"`
	MinHelperVersion string         `json:"minHelperVersion"`
	TokenID          string         `json:"tokenId"`
	DeviceID         string         `json:"deviceId"`
	SnapshotID       string         `json:"snapshotId"`
	RestoreType      string         `json:"restoreType"`
	TargetConfig     map[string]any `json:"targetConfig"`
	Device           map[string]any `json:"device"`
	Snapshot         map[string]any `json:"snapshot"`
	Download         map[string]any `json:"download"`
	AuthenticatedAt  string         `json:"authenticatedAt"`
	Recovery         map[string]any `json:"recovery,omitempty"`
}

func (s *Server) newToken() string {
	// Real tokens are opaque random strings (bmr.generateRecoveryToken);
	// the fake just needs uniqueness within one run.
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	return "e2e_tok_" + hex.EncodeToString(buf)
}

// manifestEntry is the subset of backup.SnapshotFile the fake needs. Kind
// is "" (or omitted) for a regular file whose bytes live at BackupPath and
// "symlink"/"dir" for a content-less entry that legitimately carries
// BackupPath "" — see agent/internal/backup/snapshot.go.
type manifestEntry struct {
	SourcePath string `json:"sourcePath"`
	BackupPath string `json:"backupPath"`
	Kind       string `json:"kind"`
}

// validateManifest applies the SAME gate the real server's hydration does
// (apps/api/src/services/backupSnapshotFileIndex.ts): a content entry
// (kind "") must name its object — backupPath "" there is manifest_invalid
// — and every non-empty backupPath must pass the shared object-key contract
// (bmr.ParseObjectKey) or the whole manifest is manifest_key_invalid. A
// dir/symlink entry with backupPath "" is fine (D-W09-1). Failing closed
// here is what lets the QEMU e2e catch a manifest the real server would
// refuse (the KIT rig's real manifest failed both checks on 94d07c466 and
// the e2e passed because its fake accepted anything).
func validateManifest(files []manifestEntry) error {
	for _, f := range files {
		if f.BackupPath == "" {
			if f.Kind == "dir" || f.Kind == "symlink" {
				continue
			}
			return fmt.Errorf("manifest_invalid: content entry %q has an empty backupPath", f.SourcePath)
		}
		if _, ok := bmr.ParseObjectKey(f.BackupPath); !ok {
			return fmt.Errorf("manifest_key_invalid: unparseable backupPath %q", f.BackupPath)
		}
	}
	return nil
}

// computeFileIndex reads the seeded manifest.json for s.cfg.SnapshotID and
// returns its sha256 (hex) plus a count of file entries whose backupPath
// points outside this snapshot's own prefix (the fake server's stand-in
// for the real server's hydrated fileIndex.externalCount). It fails when
// the manifest would not pass the real server's hydration gate — see
// validateManifest.
func (s *Server) computeFileIndex() (sha string, externalCount int, err error) {
	data, err := os.ReadFile(filepath.Join(s.cfg.StoreDir, "snapshots", s.cfg.SnapshotID, "manifest.json"))
	if err != nil {
		return "", 0, err
	}
	sum := sha256.Sum256(data)
	var m struct {
		Files []manifestEntry `json:"files"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return "", 0, err
	}
	if err := validateManifest(m.Files); err != nil {
		return "", 0, err
	}
	own := "snapshots/" + s.cfg.SnapshotID + "/"
	for _, f := range m.Files {
		if f.BackupPath != "" && !strings.HasPrefix(f.BackupPath, own) {
			externalCount++
		}
	}
	return hex.EncodeToString(sum[:]), externalCount, nil
}

// fileIndexRefusal mirrors negotiateRecoveryCapabilities' 409
// snapshot_index_failed: when references exist, the membership capability
// was requested, and the manifest fails the hydration gate, the real
// server refuses the session rather than handing out a fileIndex it could
// not build. Returns false when there is nothing to refuse.
func (s *Server) fileIndexRefusal(clientCapabilities []string) (string, bool) {
	if len(s.cfg.ReferencedSnapshotIDs) == 0 || !bmr.HasCapability(clientCapabilities, bmr.CapabilitySnapshotFileMembershipV1) {
		return "", false
	}
	if _, _, err := s.computeFileIndex(); err != nil {
		log.Printf("fakeserver: refusing session, manifest fails the hydration gate: %v", err)
		return "snapshot_index_failed", true
	}
	return "", false
}

// intersectCapabilities returns the capability strings present in both
// client and granted (order follows granted, mirroring "what the server is
// willing to give, filtered by what the client asked for").
func intersectCapabilities(client, granted []string) []string {
	var out []string
	for _, g := range granted {
		if bmr.HasCapability(client, g) {
			out = append(out, g)
		}
	}
	return out
}

func (s *Server) bootstrapFor(tokenID string, clientCapabilities []string) bootstrapPayload {
	recovery := map[string]any{
		"id":         s.cfg.RecoveryID,
		"identity":   s.cfg.Identity,
		"deviceId":   "e2e-device-1",
		"snapshotId": s.cfg.SnapshotID,
	}
	if s.cfg.Identity == "original" {
		recovery["nonce"] = s.cfg.Nonce
	}

	granted := intersectCapabilities(clientCapabilities, s.cfg.Capabilities)
	download := map[string]any{
		"type":                   "http",
		"method":                 "GET",
		"url":                    "/api/v1/backup/bmr/recover/download",
		"tokenQueryParam":        "token",
		"pathQueryParam":         "path",
		"requiresAuthentication": true,
		"pathPrefix":             "snapshots/" + s.cfg.SnapshotID,
		"expiresAt":              "",
		"capabilities":           granted,
	}
	snapshot := map[string]any{
		"id":         s.cfg.SnapshotID,
		"snapshotId": s.cfg.SnapshotID,
		"size":       0,
		"fileCount":  0,
	}
	if len(s.cfg.ReferencedSnapshotIDs) > 0 && bmr.HasCapability(granted, bmr.CapabilitySnapshotFileMembershipV1) {
		sha, externalCount, err := s.computeFileIndex()
		if err == nil {
			snapshot["fileIndex"] = map[string]any{
				"status":            "complete",
				"manifestSha256":    sha,
				"externalCount":     externalCount,
				"originSnapshotIds": s.cfg.ReferencedSnapshotIDs,
			}
		} else {
			log.Printf("fakeserver: computeFileIndex: %v", err)
		}
	}

	return bootstrapPayload{
		Version:          1,
		MinHelperVersion: s.cfg.MinHelperVersion,
		TokenID:          tokenID,
		DeviceID:         "e2e-device-1",
		SnapshotID:       s.cfg.SnapshotID,
		RestoreType:      "bare_metal",
		TargetConfig:     map[string]any{},
		Device: map[string]any{
			"id":       "e2e-device-1",
			"hostname": "e2e-source",
			"osType":   "linux",
		},
		Snapshot:        snapshot,
		Download:        download,
		AuthenticatedAt: nowRFC3339(),
		Recovery:        recovery,
	}
}

// handleExchange mirrors POST /api/v1/backup/bmr/recover/exchange
// (bmr.ExchangeRecoveryCode's client): {"code": "..."} -> {"token": "...",
// "bootstrap": {...}}. Also appends "media_booted" to the progress log —
// the real server sets bare_metal_recoveries.status = 'media_booted' as
// part of the exchange transaction itself (bmrRecoveries.ts), never via a
// client-posted progress call; the fake mirrors that side effect here so
// run-qemu.sh's progress.json assertion (media_booted first) matches
// reality without the console ever calling /progress for it.
func (s *Server) handleExchange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	var body struct {
		Code         string   `json:"code"`
		Capabilities []string `json:"capabilities,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body")
		return
	}
	if strings.TrimSpace(body.Code) != s.cfg.Code {
		writeError(w, http.StatusNotFound, "code_invalid")
		return
	}
	// Refuse before the code is consumed / token minted, matching Part 0
	// §1's "code NOT consumed" requirement for R2.
	if len(s.cfg.ReferencedSnapshotIDs) > 0 && !bmr.HasCapability(body.Capabilities, bmr.CapabilitySnapshotFileMembershipV1) {
		writeError(w, http.StatusConflict, "client_capability_required")
		return
	}
	// Also before the code is consumed: the real server's
	// negotiateRecoveryCapabilities refuses snapshot_index_failed at the
	// same point when the manifest could not be hydrated.
	if code, refuse := s.fileIndexRefusal(body.Capabilities); refuse {
		writeError(w, http.StatusConflict, code)
		return
	}

	token := s.newToken()
	s.mu.Lock()
	s.tokens[token] = true
	s.mu.Unlock()

	s.appendProgress(progressRecord{Status: "media_booted"})

	// Mirror the REAL exchange response shape (apps/api
	// bmrRecoveries.ts → buildAuthenticatedBootstrapPayload): `bootstrap` is
	// the authenticate envelope — flat legacy fields plus a nested versioned
	// `bootstrap` that carries download/recovery. The e2e previously sent the
	// inner object directly, which hid the console's envelope-decoding bug
	// until the first run against a real API.
	inner := s.bootstrapFor("e2e-token-1", body.Capabilities)
	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"bootstrap": map[string]any{
			"version":          inner.Version,
			"minHelperVersion": inner.MinHelperVersion,
			"tokenId":          inner.TokenID,
			"deviceId":         inner.DeviceID,
			"snapshotId":       inner.SnapshotID,
			"restoreType":      inner.RestoreType,
			"targetConfig":     inner.TargetConfig,
			"device":           inner.Device,
			"snapshot":         inner.Snapshot,
			"authenticatedAt":  inner.AuthenticatedAt,
			"bootstrap":        inner,
		},
	})
}

// handleAuthenticate mirrors POST /api/v1/backup/bmr/recover/authenticate:
// {"token": "..."} -> {"bootstrap": {...}}. Used by
// bmr.AuthenticateRecoverySession/NewRecoveryProvider if the console's
// Deps.Provider re-authenticates; not exercised by the console's own
// Exchange->Provider flow directly (which uses the exchange response's
// bootstrap in-memory), but kept for parity with real recovery tokens and
// for recoveryDownloadProvider's session refresh (proactive before
// expiresAt, reactive on 401).
func (s *Server) handleAuthenticate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	var body struct {
		Token        string   `json:"token"`
		Capabilities []string `json:"capabilities,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body")
		return
	}
	s.mu.Lock()
	ok := s.tokens[body.Token]
	s.mu.Unlock()
	if !ok {
		writeError(w, http.StatusUnauthorized, "invalid_token")
		return
	}
	if len(s.cfg.ReferencedSnapshotIDs) > 0 && !bmr.HasCapability(body.Capabilities, bmr.CapabilitySnapshotFileMembershipV1) {
		writeError(w, http.StatusConflict, "client_capability_required")
		return
	}
	if code, refuse := s.fileIndexRefusal(body.Capabilities); refuse {
		writeError(w, http.StatusConflict, code)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bootstrap": s.bootstrapFor("e2e-token-1", body.Capabilities)})
}

type progressRecord struct {
	Status string `json:"status"`
}

// handleProgress mirrors POST /api/v1/backup/bmr/recover/progress
// (bmr.PostRecoveryProgress / ProgressUpdate): records status to
// ProgressLogPath and always returns 200 (the real endpoint's 409
// invalid_transition case is not modeled — the fake trusts the console to
// post phases in order, which is exactly what it's here to prove).
func (s *Server) handleProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	var body struct {
		Token  string `json:"token"`
		Status string `json:"status"`
		Reason string `json:"reason,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body")
		return
	}
	s.appendProgress(progressRecord{Status: body.Status})
	writeJSON(w, http.StatusOK, map[string]any{"status": body.Status})
}

// handleComplete mirrors POST /api/v1/backup/bmr/recover/complete — not on
// the bare-metal recovery-console's own call path (that's rebuild_cmd.go's
// --token mode, W04a), but bmr.RunRecoveryWithTokenContext dials it
// unconditionally in some code paths; accepted here as a harmless no-op so
// nothing 404s if it is ever hit.
func (s *Server) handleComplete(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDownload mirrors the recovery download endpoint
// (recoveryDownloadProvider.downloadOnce's target): GET
// ?path=<key>&token=<token> streams StoreDir/<key> verbatim. No
// compression handling (see agent/recovery-media/e2e/seed-snapshot.sh —
// the seeded store never gzips content, matching how every REAL provider
// except LocalProvider stores objects, so streaming raw bytes here is
// the faithful behavior to test against).
func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	token := r.URL.Query().Get("token")
	s.mu.Lock()
	ok := s.tokens[token]
	s.mu.Unlock()
	if !ok {
		writeError(w, http.StatusUnauthorized, "invalid_token")
		return
	}

	key := r.URL.Query().Get("path")
	prefix := "snapshots/" + s.cfg.SnapshotID
	if key != prefix && !strings.HasPrefix(key, prefix+"/") {
		if !s.externalKeyReferenced(key) {
			log.Printf("fakeserver: download refused (not_authorized): %s", key)
			writeError(w, http.StatusConflict, "not_authorized")
			return
		}
	}

	full, err := containedPath(s.cfg.StoreDir, key)
	if err != nil {
		writeError(w, http.StatusForbidden, "invalid_path")
		return
	}
	f, err := os.Open(full)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "object_not_found")
			return
		}
		writeError(w, http.StatusInternalServerError, "read_failed")
		return
	}
	defer func() { _ = f.Close() }()
	w.Header().Set("Content-Type", "application/octet-stream")
	if s.shouldInjectTransportFault(key) {
		s.injectTransportFault(w, f, key)
		return
	}
	if _, err := io.Copy(w, f); err != nil {
		log.Printf("fakeserver: download %s: copy failed: %v", key, err)
	}
}

// shouldInjectTransportFault claims the one-shot fault for key when it
// matches Config.FaultTransportOnceKey and nothing has claimed it yet.
func (s *Server) shouldInjectTransportFault(key string) bool {
	if s.cfg.FaultTransportOnceKey == "" || !strings.Contains(key, s.cfg.FaultTransportOnceKey) {
		return false
	}
	s.faultMu.Lock()
	defer s.faultMu.Unlock()
	if s.faultFired {
		return false
	}
	s.faultFired = true
	return true
}

// injectTransportFault announces the full object (200 + Content-Length),
// writes at most half of it, flushes, then hijacks and closes the TCP
// connection so the client's body read fails with an unexpected EOF /
// connection reset — a transport-class failure with no HTTP status. If the
// ResponseWriter cannot be hijacked the fault is logged as NOT injected and
// the object is served normally, so the e2e's log assertion fails loudly
// rather than the run silently passing without the fault.
func (s *Server) injectTransportFault(w http.ResponseWriter, f *os.File, key string) {
	info, err := f.Stat()
	if err != nil {
		log.Printf("fakeserver: transport fault: stat %s: %v", key, err)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		log.Printf("fakeserver: transport fault NOT injected (ResponseWriter is not hijackable): %s", key)
		_, _ = io.Copy(w, f)
		return
	}
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.CopyN(w, f, info.Size()/2)
	if fl, ok := w.(http.Flusher); ok {
		fl.Flush()
	}
	conn, _, err := hj.Hijack()
	if err != nil {
		log.Printf("fakeserver: transport fault: hijack %s: %v", key, err)
		return
	}
	_ = conn.Close()
	log.Printf("fakeserver: transport fault injected (connection dropped mid-body): %s", key)
}

// externalKeyReferenced reports whether key belongs to one of the seeded
// ReferencedSnapshotIDs generations — the fake server's stand-in for the
// real server's backup_snapshot_files/backup_snapshot_origins membership
// check.
func (s *Server) externalKeyReferenced(key string) bool {
	// Exact membership, never prefix widening (Part 0 Global Constraints):
	// an external key is admissible only if the token snapshot's own
	// manifest names it verbatim AND it lives under one of the configured
	// origin ids. A sibling object under a referenced origin's prefix that
	// no manifest entry names (e2e's not-referenced.gz) must be refused.
	underOrigin := false
	for _, id := range s.cfg.ReferencedSnapshotIDs {
		if strings.HasPrefix(key, "snapshots/"+id+"/") {
			underOrigin = true
			break
		}
	}
	if !underOrigin {
		return false
	}
	_, ok := s.manifestKeys()[key]
	return ok
}

// manifestKeys returns the set of backupPath values in the token
// snapshot's manifest (loaded once; the store is immutable for a run).
func (s *Server) manifestKeys() map[string]struct{} {
	s.manifestOnce.Do(func() {
		s.manifestSet = map[string]struct{}{}
		data, err := os.ReadFile(filepath.Join(s.cfg.StoreDir, "snapshots", s.cfg.SnapshotID, "manifest.json"))
		if err != nil {
			log.Printf("fakeserver: manifest for membership check unavailable: %v", err)
			return
		}
		var m struct {
			Files []manifestEntry `json:"files"`
		}
		if err := json.Unmarshal(data, &m); err != nil {
			log.Printf("fakeserver: manifest for membership check invalid: %v", err)
			return
		}
		if err := validateManifest(m.Files); err != nil {
			// Same gate as computeFileIndex: a manifest the real server
			// would refuse to hydrate must not widen anything.
			log.Printf("fakeserver: manifest for membership check fails the hydration gate: %v", err)
			return
		}
		for _, f := range m.Files {
			if f.BackupPath != "" {
				s.manifestSet[f.BackupPath] = struct{}{}
			}
		}
	})
	return s.manifestSet
}

// appendProgress appends one status to ProgressLogPath as a JSON array,
// read-modify-write under the server's own mutex (call volume here is a
// handful of calls across one recovery — no concurrency concern).
func (s *Server) appendProgress(rec progressRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var statuses []string
	if data, err := os.ReadFile(s.cfg.ProgressLogPath); err == nil {
		_ = json.Unmarshal(data, &statuses)
	}
	statuses = append(statuses, rec.Status)
	data, err := json.MarshalIndent(statuses, "", "  ")
	if err != nil {
		log.Printf("fakeserver: marshal progress log: %v", err)
		return
	}
	if err := os.WriteFile(s.cfg.ProgressLogPath, data, 0o644); err != nil {
		log.Printf("fakeserver: write progress log: %v", err)
	}
}

// containedPath resolves key under root, refusing to escape it (the same
// contract providers.LocalProvider's own containedPath gives — this is a
// separate, test-only copy since that one is unexported).
// containedPath resolves an object key under the store root. Keys are
// always relative, slash-separated object names under snapshots/<id>/, so
// anything absolute, empty, or containing a ".." segment is rejected
// outright. The ".." test is a plain strings.Contains on purpose: that is
// the guard shape CodeQL's go/path-injection query recognises as a
// sanitiser (a per-segment loop was still flagged on this PR). Object
// keys are content hashes and fixed names, so a literal ".." never
// appears in a legitimate key. The prefix check that follows is
// belt-and-braces for symlink-free roots.
func containedPath(root, key string) (string, error) {
	if key == "" || strings.HasPrefix(key, "/") || filepath.IsAbs(key) {
		return "", fmt.Errorf("fakeserver: path %q is not a relative object key", key)
	}
	if strings.Contains(key, "..") {
		return "", fmt.Errorf("fakeserver: path %q contains a parent segment", key)
	}
	full := filepath.Join(root, filepath.FromSlash(key))
	rootClean := filepath.Clean(root) + string(filepath.Separator)
	if !strings.HasPrefix(filepath.Clean(full)+string(filepath.Separator), rootClean) {
		return "", fmt.Errorf("fakeserver: path %q escapes store root", key)
	}
	return full, nil
}

func nowRFC3339() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05Z07:00")
}
