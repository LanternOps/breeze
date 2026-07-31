package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// crossHostURL rewrites an httptest server URL (always 127.0.0.1) to a different
// hostname so it models a redirect that leaves the agent's trusted host. The
// target is never actually dialed in these tests — the redirect is refused
// first — so it only needs a distinct hostname.
func crossHostURL(serverURL, path string) string {
	return strings.Replace(serverURL, "127.0.0.1", "localhost", 1) + path
}

func TestErrHTTPStatus_Error(t *testing.T) {
	err := &ErrHTTPStatus{StatusCode: 401, Body: `{"error":"invalid key"}`}
	got := err.Error()
	want := `http 401: {"error":"invalid key"}`
	if got != want {
		t.Errorf("Error() = %q, want %q", got, want)
	}
}

func TestErrHTTPStatus_ErrorsAs(t *testing.T) {
	var wrapped error = &ErrHTTPStatus{StatusCode: 404, Body: "not found"}
	var target *ErrHTTPStatus
	if !errors.As(wrapped, &target) {
		t.Fatal("errors.As should match *ErrHTTPStatus")
	}
	if target.StatusCode != 404 {
		t.Errorf("StatusCode = %d, want 404", target.StatusCode)
	}
}

func TestRotateToken(t *testing.T) {
	t.Parallel()

	var sawAuth string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path != "/api/v1/agents/agent-1/rotate-token" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"authToken":"brz_rotated","watchdogAuthToken":"brz_watchdog","helperAuthToken":"brz_helper","rotatedAt":"2026-03-31T20:00:00Z"}`))
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "brz_old", "agent-1")
	resp, err := client.RotateToken()
	if err != nil {
		t.Fatalf("RotateToken() error = %v", err)
	}
	if sawAuth != "Bearer brz_old" {
		t.Fatalf("Authorization header = %q, want %q", sawAuth, "Bearer brz_old")
	}
	if resp.AuthToken != "brz_rotated" {
		t.Fatalf("AuthToken = %q, want %q", resp.AuthToken, "brz_rotated")
	}
	if resp.WatchdogAuthToken != "brz_watchdog" {
		t.Fatalf("WatchdogAuthToken = %q, want %q", resp.WatchdogAuthToken, "brz_watchdog")
	}
	if resp.HelperAuthToken != "brz_helper" {
		t.Fatalf("HelperAuthToken = %q, want %q", resp.HelperAuthToken, "brz_helper")
	}
	if resp.RotatedAt != "2026-03-31T20:00:00Z" {
		t.Fatalf("RotatedAt = %q, want %q", resp.RotatedAt, "2026-03-31T20:00:00Z")
	}
}

func TestEnrollPresentsReenrollToken(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		clientToken string
		wantHeader  string
	}{
		{name: "force re-enroll presents existing token", clientToken: "brz_existing", wantHeader: "brz_existing"},
		{name: "fresh enroll omits the header", clientToken: "", wantHeader: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var sawReenroll string
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sawReenroll = r.Header.Get("x-agent-reenrollment-token")
				if r.Method != http.MethodPost || r.URL.Path != "/api/v1/agents/enroll" {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				_, _ = w.Write([]byte(`{"agentId":"agent-1","authToken":"brz_new"}`))
			}))
			defer ts.Close()

			client := NewClient(ts.URL, tt.clientToken, "agent-1")
			resp, err := client.Enroll(&EnrollRequest{EnrollmentKey: "key", Hostname: "host-1"})
			if err != nil {
				t.Fatalf("Enroll() error = %v", err)
			}
			if resp.AgentID != "agent-1" {
				t.Fatalf("AgentID = %q, want %q", resp.AgentID, "agent-1")
			}
			if sawReenroll != tt.wantHeader {
				t.Fatalf("x-agent-reenrollment-token = %q, want %q", sawReenroll, tt.wantHeader)
			}
		})
	}
}

// refuseUntrustedRedirect is the http.Client.CheckRedirect policy. It must
// reject any redirect that would carry the agent's credentials off the endpoint
// the request originally targeted, and allow trusted same-endpoint redirects.
// See #1043.
func TestRefuseUntrustedRedirect(t *testing.T) {
	t.Parallel()

	mustReq := func(rawURL string) *http.Request {
		r, err := http.NewRequest(http.MethodGet, rawURL, nil)
		if err != nil {
			t.Fatalf("bad url %q: %v", rawURL, err)
		}
		return r
	}

	tests := []struct {
		name    string
		target  string
		prev    string
		wantErr bool
	}{
		{name: "same host and scheme, different path", target: "https://api.example.com/b", prev: "https://api.example.com/a", wantErr: false},
		{name: "http to https upgrade on same host", target: "https://api.example.com/b", prev: "http://api.example.com/a", wantErr: false},
		{name: "host comparison is case-insensitive", target: "https://API.Example.com/b", prev: "https://api.example.com/a", wantErr: false},
		{name: "different port on same host is allowed", target: "https://api.example.com:8443/b", prev: "https://api.example.com/a", wantErr: false},
		{name: "different host is refused", target: "https://evil.example.com/b", prev: "https://api.example.com/a", wantErr: true},
		{name: "https to http downgrade is refused", target: "http://api.example.com:8443/b", prev: "https://api.example.com:8443/a", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := refuseUntrustedRedirect(mustReq(tt.target), []*http.Request{mustReq(tt.prev)})
			if (err != nil) != tt.wantErr {
				t.Fatalf("refuseUntrustedRedirect() error = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}

	// The first call (no prior hops) must always be allowed.
	if err := refuseUntrustedRedirect(mustReq("https://api.example.com/a"), nil); err != nil {
		t.Fatalf("empty via should be allowed, got %v", err)
	}
}

// A compromised or MITM'd server can answer the enroll request with a redirect
// to a host it controls. Stripping the token would not be enough: following the
// redirect still hands the enrollment body (hostname, hardware serial, OS info)
// to the attacker and lets it forge the EnrollResponse the agent persists. The
// client must refuse the redirect outright and never contact the other host.
// See #1043.
func TestEnrollRefusesCrossHostRedirect(t *testing.T) {
	t.Parallel()

	var attackerHits int
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attackerHits++
		_, _ = w.Write([]byte(`{"agentId":"attacker","authToken":"brz_evil"}`))
	}))
	defer attacker.Close()

	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, crossHostURL(attacker.URL, "/api/v1/agents/enroll"), http.StatusTemporaryRedirect)
	}))
	defer origin.Close()

	client := NewClient(origin.URL, "brz_existing", "agent-1")
	resp, err := client.Enroll(&EnrollRequest{EnrollmentKey: "key", Hostname: "host-1"})
	if err == nil {
		t.Fatalf("Enroll() should refuse the cross-host redirect, got resp = %+v", resp)
	}
	if attackerHits != 0 {
		t.Fatalf("agent contacted attacker host %d time(s); the request must never be sent there", attackerHits)
	}
}

// The same protection applies to every credentialed call, not just Enroll,
// because all methods share one http.Client. RotateToken sends the device token
// as Authorization: Bearer, which must never follow a cross-host redirect.
func TestAuthenticatedRequestRefusesCrossHostRedirect(t *testing.T) {
	t.Parallel()

	var attackerHits int
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attackerHits++
		_, _ = w.Write([]byte(`{"authToken":"brz_evil"}`))
	}))
	defer attacker.Close()

	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, crossHostURL(attacker.URL, "/rotate"), http.StatusTemporaryRedirect)
	}))
	defer origin.Close()

	client := NewClient(origin.URL, "brz_token", "agent-1")
	if _, err := client.RotateToken(); err == nil {
		t.Fatal("RotateToken() should refuse the cross-host redirect")
	}
	if attackerHits != 0 {
		t.Fatalf("Authorization header would have leaked: attacker contacted %d time(s)", attackerHits)
	}
}

// NewClientWithTLS (the mTLS production path) must wire the same redirect
// policy as NewClient — exercised here so a regression in that constructor
// cannot ship silently.
func TestEnrollWithTLSClientRefusesCrossHostRedirect(t *testing.T) {
	t.Parallel()

	var attackerHits int
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attackerHits++
		_, _ = w.Write([]byte(`{"agentId":"attacker"}`))
	}))
	defer attacker.Close()

	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, crossHostURL(attacker.URL, "/api/v1/agents/enroll"), http.StatusTemporaryRedirect)
	}))
	defer origin.Close()

	client := NewClientWithTLS(origin.URL, "brz_existing", "agent-1", nil)
	if _, err := client.Enroll(&EnrollRequest{EnrollmentKey: "key", Hostname: "host-1"}); err == nil {
		t.Fatal("Enroll() via NewClientWithTLS should refuse the cross-host redirect")
	}
	if attackerHits != 0 {
		t.Fatalf("TLS client contacted attacker host %d time(s)", attackerHits)
	}
}

// A same-endpoint redirect (e.g. a path redirect from the legitimate server) is
// trusted, so the token must still reach the final hop — otherwise refusing it
// would break legitimate re-enrollment.
func TestEnrollKeepsReenrollTokenOnSameHostRedirect(t *testing.T) {
	t.Parallel()

	var finalSawToken string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/agents/enroll":
			http.Redirect(w, r, "/api/v1/agents/enroll-final", http.StatusTemporaryRedirect)
		case "/api/v1/agents/enroll-final":
			finalSawToken = r.Header.Get("x-agent-reenrollment-token")
			_, _ = w.Write([]byte(`{"agentId":"agent-1","authToken":"brz_new"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "brz_existing", "agent-1")
	if _, err := client.Enroll(&EnrollRequest{EnrollmentKey: "key", Hostname: "host-1"}); err != nil {
		t.Fatalf("Enroll() error = %v", err)
	}
	if finalSawToken != "brz_existing" {
		t.Fatalf("same-host redirect should preserve re-enrollment token, got %q", finalSawToken)
	}
}

// ---------- Wave 5 Task 5: two-phase mTLS renewal client ----------

// generateSelfSignedCertPEM builds a throwaway self-signed ECDSA P-256 cert +
// key pair for tests, distinct from any other cert generated in the same
// test (via cn) so "which certificate reached the server" is checkable.
func generateSelfSignedCertPEM(t *testing.T, cn string) (certPEM, keyPEM string, cert tls.Certificate) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-1 * time.Hour),
		NotAfter:     time.Now().Add(1 * time.Hour),
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

	cert, err = tls.X509KeyPair([]byte(certPEM), []byte(keyPEM))
	if err != nil {
		t.Fatalf("X509KeyPair: %v", err)
	}
	return certPEM, keyPEM, cert
}

func TestRenewCertV2SendsProtocolVersion2(t *testing.T) {
	t.Parallel()

	var gotBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"protocolVersion":     2,
			"certificateId":       "cert-1",
			"activationExpiresAt": "2026-07-27T12:15:00Z",
			"mtls": map[string]any{
				"certificate":  "CERT",
				"privateKey":   "KEY",
				"expiresAt":    "2026-10-27T00:00:00Z",
				"serialNumber": "AA",
			},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "brz_token", "agent-1")
	resp, err := client.RenewCertV2(nil)
	if err != nil {
		t.Fatalf("RenewCertV2: %v", err)
	}
	if pv, ok := gotBody["protocolVersion"].(float64); !ok || pv != 2 {
		t.Fatalf("request body protocolVersion = %v, want 2", gotBody["protocolVersion"])
	}
	if _, hasProof := gotBody["recoveryProof"]; hasProof {
		t.Fatalf("request body should omit recoveryProof when proof is nil: %v", gotBody)
	}
	if resp.IsLegacyResponse() {
		t.Fatal("expected a capable (non-legacy) response")
	}
	if resp.CertificateID != "cert-1" {
		t.Fatalf("CertificateID = %q, want cert-1", resp.CertificateID)
	}
}

func TestRenewCertV2SendsRecoveryProof(t *testing.T) {
	t.Parallel()

	var gotBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"protocolVersion":     2,
			"certificateId":       "cert-2",
			"activationExpiresAt": "2026-07-27T12:15:00Z",
			"mtls": map[string]any{
				"certificate": "CERT", "privateKey": "KEY",
				"expiresAt": "2026-10-27T00:00:00Z", "serialNumber": "AA",
			},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "brz_token", "agent-1")
	proof := &RecoveryProof{ChallengeID: "chal-1", ExpiresUnix: 1780000000, SignatureBase64: "c2ln"}
	if _, err := client.RenewCertV2(proof); err != nil {
		t.Fatalf("RenewCertV2: %v", err)
	}

	rp, ok := gotBody["recoveryProof"].(map[string]any)
	if !ok {
		t.Fatalf("request body missing recoveryProof: %v", gotBody)
	}
	if rp["challengeId"] != "chal-1" {
		t.Errorf("challengeId = %v, want chal-1", rp["challengeId"])
	}
	if rp["signatureBase64"] != "c2ln" {
		t.Errorf("signatureBase64 = %v, want c2ln", rp["signatureBase64"])
	}
	if got, ok := rp["expiresUnix"].(float64); !ok || int64(got) != 1780000000 {
		t.Errorf("expiresUnix = %v, want 1780000000", rp["expiresUnix"])
	}
}

// TestRenewCertV2DetectsLegacyResponse is the rolling-upgrade compatibility
// contract: a peer server still running the pre-Task-4 route answers with
// the old single-phase shape (no protocolVersion/certificateId) even though
// the agent's request declared protocolVersion 2, and the client must
// recognize this so the caller falls back to immediate promotion.
func TestRenewCertV2DetectsLegacyResponse(t *testing.T) {
	t.Parallel()

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"mtls": map[string]any{
				"certificate": "CERT", "privateKey": "KEY",
				"expiresAt": "2026-10-27T00:00:00Z", "serialNumber": "AA",
			},
		})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "brz_token", "agent-1")
	resp, err := client.RenewCertV2(nil)
	if err != nil {
		t.Fatalf("RenewCertV2: %v", err)
	}
	if !resp.IsLegacyResponse() {
		t.Fatal("expected a legacy response (no protocolVersion/certificateId)")
	}
	if resp.Mtls == nil || resp.Mtls.Certificate != "CERT" {
		t.Fatalf("legacy response should still carry Mtls: %+v", resp.Mtls)
	}
}

func TestRequestRenewalChallenge(t *testing.T) {
	t.Parallel()

	var sawAuth, sawPath string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		sawPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"challengeId": "chal-9", "expiresUnix": 1780000300})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "brz_token", "agent-1")
	resp, err := client.RequestRenewalChallenge()
	if err != nil {
		t.Fatalf("RequestRenewalChallenge: %v", err)
	}
	if sawAuth != "Bearer brz_token" {
		t.Errorf("Authorization = %q, want Bearer brz_token", sawAuth)
	}
	if sawPath != "/api/v1/agents/renew-cert/challenge" {
		t.Errorf("path = %q, want /api/v1/agents/renew-cert/challenge", sawPath)
	}
	if resp.ChallengeID != "chal-9" || resp.ExpiresUnix != 1780000300 {
		t.Errorf("got %+v, want ChallengeID=chal-9 ExpiresUnix=1780000300", resp)
	}
}

func TestRequestRenewalChallengeNon200ReturnsError(t *testing.T) {
	t.Parallel()

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate limited"}`))
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "brz_token", "agent-1")
	if _, err := client.RequestRenewalChallenge(); err == nil {
		t.Fatal("expected error for 429 response")
	} else {
		var httpErr *ErrHTTPStatus
		if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusTooManyRequests {
			t.Fatalf("error = %v, want *ErrHTTPStatus{429}", err)
		}
	}
}

// TestConfirmCertRenewalUsesPendingTLSMaterial is the one-off-pending-TLS
// contract: ConfirmCertRenewal must be called on a client whose TLS
// transport presents the PENDING certificate, not the (unrelated) active
// one — the server tells the two apart only via the client cert on the
// wire. Requires the server to demand a client cert; the peer certificate
// it actually receives is asserted against the pending cert's raw DER.
func TestConfirmCertRenewalUsesPendingTLSMaterial(t *testing.T) {
	t.Parallel()

	_, _, activeCert := generateSelfSignedCertPEM(t, "active")
	_, _, pendingCert := generateSelfSignedCertPEM(t, "pending")

	var gotBody map[string]any
	var peerCertDER []byte
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/renew-cert/confirm", func(w http.ResponseWriter, r *http.Request) {
		if len(r.TLS.PeerCertificates) > 0 {
			peerCertDER = r.TLS.PeerCertificates[0].Raw
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	})

	ts := httptest.NewUnstartedServer(mux)
	ts.TLS = &tls.Config{ClientAuth: tls.RequireAnyClientCert}
	ts.StartTLS()
	defer ts.Close()

	// Trust the test server's actual certificate explicitly rather than
	// disabling verification — this test still proves TLS server identity is
	// checked, it just pins the one cert httptest generated for ts.
	serverCAPool := x509.NewCertPool()
	serverCAPool.AddCert(ts.Certificate())

	pendingTLSCfg := &tls.Config{
		Certificates: []tls.Certificate{pendingCert},
		RootCAs:      serverCAPool,
	}
	client := NewClientWithTLS(ts.URL, "brz_token", "agent-1", pendingTLSCfg)

	resp, err := client.ConfirmCertRenewal("cert-pending-1")
	if err != nil {
		t.Fatalf("ConfirmCertRenewal: %v", err)
	}
	if !resp.Success {
		t.Fatalf("resp.Success = false, want true")
	}
	if gotBody["certificateId"] != "cert-pending-1" {
		t.Errorf("certificateId = %v, want cert-pending-1", gotBody["certificateId"])
	}
	if pv, ok := gotBody["protocolVersion"].(float64); !ok || pv != 2 {
		t.Errorf("protocolVersion = %v, want 2", gotBody["protocolVersion"])
	}

	activeLeaf, err := x509.ParseCertificate(activeCert.Certificate[0])
	if err != nil {
		t.Fatalf("parse active cert: %v", err)
	}
	pendingLeaf, err := x509.ParseCertificate(pendingCert.Certificate[0])
	if err != nil {
		t.Fatalf("parse pending cert: %v", err)
	}
	if peerCertDER == nil {
		t.Fatal("server never saw a client certificate")
	}
	if string(peerCertDER) != string(pendingLeaf.Raw) {
		t.Fatal("server received a client cert that was not the pending one")
	}
	if string(peerCertDER) == string(activeLeaf.Raw) {
		t.Fatal("server received the ACTIVE cert instead of the pending one — confirmation must be a one-off client built from pending material")
	}
}

// TestConfirmCertRenewalNon2xxDoesNotReturnSuccess pins the "non-2xx = do not
// promote" contract at the client layer: a non-2xx confirm response must
// come back as an error, never as a decoded ConfirmCertRenewalResponse the
// caller might mistake for success.
func TestConfirmCertRenewalNon2xxDoesNotReturnSuccess(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status int
	}{
		{"conflict (not pending)", http.StatusConflict},
		{"gone (activation window expired)", http.StatusGone},
		{"not found", http.StatusNotFound},
		{"server error", http.StatusInternalServerError},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(`{"error":"denied"}`))
			}))
			defer ts.Close()

			client := NewClient(ts.URL, "brz_token", "agent-1")
			resp, err := client.ConfirmCertRenewal("cert-x")
			if err == nil {
				t.Fatalf("expected error for status %d, got resp=%+v", tt.status, resp)
			}
			if resp != nil {
				t.Fatalf("expected nil response on error, got %+v", resp)
			}
			var httpErr *ErrHTTPStatus
			if !errors.As(err, &httpErr) || httpErr.StatusCode != tt.status {
				t.Fatalf("error = %v, want *ErrHTTPStatus{%d}", err, tt.status)
			}
		})
	}
}

func TestConfirmCertRenewalSendsProtocolVersion2AndBearerAuth(t *testing.T) {
	t.Parallel()

	var sawAuth string
	var gotBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "brz_token", "agent-1")
	if _, err := client.ConfirmCertRenewal("cert-y"); err != nil {
		t.Fatalf("ConfirmCertRenewal: %v", err)
	}
	if sawAuth != "Bearer brz_token" {
		t.Errorf("Authorization = %q, want Bearer brz_token", sawAuth)
	}
	if gotBody["certificateId"] != "cert-y" {
		t.Errorf("certificateId = %v, want cert-y", gotBody["certificateId"])
	}
}
