package heartbeat

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	neturl "net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/discovery"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdNetworkPing] = handleNetworkPing
	handlerRegistry[tools.CmdNetworkTcpCheck] = handleNetworkTcpCheck
	handlerRegistry[tools.CmdNetworkHttpCheck] = handleNetworkHttpCheck
	handlerRegistry[tools.CmdNetworkDnsCheck] = handleNetworkDnsCheck
}

// maxPingCount bounds the ping-sweep repeat count. Monitor checks never need
// more than a handful of probes, and the value sizes a slice allocation.
const maxPingCount = 60

func clampPingCount(count int) int {
	if count < 1 {
		return 1
	}
	if count > maxPingCount {
		return maxPingCount
	}
	return count
}

func handleNetworkPing(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	target, errResult := tools.RequirePayloadString(cmd.Payload, "target")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	monitorId := tools.GetPayloadString(cmd.Payload, "monitorId", "")
	timeout := time.Duration(tools.GetPayloadInt(cmd.Payload, "timeout", 5)) * time.Second
	// count sizes an allocation below, so it must be bounded before use: a
	// negative value panics make(), and a large one lets an unvalidated
	// payload field reserve arbitrary memory on the device.
	count := clampPingCount(tools.GetPayloadInt(cmd.Payload, "count", 4))

	ip := net.ParseIP(target)
	if ip == nil {
		// Resolve hostname
		ips, err := net.LookupIP(target)
		if err != nil || len(ips) == 0 {
			return tools.NewSuccessResult(map[string]any{
				"monitorId":  monitorId,
				"status":     "offline",
				"responseMs": 0,
				"error":      fmt.Sprintf("failed to resolve hostname: %s", target),
			}, time.Since(start).Milliseconds())
		}
		ip = ips[0]
	}

	targets := make([]net.IP, count)
	for i := range targets {
		targets[i] = ip
	}

	results := discovery.PingSweep(targets, timeout, 1)

	if len(results) > 0 {
		// Calculate average RTT
		var totalRtt time.Duration
		for _, r := range results {
			totalRtt += r.RTT
		}
		avgMs := float64(totalRtt.Microseconds()) / float64(len(results)) / 1000.0

		return tools.NewSuccessResult(map[string]any{
			"monitorId":  monitorId,
			"status":     "online",
			"responseMs": avgMs,
			"replies":    len(results),
			"sent":       count,
		}, time.Since(start).Milliseconds())
	}

	// ICMP failed (possibly no root) — fall back to TCP connect on port 80/443
	for _, port := range []string{"443", "80"} {
		tcpStart := time.Now()
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(target, port), timeout)
		if err == nil {
			conn.Close()
			tcpMs := float64(time.Since(tcpStart).Microseconds()) / 1000.0
			return tools.NewSuccessResult(map[string]any{
				"monitorId":  monitorId,
				"status":     "online",
				"responseMs": tcpMs,
				"method":     "tcp_fallback",
				"port":       port,
				"warning":    "ICMP ping failed (may require root privileges), used TCP fallback",
			}, time.Since(start).Milliseconds())
		}
	}

	return tools.NewSuccessResult(map[string]any{
		"monitorId":  monitorId,
		"status":     "offline",
		"responseMs": 0,
		"error":      "host unreachable (ICMP and TCP fallback failed)",
	}, time.Since(start).Milliseconds())
}

func handleNetworkTcpCheck(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	target, errResult := tools.RequirePayloadString(cmd.Payload, "target")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	monitorId := tools.GetPayloadString(cmd.Payload, "monitorId", "")
	port := tools.GetPayloadInt(cmd.Payload, "port", 443)
	timeout := time.Duration(tools.GetPayloadInt(cmd.Payload, "timeout", 5)) * time.Second
	expectBanner := tools.GetPayloadString(cmd.Payload, "expectBanner", "")

	addr := net.JoinHostPort(target, fmt.Sprintf("%d", port))
	dialStart := time.Now()
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return tools.NewSuccessResult(map[string]any{
			"monitorId":  monitorId,
			"status":     "offline",
			"responseMs": float64(time.Since(dialStart).Microseconds()) / 1000.0,
			"error":      err.Error(),
		}, time.Since(start).Milliseconds())
	}
	defer conn.Close()

	responseMs := float64(time.Since(dialStart).Microseconds()) / 1000.0

	result := map[string]any{
		"monitorId":  monitorId,
		"status":     "online",
		"responseMs": responseMs,
	}

	if expectBanner != "" {
		conn.SetReadDeadline(time.Now().Add(timeout))
		buf := make([]byte, 1024)
		n, err := conn.Read(buf)
		if n > 0 {
			banner := string(buf[:n])
			result["banner"] = banner
			if !strings.Contains(banner, expectBanner) {
				result["status"] = "degraded"
				result["error"] = fmt.Sprintf("banner mismatch: expected %q", expectBanner)
			}
		} else if err != nil {
			result["status"] = "degraded"
			result["error"] = fmt.Sprintf("banner read failed: %v", err)
		} else {
			result["status"] = "degraded"
			result["error"] = "no banner received"
		}
	}

	return tools.NewSuccessResult(result, time.Since(start).Milliseconds())
}

// maxTlsObservationLen bounds the issuer DN and observed host the agent
// reports. They land in varchar(255) columns on network_monitors (#4230); a
// truncated display string is strictly better than a rejected writeback that
// drops the whole observation.
const maxTlsObservationLen = 255

// maxRedirectHops mirrors net/http's own default redirect cap, which our
// CheckRedirect replaces.
const maxRedirectHops = 10

// truncateObservation clips to maxTlsObservationLen bytes without splitting a
// multi-byte rune — issuer DNs carry non-ASCII organisation names.
func truncateObservation(s string) string {
	if len(s) <= maxTlsObservationLen {
		return s
	}
	cut := maxTlsObservationLen
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func handleNetworkHttpCheck(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	url, errResult := tools.RequirePayloadString(cmd.Payload, "url")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	monitorId := tools.GetPayloadString(cmd.Payload, "monitorId", "")
	method := tools.GetPayloadString(cmd.Payload, "method", "GET")
	expectedStatus := tools.GetPayloadInt(cmd.Payload, "expectedStatus", 200)
	expectedBody := tools.GetPayloadString(cmd.Payload, "expectedBody", "")
	verifySsl := tools.GetPayloadBool(cmd.Payload, "verifySsl", true)
	followRedirects := tools.GetPayloadBool(cmd.Payload, "followRedirects", true)
	timeout := time.Duration(tools.GetPayloadInt(cmd.Payload, "timeout", 10)) * time.Second

	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: !verifySsl,
		},
	}

	client := &http.Client{
		Timeout:   timeout,
		Transport: transport,
	}

	// The hop actually being ATTEMPTED (#5754). `client.Do` follows redirects by
	// building a new request per hop and never mutates the caller's, so the
	// original `req` cannot answer "which endpoint just failed". Without this,
	// an http:// monitor that redirects to a broken https endpoint reports no
	// TLS state at all, the server leaves the stored observation untouched, and
	// a stale `observed` row keeps reading as "fine" through a live failure.
	var lastURL *neturl.URL
	client.CheckRedirect = func(r *http.Request, via []*http.Request) error {
		if !followRedirects {
			return http.ErrUseLastResponse
		}
		// Installing ANY CheckRedirect replaces net/http's default, which is
		// what caps a chain at 10 hops. Restoring the cap explicitly is the
		// only thing between a redirect LOOP and a check that runs hops for
		// the whole timeout window on every polling interval.
		if len(via) >= maxRedirectHops {
			return fmt.Errorf("stopped after %d redirects", len(via))
		}
		lastURL = r.URL
		return nil
	}

	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		return tools.NewSuccessResult(map[string]any{
			"monitorId":  monitorId,
			"status":     "offline",
			"responseMs": 0,
			"error":      fmt.Sprintf("invalid request: %v", err),
		}, time.Since(start).Milliseconds())
	}

	req.Header.Set("User-Agent", "BreezeRMM-Monitor/1.0")
	lastURL = req.URL

	reqStart := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		errResult := map[string]any{
			"monitorId":  monitorId,
			"status":     "offline",
			"responseMs": float64(time.Since(reqStart).Microseconds()) / 1000.0,
			"error":      err.Error(),
		}
		// #4230: the server must be able to tell "the handshake failed" from
		// "plain HTTP" from "the check never ran". A TLS failure returns here,
		// before any certificate exists, so the state is reported explicitly.
		// A TCP-level failure against an http:// target is NOT a handshake
		// failure and stays silent, leaving any prior observation untouched.
		if lastURL != nil && strings.EqualFold(lastURL.Scheme, "https") {
			errResult["sslState"] = "handshake_failed"
			errResult["sslObservedHost"] = truncateObservation(lastURL.Host)
			errResult["sslRequestedUrl"] = truncateObservation(url)
		}
		return tools.NewSuccessResult(errResult, time.Since(start).Milliseconds())
	}
	defer resp.Body.Close()

	responseMs := float64(time.Since(reqStart).Microseconds()) / 1000.0

	result := map[string]any{
		"monitorId":  monitorId,
		"status":     "online",
		"responseMs": responseMs,
		"statusCode": resp.StatusCode,
	}

	var errors []string

	// Check status code
	if resp.StatusCode != expectedStatus {
		result["status"] = "degraded"
		errors = append(errors, fmt.Sprintf("expected status %d, got %d", expectedStatus, resp.StatusCode))
	}

	// Check body match if specified
	if expectedBody != "" {
		bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1MB limit
		if err != nil {
			result["status"] = "degraded"
			errors = append(errors, fmt.Sprintf("failed to read body: %v", err))
		} else {
			bodyMatch := strings.Contains(string(bodyBytes), expectedBody)
			result["bodyMatch"] = bodyMatch
			if !bodyMatch {
				result["status"] = "degraded"
				errors = append(errors, "expected body content not found")
			}
		}
	}

	if len(errors) > 0 {
		result["error"] = strings.Join(errors, "; ")
	}

	// Certificate observation (#4230). The certificate belongs to the FINAL
	// response, which after a redirect is a different endpoint than the
	// monitor's target — so the observed host is recorded alongside the expiry,
	// or a finding would name the wrong endpoint.
	if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		cert := resp.TLS.PeerCertificates[0]
		daysUntilExpiry := int(time.Until(cert.NotAfter).Hours() / 24)
		result["sslExpiry"] = cert.NotAfter.Format(time.RFC3339)
		result["sslDaysRemaining"] = daysUntilExpiry
		result["sslIssuer"] = truncateObservation(cert.Issuer.String())
		result["sslState"] = "observed"
	} else if resp.TLS != nil {
		// A completed handshake that presented no certificate is not plain
		// HTTP and is not a reading we can trust — never report it as not_tls,
		// which would say "this endpoint has no certificate to expire".
		result["sslState"] = "handshake_failed"
	} else {
		result["sslState"] = "not_tls"
	}
	if resp.Request != nil && resp.Request.URL != nil {
		result["sslObservedHost"] = truncateObservation(resp.Request.URL.Host)
	} else {
		result["sslObservedHost"] = truncateObservation(req.URL.Host)
	}
	// Echoed so the server can tell a result produced under the CURRENT
	// target/config from one already in flight when an operator edited the
	// monitor — see recordMonitorCheckResult.
	result["sslRequestedUrl"] = truncateObservation(url)

	return tools.NewSuccessResult(result, time.Since(start).Milliseconds())
}

func handleNetworkDnsCheck(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	hostname, errResult := tools.RequirePayloadString(cmd.Payload, "hostname")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	monitorId := tools.GetPayloadString(cmd.Payload, "monitorId", "")
	recordType := tools.GetPayloadString(cmd.Payload, "recordType", "A")
	expectedValue := tools.GetPayloadString(cmd.Payload, "expectedValue", "")
	nameserver := tools.GetPayloadString(cmd.Payload, "nameserver", "")
	timeout := time.Duration(tools.GetPayloadInt(cmd.Payload, "timeout", 5)) * time.Second

	resolver := &net.Resolver{
		PreferGo: true,
	}

	if nameserver != "" {
		if !strings.Contains(nameserver, ":") {
			nameserver = nameserver + ":53"
		}
		resolver.Dial = func(ctx context.Context, network, address string) (net.Conn, error) {
			d := net.Dialer{Timeout: timeout}
			return d.DialContext(ctx, "udp", nameserver)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	lookupStart := time.Now()
	var records []string
	var lookupErr error

	switch strings.ToUpper(recordType) {
	case "A", "AAAA":
		ips, err := resolver.LookupIPAddr(ctx, hostname)
		lookupErr = err
		for _, ip := range ips {
			if recordType == "A" && ip.IP.To4() != nil {
				records = append(records, ip.IP.String())
			} else if recordType == "AAAA" && ip.IP.To4() == nil {
				records = append(records, ip.IP.String())
			}
		}
	case "MX":
		mxs, err := resolver.LookupMX(ctx, hostname)
		lookupErr = err
		for _, mx := range mxs {
			records = append(records, fmt.Sprintf("%d %s", mx.Pref, mx.Host))
		}
	case "CNAME":
		cname, err := resolver.LookupCNAME(ctx, hostname)
		lookupErr = err
		if cname != "" {
			records = append(records, cname)
		}
	case "TXT":
		txts, err := resolver.LookupTXT(ctx, hostname)
		lookupErr = err
		records = txts
	case "NS":
		nss, err := resolver.LookupNS(ctx, hostname)
		lookupErr = err
		for _, ns := range nss {
			records = append(records, ns.Host)
		}
	default:
		return tools.NewSuccessResult(map[string]any{
			"monitorId":  monitorId,
			"status":     "offline",
			"responseMs": 0,
			"error":      fmt.Sprintf("unsupported record type: %s", recordType),
		}, time.Since(start).Milliseconds())
	}

	responseMs := float64(time.Since(lookupStart).Microseconds()) / 1000.0

	if lookupErr != nil {
		return tools.NewSuccessResult(map[string]any{
			"monitorId":  monitorId,
			"status":     "offline",
			"responseMs": responseMs,
			"error":      lookupErr.Error(),
		}, time.Since(start).Milliseconds())
	}

	result := map[string]any{
		"monitorId":  monitorId,
		"status":     "online",
		"responseMs": responseMs,
		"records":    records,
	}

	if expectedValue != "" {
		matched := false
		for _, r := range records {
			if strings.Contains(r, expectedValue) {
				matched = true
				break
			}
		}
		result["matched"] = matched
		if !matched {
			result["status"] = "degraded"
			result["error"] = fmt.Sprintf("expected value %q not found in records", expectedValue)
		}
	}

	return tools.NewSuccessResult(result, time.Since(start).Milliseconds())
}
