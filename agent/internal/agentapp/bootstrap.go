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

// bootstrapInstallData is the WiX CustomActionData payload, packed by the
// SetBootstrapData type-51 CA as "<OriginalDatabase>|<BOOTSTRAP_TOKEN>|<SERVER_URL>".
var bootstrapInstallData string

type bootstrapResult struct {
	ServerURL        string `json:"serverUrl"`
	EnrollmentKey    string `json:"enrollmentKey"`
	EnrollmentSecret string `json:"enrollmentSecret"`
	SiteID           string `json:"siteId"`
}

// resolveBootstrapInputs decides which token/server to use. Property token +
// server take precedence (explicit silent-install intent); otherwise the
// [TOKEN@HOST] in the installer filename is used, with the host promoted to an
// https:// server URL. Mirrors the macOS payload-then-filename precedence.
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
		os.Exit(1) // hard — roll back the install
	}

	// Hand off to the existing enroll path via the package globals it reads.
	// siteId is NOT forwarded here: enrollDevice does not read enrollSiteID for
	// the resolved key — the server derives the site from the (child) key and
	// returns it in the enroll response (cfg.SiteID = enrollResp.SiteID).
	serverURL = res.ServerURL
	enrollmentSecret = res.EnrollmentSecret
	enrollDevice(res.EnrollmentKey)
}
