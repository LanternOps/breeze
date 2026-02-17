package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/audit"
	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/heartbeat"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/mtls"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/userhelper"
	"github.com/breeze-rmm/agent/internal/websocket"
	"github.com/breeze-rmm/agent/pkg/api"
	"github.com/spf13/cobra"
)

var (
	version          = "0.1.0"
	cfgFile          string
	serverURL        string
	enrollmentSecret string
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

func init() {
	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default is /etc/breeze/agent.yaml)")
	rootCmd.PersistentFlags().StringVar(&serverURL, "server", "", "Breeze server URL")
	enrollCmd.Flags().StringVar(&enrollmentSecret, "enrollment-secret", "", "Enrollment secret (AGENT_ENROLLMENT_SECRET on the server)")

	rootCmd.AddCommand(runCmd)
	rootCmd.AddCommand(enrollCmd)
	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(userHelperCmd)
}

func main() {
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

// agentComponents holds the running components created by runAgent so that
// service wrappers (Windows SCM, etc.) can shut them down gracefully.
type agentComponents struct {
	hb       *heartbeat.Heartbeat
	wsClient *websocket.Client
}

// shutdownAgent gracefully stops all agent components.
func shutdownAgent(comps *agentComponents) {
	if comps == nil {
		return
	}
	comps.hb.StopAcceptingCommands()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	comps.hb.DrainAndWait(ctx)
	comps.wsClient.Stop()
	comps.hb.Stop()
}

// runAgent starts the main agent run loop. The heartbeat module handles:
// - Periodic heartbeat calls to the API endpoint
// - Receiving pending commands from the server via heartbeat response
// - Executing commands and reporting results back to the server
func runAgent() {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}

	if cfg.AgentID == "" {
		fmt.Fprintln(os.Stderr, "Agent not enrolled. Run 'breeze-agent enroll <key>' first.")
		os.Exit(1)
	}

	initLogging(cfg)

	// Wrap auth token in SecureString for defense-in-depth
	secureToken := secmem.NewSecureString(cfg.AuthToken)
	cfg.AuthToken = "" // Clear plaintext from config struct
	defer secureToken.Zero()

	// Initialize log shipper for centralized diagnostics
	if cfg.AgentID != "" && cfg.ServerURL != "" {
		logging.InitShipper(logging.ShipperConfig{
			ServerURL:    cfg.ServerURL,
			AgentID:      cfg.AgentID,
			AuthToken:    secureToken.Reveal(),
			AgentVersion: version,
			HTTPClient:   nil, // will use default
			MinLevel:     cfg.LogShippingLevel,
		})
		defer logging.StopShipper()
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

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	<-sigChan
	log.Info("shutting down agent")

	// Graceful shutdown: stop accepting, drain in-flight commands, then stop
	hb.StopAcceptingCommands()

	drainCtx, drainCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer drainCancel()
	hb.DrainAndWait(drainCtx)

	wsClient.Stop()
	hb.Stop()
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
		fmt.Fprintf(os.Stderr, "Agent is already enrolled with ID: %s\n", cfg.AgentID)
		fmt.Fprintln(os.Stderr, "To re-enroll, delete the config file first.")
		os.Exit(1)
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

	enrollReq := &api.EnrollRequest{
		EnrollmentKey:    enrollmentKey,
		EnrollmentSecret: secret,
		Hostname:         systemInfo.Hostname,
		OSType:           systemInfo.OSType,
		OSVersion:        systemInfo.OSVersion,
		Architecture:     systemInfo.Architecture,
		AgentVersion:     version,
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
	fmt.Println("Run 'breeze-agent run' to start the agent.")
}

func checkStatus() {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		fmt.Println("Status: Not configured")
		return
	}

	if cfg.AgentID == "" {
		fmt.Println("Status: Not enrolled")
		return
	}

	fmt.Println("Status: Enrolled")
	fmt.Printf("Agent ID: %s\n", cfg.AgentID)
	fmt.Printf("Server: %s\n", cfg.ServerURL)
	fmt.Printf("Heartbeat Interval: %d seconds\n", cfg.HeartbeatIntervalSeconds)
	fmt.Printf("Metrics Interval: %d seconds\n", cfg.MetricsIntervalSeconds)
	fmt.Printf("Enabled Collectors: %v\n", cfg.EnabledCollectors)
}

// runUserHelper starts the per-user session helper process.
// It connects to the root daemon via IPC and handles user-context operations.
func runUserHelper() {
	// Minimal logging for user helper (no config file needed)
	logging.Init("text", "info", os.Stdout)

	socketPath := ipc.DefaultSocketPath()
	if cfgFile != "" {
		// Try to load config for custom socket path
		if cfg, err := config.Load(cfgFile); err == nil && cfg.IPCSocketPath != "" {
			socketPath = cfg.IPCSocketPath
		}
	}

	log.Info("starting user helper",
		"version", version,
		"socket", socketPath,
		"pid", os.Getpid(),
	)

	client := userhelper.New(socketPath)

	// Handle shutdown signals
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		log.Info("shutting down user helper")
		client.Stop()
	}()

	if err := client.Run(); err != nil {
		log.Error("user helper error", "error", err)
		os.Exit(1)
	}

	log.Info("user helper stopped")
}
