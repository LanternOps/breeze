package heartbeat

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/tunnel"
)

const (
	httpProxyTimeout = 20 * time.Second
	httpProxyMaxBody = 16 << 20 // 16 MiB
)

func handleHttpRequest(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	targetHost, _ := cmd.Payload["targetHost"].(string)
	targetPortF, _ := cmd.Payload["targetPort"].(float64)
	targetPort := int(targetPortF)
	scheme, _ := cmd.Payload["scheme"].(string)
	skipTLSVerify, _ := cmd.Payload["skipTlsVerify"].(bool)
	method, _ := cmd.Payload["method"].(string)
	path, _ := cmd.Payload["path"].(string)

	if targetHost == "" || targetPort == 0 {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "missing targetHost or targetPort",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
	if method == "" {
		method = "GET"
	}
	if path == "" {
		path = "/"
	}

	// SECURITY: restrict the scheme to http(s). An empty scheme is fine —
	// tunnel.Fetch derives it from the port. Anything else (file://, gopher://,
	// etc.) is rejected outright.
	if scheme != "" && scheme != "http" && scheme != "https" {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "unsupported scheme",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	// SECURITY: reject any path that is not a plain relative path. A value like
	// "@evil.com/x" or "//evil.com/x" would otherwise re-parse to a different
	// host and bypass the IsBlocked/IsAllowed checks below (which validate
	// targetHost only). Defense-in-depth — tunnel.Fetch enforces this too.
	if !strings.HasPrefix(path, "/") {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "path must start with /",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	// Decode optional request body (arrives base64-encoded).
	var body []byte
	if b64, ok := cmd.Payload["bodyB64"].(string); ok && b64 != "" {
		var err error
		body, err = base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return tools.CommandResult{
				Status:     "failed",
				Error:      "invalid bodyB64: " + err.Error(),
				DurationMs: time.Since(start).Milliseconds(),
			}
		}
	}

	// Parse forwarded request headers.
	headers := parseProxyHeaderMap(cmd.Payload["headers"])

	// Defense-in-depth guard 1: hardcoded block list (same as tunnel_open, isVNC=false).
	if blocked, reason := tunnel.IsBlocked(targetHost, targetPort, false); blocked {
		return tools.CommandResult{
			Status:     "failed",
			Error:      fmt.Sprintf("target %s:%d is blocked: %s", targetHost, targetPort, reason),
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	// Defense-in-depth guard 2: allowlist rules sent by the API.
	// Empty rules = deny (API must always send rules for http_request).
	var rules []tunnel.AllowlistRule
	if rawRules, ok := cmd.Payload["allowlistRules"].([]interface{}); ok {
		for _, r := range rawRules {
			if pattern, ok := r.(string); ok {
				rule, err := tunnel.ParseAllowlistRule(pattern)
				if err != nil {
					log.Warn("invalid allowlist rule from API", "pattern", pattern, "error", err.Error())
					continue
				}
				rules = append(rules, rule)
			}
		}
	}
	if !tunnel.IsAllowed(targetHost, targetPort, rules) {
		return tools.CommandResult{
			Status:     "failed",
			Error:      fmt.Sprintf("target %s:%d not permitted by allowlist", targetHost, targetPort),
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), httpProxyTimeout)
	defer cancel()

	return fetchAndEncodeHttp(ctx, tunnel.FetchRequest{
		Scheme:        scheme,
		Host:          targetHost,
		Port:          targetPort,
		Method:        method,
		Path:          path,
		Headers:       headers,
		Body:          body,
		SkipTLSVerify: skipTLSVerify,
	}, start)
}

// fetchAndEncodeHttp performs the proxied fetch and builds the command result.
// It deliberately does NOT run the IsBlocked/IsAllowed guards — callers must
// apply those first. Kept separate so the fetch→encode path can be tested
// against a loopback httptest server in any environment (including CI
// containers with only a loopback interface), without weakening the block guard.
func fetchAndEncodeHttp(ctx context.Context, req tunnel.FetchRequest, start time.Time) tools.CommandResult {
	resp, err := tunnel.Fetch(ctx, req, httpProxyTimeout, httpProxyMaxBody)
	if err != nil {
		errStr := err.Error()
		// Defensive guard: normalise the error to the stable API token.
		// Today Fetch returns ErrTLSCertUntrusted unwrapped, so err.Error() already
		// equals "tls_cert_untrusted" and the branch is belt-and-suspenders; but if
		// Fetch ever wraps the sentinel with %w, errors.Is still catches it while a
		// bare string comparison would not, keeping the stable "tls_cert_untrusted"
		// token intact for the API's string match.
		if errors.Is(err, tunnel.ErrTLSCertUntrusted) {
			errStr = "tls_cert_untrusted"
		}
		return tools.CommandResult{
			Status:     "failed",
			Error:      errStr,
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	return tools.NewSuccessResult(map[string]any{
		"status":    resp.Status,
		"headers":   resp.Headers,
		"bodyB64":   base64.StdEncoding.EncodeToString(resp.Body),
		"truncated": resp.Truncated,
	}, time.Since(start).Milliseconds())
}

// parseProxyHeaderMap converts the raw payload "headers" value (a
// map[string]any where values may be []any or string) to the canonical
// map[string][]string used by tunnel.FetchRequest / net/http.
func parseProxyHeaderMap(raw any) map[string][]string {
	if raw == nil {
		return nil
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string][]string, len(m))
	for k, v := range m {
		switch val := v.(type) {
		case []any:
			strs := make([]string, 0, len(val))
			for _, s := range val {
				if str, ok := s.(string); ok {
					strs = append(strs, str)
				}
			}
			out[k] = strs
		case string:
			out[k] = []string{val}
		}
	}
	return out
}
