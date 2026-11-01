package heartbeat

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/isolation"
	"github.com/breeze-rmm/agent/internal/updater"
)

type ContainmentReport struct {
	NetworkIsolation *isolation.Report `json:"networkIsolation,omitempty"`
}

type ContainmentDesired = isolation.DesiredBlock

var containmentUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var errContainmentSpec = errors.New("invalid network isolation specification")

// containmentExpirySlack tolerates agent/server clock skew on the 720 h upper
// bound, matching the Manager's own structural check (isolation.validateSpec).
const containmentExpirySlack = 5 * time.Minute

// Validation errors deliberately never include payload values: they may contain
// the break-glass secret, including inside a malformed field.
func validateContainmentPayload(payload map[string]any, server string, now time.Time) error {
	params, ok := payload["parameters"].(map[string]any)
	if !ok {
		return errContainmentSpec
	}
	raw, ok := payload["breakGlassSecret"].(string)
	if !ok || len(raw) != 44 {
		return errContainmentSpec
	}
	secret, err := base64.StdEncoding.Strict().DecodeString(raw)
	if err != nil || len(secret) != 32 || base64.StdEncoding.EncodeToString(secret) != raw {
		return errContainmentSpec
	}
	data, err := json.Marshal(params)
	if err != nil {
		return errContainmentSpec
	}
	var spec struct {
		isolation.Spec
		PolicyRevision any `json:"policyRevision"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&spec) != nil {
		return errContainmentSpec
	}
	if !validContainmentIdentity(spec.Spec, now) {
		return errContainmentSpec
	}
	return validateContainmentAllow(spec.Allow, server, validContainmentPolicyRevision(spec.PolicyRevision))
}

func validContainmentPolicyRevision(v any) bool {
	switch r := v.(type) {
	case string:
		return strings.TrimSpace(r) != ""
	case float64:
		return r > 0 && !math.IsInf(r, 0) && math.Trunc(r) == r
	default:
		return false
	}
}

func validContainmentIdentity(s isolation.Spec, now time.Time) bool {
	return containmentUUID.MatchString(s.IsolationID) && s.Generation >= 1 && now.Before(s.ExpiresAt) && !s.ExpiresAt.After(now.Add(isolation.MaxTTL+containmentExpirySlack))
}

// validateContainmentAllow binds the permit to this agent's configured control
// plane, including the effective port. A covering subnet is not an IP-host
// permit; it must be precisely that single address.
func validateContainmentAllow(allow []isolation.AllowEntry, server string, policyRevision bool) error {
	u, err := url.Parse(server)
	if err != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
		return errContainmentSpec
	}
	port := 443
	if u.Scheme == "http" {
		port = 80
	}
	if u.Port() != "" {
		port, err = strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return errContainmentSpec
		}
	}
	host := strings.ToLower(u.Hostname())
	addr, ipErr := netip.ParseAddr(host)
	if len(allow) == 0 || len(allow) > 64 {
		return errContainmentSpec
	}
	found := false
	for _, e := range allow {
		if e.Scope != isolation.ScopeBreeze && (e.Scope != isolation.ScopeAny || !policyRevision) {
			return errContainmentSpec
		}
		if e.Proto != isolation.ProtoTCP && e.Proto != isolation.ProtoUDP && e.Proto != isolation.ProtoUDPTCP {
			return errContainmentSpec
		}
		if len(e.Ports) == 0 || len(e.Ports) > 16 {
			return errContainmentSpec
		}
		seen := map[uint16]bool{}
		hasPort := false
		for _, p := range e.Ports {
			if p == 0 || seen[p] {
				return errContainmentSpec
			}
			seen[p] = true
			hasPort = hasPort || int(p) == port
		}
		match := false
		switch e.Kind {
		case isolation.KindHost:
			if !validContainmentHost(e.Host) || e.CIDR != "" {
				return errContainmentSpec
			}
			match = ipErr != nil && strings.EqualFold(e.Host, host)
		case isolation.KindCIDR:
			prefix, err := netip.ParsePrefix(e.CIDR)
			if err != nil || prefix.Bits() == 0 || e.Host != "" {
				return errContainmentSpec
			}
			match = ipErr == nil && prefix.Addr() == addr && prefix.Bits() == addr.BitLen()
		default:
			return errContainmentSpec
		}
		found = found || (match && e.Scope == isolation.ScopeBreeze && e.Proto != isolation.ProtoUDP && hasPort)
	}
	if !found {
		return errContainmentSpec
	}
	return nil
}

func validContainmentHost(host string) bool {
	if host == "" || len(host) > 253 {
		return false
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			switch {
			case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-':
			default:
				return false
			}
		}
	}
	return true
}

func validateContainmentDesired(d *isolation.Desired, server string, now time.Time) error {
	if d == nil || d.Desired == isolation.DesiredReleased {
		return nil
	}
	if d.Desired != isolation.DesiredIsolated || !validContainmentIdentity(d.Spec, now) {
		return errContainmentSpec
	}
	return validateContainmentAllow(d.Allow, server, false)
}

type containmentManager interface {
	HandleIsolate(context.Context, map[string]any) isolation.CommandOutcome
	HandleRelease(context.Context, map[string]any) isolation.CommandOutcome
	Reconcile(context.Context, *isolation.DesiredBlock)
	Startup(context.Context)
	Tick(context.Context)
	Report() *isolation.Report
	Active() bool
}

// One worker serializes startup, desired-state reconciliation and ticks. Only
// the newest pending server assertion is retained while a probe is in flight.
// Commands retain the Manager's independent release path during probes.
type containmentRuntime struct {
	manager   containmentManager
	desired   chan *isolation.DesiredBlock
	queueMu   sync.Mutex
	startOnce sync.Once
}

func newContainmentRuntime(m containmentManager) *containmentRuntime {
	return &containmentRuntime{manager: m, desired: make(chan *isolation.DesiredBlock, 1)}
}

func (r *containmentRuntime) enqueue(d *isolation.DesiredBlock) {
	r.queueMu.Lock()
	defer r.queueMu.Unlock()
	select {
	case <-r.desired:
	default:
	}
	r.desired <- d
}

func (r *containmentRuntime) run(ctx context.Context, ticks <-chan time.Time) {
	r.manager.Startup(ctx)
	for {
		if ctx.Err() != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case d := <-r.desired:
			r.manager.Reconcile(ctx, d)
		case <-ticks:
			r.manager.Tick(ctx)
		}
	}
}

func (h *Heartbeat) startContainment() {
	if h.containment == nil {
		return
	}
	h.containment.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			select {
			case <-h.stopChan:
				cancel()
			case <-ctx.Done():
			}
		}()
		go func() {
			defer cancel()
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			h.containment.run(ctx, ticker.C)
		}()
	})
}

func (h *Heartbeat) initializeContainment(dataDir string) {
	m := isolation.NewManager(isolation.ManagerDeps{
		DataDir: dataDir, Isolator: isolation.NewPlatformIsolator(), Scheduler: isolation.NewPlatformScheduler(dataDir),
		VerifyRoundTrip: func(ctx context.Context, id string) (time.Time, error) {
			return isolation.NewHTTPVerifier(h.containmentVerifierConfig())(ctx, id)
		},
		Dialer: containmentDialer(func(ctx context.Context, network, address string) (net.Conn, error) {
			cfg := h.containmentVerifierConfig()
			if cfg.DialContext != nil {
				return cfg.DialContext(ctx, network, address)
			}
			return (&net.Dialer{}).DialContext(ctx, network, address)
		}),
		Proxy: func() (*url.URL, error) {
			cfg := h.containmentVerifierConfig()
			if cfg.Proxy == nil {
				return nil, nil
			}
			req, err := http.NewRequest(http.MethodPost, h.serverURL(), nil)
			if err != nil {
				return nil, err
			}
			return cfg.Proxy(req)
		},
	})
	h.containment = newContainmentRuntime(m)
	updater.SetIsolationGate(m.Active)
}

type containmentDialer func(context.Context, string, string) (net.Conn, error)

func (d containmentDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	return d(ctx, network, address)
}

func (h *Heartbeat) containmentVerifierConfig() isolation.HTTPVerifierConfig {
	h.mu.Lock()
	agentID := h.config.AgentID
	h.mu.Unlock()
	cfg := isolation.HTTPVerifierConfig{
		URL: isolation.DefaultVerifyURL(h.serverURL(), agentID),
		Header: func() http.Header {
			h.mu.Lock()
			defer h.mu.Unlock()
			return http.Header{"Authorization": {h.authHeader()}}
		},
	}
	if client := h.httpClient(); client != nil {
		if tr, ok := client.Transport.(*http.Transport); ok {
			transport := tr.Clone()
			cfg.TLSConfig = transport.TLSClientConfig
			cfg.DialContext = transport.DialContext
			cfg.Proxy = transport.Proxy
			// TODO(W1f): HTTPVerifierConfig cannot carry DialTLSContext. Preserve the
			// ECH TLS dialer as well when the verifier supports that transport hook.
		}
	}
	return cfg
}

// containmentReport attaches the Manager's report to the heartbeat. A nil
// report means the journal is mid-cleanup with Breeze-owned rules possibly
// still installed: the beat then carries no containment block at all. It must
// never be replaced by the {phase:"none"} form, which the server takes as
// proof that nothing is installed and uses to confirm a release tombstone.
// (Manager.Report itself returns the absent form when there is no journal.)
func (h *Heartbeat) containmentReport() *ContainmentReport {
	if h.containment == nil {
		return nil
	}
	report := h.containment.manager.Report()
	if report == nil {
		return nil
	}
	return &ContainmentReport{NetworkIsolation: report}
}

func (h *Heartbeat) reconcileContainment(d *isolation.DesiredBlock) {
	if h.containment == nil || d == nil || d.NetworkIsolation == nil {
		return
	}
	if err := validateContainmentDesired(d.NetworkIsolation, h.serverURL(), time.Now()); err != nil {
		n := d.NetworkIsolation
		log.Warn("ignoring invalid containment desired state", "isolationId", n.IsolationID,
			"generation", n.Generation, "desired", n.Desired, "error", err.Error())
		return
	}
	h.containment.enqueue(d)
}

func containmentCapabilities(c *SecurityCapabilities) {
	cap := isolation.NewPlatformIsolator().Capability()
	ready, why := isolation.NewPlatformScheduler(config.GetDataDir()).Ready()
	c.NetworkIsolationVersion = cap.Version
	c.NetworkIsolationMechanism = cap.Mechanism
	c.NetworkIsolationUnsupportedReason = cap.UnsupportedReason
	c.NetworkIsolationReady = cap.Version >= 1 && cap.Ready && ready
	if c.NetworkIsolationUnsupportedReason == "" && cap.Version >= 1 && !ready {
		c.NetworkIsolationUnsupportedReason = "recovery not ready: " + why
	}
}

// containmentBlocksUpgrade: no self-update starts while isolated. Companion
// binaries carry no signed metadata and most artifact hosts are firewalled,
// so an attempt could only fail (and burn companion failure budgets).
func (h *Heartbeat) containmentBlocksUpgrade() bool {
	return h.containment != nil && h.containment.manager.Active()
}
