package heartbeat

import (
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ech"
	"github.com/breeze-rmm/agent/internal/state"
)

// bodyLog records heartbeat request bodies per host.
type bodyLog struct {
	mu     sync.Mutex
	bodies map[string][]map[string]any
}

func (b *bodyLog) add(host string, body []byte) {
	var m map[string]any
	_ = json.Unmarshal(body, &m)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.bodies == nil {
		b.bodies = map[string][]map[string]any{}
	}
	b.bodies[host] = append(b.bodies[host], m)
}

func (b *bodyLog) get(host string) []map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]map[string]any(nil), b.bodies[host]...)
}

func TestHeartbeatPayload_ControlPlaneBlockOmittedWhenNone(t *testing.T) {
	b, err := json.Marshal(HeartbeatPayload{Status: "ok"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "controlPlaneBlock") {
		t.Fatalf("payload without an episode carries controlPlaneBlock: %s", b)
	}
	b, _ = json.Marshal(HeartbeatPayload{ControlPlaneBlock: &ControlPlaneBlockReport{Kind: "web_filter", Host: cpHost}})
	if !strings.Contains(string(b), `"controlPlaneBlock":{"kind":"web_filter"`) {
		t.Fatalf("payload = %s, want a controlPlaneBlock object", b)
	}
}

func TestDoHeartbeatPost_AttachesFreshReportToBackupProbe(t *testing.T) {
	swapSharedECHDialer(t)
	const (
		primaryURL = "https://primary.example"
		backupURL  = "https://backup.example"
	)
	cfg := swapTestConfig(t, primaryURL, backupURL)
	bodies := &bodyLog{}
	h := newFailoverTestHeartbeat(cfg, failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(req.Body)
		bodies.add(req.URL.Host, body)
		if req.URL.Host == "primary.example" {
			return nil, signatureErr()
		}
		return failoverResponse(req, http.StatusOK, `{"commands":[]}`), nil
	}))
	h.blocks = newBlockTracker("", time.Now)
	payload := &HeartbeatPayload{Status: "ok", AgentVersion: "test"}
	for range backupProbeThreshold {
		if h.postHeartbeat(h.serverURL(), payload) {
			t.Fatal("primary heartbeat succeeded")
		}
		h.recordHeartbeatFailure(payload)
	}
	first := bodies.get("primary.example")[0]
	if _, ok := first["controlPlaneBlock"]; ok {
		t.Fatalf("first primary beat already carried an episode: %v", first["controlPlaneBlock"])
	}
	backup := bodies.get("backup.example")
	if len(backup) != 1 {
		t.Fatalf("backup probes = %d, want 1", len(backup))
	}
	block, ok := backup[0]["controlPlaneBlock"].(map[string]any)
	if !ok {
		t.Fatalf("backup probe body has no controlPlaneBlock: %v", backup[0])
	}
	if block["kind"] != "plaintext_unknown" || block["host"] != "primary.example" {
		t.Fatalf("controlPlaneBlock = %v, want plaintext_unknown for primary.example", block)
	}
	// The backup 200 is not a plain success for the primary: still active.
	if _, active := h.blocks.Current("primary.example"); !active {
		t.Fatal("a backup 200 cleared the primary's episode")
	}
}

func TestDoHeartbeatPost_200DeliversClearedOnce(t *testing.T) {
	swapSharedECHDialer(t)
	bodies := &bodyLog{}
	h := newFailoverTestHeartbeat(swapTestConfig(t, "https://"+cpHost, ""), failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(req.Body)
		bodies.add(req.URL.Host, body)
		return failoverResponse(req, http.StatusOK, `{"commands":[]}`), nil
	}))
	h.blocks = newBlockTracker("", time.Now)
	h.blocks.Observe(cpHost, webFilterStatus(time.Now().Add(-time.Minute)))

	for i := 0; i < 3; i++ {
		if _, ok := h.doHeartbeatPost("https://"+cpHost, &HeartbeatPayload{Status: "ok"}); !ok {
			t.Fatalf("post %d failed", i)
		}
	}
	got := bodies.get(cpHost)
	b0, _ := got[0]["controlPlaneBlock"].(map[string]any)
	if b0 == nil || b0["clearedAt"] != nil {
		t.Fatalf("beat 1 controlPlaneBlock = %v, want the active episode", got[0]["controlPlaneBlock"])
	}
	b1, _ := got[1]["controlPlaneBlock"].(map[string]any)
	if b1 == nil || b1["clearedBy"] != "plain_success" {
		t.Fatalf("beat 2 controlPlaneBlock = %v, want the cleared episode", got[1]["controlPlaneBlock"])
	}
	if _, ok := got[2]["controlPlaneBlock"]; ok {
		t.Fatalf("beat 3 still carries the delivered episode: %v", got[2]["controlPlaneBlock"])
	}
}

func TestDoHeartbeatPost_NonOKKeepsClearedEpisode(t *testing.T) {
	swapSharedECHDialer(t)
	status := http.StatusServiceUnavailable
	var mu sync.Mutex
	h := newFailoverTestHeartbeat(swapTestConfig(t, "https://"+cpHost, ""), failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		mu.Lock()
		defer mu.Unlock()
		return failoverResponse(req, status, `{"commands":[]}`), nil
	}))
	h.blocks = newBlockTracker("", time.Now)
	h.blocks.Observe(cpHost, webFilterStatus(time.Now().Add(-time.Minute)))
	h.blocks.ObserveReached(cpHost, false)
	if _, ok := h.doHeartbeatPost("https://"+cpHost, &HeartbeatPayload{Status: "ok"}); ok {
		t.Fatal("503 reported ok")
	}
	if r := h.blocks.Report(); r == nil || r.ClearedAt == "" {
		t.Fatalf("Report = %+v, want the cleared episode kept after a 503", r)
	}
}

func TestDoHeartbeatPost_FilterFailureClassifiedAndHoldsRestart(t *testing.T) {
	swapSharedECHDialer(t)
	statePath := filepath.Join(t.TempDir(), "agent.state")
	if err := state.Write(statePath, &state.AgentState{}); err != nil {
		t.Fatal(err)
	}
	failWith := signatureErr()
	var mu sync.Mutex
	h := newFailoverTestHeartbeat(swapTestConfig(t, "https://"+cpHost, ""), failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		mu.Lock()
		defer mu.Unlock()
		return nil, failWith
	}))
	h.blocks = newBlockTracker("", time.Now)
	h.statePath = statePath

	if _, ok := h.doHeartbeatPost("https://"+cpHost, &HeartbeatPayload{Status: "ok"}); ok {
		t.Fatal("post succeeded")
	}
	c, _ := h.healthMon.Get("heartbeat")
	if c.Message != "control plane blocked by a network security filter (no detail)" {
		t.Fatalf("heartbeat component message = %q", c.Message)
	}
	s, err := state.Read(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if s.ControlPlaneBlockedAt.IsZero() {
		t.Fatal("filter failure did not write the blocked-liveness marker")
	}

	// A timeout with no episode is not a block: no marker.
	mu.Lock()
	failWith = errors.New("dial tcp: i/o timeout")
	mu.Unlock()
	h.blocks = newBlockTracker("", time.Now)
	if err := state.Write(statePath, &state.AgentState{}); err != nil {
		t.Fatal(err)
	}
	_, _ = h.doHeartbeatPost("https://"+cpHost, &HeartbeatPayload{Status: "ok"})
	if s, _ := state.Read(statePath); !s.ControlPlaneBlockedAt.IsZero() {
		t.Fatal("a timeout wrote the blocked-liveness marker")
	}
	if c, _ := h.healthMon.Get("heartbeat"); !strings.Contains(c.Message, "i/o timeout") {
		t.Fatalf("timeout message = %q, want the raw error", c.Message)
	}
}

func TestClassifiedSendFailure_Strings(t *testing.T) {
	now := time.Now()
	sig := signatureErr()
	webFilter := ech.HostStatus{Evidence: ech.BlockEvidence{Kind: ech.BlockWebFilter, HTTPStatus: 302, LocationHost: "warn.filter-a.example", SeenAt: now}}
	captive := ech.HostStatus{Evidence: ech.BlockEvidence{Kind: ech.BlockCaptivePortal, HTTPStatus: 511, SeenAt: now}}
	stale := webFilter
	stale.LastPlainSuccessAt = now.Add(time.Second)

	leaf := selfSignedLeaf(t, pkix.Name{Organization: []string{"Example Inspect CA"}})
	certErr := fmt.Errorf("Post: %w", &tls.CertificateVerificationError{UnverifiedCertificates: []*x509.Certificate{leaf}, Err: x509.UnknownAuthorityError{Cert: leaf}})
	noIssuer := selfSignedLeaf(t, pkix.Name{})
	certErrNoIssuer := &tls.CertificateVerificationError{UnverifiedCertificates: []*x509.Certificate{noIssuer}, Err: x509.UnknownAuthorityError{Cert: noIssuer}}
	plain := errors.New("dial tcp: connection refused")

	cases := []struct {
		name string
		err  error
		st   ech.HostStatus
		want string
	}{
		{"web filter with location", sig, webFilter, "control plane blocked by a network security filter (warn.filter-a.example)"},
		{"signature without evidence", sig, ech.HostStatus{}, "control plane blocked by a network security filter (no detail)"},
		{"stale evidence ignored", sig, stale, "control plane blocked by a network security filter (no detail)"},
		{"captive portal", sig, captive, "control plane held by a captive portal"},
		{"untrusted certificate", certErr, ech.HostStatus{}, "control plane certificate not trusted (issuer: Example Inspect CA)"},
		{"untrusted certificate no issuer", certErrNoIssuer, ech.HostStatus{}, "control plane certificate not trusted (issuer: unknown)"},
		{"certificate error ignores filter evidence", certErr, webFilter, "control plane certificate not trusted (issuer: Example Inspect CA)"},
		{"other error unchanged", plain, webFilter, plain.Error()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifiedSendFailure(tc.err, tc.st); got != tc.want {
				t.Fatalf("classifiedSendFailure = %q, want %q", got, tc.want)
			}
		})
	}
}

func selfSignedLeaf(t *testing.T, issuer pkix.Name) *x509.Certificate {
	t.Helper()
	// Only Issuer is read; a parsed certificate is not needed.
	return &x509.Certificate{Issuer: issuer, Subject: issuer}
}

type contractFixture struct {
	HostPattern   string            `json:"hostPattern"`
	IssuerPattern string            `json:"issuerPattern"`
	Kinds         []string          `json:"kinds"`
	ClearedBy     []string          `json:"clearedBy"`
	Valid         []json.RawMessage `json:"valid"`
	Invalid       []json.RawMessage `json:"invalid"`
}

// TestControlPlaneBlockContractFixture is the cross-language drift guard: the
// API test (W2) parses the same file.
func TestControlPlaneBlockContractFixture(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "control_plane_block_contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx contractFixture
	if err := json.Unmarshal(data, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Valid) == 0 || len(fx.Invalid) == 0 {
		t.Fatal("fixture has no cases")
	}
	for i, raw := range fx.Valid {
		var r ControlPlaneBlockReport
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&r); err != nil {
			t.Fatalf("valid[%d] does not decode into ControlPlaneBlockReport: %v", i, err)
		}
		out, _ := json.Marshal(r)
		var a, b map[string]any
		_ = json.Unmarshal(raw, &a)
		_ = json.Unmarshal(out, &b)
		if !reflect.DeepEqual(a, b) {
			t.Fatalf("valid[%d] does not round-trip:\n in  %s\n out %s", i, raw, out)
		}
	}

	wantKinds := []string{string(ech.BlockWebFilter), string(ech.BlockCaptivePortal), string(ech.BlockPlaintextUnknown), string(ech.BlockUntrustedCertificate)}
	if !reflect.DeepEqual(fx.Kinds, wantKinds) {
		t.Fatalf("fixture kinds %v, agent kinds %v", fx.Kinds, wantKinds)
	}
	if !reflect.DeepEqual(fx.ClearedBy, []string{blockClearedByPlainSuccess, blockClearedByUnobserved}) {
		t.Fatalf("fixture clearedBy %v", fx.ClearedBy)
	}

	hostRe := regexp.MustCompile(fx.HostPattern)
	for _, in := range []string{"CP.Example", "cp.example:8443", "warn.filter-a.example.", "10.0.0.1", "a", "x-" + strings.Repeat("y", 250), "bad host", "-x.example", "ü.example", ""} {
		if got := ech.SanitizeHost(in); got != "" && !hostRe.MatchString(got) {
			t.Errorf("SanitizeHost(%q) = %q does not match the fixture hostPattern", in, got)
		}
	}
	issuerRe := regexp.MustCompile(fx.IssuerPattern)
	for _, in := range []string{"Example Inspect CA", "  padded  ", strings.Repeat("Z", 90), "a" + strings.Repeat(" ", 70) + "b", "\x07bell", "Exämple"} {
		if got := ech.SanitizeIssuer(in); got != "" && !issuerRe.MatchString(got) {
			t.Errorf("SanitizeIssuer(%q) = %q does not match the fixture issuerPattern", in, got)
		}
	}
}
