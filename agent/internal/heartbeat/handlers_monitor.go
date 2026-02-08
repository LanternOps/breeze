package heartbeat

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/discovery"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdNetworkPing] = handleNetworkPing
	handlerRegistry[tools.CmdNetworkTcpCheck] = handleNetworkTcpCheck
	handlerRegistry[tools.CmdNetworkHttpCheck] = handleNetworkHttpCheck
	handlerRegistry[tools.CmdNetworkDnsCheck] = handleNetworkDnsCheck
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
	count := tools.GetPayloadInt(cmd.Payload, "count", 4)

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

	if !followRedirects {
		client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		}
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

	reqStart := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return tools.NewSuccessResult(map[string]any{
			"monitorId":  monitorId,
			"status":     "offline",
			"responseMs": float64(time.Since(reqStart).Microseconds()) / 1000.0,
			"error":      err.Error(),
		}, time.Since(start).Milliseconds())
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

	// Check SSL expiry if TLS was used
	if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		cert := resp.TLS.PeerCertificates[0]
		daysUntilExpiry := int(time.Until(cert.NotAfter).Hours() / 24)
		result["sslExpiry"] = cert.NotAfter.Format(time.RFC3339)
		result["sslDaysRemaining"] = daysUntilExpiry
	}

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
