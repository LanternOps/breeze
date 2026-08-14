package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/heartbeat"
)

// `nu-agent uninstall --token <TOKEN>` — the AUTHORIZED local uninstall.
//
// Why this lives in cmd/ rather than as another cobra command in
// internal/agentapp: the uninstall path must be reachable and reviewable on
// its own, and intercepting argv here keeps the whole local-uninstall surface
// (parse → authorize → teardown → verify) in one file next to the binary's
// entrypoint. Everything downstream of authorization is delegated — the
// teardown itself is heartbeat.RunLocalUninstall, the same code the RMM-pushed
// self_uninstall command runs. There is exactly one teardown implementation.
//
// FAIL CLOSED is the contract. A rejected token, a malformed response, an
// unreachable server, a DNS failure, a timeout, an unenrolled config, a
// missing token — every one of them aborts WITHOUT removing anything. The
// only path that reaches teardown is an explicit `{"allowed":true}` from the
// server. This is the entire point of the feature: before it existed, a local
// admin could remove the agent from a managed machine with no server
// involvement at all.

const uninstallCommandName = "uninstall"

// uninstallTokenPattern mirrors the server's mint format (`nuu_` + 64 hex).
// Checked locally only to fail fast with a useful message — the server is the
// authority and rejects anything it did not mint.
var uninstallTokenPattern = regexp.MustCompile(`^nuu_[0-9a-f]{64}$`)

// authorizeTimeout bounds the single authorization call. A hang must not leave
// a technician staring at a terminal, and a timeout is a REFUSAL, not a retry.
const authorizeTimeout = 20 * time.Second

// uninstallHTTPClient is a seam for tests.
var uninstallHTTPClient = &http.Client{Timeout: authorizeTimeout}

// loadUninstallConfig / runLocalUninstall / exitFn are seams so the fail-closed
// contract can be unit-tested without a real install.
var (
	loadUninstallConfig = func(cfgFile string) (*config.Config, error) { return config.Load(cfgFile) }
	runLocalUninstall   = heartbeat.RunLocalUninstall
	uninstallExit       = os.Exit
	uninstallStderr     io.Writer = os.Stderr
	uninstallStdout     io.Writer = os.Stdout
)

type uninstallArgs struct {
	token      string
	configFile string
	keepConfig bool
}

// parseUninstallArgs parses the argv tail after the `uninstall` verb.
func parseUninstallArgs(args []string) (uninstallArgs, error) {
	var out uninstallArgs
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--token":
			if i+1 >= len(args) {
				return out, fmt.Errorf("--token requires a value")
			}
			out.token = args[i+1]
			i++
		case "--config":
			if i+1 >= len(args) {
				return out, fmt.Errorf("--config requires a value")
			}
			out.configFile = args[i+1]
			i++
		case "--keep-config":
			out.keepConfig = true
		default:
			if strings.HasPrefix(args[i], "--token=") {
				out.token = strings.TrimPrefix(args[i], "--token=")
				continue
			}
			if strings.HasPrefix(args[i], "--config=") {
				out.configFile = strings.TrimPrefix(args[i], "--config=")
				continue
			}
			return out, fmt.Errorf("unknown argument %q", args[i])
		}
	}
	if out.token == "" {
		return out, fmt.Errorf("--token is required: mint one from the RMM (device actions → Uninstall agent). A local uninstall without an RMM-issued token is refused")
	}
	if !uninstallTokenPattern.MatchString(out.token) {
		return out, fmt.Errorf("--token is not a valid uninstall token")
	}
	return out, nil
}

type authorizeResponse struct {
	Allowed bool   `json:"allowed"`
	Error   string `json:"error"`
}

// authorizeUninstall exchanges the token at POST
// /api/v1/agents/:id/uninstall-authorize using the device's own agent token.
// It returns an error on ANY outcome that is not an explicit allow.
func authorizeUninstall(cfg *config.Config, token string) error {
	base := strings.TrimSuffix(cfg.ServerURL, "/")
	if base == "" {
		return fmt.Errorf("no server URL configured")
	}
	endpoint := fmt.Sprintf("%s/api/v1/agents/%s/uninstall-authorize", base, url.PathEscape(cfg.AgentID))

	body, err := json.Marshal(map[string]string{"token": token})
	if err != nil {
		return fmt.Errorf("encode authorization request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build authorization request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)

	resp, err := uninstallHTTPClient.Do(req)
	if err != nil {
		// Network failure is a REFUSAL. An operator who can cut the agent off
		// the network must not thereby gain the ability to uninstall it.
		return fmt.Errorf("could not reach the server to authorize this uninstall: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return fmt.Errorf("read authorization response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("server refused this uninstall (HTTP %d)", resp.StatusCode)
	}

	var decoded authorizeResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return fmt.Errorf("unreadable authorization response")
	}
	if !decoded.Allowed {
		return fmt.Errorf("server refused this uninstall")
	}
	return nil
}

// runUninstallCommand is the whole local-uninstall flow.
func runUninstallCommand(args []string) int {
	parsed, err := parseUninstallArgs(args)
	if err != nil {
		fmt.Fprintf(uninstallStderr, "Error: %v\n", err)
		return 2
	}

	cfg, err := loadUninstallConfig(parsed.configFile)
	if err != nil {
		fmt.Fprintf(uninstallStderr, "Error: cannot read agent config: %v\n", err)
		return 1
	}
	if !config.IsEnrolled(cfg) {
		// Not enrolled ⇒ no device identity ⇒ nothing can authorize this.
		// Refusing here is deliberate: it must not be possible to "uninstall"
		// by first breaking the enrollment.
		fmt.Fprintln(uninstallStderr, "Error: this agent is not enrolled, so no server can authorize its removal. Remove it from the RMM instead.")
		return 1
	}

	if err := authorizeUninstall(cfg, parsed.token); err != nil {
		fmt.Fprintf(uninstallStderr, "Error: uninstall NOT authorized — nothing was removed: %v\n", err)
		return 1
	}

	fmt.Fprintln(uninstallStdout, "Uninstall authorized by the server. Removing the agent...")

	if err := runLocalUninstall(!parsed.keepConfig); err != nil {
		fmt.Fprintf(uninstallStderr, "Error: %v\n", err)
		return 1
	}

	return verifyUninstall()
}

// verifyUninstall waits out the detached teardown helper and proves the
// machine is clean. Non-zero exit + a loud message is the contract when
// anything survives — a "successful" uninstall that leaves binaries, launchd
// jobs or receipts behind is the failure mode this whole path exists to
// prevent.
func verifyUninstall() int {
	if runtime.GOOS != "darwin" {
		// The manifest-derived sweep is macOS-specific (pkg receipts); the
		// other platforms' teardown is unchanged and self-verifying via the
		// service manager.
		return 0
	}

	paths := heartbeat.DarwinTeardownPaths()
	deadline := time.Now().Add(time.Duration(heartbeat.UninstallHelperDelaySeconds+45) * time.Second)
	var survivors []string
	for {
		survivors = heartbeat.SurvivingArtifacts(paths)
		if len(survivors) == 0 {
			fmt.Fprintln(uninstallStdout, "Uninstall complete — no agent artifacts remain.")
			return 0
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(2 * time.Second)
	}

	fmt.Fprintln(uninstallStderr, "UNINSTALL INCOMPLETE — the following artifacts survived teardown:")
	for _, p := range survivors {
		fmt.Fprintf(uninstallStderr, "  %s\n", p)
	}
	fmt.Fprintf(uninstallStderr, "Remove them manually and check %s.\n", heartbeat.DarwinUninstallLogPath)
	return 1
}

// maybeRunUninstallCommand intercepts `nu-agent uninstall …` before cobra
// dispatch in internal/agentapp. Returns true when it handled the invocation.
func maybeRunUninstallCommand(argv []string) bool {
	if len(argv) < 2 || argv[1] != uninstallCommandName {
		return false
	}
	uninstallExit(runUninstallCommand(argv[2:]))
	return true
}
