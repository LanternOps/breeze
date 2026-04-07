package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/audit"
	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
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
	helperRole       string
	desktopContext   string
)

var log = logging.L("main")

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

// startAgent performs all agent initialisation and returns the running
// components. It is used by both the console-mode runAgent and the Windows
// SCM service wrapper so the startup logic lives in one place.
func startAgent() (*agentComponents, error) {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	if cfg.AgentID == "" {
		return nil, fmt.Errorf("agent not enrolled — run 'breeze-agent enroll <key>' first")
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
				log.Error("mTLS cert renewal request failed, continuing without mTLS", "error", err)
				cfg.MtlsCertPEM = "" // Clear so we don't load the expired cert
			} else if renewResp.Quarantined {
				log.Error("device quarantined by server, continuing without mTLS")
				cfg.MtlsCertPEM = "" // Clear so we don't load the expired cert
			} else if renewResp.Mtls != nil {
				// Validate the cert/key pair before saving
				if _, verifyErr := mtls.LoadClientCert(renewResp.Mtls.Certificate, renewResp.Mtls.PrivateKey); verifyErr != nil {
					log.Error("renewed cert/key pair is invalid, continuing without mTLS", "error", verifyErr)
					cfg.MtlsCertPEM = ""
				} else {
					cfg.MtlsCertPEM = renewResp.Mtls.Certificate
					cfg.MtlsKeyPEM = renewResp.Mtls.PrivateKey
					cfg.MtlsCertExpires = renewResp.Mtls.ExpiresAt
					cfg.AuthToken = secureToken.Reveal()
					if saveErr := config.SaveTo(cfg, cfgFile); saveErr != nil {
						log.Error("failed to save renewed mTLS cert to config", "error", saveErr)
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
			log.Error("failed to load mTLS certificate, continuing without mTLS", "error", err)
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
	// so we report Running/Stopped status back to the SCM correctly.
	if isWindowsService() {
		if err := runAsService(startAgent); err != nil {
			log.Error("service failed", "error", err)
			os.Exit(1)
		}
		return
	}

	// Console mode — start components and wait for OS signal.
	comps, err := startAgent()
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

	// Ignore SIGINT — as a daemon, PTY child processes can propagate
	// SIGINT to our process group via Ctrl+C. Only SIGTERM should trigger shutdown.
	signal.Ignore(syscall.SIGINT)

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGTERM)

	<-sigChan
	log.Info("shutting down agent")

	shutdownAgent(comps)
	log.Info("agent stopped")
}

// enrollDevice handles the enrollment process to register this agent with the Breeze server.
func enrollDevice(enrollmentKey string) {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		cfg = config.Default()
	}

	if serverURL != "" {
		cfg.ServerURL = serverURL
	}

	if cfg.ServerURL == "" {
		fmt.Fprintln(os.Stderr, "Server URL required. Use --server flag or set in config.")
		os.Exit(1)
	}

	if cfg.AgentID != "" {
		fmt.Printf("Agent is already enrolled with ID: %s\n", cfg.AgentID)
		fmt.Println("To re-enroll, delete the config file first.")
		return // exit 0 — not an error, allows && chains to continue
	}

	fmt.Printf("Enrolling with server: %s\n", cfg.ServerURL)

	hwCollector := collectors.NewHardwareCollector()

	systemInfo, err := hwCollector.CollectSystemInfo()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: Failed to collect system info: %v\n", err)
		systemInfo = &collectors.SystemInfo{}
	}

	hardwareInfo, err := hwCollector.CollectHardware()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: Failed to collect hardware info: %v\n", err)
		hardwareInfo = &collectors.HardwareInfo{}
	}

	fmt.Printf("Hostname: %s\n", systemInfo.Hostname)
	fmt.Printf("OS: %s (%s)\n", systemInfo.OSVersion, systemInfo.Architecture)

	client := api.NewClient(cfg.ServerURL, "", "")

	secret := enrollmentSecret
	if secret == "" {
		secret = os.Getenv("BREEZE_AGENT_ENROLLMENT_SECRET")
	}

	deviceRole := enrollDeviceRole
	if deviceRole == "" {
		deviceRole = collectors.ClassifyDeviceRole(systemInfo, hardwareInfo)
	}
	fmt.Printf("Device role: %s\n", deviceRole)

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

	fmt.Println("Sending enrollment request...")

	enrollResp, err := client.Enroll(enrollReq)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Enrollment failed: %v\n", err)
		os.Exit(1)
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

	// Save mTLS certificate if issued
	if enrollResp.Mtls != nil {
		cfg.MtlsCertPEM = enrollResp.Mtls.Certificate
		cfg.MtlsKeyPEM = enrollResp.Mtls.PrivateKey
		cfg.MtlsCertExpires = enrollResp.Mtls.ExpiresAt
		fmt.Printf("mTLS certificate issued (expires: %s)\n", enrollResp.Mtls.ExpiresAt)
	}

	if err := config.SaveTo(cfg, cfgFile); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: Failed to save config: %v\n", err)
		fmt.Fprintf(os.Stderr, "Agent ID: %s\n", cfg.AgentID)
		fmt.Fprintln(os.Stderr, "You may need to manually save the configuration.")
		os.Exit(1)
	}

	fmt.Println("Enrollment successful!")
	fmt.Printf("Agent ID: %s\n", cfg.AgentID)
	fmt.Println("Configuration saved.")

	if isSystemServiceRunning() {
		fmt.Println("Agent is already running via system service.")
	} else if runtime.GOOS == "darwin" || runtime.GOOS == "linux" {
		fmt.Println("Start the agent with:")
		fmt.Println("  sudo breeze-agent service start")
	} else {
		fmt.Println("Run 'breeze-agent run' to start the agent.")
	}
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
	const (
		helperMinBackoff = 2 * time.Second
		helperMaxBackoff = 30 * time.Second
	)

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

		connStart := time.Now()
		err := client.Run()
		close(clientDone)
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

		// If the connection was up for a meaningful period, reset backoff
		// so the next reconnect starts fast.
		if time.Since(connStart) > helperMaxBackoff {
			backoff = helperMinBackoff
		}

		log.Warn("helper disconnected, reconnecting",
			"name", name, "error", err.Error(), "backoff", backoff)

		// Wait for backoff or shutdown signal.
		select {
		case <-time.After(backoff):
			backoff = min(backoff*2, helperMaxBackoff)
		case <-done:
			log.Info("helper stopped during reconnect backoff", "name", name)
			return
		}
	}
}
