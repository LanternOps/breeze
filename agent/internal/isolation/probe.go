package isolation

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strings"
	"syscall"
	"time"
)

// NegativeProbeTimeout is the local timeout for the negative probe's SYN.
const NegativeProbeTimeout = 3 * time.Second

// negativeGrace absorbs scheduling jitter around the local timeout.
const negativeGrace = 500 * time.Millisecond

// ProbeBudget is how long both probes may take after the rules are applied.
const ProbeBudget = 60 * time.Second

// Dialer dials the negative probe (the agent's ordinary dialer, not a proxy).
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

type probeError struct {
	code string
	msg  string
}

func (e *probeError) Error() string { return e.msg }

func errPositive(format string, args ...any) error {
	return &probeError{code: FailControlPlaneUnreachable, msg: "positive probe: " + fmt.Sprintf(format, args...)}
}

func errNegative(format string, args ...any) error {
	return &probeError{code: FailEnforcementNotObserved, msg: "negative probe: " + fmt.Sprintf(format, args...)}
}

// probeFailureCode is the episode failure code for a probe error.
func probeFailureCode(err error) string {
	var pe *probeError
	if errors.As(err, &pe) {
		return pe.code
	}
	return FailControlPlaneUnreachable
}

// negativeProbe sends a SYN to a control-plane address on a port no permit
// allows (spec §3.7). It passes only when the connect fails locally within
// the timeout AND a Breeze-owned drop rule fired. A connect, an RST, a
// failure that took too long, or a timeout nobody attributes to our rules
// (an upstream blackhole times out too) all fail.
func negativeProbe(ctx context.Context, d Dialer, iso Isolator, target netip.AddrPort, timeout time.Duration) error {
	mark, err := iso.Mark(ctx)
	if err != nil {
		return errNegative("mark drop counter: %v", err)
	}
	dctx, cancel := context.WithTimeout(ctx, timeout)
	start := time.Now()
	conn, dialErr := d.DialContext(dctx, "tcp", target.String())
	elapsed := time.Since(start)
	cancel()
	if dialErr == nil {
		_ = conn.Close()
		return errNegative("connection to %s succeeded", target)
	}
	if errors.Is(dialErr, syscall.ECONNREFUSED) || errors.Is(dialErr, syscall.ECONNRESET) {
		return errNegative("connection to %s was reset, not dropped", target)
	}
	if elapsed > timeout+negativeGrace {
		return errNegative("connect to %s failed only after %v", target, elapsed.Round(time.Millisecond))
	}
	if ctx.Err() != nil {
		return errNegative("cancelled: %v", ctx.Err())
	}
	dropped, err := iso.DropObserved(ctx, mark)
	if err != nil {
		return errNegative("read drop counter: %v", err)
	}
	if !dropped {
		return errNegative("connect to %s failed (%v) but no Breeze-owned rule dropped it", target, dialErr)
	}
	return nil
}

// negativeProbePort picks a port none of the permitted ports covers: 80 when
// 443 is permitted, otherwise a permitted port ± 1.
func negativeProbePort(permitted []uint16) uint16 {
	allowed := func(p int) bool { return slices.Contains(permitted, uint16(p)) }
	var candidates []int
	if allowed(443) {
		candidates = append(candidates, 80)
	}
	for _, p := range permitted {
		candidates = append(candidates, int(p)+1, int(p)-1)
	}
	candidates = append(candidates, 9)
	for _, c := range candidates {
		if c >= 1 && c <= 65535 && !allowed(c) {
			return uint16(c)
		}
	}
	return 9
}

// negativeProbeTarget is the control plane's first address (the server puts
// the control-plane permit first) on a port no entry permits for it.
func negativeProbeTarget(spec ResolvedSpec) (netip.AddrPort, error) {
	if len(spec.Entries) == 0 || len(spec.Entries[0].Addrs) == 0 {
		return netip.AddrPort{}, errors.New("no control-plane address to probe")
	}
	addr := spec.Entries[0].Addrs[0].Addr()
	var permitted []uint16
	for _, e := range spec.Entries {
		if e.Proto != ProtoTCP && e.Proto != ProtoUDPTCP {
			continue
		}
		for _, p := range e.Addrs {
			if p.Contains(addr) {
				permitted = append(permitted, e.Ports...)
				break
			}
		}
	}
	return netip.AddrPortFrom(addr, negativeProbePort(permitted)), nil
}

// HTTPVerifierConfig builds the positive probe: a fresh authenticated round
// trip to POST /agents/isolation/:isolationId/verify (W1b).
type HTTPVerifierConfig struct {
	// URL returns the verify URL for an episode (DefaultVerifyURL).
	URL func(isolationID string) string
	// Header returns the request headers (the agent's Authorization).
	Header func() http.Header
	// TLSConfig is the agent's TLS configuration (mTLS client certificate,
	// roots). It is cloned per probe.
	TLSConfig *tls.Config
	// DialContext dials the connection (the agent's control-plane dialer).
	DialContext func(ctx context.Context, network, address string) (net.Conn, error)
	// Proxy is the transport's effective proxy (http.ProxyFromEnvironment).
	Proxy func(*http.Request) (*url.URL, error)
	// Timeout bounds the whole round trip.
	Timeout time.Duration
}

// DefaultVerifyURL is the W1b verify route under serverURL.
func DefaultVerifyURL(serverURL string) func(string) string {
	base := strings.TrimRight(serverURL, "/")
	return func(isolationID string) string {
		return base + "/api/v1/agents/isolation/" + url.PathEscape(isolationID) + "/verify"
	}
}

// NewHTTPVerifier returns a VerifyRoundTrip. Every call builds a new
// http.Transport with keep-alives disabled, so each probe is a new TCP
// connection and a fresh TLS session through the rules just installed — an
// already-open socket proves nothing (spec §3.6 item 1). It returns the
// server's Date header (zero if absent), which feeds HighWaterWall.
func NewHTTPVerifier(cfg HTTPVerifierConfig) func(ctx context.Context, isolationID string) (time.Time, error) {
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return func(ctx context.Context, isolationID string) (time.Time, error) {
		if cfg.URL == nil {
			return time.Time{}, errors.New("verify URL not configured")
		}
		tr := &http.Transport{
			Proxy:               cfg.Proxy,
			DialContext:         cfg.DialContext,
			DisableKeepAlives:   true,
			TLSHandshakeTimeout: 15 * time.Second,
			ForceAttemptHTTP2:   false,
		}
		if cfg.TLSConfig != nil {
			tr.TLSClientConfig = cfg.TLSConfig.Clone()
		}
		defer tr.CloseIdleConnections()
		client := &http.Client{Transport: tr, Timeout: timeout}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.URL(isolationID), strings.NewReader("{}"))
		if err != nil {
			return time.Time{}, err
		}
		if cfg.Header != nil {
			for k, vs := range cfg.Header() {
				for _, v := range vs {
					req.Header.Add(k, v)
				}
			}
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return time.Time{}, err
		}
		defer func() { _ = resp.Body.Close() }()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			return time.Time{}, fmt.Errorf("verify returned HTTP %d", resp.StatusCode)
		}
		serverTime, _ := http.ParseTime(resp.Header.Get("Date"))
		return serverTime, nil
	}
}
