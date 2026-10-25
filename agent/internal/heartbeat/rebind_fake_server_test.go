package heartbeat

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
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/spf13/viper"
)

// A fake control plane for the bounded rebind (#8318 wave 1b-3), built from
// the wave 1b-2 hand-off: phase 1, confirm and the heartbeat, with the
// intent state machine (requested → staged → confirmed | cancelled |
// expired), the restage refusal, the confirm replay, the mTLS binding rule,
// and injection of any status/code, lost responses and 401s.
//
// The client certificate a call presents is carried by a test transport as
// the X-Test-Client-Cert header: "source" for the heartbeat's own client,
// the staged certificate's common name for newRebindHTTPClient's.

const (
	rebindTestSourceToken  = "brz_source_current_token"
	rebindTestSourceDevice = "00000000-0000-4000-8000-0000000000f1"
	rebindTestHoldingOrg   = "00000000-0000-4000-8000-0000000000f2"
	rebindTestHoldingSite  = "00000000-0000-4000-8000-0000000000f3"
	rebindTestCertHeader   = "X-Test-Client-Cert"
)

var rebindTestStagedAgentID = strings.Repeat("c", 64)

// rebindInjection overrides one call. status != 0 answers with it (and
// body); drop closes the connection without an answer; commitThenDrop
// processes the call normally and then drops the answer (a lost response).
type rebindInjection struct {
	status         int
	body           map[string]any
	retryAfter     string
	drop           bool
	commitThenDrop bool
}

type rebindCall struct {
	path  string
	auth  string
	cert  string
	stage *rebindStageRequest
	body  map[string]any
}

type rebindFake struct {
	t   *testing.T
	srv *httptest.Server

	mu            sync.Mutex
	sourceAlive   bool
	intentID      string
	state         string
	cancelReason  string
	target        config.RebindTarget
	staged        *rebindStageRequest
	stagedAgentID string
	certN         int
	certSerial    string // the target's current staged (pending, then active) certificate
	certs         map[string]*config.RebindCertificate
	noMTLS        bool // the server has no mTLS provider: certificate null

	stageQueue     []rebindInjection
	confirmQueue   []rebindInjection
	heartbeatQueue []rebindInjection

	// directive rides on the source's heartbeat answer while set.
	directive *RebindDirective
	// onCall records the call in the harness's event order.
	onCall func(event string)

	calls []rebindCall
}

func newRebindFake(t *testing.T) *rebindFake {
	f := &rebindFake{
		t:           t,
		sourceAlive: true,
		intentID:    rebindGoldenIntent,
		state:       "requested",
		target:      config.RebindTarget{DeviceID: rebindGoldenDevice, OrgID: rebindGoldenOrg, SiteID: rebindGoldenSite},
		certs:       map[string]*config.RebindCertificate{},
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *rebindFake) callsTo(suffix string) []rebindCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []rebindCall
	for _, c := range f.calls {
		if strings.HasSuffix(c.path, suffix) {
			out = append(out, c)
		}
	}
	return out
}

func (f *rebindFake) setState(state, reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state, f.cancelReason = state, reason
}

func (f *rebindFake) currentState() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}

func (f *rebindFake) queue(q *[]rebindInjection, inj ...rebindInjection) {
	f.mu.Lock()
	defer f.mu.Unlock()
	*q = append(*q, inj...)
}

func pop(q *[]rebindInjection) *rebindInjection {
	if len(*q) == 0 {
		return nil
	}
	inj := (*q)[0]
	*q = (*q)[1:]
	return &inj
}

func (f *rebindFake) serve(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/agents/"), "/")
	if len(parts) != 2 || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	id, action := parts[0], parts[1]
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	call := rebindCall{path: r.URL.Path, auth: r.Header.Get("Authorization"), cert: r.Header.Get(rebindTestCertHeader), body: body}
	if action == "rebind" {
		raw, _ := json.Marshal(body)
		var req rebindStageRequest
		_ = json.Unmarshal(raw, &req)
		call.stage = &req
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
	if f.onCall != nil {
		f.onCall("call:" + action)
	}
	switch action {
	case "rebind":
		f.stage(w, id, call)
	case "rebind-confirm":
		f.confirm(w, id, call)
	case "heartbeat":
		f.heartbeat(w, id, call)
	default:
		http.NotFound(w, r)
	}
}

func dropConnection(w http.ResponseWriter) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		panic("response writer cannot hijack")
	}
	conn, _, err := hj.Hijack()
	if err != nil {
		panic(err)
	}
	_ = conn.Close()
}

func writeJSON(w http.ResponseWriter, status int, body any, retryAfter string) {
	w.Header().Set("Content-Type", "application/json")
	if retryAfter != "" {
		w.Header().Set("Retry-After", retryAfter)
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// injected answers an injection that replaces the call; it reports whether
// the call was answered, and whether to drop after committing.
func injected(w http.ResponseWriter, inj *rebindInjection) (answered, dropAfter bool) {
	if inj == nil {
		return false, false
	}
	if inj.drop {
		dropConnection(w)
		return true, false
	}
	if inj.commitThenDrop {
		return false, true
	}
	if inj.status != 0 {
		writeJSON(w, inj.status, inj.body, inj.retryAfter)
		return true, false
	}
	return false, false
}

// stateRefusal is intentStateRefusal: code and state are the state.
func (f *rebindFake) stateRefusal(w http.ResponseWriter) {
	body := map[string]any{"error": "intent " + f.state, "code": f.state, "state": f.state}
	switch f.state {
	case "cancelled":
		body["cancelReason"] = f.cancelReason
	case "requested":
		body["code"] = "not_staged"
	}
	writeJSON(w, http.StatusConflict, body, "")
}

func sameStage(a, b *rebindStageRequest) bool {
	return a.StagedTokenHash == b.StagedTokenHash && a.StagedWatchdogTokenHash == b.StagedWatchdogTokenHash &&
		a.StagedHelperTokenHash == b.StagedHelperTokenHash && a.ConfirmationTokenHash == b.ConfirmationTokenHash
}

func (f *rebindFake) issueCert() *config.RebindCertificate {
	if f.noMTLS {
		return nil
	}
	f.certN++
	serial := fmt.Sprintf("staged-cert-%d", f.certN)
	c := newRebindTestCert(f.t, serial)
	f.certs[serial] = c
	f.certSerial = serial
	return c
}

func (f *rebindFake) stage(w http.ResponseWriter, id string, call rebindCall) {
	if id != rebindGoldenSource || call.auth != "Bearer "+rebindTestSourceToken || !f.sourceAlive {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Invalid agent credentials"}, "")
		return
	}
	answered, dropAfter := injected(w, pop(&f.stageQueue))
	if answered {
		return
	}
	req := call.stage
	if req.IntentID != f.intentID {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "No such reattach intent", "code": "intent_not_found"}, "")
		return
	}
	if f.state != "requested" && f.state != "staged" {
		f.stateRefusal(w)
		return
	}
	if f.state == "staged" && !sameStage(f.staged, req) {
		f.state, f.cancelReason = "cancelled", "restage_refused"
		writeJSON(w, http.StatusConflict, map[string]any{"error": "restage", "code": "restage_refused", "state": "cancelled", "cancelReason": "restage_refused"}, "")
		return
	}
	if f.state == "requested" {
		f.staged = req
		f.stagedAgentID = rebindTestStagedAgentID
		f.state = "staged"
	}
	cert := f.issueCert()
	var certBody any
	if cert != nil {
		certBody = cert
	}
	if dropAfter {
		dropConnection(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"intentId":      f.intentID,
		"stagedAgentId": f.stagedAgentID,
		"target":        f.target,
		"certificate":   certBody,
		"expiresAt":     "2026-10-09T19:30:00.000Z",
	}, "")
}

func (f *rebindFake) identity() map[string]any {
	return map[string]any{"deviceId": f.target.DeviceID, "orgId": f.target.OrgID, "siteId": f.target.SiteID, "agentId": f.stagedAgentID}
}

func (f *rebindFake) confirm(w http.ResponseWriter, id string, call rebindCall) {
	token := strings.TrimPrefix(call.auth, "Bearer ")
	if id != rebindGoldenSource || !strings.HasPrefix(token, "brz_rbc_") || f.staged == nil || rebindHash(token) != f.staged.ConfirmationTokenHash {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Invalid confirmation credentials", "code": "invalid_confirmation"}, "")
		return
	}
	answered, dropAfter := injected(w, pop(&f.confirmQueue))
	if answered {
		return
	}
	// The mTLS binding (enforce): before the commit the source's active or
	// the staged certificate; once confirmed only the staged (now active).
	staged := f.certSerial != "" && call.cert == f.certSerial
	if f.certSerial != "" && !staged && (f.state == "confirmed" || call.cert != "source") {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "certificate", "code": "certificate_binding_failed"}, "")
		return
	}
	switch f.state {
	case "confirmed":
	case "staged":
		f.state = "confirmed"
		f.sourceAlive = false
	default:
		f.stateRefusal(w)
		return
	}
	if dropAfter {
		dropConnection(w)
		return
	}
	writeJSON(w, http.StatusOK, f.identity(), "")
}

func (f *rebindFake) heartbeat(w http.ResponseWriter, id string, call rebindCall) {
	answered, _ := injected(w, pop(&f.heartbeatQueue))
	if answered {
		return
	}
	token := strings.TrimPrefix(call.auth, "Bearer ")
	switch {
	case id == rebindGoldenSource && token == rebindTestSourceToken && f.sourceAlive:
		resp := map[string]any{"commands": []any{}}
		if f.directive != nil && (f.state == "requested" || f.state == "staged") {
			resp["rebind"] = f.directive
		}
		writeJSON(w, http.StatusOK, resp, "")
	case id == f.stagedAgentID && f.state == "confirmed" && f.staged != nil && rebindHash(token) == f.staged.StagedTokenHash &&
		(f.certSerial == "" || call.cert == f.certSerial):
		writeJSON(w, http.StatusOK, map[string]any{"commands": []any{}}, "")
	default:
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Invalid agent credentials"}, "")
	}
}

// newRebindTestCert is a self-signed client certificate whose common name is
// serial, so the test transport can name the certificate a call presented.
func newRebindTestCert(t *testing.T, serial string) *config.RebindCertificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: serial},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(90 * 24 * time.Hour),
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return &config.RebindCertificate{
		Certificate:  string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		PrivateKey:   string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})),
		ExpiresAt:    tmpl.NotAfter.UTC().Format(time.RFC3339),
		SerialNumber: serial,
	}
}

// certTagTransport stamps the presented client certificate on the request.
type certTagTransport struct{ tag string }

func (c certTagTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set(rebindTestCertHeader, c.tag)
	return http.DefaultTransport.RoundTrip(req)
}

func stagedCertClient(tlsCfg *tls.Config) *http.Client {
	tag := "none"
	if tlsCfg != nil && len(tlsCfg.Certificates) > 0 {
		if leaf, err := x509.ParseCertificate(tlsCfg.Certificates[0].Certificate[0]); err == nil {
			tag = leaf.Subject.CommonName
		}
	}
	return &http.Client{Timeout: 5 * time.Second, Transport: certTagTransport{tag: tag}}
}

// rebindHarness is an agent process over a config directory. restart()
// builds a fresh process over the same directory: the crash-table tests
// "kill" the agent at a persistence step and resume from disk.
type rebindHarness struct {
	t        *testing.T
	fake     *rebindFake
	cfgPath  string
	h        *Heartbeat
	now      time.Time
	restarts atomic.Int32
	logs     *syncBuffer
	secrets  map[string]bool

	eventsMu sync.Mutex
	events   []string
	written  []config.RebindStagedSet
	// killAfter: a write of a set in this phase lands, then the process
	// "dies" (the write reports an error, so the flow stops right there).
	killAfter string
	// failWrites: the staged-set write fails before touching the disk.
	failWrites bool
	// failApply: the identity swap fails.
	failApply bool
}

func (r *rebindHarness) event(e string) {
	r.eventsMu.Lock()
	defer r.eventsMu.Unlock()
	r.events = append(r.events, e)
}

func (r *rebindHarness) eventLog() []string {
	r.eventsMu.Lock()
	defer r.eventsMu.Unlock()
	return append([]string(nil), r.events...)
}

func newRebindHarness(t *testing.T) *rebindHarness {
	t.Helper()
	viper.Reset()
	t.Cleanup(viper.Reset)

	r := &rebindHarness{
		t:       t,
		fake:    newRebindFake(t),
		cfgPath: filepath.Join(t.TempDir(), "agent.yaml"),
		now:     rebindGoldenNow,
		logs:    &syncBuffer{},
		secrets: map[string]bool{rebindTestSourceToken: true},
	}
	cfg := config.Default()
	cfg.AgentID = rebindGoldenSource
	cfg.DeviceID = rebindTestSourceDevice
	cfg.OrgID = rebindTestHoldingOrg
	cfg.SiteID = rebindTestHoldingSite
	cfg.ServerURL = r.fake.srv.URL
	cfg.AuthToken = rebindTestSourceToken
	cfg.WatchdogAuthToken = "brz_source_watchdog_token"
	cfg.HelperAuthToken = "brz_source_helper_token"
	cfg.PinnedManifestPubKeys = identityTestPinned()
	logging.Init("text", "debug", r.logs)
	if err := config.SaveTo(cfg, r.cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	origNow, origRestart, origClient := rebindNow, rebindRestartFn, newRebindHTTPClient
	origWrite, origApply, origFile := rebindWriteStaged, rebindApplyIdentity, rebindConfigFile
	t.Cleanup(func() {
		rebindNow, rebindRestartFn, newRebindHTTPClient = origNow, origRestart, origClient
		rebindWriteStaged, rebindApplyIdentity, rebindConfigFile = origWrite, origApply, origFile
		logging.Init("text", "info", nil)
	})
	rebindNow = func() time.Time { return r.now }
	rebindRestartFn = func() error { r.restarts.Add(1); return nil }
	newRebindHTTPClient = stagedCertClient
	rebindConfigFile = func() string { return r.cfgPath }
	rebindWriteStaged = func(cfgFile string, s *config.RebindStagedSet) error {
		if r.failWrites {
			return errors.New("disk full")
		}
		if err := origWrite(cfgFile, s); err != nil {
			return err
		}
		r.event("persist:" + s.Phase)
		r.noteSecretsOf(s)
		r.eventsMu.Lock()
		r.written = append(r.written, *s)
		r.eventsMu.Unlock()
		if r.killAfter == s.Phase {
			return errors.New("killed right after the write")
		}
		return nil
	}
	rebindApplyIdentity = func(cfgFile string, id config.RebindIdentity) error {
		if r.failApply {
			return errors.New("antivirus holds secrets.yaml")
		}
		if err := origApply(cfgFile, id); err != nil {
			return err
		}
		r.event("swap")
		return nil
	}
	r.fake.onCall = r.event
	t.Cleanup(r.assertNoSecretsLogged)

	r.restart()
	return r
}

// restart is a new agent process over the same directory: the identity is
// loaded from disk and every in-memory rebind state starts empty.
func (r *rebindHarness) restart() {
	r.t.Helper()
	viper.Reset()
	cfg, err := config.Load(r.cfgPath)
	if err != nil {
		r.t.Fatalf("Load: %v", err)
	}
	token := cfg.AuthToken
	cfg.AuthToken = ""
	r.h = &Heartbeat{
		config:       cfg,
		secureToken:  secmem.NewSecureString(token),
		client:       &http.Client{Timeout: 5 * time.Second, Transport: certTagTransport{tag: "source"}},
		agentVersion: "1.2.3",
	}
}

// directive is a directive for intentID signed for this install's agent id,
// valid for 15 minutes.
func (r *rebindHarness) directive(intentID string) *RebindDirective {
	d := goldenRebindDirective()
	d.IntentID = intentID
	d.ExpiresAt = r.now.Add(15 * time.Minute).UTC().Format("2006-01-02T15:04:05Z")
	return signRebindTestDirective(r.t, d, r.h.config.AgentID)
}

// drive runs the flow synchronously, past any backoff.
func (r *rebindHarness) drive(d *RebindDirective) {
	r.h.rebind.retryAt.Store(nil)
	r.h.driveRebind(d)
	r.noteSecrets()
}

func (r *rebindHarness) staged() *config.RebindStagedSet {
	r.t.Helper()
	s, err := config.ReadRebindStaged(r.cfgPath)
	if err != nil {
		r.t.Fatalf("ReadRebindStaged: %v", err)
	}
	return s
}

func (r *rebindHarness) noteSecrets() {
	if s, err := config.ReadRebindStaged(r.cfgPath); err == nil && s != nil {
		r.noteSecretsOf(s)
	}
}

func (r *rebindHarness) noteSecretsOf(s *config.RebindStagedSet) {
	r.eventsMu.Lock()
	defer r.eventsMu.Unlock()
	for _, v := range []string{s.AuthToken, s.WatchdogAuthToken, s.HelperAuthToken, s.ConfirmationToken} {
		r.secrets[v] = true
	}
	if s.Certificate != nil {
		r.secrets[strings.TrimSpace(s.Certificate.PrivateKey)] = true
	}
}

// assertNoSecretsLogged: no token, confirmation token or private key ever
// reaches a log line.
func (r *rebindHarness) assertNoSecretsLogged() {
	out := r.logs.String()
	r.eventsMu.Lock()
	defer r.eventsMu.Unlock()
	for secret := range r.secrets {
		if secret != "" && strings.Contains(out, secret) {
			r.t.Errorf("a secret reached the log")
		}
		if strings.HasPrefix(secret, "brz_") && strings.Contains(out, strings.TrimPrefix(secret, "brz_")) {
			r.t.Errorf("a secret's body reached the log")
		}
	}
	if strings.Contains(out, "PRIVATE KEY") {
		r.t.Errorf("a private key reached the log")
	}
}

func (r *rebindHarness) waitRestarts(n int32) {
	r.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for r.restarts.Load() < n {
		if time.Now().After(deadline) {
			r.t.Fatalf("restarts = %d, want %d", r.restarts.Load(), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// onDisk is the config a restarted process would load.
func (r *rebindHarness) onDisk() *config.Config {
	r.t.Helper()
	viper.Reset()
	cfg, err := config.Load(r.cfgPath)
	if err != nil {
		r.t.Fatalf("Load: %v", err)
	}
	return cfg
}

// assertSwapped checks the identity on disk is the confirmed target with the
// staged set and the newest staged certificate.
func (r *rebindHarness) assertSwapped(set *config.RebindStagedSet) {
	r.t.Helper()
	cfg := r.onDisk()
	if cfg.AgentID != rebindTestStagedAgentID || cfg.DeviceID != rebindGoldenDevice ||
		cfg.OrgID != rebindGoldenOrg || cfg.SiteID != rebindGoldenSite {
		r.t.Fatalf("identity on disk = %s/%s/%s/%s, want the target", cfg.AgentID, cfg.DeviceID, cfg.OrgID, cfg.SiteID)
	}
	if cfg.AuthToken != set.AuthToken || cfg.WatchdogAuthToken != set.WatchdogAuthToken || cfg.HelperAuthToken != set.HelperAuthToken {
		r.t.Fatal("the credentials on disk are not the staged set")
	}
	r.fake.mu.Lock()
	want := r.fake.certs[r.fake.certSerial]
	r.fake.mu.Unlock()
	if want != nil && cfg.MtlsCertPEM != want.Certificate {
		r.t.Fatal("the certificate on disk is not the newest staged one")
	}
	if _, err := os.Stat(config.RebindStagedPath(r.cfgPath)); !os.IsNotExist(err) {
		r.t.Fatal("the staged set is still on disk after the swap")
	}
}
