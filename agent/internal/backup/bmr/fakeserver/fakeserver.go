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
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
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
	// MinHelperVersion is echoed on BootstrapResponse.MinHelperVersion —
	// the console's version gate compares its own version against this.
	MinHelperVersion string
	// ProgressLogPath is where every accepted /recover/progress status is
	// appended, one JSON line per call, in call order. run-qemu.sh reads
	// this back (as a JSON array of `status` values) to assert the console
	// drove the recovery through every expected phase.
	ProgressLogPath string
}

// Server is the fake recovery server. Create with New, then serve its
// Handler (e.g. via http.ListenAndServe).
type Server struct {
	cfg    Config
	mu     sync.Mutex
	tokens map[string]bool // minted, not-yet-expired tokens
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
	return &Server{cfg: cfg, tokens: map[string]bool{}}
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

func (s *Server) bootstrapFor(tokenID string) bootstrapPayload {
	recovery := map[string]any{
		"id":         s.cfg.RecoveryID,
		"identity":   s.cfg.Identity,
		"deviceId":   "e2e-device-1",
		"snapshotId": s.cfg.SnapshotID,
	}
	if s.cfg.Identity == "original" {
		recovery["nonce"] = s.cfg.Nonce
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
		Snapshot: map[string]any{
			"id":         s.cfg.SnapshotID,
			"snapshotId": s.cfg.SnapshotID,
			"size":       0,
			"fileCount":  0,
		},
		Download: map[string]any{
			"type":                   "http",
			"method":                 "GET",
			"url":                    "/api/v1/backup/bmr/recover/download",
			"tokenQueryParam":        "token",
			"pathQueryParam":         "path",
			"requiresAuthentication": true,
			"pathPrefix":             "snapshots/" + s.cfg.SnapshotID,
			"expiresAt":              "",
		},
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
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body")
		return
	}
	if strings.TrimSpace(body.Code) != s.cfg.Code {
		writeError(w, http.StatusNotFound, "code_invalid")
		return
	}

	token := s.newToken()
	s.mu.Lock()
	s.tokens[token] = true
	s.mu.Unlock()

	s.appendProgress(progressRecord{Status: "media_booted"})

	writeJSON(w, http.StatusOK, map[string]any{
		"token":     token,
		"bootstrap": s.bootstrapFor("e2e-token-1"),
	})
}

// handleAuthenticate mirrors POST /api/v1/backup/bmr/recover/authenticate:
// {"token": "..."} -> {"bootstrap": {...}}. Used by
// bmr.AuthenticateRecoverySession/NewRecoveryProvider if the console's
// Deps.Provider re-authenticates; not exercised by the console's own
// Exchange->Provider flow directly (which uses the exchange response's
// bootstrap in-memory), but kept for parity with real recovery tokens and
// for recoveryDownloadProvider's re-auth-on-401/403 path.
func (s *Server) handleAuthenticate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	var body struct {
		Token string `json:"token"`
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
	writeJSON(w, http.StatusOK, map[string]any{"bootstrap": s.bootstrapFor("e2e-token-1")})
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
		writeError(w, http.StatusForbidden, "outside_prefix")
		return
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
	if _, err := io.Copy(w, f); err != nil {
		log.Printf("fakeserver: download %s: copy failed: %v", key, err)
	}
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
// outright (CodeQL go/path-injection recognises this shape; the prefix
// check that follows is belt-and-braces for symlink-free roots).
func containedPath(root, key string) (string, error) {
	if key == "" || strings.HasPrefix(key, "/") || filepath.IsAbs(key) {
		return "", fmt.Errorf("fakeserver: path %q is not a relative object key", key)
	}
	for _, seg := range strings.Split(key, "/") {
		if seg == ".." {
			return "", fmt.Errorf("fakeserver: path %q contains a parent segment", key)
		}
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
