package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/userhelper"
	"github.com/spf13/cobra"
)

var version = "0.5.0"
var contextFlag string
var probePrompt bool

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
	RunE: func(cmd *cobra.Command, args []string) error {
		return runProbe()
	},
}

func init() {
	rootCmd.PersistentFlags().StringVar(&contextFlag, "context", ipc.DesktopContextUserSession, "Desktop context: 'user_session' or 'login_window'")
	probeCmd.Flags().BoolVar(&probePrompt, "prompt", false, "Allow the probe to trigger macOS permission prompts")
	rootCmd.AddCommand(probeCmd)
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func runDesktopHelper() {
	logDir := filepath.Dir(config.Default().LogFile)
	_ = os.MkdirAll(logDir, 0700)
	logPath := filepath.Join(logDir, "desktop-helper.log")
	var output io.Writer = os.Stdout
	if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); err == nil {
		output = f
	}
	logging.Init("text", "info", output)

	cfg, _ := config.Load("")
	if cfg == nil {
		cfg = config.Default()
	}

	socketPath := ipc.DefaultSocketPath()
	if cfg.IPCSocketPath != "" {
		socketPath = cfg.IPCSocketPath
	}

	if cfg.AgentID != "" && cfg.ServerURL != "" && cfg.AuthToken != "" {
		helperToken := secmem.NewSecureString(cfg.AuthToken)
		cfg.AuthToken = ""
		logging.InitShipper(logging.ShipperConfig{
			ServerURL:    cfg.ServerURL,
			AgentID:      cfg.AgentID,
			AuthToken:    helperToken,
			AgentVersion: version + "-desktop-helper",
			MinLevel:     cfg.LogShippingLevel,
		})
		defer logging.StopShipper()
	}

	startupProbe := collectProbeOutput(false, true)
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

	client := userhelper.NewWithOptions(socketPath, ipc.HelperRoleSystem, ipc.HelperBinaryDesktopHelper, contextFlag)

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		client.Stop()
	}()

	if err := client.Run(); err != nil {
		log.Error("desktop helper error", "error", err)
		os.Exit(1)
	}
}

type probeOutput struct {
	Timestamp      time.Time                       `json:"timestamp"`
	Context        string                          `json:"context"`
	ProcessUser    string                          `json:"processUser,omitempty"`
	Sessions       []sessionbroker.DetectedSession `json:"sessions,omitempty"`
	TCC            *ipc.TCCStatus                  `json:"tcc,omitempty"`
	CaptureGranted bool                            `json:"captureGranted"`
	CaptureError   string                          `json:"captureError,omitempty"`
}

func runProbe() error {
	logging.Init("text", "info", os.Stdout)

	out := collectProbeOutput(probePrompt, true)

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

func collectProbeOutput(allowPrompt bool, allowCaptureProbe bool) probeOutput {
	out := probeOutput{
		Timestamp: time.Now().UTC(),
		Context:   contextFlag,
	}

	if cu, err := user.Current(); err == nil {
		out.ProcessUser = cu.Username
	}

	if detector := sessionbroker.NewSessionDetector(); detector != nil {
		sessions, err := detector.ListSessions()
		if err != nil {
			out.CaptureError = fmt.Sprintf("session detection failed: %v", err)
		} else {
			out.Sessions = sessions
		}
	}

	out.TCC = userhelper.ProbeTCCPermissions(contextFlag, allowPrompt, allowCaptureProbe)

	if allowCaptureProbe {
		granted, err := desktop.ProbeCaptureAccess(desktop.CaptureConfig{
			DesktopContext: contextFlag,
		})
		out.CaptureGranted = granted
		if err != nil {
			if out.CaptureError != "" {
				out.CaptureError += "; "
			}
			out.CaptureError += err.Error()
		}
	}

	return out
}
