package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/audit"
	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/eventlog"
	"github.com/breeze-rmm/agent/internal/heartbeat"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/mtls"
	"github.com/breeze-rmm/agent/internal/safemode"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/state"
	"github.com/breeze-rmm/agent/internal/tcc"
	"github.com/breeze-rmm/agent/internal/userhelper"
	"github.com/breeze-rmm/agent/internal/websocket"
	"github.com/breeze-rmm/agent/pkg/api"
	"github.com/spf13/cobra"
)

var (
	version          = "0.5.0"
	cfgFile          string
	serverURL        string
	enrollmentSecret string
	enrollSiteID     string
	enrollDeviceRole string
	forceEnroll      bool
	quietEnroll      bool
	helperRole       string
	desktopContext   string
)

var log = logging.L("main")

// waitForEnrollmentPollInterval is the interval between config reloads
// in the wait-for-enrollment loop. Tests override this via t.Cleanup to
// shrink the loop to milliseconds.
var waitForEnrollmentPollInterval = 10 * time.Second

// Package-level indirection for testability. Tests override these in
// t.Cleanup-guarded setup to observe Execute and runAgent ordering
// without running the real startup pipeline. Production callers MUST
// use these vars, not the unexported symbols they wrap.
//
// startAgentFn and waitForEnrollmentFn are cross-platform; runServiceLoopFn
// is defined in service_seams_windows.go because its signature references
// Windows-only types.
var (
	startAgentFn        func(*config.Config) (*agentComponents, error) = startAgent
	waitForEnrollmentFn func(context.Context, string) *config.Config   = waitForEnrollment
)

// initBootstrapLogging initializes the logging package with stderr +
// the configured log file so waitForEnrollment can emit Warn/Info
// lines before full startAgent runs. Does NOT start the log shipper,
// heartbeat, or any network I/O — those are initialized later in
// startAgent once enrollment is complete. Safe to call multiple times
// (logging.Init is idempotent).
func initBootstrapLogging(cfg *config.Config) {
	logFile := cfg.LogFile
	if logFile == "" {
		logFile = filepath.Join(config.LogDir(), "agent.log")
	}
	// Best effort: if the log file can't be opened (permissions, missing
	// dir), fall back to stderr only. Bootstrap logging must never fail
	// the agent start.
	if err := os.MkdirAll(filepath.Dir(logFile), 0o755); err != nil {
		logging.Init(cfg.LogFormat, cfg.LogLevel, os.Stderr)
		return
	}
	rw, err := logging.NewRotatingWriter(logFile, cfg.LogMaxSizeMB, cfg.LogMaxBackups)
	if err != nil {
		logging.Init(cfg.LogFormat, cfg.LogLevel, os.Stderr)
		return
	}
	logging.Init(cfg.LogFormat, cfg.LogLevel, logging.TeeWriter(os.Stderr, rw))
}

// waitForEnrollment polls agent.yaml + secrets.yaml every
// waitForEnrollmentPollInterval until config.IsEnrolled returns true,
// then returns the enrolled config. Returns nil if ctx is cancelled
// before enrollment completes.
//
// Intended for post-MSI-install scenarios where the service starts
// before a later `breeze-agent enroll` call populates the config. The
// ctx allows the caller to cancel the wait on shutdown (SIGINT/SIGTERM
// via signal.NotifyContext in runAgent, or SCM Stop in the Windows
// service wrapper).
func waitForEnrollment(ctx context.Context, cfgFile string) *config.Config {
	log.Warn("agent not enrolled — waiting for enrollment. "+
		"Run 'breeze-agent enroll <key> --server <url>' to complete setup.",
		"pollInterval", waitForEnrollmentPollInterval)
	eventlog.Info("BreezeAgent",
		"Waiting for enrollment. Run 'breeze-agent enroll <key> --server <url>'.")

	ticker := time.NewTicker(waitForEnrollmentPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info("waitForEnrollment cancelled", "reason", ctx.Err().Error())
			return nil
		case <-ticker.C:
			cfg, err := config.Load(cfgFile)
			if err != nil {
				log.Debug("config reload failed while waiting for enrollment",
					"error", err.Error())
				continue
			}
			if config.IsEnrolled(cfg) {
				log.Info("enrollment detected, continuing startup",
					"agentId", cfg.AgentID)
				return cfg
			}
		}
	}
}

var rootCmd = &cobra.Command{
	Use:   "breeze-agent",
	Short: "Breeze RMM Agent",
	Long:  `Breeze Agent - Remote Monitoring and Management agent for Windows, macOS, and Linux`,
}

var runCmd = &cobra.Command{
	Use:   "run",
	Short: "Start the agent",
	Run: func(cmd *cobra.Command, args []string) {
		runAgent()
	},
}

var enrollCmd = &cobra.Command{
	Use:   "enroll [enrollment-key]",
	Short: "Enroll this device with the Breeze server",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		enrollDevice(args[0])
	},
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the version number",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("Breeze Agent v%s\n", version)
	},
}

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Check agent status",
	Run: func(cmd *cobra.Command, args []string) {
		checkStatus()
	},
}

var userHelperCmd = &cobra.Command{
	Use:   "user-helper",
	Short: "Run as a per-user session helper (started automatically by the system)",
	Long: `The user-helper runs in the logged-in user's session context and provides
desktop notifications, system tray icon, screen capture, clipboard access,
and user-context script execution. It communicates with the root daemon
via a local IPC socket and has no direct network access.`,
	Run: func(cmd *cobra.Command, args []string) {
		runUserHelper()
	},
}

var desktopHelperCmd = &cobra.Command{
	Use:   "desktop-helper",
	Short: "Run as the dedicated desktop helper",
	Run: func(cmd *cobra.Command, args []string) {
		runDesktopHelper()
	},
}

func init() {
	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default is /etc/breeze/agent.yaml)")
	rootCmd.PersistentFlags().StringVar(&serverURL, "server", "", "Breeze server URL")
	enrollCmd.Flags().StringVar(&enrollmentSecret, "enrollment-secret", "", "Enrollment secret (AGENT_ENROLLMENT_SECRET on the server)")
	enrollCmd.Flags().StringVar(&enrollSiteID, "site-id", "", "Site ID to enroll into (optional, overrides enrollment key default)")
	enrollCmd.Flags().StringVar(&enrollDeviceRole, "device-role", "", "Device role override (e.g. workstation, server)")
	enrollCmd.Flags().BoolVar(&forceEnroll, "force", false, "Re-enroll even if already enrolled; replaces AgentID/AuthToken on success (no-op on failure)")
	enrollCmd.Flags().BoolVar(&quietEnroll, "quiet", false, "Suppress stdout progress output (errors still go to stderr). Intended for unattended installs.")
	userHelperCmd.Flags().StringVar(&helperRole, "role", "system", "Helper role: 'system' (desktop capture) or 'user' (script execution)")
	desktopHelperCmd.Flags().StringVar(&desktopContext, "context", ipc.DesktopContextUserSession, "Desktop context: 'user_session' or 'login_window'")

	rootCmd.AddCommand(runCmd)
	rootCmd.AddCommand(enrollCmd)
	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(userHelperCmd)
	rootCmd.AddCommand(desktopHelperCmd)
}

func main() {
	if filepath.Base(os.Args[0]) == "breeze-desktop-helper" {
		for i := 1; i < len(os.Args)-1; i++ {
			if os.Args[i] == "--context" {
				desktopContext = os.Args[i+1]
				break
			}
		}
		runDesktopHelper()
		return
	}
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// initLogging sets up structured logging from config. Call after config.Load().
func initLogging(cfg *config.Config) {
	var output io.Writer = os.Stdout
	logFileFallback := false

	if cfg.LogFile != "" {
		rw, err := logging.NewRotatingWriter(cfg.LogFile, cfg.LogMaxSizeMB, cfg.LogMaxBackups)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to open log file %s: %v (logging to stdout)\n", cfg.LogFile, err)
			logFileFallback = true
		} else if !hasConsole() {
			// No console attached (Windows service, launchd daemon, or systemd
			// service). Use file-only logging — stdout may be invalid or already
			// redirected to a log destination by the init system. Using
			// io.MultiWriter with an invalid stdout would fail the first write
			// and short-circuit all subsequent log output.
			output = rw
		} else {
			output = logging.TeeWriter(os.Stdout, rw)
		}
	}

	logging.Init(cfg.LogFormat, cfg.LogLevel, output)
	// Re-bind package-level logger after Init
	log = logging.L("main")

	// Re-log fallback via structured logger so it appears in journalctl/Event Viewer
	if logFileFallback {
		log.Warn("log file fallback active, logging to stdout only", "requestedFile", cfg.LogFile)
	}
}

// agentComponents holds the running components created by startAgent so that
// service wrappers (Windows SCM, etc.) can shut them down gracefully.
type agentComponents struct {
	hb          *heartbeat.Heartbeat
	wsClient    *websocket.Client
	secureToken *secmem.SecureString
}

// shutdownAgent gracefully stops all agent components.
func shutdownAgent(comps *agentComponents) {
	if comps == nil {
		return
	}

	// Write stopping state so the watchdog knows shutdown is intentional.
	statePath := state.PathInDir(config.ConfigDir())
	if err := state.Write(statePath, &state.AgentState{
		Status:    state.StatusStopping,
		Reason:    state.ReasonUserStop,
		PID:       os.Getpid(),
		Version:   version,
		Timestamp: time.Now(),
	}); err != nil {
		log.Warn("failed to write stopping state file", "error", err.Error())
	}

	// Notify the watchdog of intentional shutdown so it doesn't restart us.
	if broker := comps.hb.SessionBroker(); broker != nil {
		if sess := broker.PreferredSessionWithScope("watchdog"); sess != nil {
			_ = sess.SendNotify("", ipc.TypeShutdownIntent, ipc.ShutdownIntent{
				Reason: state.ReasonUserStop,
			})
		}
	}

	comps.hb.StopAcceptingCommands()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	comps.hb.DrainAndWait(ctx)
	comps.wsClient.Stop()
	comps.hb.Stop()
	if comps.secureToken != nil {
		comps.secureToken.Zero()
	}
}

// startAgent performs all agent initialisation assuming cfg is already
// enrolled. Returns the running components or an error if any
// initialization step fails (mTLS load, log shipper init, heartbeat
// bring-up, etc.). Callers (runAgent on console/Unix, the Windows
// service wrapper) MUST check config.IsEnrolled first and call
// waitForEnrollment if needed — this function no longer performs the
// enrollment check itself.
func startAgent(cfg *config.Config) (*agentComponents, error) {
	if !config.IsEnrolled(cfg) {
		return nil, fmt.Errorf("startAgent called with unenrolled config — caller must waitForEnrollment first")
	}

	// Loosen config directory (0755) and agent.yaml (0644) so the Helper can read
	// them. secrets.yaml stays root-only (0600).
	config.FixConfigPermissions()

	initLogging(cfg)

	// Auto-clear Safe Mode BCD flag on startup to prevent reboot loops.
	// If the agent triggered a safe mode reboot, the safeboot BCD entry
	// persists until explicitly removed. Clear it so the next reboot is normal.
	// NOTE: Requires BreezeAgent to be registered under SafeBoot\Network in the
	// registry (see breeze.wxs) — otherwise the service won't start in safe mode.
	if safemode.IsSafeMode() {
		log.Warn("system is in Safe Mode — clearing safeboot BCD flag for normal reboot")
		if err := safemode.ClearSafeBootFlag(); err != nil {
			log.Error("failed to clear safeboot BCD flag, machine may be stuck in safe mode", "error", err.Error())
		} else {
			log.Info("safeboot BCD flag cleared, next reboot will be normal mode")
		}
	}

	// Wrap auth token in SecureString for defense-in-depth
	secureToken := secmem.NewSecureString(cfg.AuthToken)
	cfg.AuthToken = "" // Clear plaintext from config struct

	// Initialize log shipper for centralized diagnostics
	if cfg.AgentID != "" && cfg.ServerURL != "" {
		logging.InitShipper(logging.ShipperConfig{
			ServerURL:    cfg.ServerURL,
			AgentID:      cfg.AgentID,
			AuthToken:    secureToken,
			AgentVersion: version,
			HTTPClient:   nil, // will use default
			MinLevel:     cfg.LogShippingLevel,
		})
		// Dev builds ship info-level logs for performance tuning and diagnostics.
		if strings.HasPrefix(version, "dev-") && cfg.LogShippingLevel == "warn" {
			logging.SetShipperLevel("info")
		}
	}

	log.Info("starting agent",
		"version", version,
		"server", cfg.ServerURL,
		"agentId", cfg.AgentID,
	)

	// Load mTLS client certificate if configured
	var tlsCfg *tls.Config
	if cfg.MtlsCertPEM != "" {
		if mtls.IsExpired(cfg.MtlsCertExpires) {
			log.Warn("mTLS certificate expired, attempting renewal")
			// Use bearer-only client for renewal (no mTLS required)
			renewClient := api.NewClient(cfg.ServerURL, secureToken.Reveal(), cfg.AgentID)
			renewResp, err := renewClient.RenewCert()
			if err != nil {
				log.Error("mTLS cert renewal request failed, continuing without mTLS", "error", err.Error())
				cfg.MtlsCertPEM = "" // Clear so we don't load the expired cert
			} else if renewResp.Quarantined {
				log.Error("device quarantined by server, continuing without mTLS")
				cfg.MtlsCertPEM = "" // Clear so we don't load the expired cert
			} else if renewResp.Mtls != nil {
				// Validate the cert/key pair before saving
				if _, verifyErr := mtls.LoadClientCert(renewResp.Mtls.Certificate, renewResp.Mtls.PrivateKey); verifyErr != nil {
					log.Error("renewed cert/key pair is invalid, continuing without mTLS", "error", verifyErr.Error())
					cfg.MtlsCertPEM = ""
				} else {
					cfg.MtlsCertPEM = renewResp.Mtls.Certificate
					cfg.MtlsKeyPEM = renewResp.Mtls.PrivateKey
					cfg.MtlsCertExpires = renewResp.Mtls.ExpiresAt
					cfg.AuthToken = secureToken.Reveal()
					if saveErr := config.SaveTo(cfg, cfgFile); saveErr != nil {
						log.Error("failed to save renewed mTLS cert to config", "error", saveErr.Error())
					}
					cfg.AuthToken = ""
					log.Info("mTLS certificate renewed", "expires", renewResp.Mtls.ExpiresAt)
				}
			} else {
				log.Warn("renewal response contained no cert data, continuing without mTLS")
				cfg.MtlsCertPEM = ""
			}
		}

		var err error
		tlsCfg, err = mtls.BuildTLSConfig(cfg.MtlsCertPEM, cfg.MtlsKeyPEM)
		if err != nil {
			log.Error("failed to load mTLS certificate, continuing without mTLS", "error", err.Error())
			tlsCfg = nil
		} else if tlsCfg != nil {
			log.Info("mTLS client certificate loaded")
		}
	}

	// Propagate service/headless flags. On Windows, desktop sessions route
	// through the IPC user helper. On macOS, the daemon handles desktop
	// directly but uses IPC for user-context operations (run_as_user, helper).
	cfg.IsService = isWindowsService()
	cfg.IsHeadless = isHeadless()

	// Ensure SAS (Ctrl+Alt+Del) policy allows services to generate it.
	// Only relevant on Windows when running as a service.
	if cfg.IsService {
		ensureSASPolicy()
	}

	// On macOS, the root daemon has Full Disk Access and can write to the
	// system TCC database. Grant Screen Recording and Accessibility
	// permissions so the agent doesn't rely on user interaction (bare
	// binaries can't trigger TCC prompts properly).
	if runtime.GOOS == "darwin" && os.Getuid() == 0 {
		allTCCGranted := attemptTCCGrant()
		if !allTCCGranted {
			// Retry periodically for the first 30 minutes. This handles the
			// common case where FDA is granted shortly after agent install.
			go retryTCCGrant()
		}
	}

	if cfg.IsHeadless {
		log.Info("running in headless/daemon mode (no console attached)")
	}

	// Start heartbeat - this implements the main agent run loop
	hb := heartbeat.NewWithVersion(cfg, version, secureToken, tlsCfg)

	// Log agent start audit event (nil-safe: Log() is a no-op on nil receiver)
	hb.AuditLog().Log(audit.EventAgentStart, "", map[string]any{
		"version": version,
		"agentId": cfg.AgentID,
	})

	go hb.Start()

	// Start WebSocket client for real-time command delivery
	wsConfig := &websocket.Config{
		ServerURL: cfg.ServerURL,
		AgentID:   cfg.AgentID,
		AuthToken: secureToken,
		TLSConfig: tlsCfg,
	}
	wsClient := websocket.New(wsConfig, hb.HandleCommand)
	hb.SetWebSocketClient(wsClient)
	go wsClient.Start()

	log.Info("agent is running")

	// Write state file so the watchdog can detect a running agent.
	statePath := state.PathInDir(config.ConfigDir())
	if err := state.Write(statePath, &state.AgentState{
		Status:    state.StatusRunning,
		PID:       os.Getpid(),
		Version:   version,
		Timestamp: time.Now(),
	}); err != nil {
		log.Warn("failed to write agent state file", "error", err.Error())
	}

	// Tell the heartbeat where the state file is so it can update after each heartbeat.
	hb.SetStatePath(statePath)

	return &agentComponents{
		hb:          hb,
		wsClient:    wsClient,
		secureToken: secureToken,
	}, nil
}

// attemptTCCGrant runs tcc.EnsurePermissions and logs the results.
// Returns true if all permissions were granted (or already present).
func attemptTCCGrant() bool {
	results, err := tcc.EnsurePermissions()
	if err != nil {
		log.Warn("TCC permission auto-grant incomplete", "error", err.Error())
	}
	allGranted := true
	for _, r := range results {
		if r.Already {
			log.Debug("TCC permission pre-existing", "service", r.Name)
		} else if r.Granted {
			log.Info("TCC permission auto-granted", "service", r.Name)
		} else if r.Err != nil {
			log.Warn("TCC permission grant failed", "service", r.Name, "error", r.Err.Error())
			allGranted = false
		}
	}
	return allGranted && err == nil
}

// retryTCCGrant retries TCC permission grants every 5 minutes for the first
// 30 minutes after startup. This handles the common case where FDA is granted
// shortly after the agent is installed.
func retryTCCGrant() {
	const retryInterval = 5 * time.Minute
	const retryDuration = 30 * time.Minute
	deadline := time.Now().Add(retryDuration)
	ticker := time.NewTicker(retryInterval)
	defer ticker.Stop()

	for {
		<-ticker.C
		if time.Now().After(deadline) {
			log.Info("TCC retry window expired, stopping retries")
			return
		}
		log.Debug("retrying TCC permission auto-grant")
		if attemptTCCGrant() {
			log.Info("TCC permissions all granted, stopping retries")
			return
		}
	}
}

// runAgent starts the main agent run loop. The heartbeat module handles:
// - Periodic heartbeat calls to the API endpoint
// - Receiving pending commands from the server via heartbeat response
// - Executing commands and reporting results back to the server
func runAgent() {
	// Self-heal launchd plists on macOS (fixes KeepAlive config from older installs).
	healLaunchdPlistsIfNeeded()

	// On Windows, if launched by the SCM, run under the service framework
	// so we report Running/Stopped status back to the SCM correctly. The
	// service wrapper owns its own config loading, enrollment check, and
	// cancellation via the SCM request channel.
	if isWindowsService() {
		if err := runAsService(cfgFile); err != nil {
			log.Error("service failed", "error", err.Error())
			os.Exit(1)
		}
		return
	}

	// Console / Unix service-manager mode. Load config, prepare bootstrap
	// logging, and wait for enrollment if needed. signal.NotifyContext
	// wires SIGINT/SIGTERM to ctx so Ctrl+C in a terminal and
	// `systemctl stop` / `launchctl kickstart -k` all cancel any active
	// wait cleanly.
	cfg, err := config.Load(cfgFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}
	initBootstrapLogging(cfg)

	ctx, stop := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer stop()

	if !config.IsEnrolled(cfg) {
		cfg = waitForEnrollmentFn(ctx, cfgFile)
		if cfg == nil {
			log.Info("agent shutting down without enrollment",
				"reason", ctx.Err().Error())
			return
		}
	}

	comps, err := startAgentFn(cfg)
	if err != nil {
		if isPermissionError(err) {
			fmt.Fprintln(os.Stderr, "Error: Permission denied reading agent configuration.")
			fmt.Fprintln(os.Stderr, "The agent runs as a system service and should not be started manually.")
			fmt.Fprintln(os.Stderr, "Check service status with:")
			switch runtime.GOOS {
			case "darwin":
				fmt.Fprintln(os.Stderr, "  sudo breeze-agent status")
				fmt.Fprintln(os.Stderr, "  sudo launchctl list | grep breeze")
			case "linux":
				fmt.Fprintln(os.Stderr, "  sudo breeze-agent status")
				fmt.Fprintln(os.Stderr, "  sudo systemctl status breeze-agent")
			default:
				fmt.Fprintln(os.Stderr, "  Try running with elevated privileges (e.g. sudo).")
			}
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "Failed to start agent: %v\n", err)
		os.Exit(1)
	}
	defer logging.StopShipper()

	// Wait for ctx to be cancelled — SIGINT or SIGTERM via
	// signal.NotifyContext above. Behaviour change: console-mode
	// breeze-agent now treats SIGINT as shutdown instead of ignoring
	// it. The Windows service path is unaffected (SCM signals arrive
	// via the request channel, not Unix signals).
	<-ctx.Done()
	log.Info("shutting down agent", "reason", ctx.Err().Error())

	shutdownAgent(comps)
	log.Info("agent stopped")
}

// enrollDevice handles the enrollment process to register this agent with
// the Breeze server. Respects --force (re-enroll over existing config) and
// --quiet (suppress stdout progress, errors still go to stderr). Writes
// structured logs to the agent log file so MSI-initiated enrollments leave
// the same diagnostic trail as service-initiated ones.
// trimEnrollInputs strips whitespace from the three enrollment argument
// values the MSI passes on the command line. Template MSIs (served by the
// installerBuilder API) space-pad SERVER_URL / ENROLLMENT_KEY /
// ENROLLMENT_SECRET to a fixed 512-char width so the API can byte-patch
// them in-place without relocating any other MSI structures. The padding
// survives argv all the way to this function, and url.Parse rejects
// trailing spaces in a host name — the old PowerShell wrapper trimmed the
// values before exec, and the direct-exe CA has to do the same here.
func trimEnrollInputs(key, server, secret string) (string, string, string) {
	return strings.TrimSpace(key), strings.TrimSpace(server), strings.TrimSpace(secret)
}

func enrollDevice(enrollmentKey string) {
	enrollmentKey, serverURL, enrollmentSecret = trimEnrollInputs(
		enrollmentKey, serverURL, enrollmentSecret,
	)

	cfg, err := config.Load(cfgFile)
	if err != nil {
		cfg = config.Default()
	}

	if serverURL != "" {
		cfg.ServerURL = serverURL
	}

	// Initialise logging so this enrollment leaves a record in agent.log.
	// In quiet mode, force file-only output — errors still reach stderr
	// via explicit fmt.Fprintln calls at error sites below.
	initEnrollLogging(cfg, quietEnroll)

	enrollLog := logging.L("enroll")

	// Clear any stale enroll-last-error.txt from a previous failed
	// attempt BEFORE any validation or early return. Every attempt
	// starts from a clean marker state; a validation failure later
	// in this function must not leave a stale file behind (spec
	// decision 8, issue #411).
	clearEnrollLastError()

	if cfg.ServerURL == "" {
		enrollError(catConfig,
			"server URL required — pass --server or set it in config",
			nil)
	}

	if cfg.AgentID != "" && !forceEnroll {
		enrollLog.Info("agent already enrolled, skipping (use --force to re-enroll)",
			"agentId", cfg.AgentID,
			"server", cfg.ServerURL)
		if !quietEnroll {
			fmt.Printf("Agent is already enrolled with ID: %s\n", cfg.AgentID)
			fmt.Println("Use --force to re-enroll, or delete the config file.")
		}
		return // exit 0 — not an error, allows && chains and MSI CAs to continue
	}

	if cfg.AgentID != "" && forceEnroll {
		enrollLog.Warn("force re-enrollment — existing AgentID will be overwritten on success",
			"previousAgentId", cfg.AgentID,
			"server", cfg.ServerURL)
	}

	enrollLog.Info("starting enrollment", "server", cfg.ServerURL)
	if !quietEnroll {
		fmt.Printf("Enrolling with server: %s\n", cfg.ServerURL)
	}

	hwCollector := collectors.NewHardwareCollector()

	systemInfo, err := hwCollector.CollectSystemInfo()
	if err != nil {
		enrollLog.Warn("system info collection failed, using defaults", "error", err.Error())
		fmt.Fprintf(os.Stderr, "Warning: Failed to collect system info: %v\n", err)
		systemInfo = &collectors.SystemInfo{}
	}

	// WMIC-based hardware collection can take ~75s on Windows, which would
	// block enrollment under an MSI custom action. Fall back to defaults
	// after 10s; heartbeat will populate full hardware info later.
	hardwareInfo := &collectors.HardwareInfo{}
	hwDone := make(chan *collectors.HardwareInfo, 1)
	go func() {
		info, hwErr := hwCollector.CollectHardware()
		if hwErr != nil {
			// Can't use enrollLog here — this goroutine may still be running
			// after enrollDevice has returned or called os.Exit. stderr is
			// safe from any goroutine and lands in the MSI install.log.
			fmt.Fprintf(os.Stderr, "Warning: Hardware collection failed: %v; using defaults for enrollment\n", hwErr)
			hwDone <- &collectors.HardwareInfo{}
			return
		}
		hwDone <- info
	}()
	select {
	case info := <-hwDone:
		hardwareInfo = info
	case <-time.After(10 * time.Second):
		enrollLog.Warn("hardware collection timed out, using defaults for enrollment")
		fmt.Fprintln(os.Stderr, "Warning: Hardware collection timed out; using defaults for enrollment")
	}

	enrollLog.Info("collected system info",
		"hostname", systemInfo.Hostname,
		"os", systemInfo.OSVersion,
		"arch", systemInfo.Architecture)
	if !quietEnroll {
		fmt.Printf("Hostname: %s\n", systemInfo.Hostname)
		fmt.Printf("OS: %s (%s)\n", systemInfo.OSVersion, systemInfo.Architecture)
	}

	// Refuse to enroll with an empty hostname rather than let a fallback
	// downstream (or an older server) substitute the device UUID. See
	// issue #439 — one prod device ended up with its UUID in the hostname
	// column, which is worse than a loud failure because it looks legit.
	if strings.TrimSpace(systemInfo.Hostname) == "" {
		enrollError(catConfig,
			"hostname resolution failed on this machine — tried os.Hostname(), "+
				"COMPUTERNAME env var, and WMI (win32_computersystem.Name); all "+
				"returned empty. Refusing to enroll with an empty hostname.",
			errors.New("empty hostname after fallback chain"))
	}

	client := api.NewClient(cfg.ServerURL, "", "")

	secret := enrollmentSecret
	if secret == "" {
		secret = os.Getenv("BREEZE_AGENT_ENROLLMENT_SECRET")
	}

	deviceRole := enrollDeviceRole
	if deviceRole == "" {
		deviceRole = collectors.ClassifyDeviceRole(systemInfo, hardwareInfo)
	}
	enrollLog.Info("classified device role", "role", deviceRole)
	if !quietEnroll {
		fmt.Printf("Device role: %s\n", deviceRole)
	}

	enrollReq := &api.EnrollRequest{
		EnrollmentKey:    enrollmentKey,
		EnrollmentSecret: secret,
		Hostname:         systemInfo.Hostname,
		OSType:           systemInfo.OSType,
		OSVersion:        systemInfo.OSVersion,
		Architecture:     systemInfo.Architecture,
		AgentVersion:     version,
		DeviceRole:       deviceRole,
		HardwareInfo: &api.HardwareInfo{
			CPUModel:     hardwareInfo.CPUModel,
			CPUCores:     hardwareInfo.CPUCores,
			CPUThreads:   hardwareInfo.CPUThreads,
			RAMTotalMB:   hardwareInfo.RAMTotalMB,
			DiskTotalGB:  hardwareInfo.DiskTotalGB,
			GPUModel:     hardwareInfo.GPUModel,
			SerialNumber: hardwareInfo.SerialNumber,
			Manufacturer: hardwareInfo.Manufacturer,
			Model:        hardwareInfo.Model,
			BIOSVersion:  hardwareInfo.BIOSVersion,
		},
	}

	enrollLog.Info("sending enrollment request")
	if !quietEnroll {
		fmt.Println("Sending enrollment request...")
	}

	enrollResp, err := client.Enroll(enrollReq)
	if err != nil {
		cat, friendly := classifyEnrollError(err, cfg.ServerURL)
		enrollError(cat, friendly, err)
	}

	cfg.AgentID = enrollResp.AgentID
	cfg.AuthToken = enrollResp.AuthToken
	cfg.OrgID = enrollResp.OrgID
	cfg.SiteID = enrollResp.SiteID

	if enrollResp.Config.HeartbeatIntervalSeconds > 0 {
		cfg.HeartbeatIntervalSeconds = enrollResp.Config.HeartbeatIntervalSeconds
	}
	if enrollResp.Config.MetricsCollectionIntervalSeconds > 0 {
		cfg.MetricsIntervalSeconds = enrollResp.Config.MetricsCollectionIntervalSeconds
	}
	if len(enrollResp.Config.EnabledCollectors) > 0 {
		cfg.EnabledCollectors = enrollResp.Config.EnabledCollectors
	}

	if enrollResp.Mtls != nil {
		cfg.MtlsCertPEM = enrollResp.Mtls.Certificate
		cfg.MtlsKeyPEM = enrollResp.Mtls.PrivateKey
		cfg.MtlsCertExpires = enrollResp.Mtls.ExpiresAt
		enrollLog.Info("mTLS certificate issued", "expiresAt", enrollResp.Mtls.ExpiresAt)
		if !quietEnroll {
			fmt.Printf("mTLS certificate issued (expires: %s)\n", enrollResp.Mtls.ExpiresAt)
		}
	}

	if err := config.SaveTo(cfg, cfgFile); err != nil {
		enrollError(catConfig,
			fmt.Sprintf(
				"enrollment succeeded but could not save config to %s — check that the directory exists and SYSTEM has write access (agentID=%s)",
				cfgFile, cfg.AgentID),
			err)
	}

	enrollLog.Info("enrollment successful",
		"agentId", cfg.AgentID,
		"orgId", cfg.OrgID,
		"siteId", cfg.SiteID)
	if !quietEnroll {
		fmt.Println("Enrollment successful!")
		fmt.Printf("Agent ID: %s\n", cfg.AgentID)
		fmt.Println("Configuration saved.")
	}

	if isSystemServiceRunning() {
		if !quietEnroll {
			fmt.Println("Agent is already running via system service.")
		}
	} else if runtime.GOOS == "darwin" || runtime.GOOS == "linux" {
		if !quietEnroll {
			fmt.Println("Start the agent with:")
			fmt.Println("  sudo breeze-agent service start")
		}
	} else {
		if !quietEnroll {
			fmt.Println("Run 'breeze-agent run' to start the agent.")
		}
	}
}

// initEnrollLogging configures the agent logging package for the enroll
// command. In quiet mode the slog sink is the log file only; otherwise it
// tees stdout + file (or file-only when no console is attached, matching
// the runtime behaviour of initLogging). Errors within enrollDevice
// always additionally go to stderr via explicit fmt.Fprintln calls at
// error sites. Logging-setup failures inside this helper fall back to
// stdout logging and also write a warning to stderr.
func initEnrollLogging(cfg *config.Config, quiet bool) {
	if cfg.LogFile == "" {
		cfg.LogFile = filepath.Join(config.LogDir(), "agent.log")
	}

	if err := os.MkdirAll(filepath.Dir(cfg.LogFile), 0o755); err != nil {
		// Rare in production (MSI CA runs as SYSTEM), but if it happens
		// the admin needs to see it in install.log — write to stderr
		// unconditionally so the MSI verbose log captures it.
		fmt.Fprintf(os.Stderr, "Warning: could not create log directory %s: %v — structured logs will go to stdout\n", filepath.Dir(cfg.LogFile), err)
		logging.Init(cfg.LogFormat, cfg.LogLevel, os.Stdout)
		log = logging.L("main")
		return
	}

	rw, err := logging.NewRotatingWriter(cfg.LogFile, cfg.LogMaxSizeMB, cfg.LogMaxBackups)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not open log file %s: %v — structured logs will go to stdout\n", cfg.LogFile, err)
		logging.Init(cfg.LogFormat, cfg.LogLevel, os.Stdout)
		log = logging.L("main")
		return
	}

	var output io.Writer
	switch {
	case quiet:
		output = rw
	case !hasConsole():
		output = rw
	default:
		output = logging.TeeWriter(os.Stdout, rw)
	}

	logging.Init(cfg.LogFormat, cfg.LogLevel, output)
	log = logging.L("main")
}

func checkStatus() {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		if isPermissionError(err) {
			fmt.Println("Status: Unable to read configuration (permission denied)")
			switch runtime.GOOS {
			case "darwin":
				fmt.Println("  The agent runs as a system service. Check status with:")
				fmt.Println("    sudo breeze-agent status")
				fmt.Println("    sudo launchctl list | grep breeze")
			case "linux":
				fmt.Println("  The agent runs as a system service. Check status with:")
				fmt.Println("    sudo breeze-agent status")
				fmt.Println("    sudo systemctl status breeze-agent")
			default:
				fmt.Println("  Try running with elevated privileges (e.g. sudo).")
			}
			return
		}
		fmt.Println("Status: Not configured")
		return
	}

	if cfg.AgentID == "" {
		fmt.Println("Status: Not enrolled")
		return
	}

	if isSystemServiceRunning() {
		fmt.Println("Status: Enrolled & Active")
	} else {
		fmt.Println("Status: Enrolled (stopped)")
	}
	fmt.Printf("Version: %s\n", version)
	fmt.Printf("Agent ID: %s\n", cfg.AgentID)
	fmt.Printf("Server: %s\n", cfg.ServerURL)
	fmt.Printf("Heartbeat Interval: %d seconds\n", cfg.HeartbeatIntervalSeconds)
	fmt.Printf("Metrics Interval: %d seconds\n", cfg.MetricsIntervalSeconds)
	fmt.Printf("Enabled Collectors: %v\n", cfg.EnabledCollectors)
}

// runUserHelper starts the per-user session helper process.
// It connects to the root daemon via IPC and handles user-context operations.
func runUserHelper() {
	runHelperProcess("user helper", helperRole, "", ipc.HelperBinaryUserHelper)
}

func runDesktopHelper() {
	runHelperProcess("desktop helper", ipc.HelperRoleSystem, desktopContext, ipc.HelperBinaryDesktopHelper)
}

func runHelperProcess(name, role, context, binaryKind string) {
	// Log to file in the same logs folder as the main agent
	logDir := filepath.Dir(config.Default().LogFile) // e.g. C:\ProgramData\Breeze\logs
	os.MkdirAll(logDir, 0700)
	logFileName := "user-helper.log"
	if binaryKind == ipc.HelperBinaryDesktopHelper {
		logFileName = "desktop-helper.log"
	}
	logPath := filepath.Join(logDir, logFileName)
	var output io.Writer = os.Stdout
	if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); err == nil {
		// When spawned with CREATE_NO_WINDOW (service helper), stdout is invalid.
		// Use file-only to avoid io.MultiWriter aborting on stdout write errors.
		if hasConsole() {
			output = io.MultiWriter(os.Stdout, f)
		} else {
			output = f
		}
		// Redirect stderr to the same log file so Go panic stack traces
		// are captured instead of being lost to NUL when spawned with
		// CREATE_NO_WINDOW from the service.
		redirectStderr(f)
	}
	logging.Init("text", "info", output)

	// Load agent config for IPC socket path and log shipping credentials.
	// The helper runs as SYSTEM so it can read agent.yaml.
	cfg, _ := config.Load(cfgFile)
	if cfg == nil {
		cfg = config.Default()
	}

	socketPath := ipc.DefaultSocketPath()
	if cfg.IPCSocketPath != "" {
		socketPath = cfg.IPCSocketPath
	}

	// Ship helper logs to the API under the same agent identity
	if cfg.AgentID != "" && cfg.ServerURL != "" && cfg.AuthToken != "" {
		helperToken := secmem.NewSecureString(cfg.AuthToken)
		cfg.AuthToken = "" // Clear plaintext from config struct
		logging.InitShipper(logging.ShipperConfig{
			ServerURL:    cfg.ServerURL,
			AgentID:      cfg.AgentID,
			AuthToken:    helperToken,
			AgentVersion: version + "-helper",
			MinLevel:     cfg.LogShippingLevel,
		})
		defer logging.StopShipper()
	}

	log.Info("starting helper",
		"name", name,
		"version", version,
		"socket", socketPath,
		"pid", os.Getpid(),
		"role", role,
		"context", context,
		"binaryKind", binaryKind,
	)

	// Handle shutdown signals via a done channel so multiple selects
	// can observe the shutdown without racing on a buffered sigChan.
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		<-sigChan
		close(done)
	}()

	// Reconnect loop: when the IPC socket disappears (e.g. agent self-update
	// recreates it), retry with exponential backoff instead of exiting.
	//
	// helperMinBackoff is intentionally conservative (30s) because most helper
	// disconnects in production are caused by permanent identity/auth problems
	// (binary path mismatch, SID lookup failure on headless Windows, etc.),
	// not transient socket hiccups. See issue #387.
	const (
		helperMinBackoff      = 30 * time.Second
		helperMaxBackoff      = 5 * time.Minute
		helperStableThreshold = 60 * time.Second
	)

	warnLimiter := newHelperWarnLimiter(3, 5*time.Minute)
	backoff := helperMinBackoff
	for {
		client := userhelper.NewWithOptions(socketPath, role, binaryKind, context)

		// Stop the current client when shutdown is signaled. The clientDone
		// channel lets this goroutine exit when Run() returns on its own,
		// preventing a goroutine leak per reconnect iteration.
		clientDone := make(chan struct{})
		go func() {
			select {
			case <-done:
				log.Info("shutting down helper", "name", name)
				client.Stop()
			case <-clientDone:
				// Run() returned on its own; nothing to do.
			}
		}()

		err := client.Run()
		close(clientDone)

		// Capture the auth time BEFORE the client is garbage-collected. A
		// zero value means the client never completed auth on this iteration.
		authAt := client.AuthenticatedAt()

		if err == nil {
			// Clean exit (e.g. Stop() was called via signal)
			log.Info("helper stopped", "name", name)
			return
		}

		// Check if we were signaled to stop — don't retry after shutdown.
		select {
		case <-done:
			log.Info("helper stopped after error", "name", name)
			return
		default:
		}

		// Fatal permanent rejection from the broker: exit with code 2 so
		// the lifecycle manager knows not to respawn immediately. Sleep
		// briefly to let the log shipper flush the exit reason.
		//
		// Exit code 2 semantics: signals to the lifecycle manager that
		// this helper should not be respawned immediately — the rejection
		// is permanent (binary hash mismatch, SID lookup failure, etc.).
		var permErr *userhelper.PermanentRejectError
		if errors.As(err, &permErr) {
			log.Error("helper permanently rejected, exiting fatal",
				"name", name,
				"code", permErr.CodeOr("unknown"),
				"reason", permErr.ReasonOr(err.Error()),
			)
			logging.StopShipper() // flush before os.Exit tears down goroutines
			os.Exit(2)
		}
		if errors.Is(err, userhelper.ErrSIDLookupFailed) {
			log.Error("helper permanently rejected, exiting fatal",
				"name", name,
				"code", "sid_lookup_failed",
				"reason", err.Error(),
			)
			logging.StopShipper() // flush before os.Exit tears down goroutines
			os.Exit(2)
		}

		// Only reset backoff if the connection was stably authenticated for
		// >60s. The previous logic reset on wall-clock iteration duration
		// which let the storm keep restarting from 2s after every rate limit
		// window expired.
		if !authAt.IsZero() && time.Since(authAt) > helperStableThreshold {
			backoff = helperMinBackoff
			warnLimiter.reset()
		}

		// Add jitter: [backoff, backoff + backoff/2) so concurrent helpers
		// don't synchronise their reconnect attempts.
		wait := backoff + time.Duration(rand.Int64N(int64(backoff/2)+1))

		errMsg := err.Error()
		if emit, suppressed := warnLimiter.shouldLog(errMsg, time.Now()); emit {
			log.Warn("helper disconnected, reconnecting",
				"name", name, "error", errMsg, "backoff", wait.String())
		} else if suppressed > 0 {
			log.Info("helper still disconnected, suppressing further warnings",
				"name", name,
				"error", errMsg,
				"suppressed_count", suppressed,
				"backoff", wait.String())
		}

		// Wait for backoff or shutdown signal.
		select {
		case <-time.After(wait):
			backoff = min(backoff*2, helperMaxBackoff)
		case <-done:
			log.Info("helper stopped during reconnect backoff", "name", name)
			return
		}
	}
}

// helperWarnLimiter rate-limits a repeating warning message. After `limit`
// emissions of the same message within `window`, further WARN emissions are
// suppressed; an INFO "still disconnected" summary is emitted every
// infoInterval so ops can confirm the helper is still thrashing (not silently
// stuck). Call reset() when the condition clears (e.g. connection has been
// stably authenticated).
type helperWarnLimiter struct {
	mu                   sync.Mutex
	limit                int
	window               time.Duration
	lastMsg              string
	firstSeenAt          time.Time
	count                int // total emissions (incl. suppressed) in this window
	warnsEmitted         int // warn-level emissions in this window
	suppressed           int // warnings suppressed since last info emission
	suppressedSinceInfo  int // count since last INFO — reset on each INFO emit
	lastInfoEmit         time.Time
}

// infoInterval is the sub-window cadence for INFO summaries emitted while
// WARN emissions are suppressed. Short enough to confirm liveliness during
// log tail, long enough to avoid flooding.
const infoInterval = 60 * time.Second

func newHelperWarnLimiter(limit int, window time.Duration) *helperWarnLimiter {
	return &helperWarnLimiter{limit: limit, window: window}
}

// shouldLog returns (emitWarn, suppressedCount). If emitWarn is true, the
// caller should log a WARN. Otherwise, if suppressedCount > 0, the caller
// should log a single INFO "still disconnected" line with that count.
// now is passed in by the caller (typically time.Now()) so that tests can
// control the clock without sleeping.
func (h *helperWarnLimiter) shouldLog(msg string, now time.Time) (bool, int) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if msg != h.lastMsg || now.Sub(h.firstSeenAt) > h.window {
		// New message or window rolled over — reset counters.
		h.lastMsg = msg
		h.firstSeenAt = now
		h.count = 1
		h.warnsEmitted = 1
		h.suppressed = 0
		h.suppressedSinceInfo = 0
		h.lastInfoEmit = time.Time{}
		return true, 0
	}

	h.count++
	if h.warnsEmitted < h.limit {
		h.warnsEmitted++
		return true, 0
	}

	// Over the warn budget — suppress and maybe emit an INFO summary.
	// Summaries fire every infoInterval (60s) so ops can see the helper is
	// still thrashing; each summary reports only the count since the last INFO.
	h.suppressed++
	h.suppressedSinceInfo++
	if h.lastInfoEmit.IsZero() || now.Sub(h.lastInfoEmit) >= infoInterval {
		count := h.suppressedSinceInfo
		h.suppressedSinceInfo = 0
		h.lastInfoEmit = now
		return false, count
	}
	return false, 0
}

// reset clears limiter state so the next message starts a fresh window.
// Call after a helper has been stably connected — the next disconnect is
// a new event and deserves a full WARN.
func (h *helperWarnLimiter) reset() {
	h.mu.Lock()
	h.lastMsg = ""
	h.firstSeenAt = time.Time{}
	h.count = 0
	h.warnsEmitted = 0
	h.suppressed = 0
	h.suppressedSinceInfo = 0
	h.lastInfoEmit = time.Time{}
	h.mu.Unlock()
}
