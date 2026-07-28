package agentapp

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
)

var errNoBootstrapInput = errors.New("no bootstrap token from filename or properties")

// bootstrapInstallData arrives via --install-data on the BootstrapEnroll
// deferred CA's command line, formatted directly from
// "[OriginalDatabase]|[BOOTSTRAP_TOKEN]|[SERVER_URL]" at MSI schedule time.
// (The old SetBootstrapData/CustomActionData indirection was removed — an
// EXE CA cannot read CustomActionData, so it delivered an empty string on
// every install; see the BootstrapEnroll comment in installer/breeze.wxs.)
var bootstrapInstallData string

type bootstrapResult struct {
	ServerURL        string `json:"serverUrl"`
	BackupServerURL  string `json:"backupServerUrl"`
	EnrollmentKey    string `json:"enrollmentKey"`
	EnrollmentSecret string `json:"enrollmentSecret"`
	SiteID           string `json:"siteId"`
}

// resolveBootstrapInputs decides which token/server to use. Property token +
// server take precedence (explicit silent-install intent); otherwise the
// [TOKEN@HOST] in the installer filename is used, with the host (which may
// carry a decoded `host:port`) promoted to an https:// server URL. The
// promotion is unconditionally https; servers running the #2341 fix refuse
// to emit a filename-token download for a non-https URL, but an MSI from an
// older self-hosted server may still embed an http-only host — redemption
// then fails loudly (install rollback), never silently. Mirrors the macOS
// payload-then-filename precedence.
func resolveBootstrapInputs(data string) (token, server string, err error) {
	parts := strings.SplitN(data, "|", 3)
	var installerPath, propToken, propServer string
	if len(parts) > 0 {
		installerPath = parts[0]
	}
	if len(parts) > 1 {
		propToken = strings.TrimSpace(parts[1])
	}
	if len(parts) > 2 {
		propServer = strings.TrimSpace(parts[2])
	}

	if propToken != "" && propServer != "" {
		return propToken, propServer, nil
	}

	if tok, host, ferr := parseInstallerFilenameToken(installerPath); ferr == nil {
		return tok, "https://" + host, nil
	}
	return "", "", errNoBootstrapInput
}

// redeemBootstrapToken exchanges a single-use token for a child enrollment key.
func redeemBootstrapToken(server, token string) (*bootstrapResult, error) {
	url := strings.TrimRight(server, "/") + "/api/v1/installer/bootstrap"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader([]byte("{}")))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Breeze-Bootstrap-Token", token)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bootstrap redeem failed: %d %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out bootstrapResult
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("bootstrap redeem: bad response: %w", err)
	}
	if out.EnrollmentKey == "" {
		return nil, errors.New("bootstrap redeem: response missing enrollmentKey")
	}
	if out.ServerURL == "" {
		out.ServerURL = server
	}
	return &out, nil
}

// runBootstrap resolves enrollment inputs, redeems the token, and enrolls.
// Soft-exits 0 when there is genuinely no token (manual install with no token
// and no properties), so the install completes with an unenrolled agent that
// idles in the wait-for-enrollment loop. A present-but-bad token is a real
// error and exits non-zero so the MSI rolls back cleanly.
func runBootstrap() {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		cfg = config.Default()
	}
	initEnrollLogging(cfg, quietEnroll)
	bsLog := logging.L("bootstrap")

	// The MSI BootstrapEnroll CA runs on major upgrades too (NOT Installed is
	// true for the new product). Bail out before redeeming: enrollDevice would
	// skip anyway (same cfg.AgentID check), but by then redeemBootstrapToken
	// has already consumed the SINGLE-USE bootstrap token for nothing and
	// spent up to 30s on the redeem HTTP call inside a blocking deferred CA.
	// Worse: upgrading with an MSI whose filename token was ALREADY redeemed
	// (the original install's downloaded file, re-run later) makes the redeem
	// 4xx and os.Exit(1) — Return="check" would roll back the whole upgrade.
	if cfg.AgentID != "" {
		bsLog.Info("agent already enrolled; skipping bootstrap", "agent_id", cfg.AgentID)
		if !quietEnroll {
			fmt.Println("Agent already enrolled; skipping bootstrap enrollment.")
		}
		return // exit 0 — upgrade over an enrolled agent must never burn the token
	}

	token, server, err := resolveBootstrapInputs(bootstrapInstallData)
	if err != nil {
		bsLog.Info("no bootstrap token present; skipping enrollment (agent will idle until enrolled)")
		if !quietEnroll {
			fmt.Println("No enrollment token found; install will complete unenrolled.")
		}
		return // exit 0 — soft
	}

	bsLog.Info("redeeming bootstrap token", "server", server)
	res, err := redeemBootstrapToken(server, token)
	if err != nil {
		bsLog.Error("bootstrap token redemption failed", "error", err.Error())
		fmt.Fprintf(os.Stderr, "Bootstrap failed: %v\n", err)
		osExit(1) // hard — roll back the install (osExit: test seam, enroll_error.go)
	}

	// Hand off to the existing enroll path via the package globals it reads.
	// siteId is NOT forwarded here: enrollDevice does not read enrollSiteID for
	// the resolved key — the server derives the site from the (child) key and
	// returns it in the enroll response (cfg.SiteID = enrollResp.SiteID).
	serverURL = res.ServerURL
	backupServerURL = res.BackupServerURL
	enrollmentSecret = res.EnrollmentSecret
	enrollDevice(res.EnrollmentKey)
}
