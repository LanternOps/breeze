package heartbeat

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/spf13/viper"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/secmem"
)

// Security remediation Wave 5 Task 5 — ordering regression tests for the
// two-phase (protocolVersion 2) mTLS certificate renewal protocol.
//
// The invariants pinned down here mirror #2621's credential-rotation tests
// (token_rotation_test.go) exactly, applied to mTLS certificate material
// instead of bearer tokens: the server only activates a certificate once the
// agent CONFIRMS, and the agent only confirms after the pending
// certificate/key/ID/expiry are durably on disk. A crash or lost response at
// any point leaves the OLD active certificate in force — never a half
// promotion.

// generateHeartbeatTestCert creates a throwaway self-signed ECDSA P-256
// cert/key pair for these tests specifically (distinct from mtls_test.go's
// copy, which lives in a different package).
func generateHeartbeatTestCert(t *testing.T, cn string, notBefore, notAfter time.Time) (certPEM, keyPEM string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    notBefore,
		NotAfter:     notAfter,
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	certPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	keyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	return certPEM, keyPEM
}

type mtlsRenewalServer struct {
	*httptest.Server
	mu             sync.Mutex
	renewCalls     int
	confirmCalls   int
	challengeCalls int
	confirmedIDs   []string

	// Configurable behavior.
	renewCertPEM        string
	renewKeyPEM         string
	certificateID       string
	activationExpiresAt string
	legacyRenewResponse bool
	confirmStatus       int    // 0 => 200 success
	confirmConflictBody string // body returned with a non-200 confirmStatus
	renewStatus         int    // 0 => 200
}

func (s *mtlsRenewalServer) counts() (renew, confirm, challenge int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.renewCalls, s.confirmCalls, s.challengeCalls
}

func (s *mtlsRenewalServer) confirmedCertIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.confirmedIDs...)
}

// newMTLSRenewalServer stands up a capable (protocolVersion-2-aware) mock of
// all three renewal routes with sane happy-path defaults; tests override the
// exported fields (confirmStatus, legacyRenewResponse, ...) before making
// requests through the returned Heartbeat.
func newMTLSRenewalServer(t *testing.T) *mtlsRenewalServer {
	t.Helper()
	certPEM, keyPEM := generateHeartbeatTestCert(t, "pending", time.Now().Add(-1*time.Hour), time.Now().Add(90*24*time.Hour))

	rs := &mtlsRenewalServer{
		renewCertPEM:        certPEM,
		renewKeyPEM:         keyPEM,
		certificateID:       "cert-pending-1",
		activationExpiresAt: time.Now().Add(15 * time.Minute).UTC().Format(time.RFC3339),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/renew-cert/challenge", func(w http.ResponseWriter, r *http.Request) {
		rs.mu.Lock()
		rs.challengeCalls++
		rs.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"challengeId": "chal-1",
			"expiresUnix": time.Now().Add(5 * time.Minute).Unix(),
		})
	})
	mux.HandleFunc("/api/v1/agents/renew-cert/confirm", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)

		rs.mu.Lock()
		rs.confirmCalls++
		if id, ok := body["certificateId"].(string); ok {
			rs.confirmedIDs = append(rs.confirmedIDs, id)
		}
		status := rs.confirmStatus
		conflictBody := rs.confirmConflictBody
		rs.mu.Unlock()

		if status != 0 && status != http.StatusOK {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			if conflictBody == "" {
				conflictBody = `{"error":"confirmation denied"}`
			}
			_, _ = w.Write([]byte(conflictBody))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	})
	mux.HandleFunc("/api/v1/agents/renew-cert", func(w http.ResponseWriter, r *http.Request) {
		rs.mu.Lock()
		rs.renewCalls++
		legacy := rs.legacyRenewResponse
		status := rs.renewStatus
		certPEM, keyPEM := rs.renewCertPEM, rs.renewKeyPEM
		certID, activationExpiresAt := rs.certificateID, rs.activationExpiresAt
		rs.mu.Unlock()

		if status != 0 && status != http.StatusOK {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":"renewal denied"}`))
			return
		}

		w.Header().Set("Content-Type", "application/json")
		mtlsData := map[string]any{
			"certificate":  certPEM,
			"privateKey":   keyPEM,
			"expiresAt":    time.Now().Add(90 * 24 * time.Hour).UTC().Format(time.RFC3339),
			"serialNumber": "AA:BB:CC",
		}
		if legacy {
			_ = json.NewEncoder(w).Encode(map[string]any{"mtls": mtlsData})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"protocolVersion":     2,
			"certificateId":       certID,
			"activationExpiresAt": activationExpiresAt,
			"mtls":                mtlsData,
		})
	})

	rs.Server = httptest.NewServer(mux)
	t.Cleanup(rs.Close)
	return rs
}

// newMTLSTestHeartbeat wires a Heartbeat against a real temp config, exactly
// like newRotationTestHeartbeat, so the durable-persistence path exercises
// actual file I/O rather than an in-memory stand-in.
func newMTLSTestHeartbeat(t *testing.T, serverURL string) (*Heartbeat, string) {
	t.Helper()
	viper.Reset()
	t.Cleanup(viper.Reset)

	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")

	activeCertPEM, activeKeyPEM := generateHeartbeatTestCert(t, "active", time.Now().Add(-24*time.Hour), time.Now().Add(60*24*time.Hour))

	cfg := config.Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.ServerURL = serverURL
	cfg.AuthToken = "brz_current_agent"
	cfg.WatchdogAuthToken = "brz_current_watchdog"
	cfg.HelperAuthToken = "brz_current_helper"
	cfg.OrgID = "org-1"
	cfg.SiteID = "site-1"
	cfg.DeviceID = "550e8400-e29b-41d4-a716-446655440000"
	cfg.MtlsCertPEM = activeCertPEM
	cfg.MtlsKeyPEM = activeKeyPEM
	cfg.MtlsCertExpires = time.Now().Add(60 * 24 * time.Hour).UTC().Format(time.RFC3339)

	if err := config.SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	viper.SetConfigFile(cfgPath)

	h := &Heartbeat{
		config:      cfg,
		secureToken: secmem.NewSecureString("brz_current_agent"),
		client:      &http.Client{},
	}
	return h, cfgPath
}

// Happy path: stage, confirm, promote — in that order, with a single
// renew-cert call and a single confirm call.
func TestHandleCertRenewalPromotesAfterConfirm(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, _ := newMTLSTestHeartbeat(t, srv.URL)

	oldCertPEM := h.config.MtlsCertPEM
	h.handleCertRenewal()

	renew, confirm, _ := srv.counts()
	if renew != 1 || confirm != 1 {
		t.Fatalf("renew=%d confirm=%d, want 1 and 1", renew, confirm)
	}

	if h.config.MtlsCertPEM == oldCertPEM {
		t.Fatal("active certificate was not promoted")
	}
	if h.config.MtlsCertPEM != srv.renewCertPEM {
		t.Fatalf("active certificate = %q, want the server-issued pending cert", h.config.MtlsCertPEM)
	}
	if h.config.PendingMTLSCertificate != "" || h.config.PendingMTLSCertificateID != "" {
		t.Fatalf("pending fields survived a confirmed promotion: cert=%q id=%q",
			h.config.PendingMTLSCertificate, h.config.PendingMTLSCertificateID)
	}
	if h.pendingMTLSCertOnDisk.Load() {
		t.Fatal("pendingMTLSCertOnDisk should be false after a confirmed promotion")
	}
	if ids := srv.confirmedCertIDs(); len(ids) != 1 || ids[0] != srv.certificateID {
		t.Fatalf("confirmed certificate IDs = %v, want exactly [%q]", ids, srv.certificateID)
	}
}

// The durable-disk assertion, done properly against the real cfgPath.
func TestHandleCertRenewalPersistsPromotionToDisk(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, cfgPath := newMTLSTestHeartbeat(t, srv.URL)

	h.handleCertRenewal()

	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if loaded.MtlsCertPEM != srv.renewCertPEM {
		t.Errorf("persisted MtlsCertPEM = %q, want the promoted cert", loaded.MtlsCertPEM)
	}
	if loaded.PendingMTLSCertificate != "" || loaded.PendingMTLSCertificateID != "" {
		t.Errorf("persisted pending fields survived promotion: cert=%q id=%q",
			loaded.PendingMTLSCertificate, loaded.PendingMTLSCertificateID)
	}
}

// THE regression test mirroring #2621's persistence-failure test: with the
// secrets file unwritable, the agent must never call /renew-cert/confirm. If
// it did, the server could activate a certificate whose private key exists
// nowhere on the agent's disk.
func TestHandleCertRenewalDoesNotConfirmWhenPersistenceFails(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, cfgPath := newMTLSTestHeartbeat(t, srv.URL)
	oldCertPEM := h.config.MtlsCertPEM

	secretsPath := secretsPathFor(cfgPath)
	if err := os.Remove(secretsPath); err != nil {
		t.Fatalf("remove secrets file: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(secretsPath, "occupied"), 0700); err != nil {
		t.Fatalf("create blocking directory: %v", err)
	}

	h.handleCertRenewal()

	renew, confirm, _ := srv.counts()
	if renew != 1 {
		t.Fatalf("renew calls = %d, want 1", renew)
	}
	if confirm != 0 {
		t.Fatalf("renew-cert/confirm was called %d time(s) after a failed disk write — "+
			"the server would activate a certificate the agent cannot reproduce after a restart", confirm)
	}
	if h.config.MtlsCertPEM != oldCertPEM {
		t.Fatalf("active certificate changed despite a failed durable write")
	}
	if h.config.PendingMTLSCertificate != "" {
		t.Fatalf("pending certificate was left set in memory after a failed save: %q", h.config.PendingMTLSCertificate)
	}
}

// A /renew-cert request the server rejects outright (5xx) must leave the
// agent exactly as it was — no pending material staged, no confirm attempt.
func TestHandleCertRenewalRenewRejectionLeavesStateUnchanged(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	srv.renewStatus = http.StatusInternalServerError
	h, _ := newMTLSTestHeartbeat(t, srv.URL)
	oldCertPEM := h.config.MtlsCertPEM

	h.handleCertRenewal()

	renew, confirm, _ := srv.counts()
	if renew != 1 {
		t.Fatalf("renew calls = %d, want 1", renew)
	}
	if confirm != 0 {
		t.Fatalf("confirm was called %d time(s) despite the renewal request itself being rejected", confirm)
	}
	if h.config.MtlsCertPEM != oldCertPEM {
		t.Fatal("active certificate changed despite a rejected renewal request")
	}
	if h.config.PendingMTLSCertificate != "" {
		t.Fatal("pending certificate was set despite a rejected renewal request")
	}
}

// A pre-Task-4 (legacy) server has no confirm phase and already committed
// the certificate as active in its single response. Treating that as a
// two-phase renewal would be fatal: confirm would 404 forever and the agent
// would never adopt the certificate the server already committed.
func TestHandleCertRenewalPromotesImmediatelyAgainstLegacyServer(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	srv.legacyRenewResponse = true
	h, cfgPath := newMTLSTestHeartbeat(t, srv.URL)

	h.handleCertRenewal()

	renew, confirm, _ := srv.counts()
	if renew != 1 {
		t.Fatalf("renew calls = %d, want 1", renew)
	}
	if confirm != 0 {
		t.Errorf("confirm was called %d time(s) against a legacy server with no confirm phase", confirm)
	}
	if h.config.MtlsCertPEM != srv.renewCertPEM {
		t.Errorf("active cert = %q, want the legacy-promoted cert — a legacy server's certificate must be adopted immediately or the agent never renews", h.config.MtlsCertPEM)
	}
	if h.config.PendingMTLSCertificate != "" {
		t.Errorf("legacy promotion should never populate pending fields: %q", h.config.PendingMTLSCertificate)
	}

	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if loaded.MtlsCertPEM != srv.renewCertPEM {
		t.Errorf("persisted MtlsCertPEM = %q, want the legacy-promoted cert", loaded.MtlsCertPEM)
	}
}

// A confirm that comes back non-2xx must retain the OLD active certificate
// and keep the pending material on disk for a retry — never promote on a
// failed confirmation.
func TestHandleCertRenewalConfirmFailureRetainsOldCertificate(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	srv.confirmStatus = http.StatusInternalServerError
	h, cfgPath := newMTLSTestHeartbeat(t, srv.URL)
	oldCertPEM := h.config.MtlsCertPEM

	h.handleCertRenewal()

	renew, confirm, _ := srv.counts()
	if renew != 1 || confirm != 1 {
		t.Fatalf("renew=%d confirm=%d, want 1 and 1", renew, confirm)
	}
	if h.config.MtlsCertPEM != oldCertPEM {
		t.Fatalf("active certificate changed despite a failed confirmation: %q", h.config.MtlsCertPEM)
	}
	if h.config.PendingMTLSCertificate == "" {
		t.Fatal("pending certificate was dropped after a failed confirmation — it should survive for a retry")
	}
	if !h.pendingMTLSCertOnDisk.Load() {
		t.Fatal("pendingMTLSCertOnDisk should remain true after a failed confirmation, to drive the per-tick retry")
	}

	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if loaded.MtlsCertPEM != oldCertPEM {
		t.Errorf("persisted active cert changed despite a failed confirmation")
	}
	if loaded.PendingMTLSCertificate == "" {
		t.Error("persisted pending certificate was dropped after a failed confirmation")
	}
}

// No repeated issuance while a valid, unexpired pending certificate already
// exists: a second server-signaled renewCert must resume confirming the
// existing pending row rather than requesting a brand new certificate.
func TestHandleCertRenewalSkipsIssuanceWhileValidPendingExists(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	// First call stages a pending cert but the confirm fails, so it survives.
	srv.confirmStatus = http.StatusInternalServerError
	h, _ := newMTLSTestHeartbeat(t, srv.URL)

	h.handleCertRenewal()
	renew1, confirm1, _ := srv.counts()
	if renew1 != 1 || confirm1 != 1 {
		t.Fatalf("after first call: renew=%d confirm=%d, want 1 and 1", renew1, confirm1)
	}

	// Now let confirmation succeed and trigger another renewCert signal.
	srv.mu.Lock()
	srv.confirmStatus = http.StatusOK
	srv.mu.Unlock()

	h.handleCertRenewal()
	renew2, confirm2, _ := srv.counts()
	if renew2 != 1 {
		t.Fatalf("renew calls after second signal = %d, want still 1 (no new issuance while a valid pending certificate exists)", renew2)
	}
	if confirm2 != 2 {
		t.Fatalf("confirm calls after second signal = %d, want 2 (resumed the existing pending row)", confirm2)
	}
	if h.config.MtlsCertPEM != srv.renewCertPEM {
		t.Errorf("active cert = %q, want the resumed pending cert to have been promoted", h.config.MtlsCertPEM)
	}
}

// Startup/crash-restart resumption: the agent finds a staged, unconfirmed
// certificate already on disk (as if the process had been killed after
// stagePendingMTLSCert but before confirmPendingMTLSCert observed a
// response) and a freshly-constructed Heartbeat resumes and finishes the
// confirm+promote handshake exactly once. This is the state-machine
// equivalent of the brief's "kill an agent process" integration fixture:
// the post-crash disk state is constructed directly (pending fields staged,
// nothing confirmed) and a new Heartaeat value (standing in for the
// restarted process) is driven through reconcilePendingMTLSCert.
func TestReconcilePendingMTLSCertResumesAfterCrash(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	_, cfgPath := newMTLSTestHeartbeat(t, srv.URL)

	// Simulate the crash window: stage pending material directly (as
	// stagePendingMTLSCert would have, just before the process died) without
	// ever confirming it.
	staged, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	staged.PendingMTLSCertificate = srv.renewCertPEM
	staged.PendingMTLSPrivateKey = srv.renewKeyPEM
	staged.PendingMTLSCertificateID = srv.certificateID
	staged.PendingMTLSExpiresAt = time.Now().Add(10 * time.Minute)
	if err := config.SaveTo(staged, cfgPath); err != nil {
		t.Fatalf("SaveTo (simulate crash-time stage): %v", err)
	}

	// "Restart": construct a brand new Heartbeat from the on-disk config,
	// exactly as main.go would after a process restart.
	reloaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load (post-crash reload): %v", err)
	}
	h := &Heartbeat{
		config:      reloaded,
		secureToken: secmem.NewSecureString("brz_current_agent"),
		client:      &http.Client{},
	}

	h.reconcilePendingMTLSCert()

	renew, confirm, _ := srv.counts()
	if renew != 0 {
		t.Fatalf("renew calls = %d, want 0 (must resume the existing pending cert, never issue a new one)", renew)
	}
	if confirm != 1 {
		t.Fatalf("confirm calls = %d, want exactly 1", confirm)
	}
	if h.config.MtlsCertPEM != srv.renewCertPEM {
		t.Errorf("active cert after resumed confirmation = %q, want the resumed pending cert", h.config.MtlsCertPEM)
	}
	if h.config.PendingMTLSCertificate != "" {
		t.Error("pending fields survived a resumed, confirmed promotion")
	}

	// Running reconcile again must be a true no-op — exactly once.
	h.reconcilePendingMTLSCert()
	renew2, confirm2, _ := srv.counts()
	if renew2 != 0 || confirm2 != 1 {
		t.Fatalf("a second reconcile call made more server requests: renew=%d confirm=%d, want 0 and 1 total", renew2, confirm2)
	}
}

// Nothing staged => nothing to do. Runs on every startup and every tick, so
// it must be a cheap no-op that never touches the server.
func TestReconcilePendingMTLSCertNoOpWithoutPending(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, _ := newMTLSTestHeartbeat(t, srv.URL)

	h.reconcilePendingMTLSCert()

	renew, confirm, challenge := srv.counts()
	if renew != 0 || confirm != 0 || challenge != 0 {
		t.Fatalf("reconcile made server calls with nothing pending: renew=%d confirm=%d challenge=%d", renew, confirm, challenge)
	}
}

// An activation window that has GENUINELY elapsed can never be confirmed. The
// agent must discard the pending certificate locally — without even
// attempting to call confirm — and keep using its current active
// certificate.
//
// UPDATED by the Wave 5 final whole-branch review (I10): this test used to
// use a deadline one minute in the past, which now falls inside
// pendingActivationClockSkew and is deliberately still sent to the server.
// The local comparison is against a SERVER-supplied timestamp using the LOCAL
// clock, so a raw compare meant an agent whose clock ran fast — a resumed VM
// snapshot, a bad NTP peer, a dead CMOS battery — discarded every pending
// certificate the instant it arrived and could never renew, with nothing in
// the logs pointing at the clock. The server is the authority (it answers 410
// when the window has truly closed), so the local check only exists to avoid a
// pointless round-trip. The skew-tolerance behavior itself is pinned by
// TestPendingActivationToleratesClockSkew.
func TestReconcilePendingMTLSCertDiscardsExpiredPending(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, cfgPath := newMTLSTestHeartbeat(t, srv.URL)
	oldCertPEM := h.config.MtlsCertPEM

	h.mu.Lock()
	h.config.PendingMTLSCertificate = srv.renewCertPEM
	h.config.PendingMTLSPrivateKey = srv.renewKeyPEM
	h.config.PendingMTLSCertificateID = srv.certificateID
	// Well beyond the clock-skew allowance — genuinely, unambiguously elapsed.
	h.config.PendingMTLSExpiresAt = time.Now().Add(-2 * pendingActivationClockSkew)
	h.config.AuthToken = "brz_current_agent"
	if err := config.SaveTo(h.config, cfgPath); err != nil {
		t.Fatalf("config.SaveTo (simulate expired pending): %v", err)
	}
	h.config.AuthToken = ""
	h.mu.Unlock()

	h.reconcilePendingMTLSCert()

	_, confirm, _ := srv.counts()
	if confirm != 0 {
		t.Fatalf("confirm was called %d time(s) for an already-expired pending certificate — "+
			"the activation window check must short-circuit before ever calling the server", confirm)
	}
	if h.config.MtlsCertPEM != oldCertPEM {
		t.Fatalf("active certificate changed despite discarding an expired pending certificate")
	}
	if h.config.PendingMTLSCertificate != "" {
		t.Fatal("expired pending certificate was not cleared")
	}
	if h.pendingMTLSCertOnDisk.Load() {
		t.Fatal("pendingMTLSCertOnDisk should be false after discarding an expired pending certificate")
	}

	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if loaded.MtlsCertPEM != oldCertPEM {
		t.Errorf("persisted active cert changed after discarding an expired pending certificate")
	}
	if loaded.PendingMTLSCertificate != "" || loaded.PendingMTLSCertificateID != "" {
		t.Errorf("persisted pending fields survived expiry discard: cert=%q id=%q",
			loaded.PendingMTLSCertificate, loaded.PendingMTLSCertificateID)
	}
}

// =====================================================================
// Wave 5 FINAL WHOLE-BRANCH REVIEW regression tests.
//
// C4 — a dropped confirm response must never cost the agent its identity.
// I1 — the renewal request must present the current client certificate.
// I2 — expired-certificate recovery must be reachable without a server signal.
// I10 — the pending activation window must tolerate local clock skew.
// =====================================================================

// C4: the server activated the certificate but the response was lost. The
// agent retries, gets 409, and MUST adopt the material — the server is now
// authenticating it by that certificate. Discarding it (the pre-fix behavior,
// via the activation-window expiry path) is permanent identity loss.
func TestConfirm409PromotesInsteadOfLosingIdentity(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	srv.confirmStatus = http.StatusConflict
	h, cfgPath := newMTLSTestHeartbeat(t, srv.URL)

	oldCertPEM := h.config.MtlsCertPEM
	h.handleCertRenewal()

	if h.config.MtlsCertPEM == oldCertPEM {
		t.Fatal("409 on confirm discarded the certificate the server had already activated — permanent identity loss")
	}
	if h.config.MtlsCertPEM != srv.renewCertPEM {
		t.Fatalf("active certificate = %q, want the server-issued certificate", h.config.MtlsCertPEM)
	}
	if h.config.PendingMTLSCertificate != "" || h.config.PendingMTLSCertificateID != "" {
		t.Fatal("pending fields survived adoption")
	}
	if h.pendingMTLSCertOnDisk.Load() {
		t.Fatal("pendingMTLSCertOnDisk should be false after adoption")
	}

	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if loaded.MtlsCertPEM != srv.renewCertPEM {
		t.Fatal("adoption was not durably persisted")
	}
}

// C4: a 409 that EXPLICITLY reports a terminal state is the one case where the
// material must be discarded rather than adopted.
func TestConfirm409WithTerminalStateDiscardsAndKeepsCurrentCert(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	srv.confirmStatus = http.StatusConflict
	srv.confirmConflictBody = `{"error":"Certificate is not pending activation","state":"revoked"}`
	h, _ := newMTLSTestHeartbeat(t, srv.URL)

	oldCertPEM := h.config.MtlsCertPEM
	h.handleCertRenewal()

	if h.config.MtlsCertPEM != oldCertPEM {
		t.Fatal("a revoked certificate must never be adopted as the active identity")
	}
	if h.config.PendingMTLSCertificate != "" {
		t.Fatal("terminal pending material should have been discarded")
	}
	if h.pendingMTLSCertOnDisk.Load() {
		t.Fatal("pendingMTLSCertOnDisk should be false after discarding terminal material")
	}
}

// C4: 410 means the window closed server-side and the row was never
// activated — genuinely dead, and the OLD certificate stays in force.
func TestConfirm410DiscardsPendingAndKeepsCurrentCert(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	srv.confirmStatus = http.StatusGone
	h, _ := newMTLSTestHeartbeat(t, srv.URL)

	oldCertPEM := h.config.MtlsCertPEM
	h.handleCertRenewal()

	if h.config.MtlsCertPEM != oldCertPEM {
		t.Fatal("410 must leave the OLD active certificate in force")
	}
	if h.config.PendingMTLSCertificate != "" {
		t.Fatal("410 pending material should have been discarded")
	}
}

// C4 (inert-retry half): the server confirmed, but the local disk write
// failed. In-memory state must stay CONSISTENT WITH DISK so a resume actually
// finds the pending material. Pre-fix, promote zeroed the in-memory pending
// fields before SaveTo and left them zeroed on failure, so hasPendingMTLSCert
// — which reads exactly those fields — reported "nothing pending" and
// reconcilePendingMTLSCert no-opped forever.
func TestPromoteSaveFailureLeavesPendingResumable(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, cfgPath := newMTLSTestHeartbeat(t, srv.URL)

	// Stage pending material durably first (a normal renewal up to confirm).
	h.config.PendingMTLSCertificate = srv.renewCertPEM
	h.config.PendingMTLSPrivateKey = srv.renewKeyPEM
	h.config.PendingMTLSCertificateID = srv.certificateID
	h.config.PendingMTLSExpiresAt = time.Now().Add(10 * time.Minute)
	if err := config.SaveTo(h.config, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	h.pendingMTLSCertOnDisk.Store(true)

	// Make the promotion's SaveTo fail by pointing the active config file at
	// a path that cannot be written.
	unwritable := filepath.Join(cfgPath, "not-a-directory", "agent.yaml")
	viper.SetConfigFile(unwritable)

	h.promotePendingMTLSCert(srv.renewCertPEM, srv.renewKeyPEM)

	if !h.hasPendingMTLSCert() {
		t.Fatal("a failed promotion left the in-memory pending fields zeroed — the documented retry is inert and the certificate is stranded")
	}
	if !h.pendingMTLSCertOnDisk.Load() {
		t.Fatal("pendingMTLSCertOnDisk must stay set so the tick retries")
	}

	// And the on-disk state still holds the pending material, so a RESTART
	// resumes too.
	viper.SetConfigFile(cfgPath)
	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if loaded.PendingMTLSCertificateID != srv.certificateID {
		t.Fatalf("on-disk pending id = %q, want %q", loaded.PendingMTLSCertificateID, srv.certificateID)
	}

	// Resuming now completes: the server's confirm is idempotent for an
	// already-active row, and this mock answers 200.
	h.reconcilePendingMTLSCert()
	if h.config.MtlsCertPEM != srv.renewCertPEM {
		t.Fatal("resume after a save failure did not complete the promotion")
	}
}

// C4 (clear half): the same defect class in clearPendingMTLSCert.
func TestClearSaveFailureLeavesPendingResumable(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, cfgPath := newMTLSTestHeartbeat(t, srv.URL)

	h.config.PendingMTLSCertificate = srv.renewCertPEM
	h.config.PendingMTLSPrivateKey = srv.renewKeyPEM
	h.config.PendingMTLSCertificateID = srv.certificateID
	h.config.PendingMTLSExpiresAt = time.Now().Add(10 * time.Minute)
	h.pendingMTLSCertOnDisk.Store(true)

	viper.SetConfigFile(filepath.Join(cfgPath, "not-a-directory", "agent.yaml"))
	h.clearPendingMTLSCert()

	if !h.hasPendingMTLSCert() {
		t.Fatal("a failed clear zeroed the in-memory pending fields, so the 'will retry on the next tick' path can never observe anything to retry")
	}
	if !h.pendingMTLSCertOnDisk.Load() {
		t.Fatal("pendingMTLSCertOnDisk must stay set after a failed clear")
	}
}

// I10: a fast local clock must not discard a pending certificate the server
// still considers activatable. The server-supplied deadline here is already
// in the (local) past, but within the skew allowance.
func TestPendingActivationToleratesClockSkew(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, _ := newMTLSTestHeartbeat(t, srv.URL)

	h.config.PendingMTLSCertificate = srv.renewCertPEM
	h.config.PendingMTLSPrivateKey = srv.renewKeyPEM
	h.config.PendingMTLSCertificateID = srv.certificateID
	// Local clock runs ahead of the server by less than the allowance.
	h.config.PendingMTLSExpiresAt = time.Now().Add(-pendingActivationClockSkew / 2)
	h.pendingMTLSCertOnDisk.Store(true)

	h.reconcilePendingMTLSCert()

	_, confirm, _ := srv.counts()
	if confirm != 1 {
		t.Fatalf("confirm calls = %d, want 1 — a modest clock skew discarded the pending certificate without even asking the server", confirm)
	}
	if h.config.MtlsCertPEM != srv.renewCertPEM {
		t.Fatal("pending certificate was not promoted despite the server accepting it")
	}
}

// I10: beyond the allowance it is still discarded — the tolerance is bounded,
// not unlimited.
func TestPendingActivationDiscardedWellPastTheWindow(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, _ := newMTLSTestHeartbeat(t, srv.URL)

	h.config.PendingMTLSCertificate = srv.renewCertPEM
	h.config.PendingMTLSPrivateKey = srv.renewKeyPEM
	h.config.PendingMTLSCertificateID = srv.certificateID
	h.config.PendingMTLSExpiresAt = time.Now().Add(-2 * pendingActivationClockSkew)
	h.pendingMTLSCertOnDisk.Store(true)

	h.reconcilePendingMTLSCert()

	if _, confirm, _ := srv.counts(); confirm != 0 {
		t.Fatalf("confirm calls = %d, want 0 for a genuinely elapsed window", confirm)
	}
	if h.config.PendingMTLSCertificate != "" {
		t.Fatal("a genuinely elapsed pending certificate should have been discarded")
	}
}

// I1: an unexpired certificate is PRESENTED on the renewal request; an
// expired one is not (the edge would reject the handshake and take the
// recovery path down with it).
func TestNewRenewalClientPresentsUnexpiredCertificate(t *testing.T) {
	certPEM, keyPEM := generateHeartbeatTestCert(t, "active", time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour))

	if _, presented := newRenewalClient("https://example.test", "tok", "agent", certPEM, keyPEM, false); !presented {
		t.Fatal("an unexpired certificate must be presented on /renew-cert — an enforce-mode server denies a bearer-only renewal for a device with an unexpired active row, which would lock out the entire fleet")
	}
	if _, presented := newRenewalClient("https://example.test", "tok", "agent", certPEM, keyPEM, true); presented {
		t.Fatal("an EXPIRED certificate must not be presented — the edge rejects the handshake, breaking the recovery path")
	}
	if _, presented := newRenewalClient("https://example.test", "tok", "agent", "", "", false); presented {
		t.Fatal("no certificate material means no certificate to present")
	}
}

// I2: an agent whose certificate has expired must initiate renewal ITSELF.
// Pre-fix, renewal was only ever triggered by the server's `renewCert`
// heartbeat flag — but in enforce an expired certificate makes the heartbeat
// itself fail, so the signal could never arrive and the recovery proof path
// was unreachable in exactly the situation it exists for.
func TestSelfInitiatedRenewalRecoversAnExpiredCertificate(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, _ := newMTLSTestHeartbeat(t, srv.URL)

	h.config.MtlsCertExpires = time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339)
	oldCertPEM := h.config.MtlsCertPEM

	h.maybeSelfInitiateCertRenewal()

	renew, confirm, challenge := srv.counts()
	if renew != 1 {
		t.Fatalf("renew calls = %d, want 1 — an expired agent never asked to renew, which is the enforce-mode fleet lockout", renew)
	}
	if challenge != 1 {
		t.Fatalf("challenge calls = %d, want 1 — the expired-certificate recovery proof was never requested", challenge)
	}
	if confirm != 1 {
		t.Fatalf("confirm calls = %d, want 1", confirm)
	}
	if h.config.MtlsCertPEM == oldCertPEM {
		t.Fatal("expired certificate was not replaced")
	}
}

// I2: a healthy certificate well inside its lifetime must NOT trigger
// self-initiated renewal — this path is a recovery mechanism, not a second
// renewal scheduler competing with the server's signal.
func TestSelfInitiatedRenewalSkipsHealthyCertificate(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, _ := newMTLSTestHeartbeat(t, srv.URL)

	h.config.MtlsCertExpires = time.Now().Add(60 * 24 * time.Hour).UTC().Format(time.RFC3339)
	h.maybeSelfInitiateCertRenewal()

	if renew, _, _ := srv.counts(); renew != 0 {
		t.Fatalf("renew calls = %d, want 0 for a healthy certificate", renew)
	}
}

// I2: a bearer-only device (no certificate material at all) must never
// attempt a renewal — enrollment, not renewal, issues a first certificate.
func TestSelfInitiatedRenewalSkipsBearerOnlyDevice(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, _ := newMTLSTestHeartbeat(t, srv.URL)

	h.config.MtlsCertPEM = ""
	h.config.MtlsKeyPEM = ""
	h.maybeSelfInitiateCertRenewal()

	if renew, _, _ := srv.counts(); renew != 0 {
		t.Fatalf("renew calls = %d, want 0 for a bearer-only device", renew)
	}
}
