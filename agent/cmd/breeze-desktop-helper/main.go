package main

import (
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/breeze-rmm/agent/internal/authstate"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/userhelper"
	"github.com/spf13/cobra"
)

var version = "0.5.0"
var contextFlag string
var probePrompt bool
var probeSCK bool

var log = logging.L("desktop-helper")

var rootCmd = &cobra.Command{
	Use: "breeze-desktop-helper",
	Run: func(cmd *cobra.Command, args []string) {
		runDesktopHelper()
	},
}

var probeCmd = &cobra.Command{
	Use:   "probe",
	Short: "Probe the local macOS desktop capture path for the selected context",
	Long: `Probe the local macOS desktop capture path for the selected context.

The probe captures once, through CoreGraphics, and does not call
ScreenCaptureKit unless --sck is given: on macOS 15+ a ScreenCaptureKit call
can raise the system's screen-recording consent dialog (#8058).

macOS charges the probe's capture to the process that launched it (Terminal,
or breeze-agent from a Breeze script or remote terminal), not to the launchd
desktop helper, so its permission results do not reflect the helper's grants.
The authoritative source is the agent log line "TCC permissions received".`,
	RunE: func(cmd *cobra.Command, args []string) error {
		// Logs to stderr so stdout stays the JSON report.
		logging.Init("text", "info", os.Stderr)
		return runProbeTo(os.Stdout, os.Stderr, probeOptions{
			allowPrompt: probePrompt,
			capture:     true,
			allowSCK:    probeSCK,
		}, runtime.GOOS)
	},
}

func init() {
	rootCmd.PersistentFlags().StringVar(&contextFlag, "context", ipc.DesktopContextUserSession, "Desktop context: 'user_session' or 'login_window'")
	probeCmd.Flags().BoolVar(&probePrompt, "prompt", false, "Allow the probe to trigger macOS permission prompts")
	probeCmd.Flags().BoolVar(&probeSCK, "sck", false, "Also try ScreenCaptureKit, once (macOS 14+). May raise the macOS screen-recording consent dialog")
	rootCmd.AddCommand(probeCmd)
	rootCmd.AddCommand(newCaptureBackendCmd())
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func runDesktopHelper() {
	// On macOS this resolves to ~/Library/Logs/Breeze, not the root-owned
	// 0700 shared agent log directory the user-session LaunchAgent cannot
	// write (#5877). Other platforms keep the shared directory.
	logDir, homeErr := config.HelperLogDir()
	mkdirErr := os.MkdirAll(logDir, 0700)
	logPath := filepath.Join(logDir, "desktop-helper.log")
	var output io.Writer = os.Stdout
	f, openErr := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if openErr == nil {
		output = f
	}
	logging.Init("text", "info", output)

	// Use LoadHelperConfig, NOT Load: on macOS the desktop-helper runs as the
	// logged-in user (Aqua LaunchAgent), and Load() unconditionally reads
	// root-only secrets.yaml and errors there, leaving the helper with no
	// shipper (#2483). LoadHelperConfig reads agent.yaml only.
	cfg, err := config.LoadHelperConfig("")
	if err != nil {
		log.Warn("helper config load failed; helper log shipping disabled", "error", err)
		cfg = config.Default()
	}

	socketPath := ipc.DefaultSocketPath()
	if cfg.IPCSocketPath != "" {
		socketPath = cfg.IPCSocketPath
	}

	// Like the user-helper, this is a separate long-lived process with no
	// heartbeat, and nothing respawns it on a backup-server-URL promotion
	// (#2323) — so its shipper reads the persisted server URL on a TTL instead
	// of freezing the startup copy at the dead primary (#2463).
	//
	// This gate is now reachable in user context too: LoadHelperConfig reads
	// agent.yaml (world-readable) and skips root-only secrets.yaml, so the macOS
	// user-session desktop-helper populates AgentID/ServerURL/HelperAuthToken
	// and ships its diagnostics (#2483). On Windows no user-readable file
	// carries the helper token (see config/helpertoken_windows.go).
	if cfg.AgentID != "" && cfg.ServerURL != "" && cfg.HelperAuthToken != "" {
		helperToken := secmem.NewSecureString(cfg.HelperAuthToken)
		cfg.HelperAuthToken = ""
		cfg.AuthToken = ""
		authMon := authstate.NewMonitor(3)
		logging.InitShipper(logging.ShipperConfig{
			ServerURL:    config.NewPersistedServerURLProvider("", cfg.ServerURL, 0),
			AgentID:      cfg.AgentID,
			AuthToken:    helperToken,
			AgentVersion: version + "-desktop-helper",
			MinLevel:     cfg.LogShippingLevel,
			AuthMonitor:  authMon,
			// The WebRTC/ICE diagnostics live in this process, so it must
			// follow the agent's set_log_level override too (#7416).
			LevelOverridePath: config.LogLevelOverridePath(),
		})
		defer logging.StopShipper()
	} else {
		// Say so once, loudly: without a shipper nothing this process logs
		// ever reaches Agent Logs, and the WebRTC session diagnostics are the
		// only evidence for remote-desktop triage (#5929). Report which keys
		// are missing, never their values.
		log.Warn("Log shipping disabled: helper config is missing required keys",
			"missing", missingShipperKeys(cfg),
		)
	}

	// Always record where diagnostics are going. The pre-#5877 code fell
	// back to stdout silently, and this LaunchAgent's plist points stdout
	// and stderr at /dev/null, so an unwritable log directory looked like
	// an empty log with no explanation anywhere. Emitted after the shipper
	// is up so the warn reaches Agent Logs even when nothing local can be
	// written.
	logging.EmitLogFileOutcome(log, logPath, openErr, mkdirErr, homeErr)

	// A permission check like any other: one CoreGraphics capture, never
	// ScreenCaptureKit (#8058). It used to run ScreenCaptureKit twice on
	// every helper start.
	startupProbe := collectProbeOutput(probeOptions{capture: true})
	attrs := []any{
		"context", startupProbe.Context,
		"processUser", startupProbe.ProcessUser,
		"captureGranted", startupProbe.CaptureGranted,
		"pid", os.Getpid(),
		"version", version,
	}
	if startupProbe.CaptureError != "" {
		attrs = append(attrs, "captureError", startupProbe.CaptureError)
	}
	if v := startupProbe.ScreenCaptureKitVerdict; v != nil && v.Present {
		attrs = append(attrs, "sckVerdict", v.Reason, "sckVerdictApplies", v.Applies)
	}
	if startupProbe.TCC != nil {
		remoteDesktop := "unknown"
		if startupProbe.TCC.RemoteDesktop != nil {
			remoteDesktop = fmt.Sprintf("%t", *startupProbe.TCC.RemoteDesktop)
		}
		attrs = append(attrs,
			"screenRecording", startupProbe.TCC.ScreenRecording,
			"accessibility", startupProbe.TCC.Accessibility,
			"fullDiskAccess", startupProbe.TCC.FullDiskAccess,
			"remoteDesktop", remoteDesktop,
		)
	}
	if len(startupProbe.Sessions) > 0 {
		attrs = append(attrs, "sessions", startupProbe.Sessions)
	}
	log.Info("desktop helper startup probe", attrs...)

	// Shutdown is signalled by closing `done`, NOT by calling Stop on a
	// captured client. The supervisor builds a fresh client per reconnect
	// attempt, so a handler closing over one client would stop the first
	// attempt's client and silently ignore SIGTERM from then on.
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		<-sigChan
		close(done)
	}()

	// Reconnect in-process instead of exiting on the first IPC failure.
	// Before #4194 any transient failure — the agent restarting and
	// recreating the socket, a sleep/wake gap — killed the process, and
	// recovery depended entirely on launchd respawning it into a live Aqua
	// session. Until that happened the device reported
	// desktopAccess.reason = "helper_not_connected" while showing as online.
	//
	// Keeping the process alive also means the startup capture probe above
	// runs once per login session rather than once per IPC blip, which stops
	// reconnects from re-firing the macOS Screen Recording prompt.
	sup := &userhelper.Supervisor{
		Name:   "desktop helper",
		Policy: desktopHelperReconnectPolicy(),
		NewClient: func() userhelper.SupervisedClient {
			return userhelper.NewWithOptions(socketPath, desktopHelperRole(), ipc.HelperBinaryDesktopHelper, contextFlag)
		},
		Log: log,
	}

	code := runSupervisedHelper(sup, done, fatalCooldown, userhelper.WaitOrShutdown)
	if code != exitOK {
		logging.StopShipper() // flush before os.Exit skips the deferred stop
		os.Exit(code)
	}
}

func desktopHelperRole() ipc.HelperRole {
	if runtime.GOOS == "darwin" {
		return ipc.HelperRoleUser
	}
	return ipc.HelperRoleSystem
}
