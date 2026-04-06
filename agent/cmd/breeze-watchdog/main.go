package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/state"
	"github.com/breeze-rmm/agent/internal/updater"
	"github.com/breeze-rmm/agent/internal/watchdog"
	"github.com/spf13/cobra"
)

var version = "0.1.0"

var rootCmd = &cobra.Command{
	Use:   "breeze-watchdog",
	Short: "Breeze RMM Agent Watchdog",
	Long:  `Breeze Watchdog monitors the agent process and provides failover heartbeats when the agent is down.`,
}

// run command flags
var (
	devMode  bool
	agentPID int
)

// health-journal flags
var journalCount int

var runCmd = &cobra.Command{
	Use:   "run",
	Short: "Start the watchdog monitoring loop",
	Run: func(cmd *cobra.Command, args []string) {
		runWatchdog()
	},
}

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Print watchdog version, agent state, and IPC socket status",
	Run: func(cmd *cobra.Command, args []string) {
		printStatus()
	},
}

var healthJournalCmd = &cobra.Command{
	Use:   "health-journal",
	Short: "Read the health journal from disk",
	Run: func(cmd *cobra.Command, args []string) {
		readHealthJournal()
	},
}

var triggerFailoverCmd = &cobra.Command{
	Use:   "trigger-failover",
	Short: "Trigger failover mode (placeholder)",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("trigger-failover: not implemented yet")
	},
}

var triggerRecoveryCmd = &cobra.Command{
	Use:   "trigger-recovery",
	Short: "Trigger recovery mode (placeholder)",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("trigger-recovery: not implemented yet")
	},
}

func init() {
	runCmd.Flags().BoolVar(&devMode, "dev", false, "Development mode (shorter intervals)")
	runCmd.Flags().IntVar(&agentPID, "agent-pid", 0, "Override agent PID (for testing)")
	healthJournalCmd.Flags().IntVarP(&journalCount, "count", "n", 50, "Number of recent entries to display")

	rootCmd.AddCommand(runCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(healthJournalCmd)
	rootCmd.AddCommand(triggerFailoverCmd)
	rootCmd.AddCommand(triggerRecoveryCmd)
	rootCmd.AddCommand(serviceCmd())
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// runWatchdog is the main watchdog loop.
func runWatchdog() {
	cfg, err := config.Load("")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}

	wdCfg := watchdog.Config{
		ProcessCheckInterval:    cfg.Watchdog.ProcessCheckInterval,
		IPCProbeInterval:        cfg.Watchdog.IPCProbeInterval,
		HeartbeatStaleThreshold: cfg.Watchdog.HeartbeatStaleThreshold,
		MaxRecoveryAttempts:     cfg.Watchdog.MaxRecoveryAttempts,
		RecoveryCooldown:        cfg.Watchdog.RecoveryCooldown,
		StandbyTimeout:          cfg.Watchdog.StandbyTimeout,
		FailoverPollInterval:    cfg.Watchdog.FailoverPollInterval,
	}

	// Override intervals in dev mode for faster iteration.
	if devMode {
		wdCfg.ProcessCheckInterval = 2 * time.Second
		wdCfg.IPCProbeInterval = 10 * time.Second
		wdCfg.HeartbeatStaleThreshold = 30 * time.Second
		fmt.Println("[dev] Using shortened intervals: process=2s, ipc=10s, heartbeat=30s")
	}

	// Create health journal in the log directory.
	journal, err := watchdog.NewJournal(
		config.LogDir(),
		cfg.Watchdog.HealthJournalMaxSizeMB,
		cfg.Watchdog.HealthJournalMaxFiles,
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create health journal: %v\n", err)
		os.Exit(1)
	}
	defer journal.Close()

	journal.Log(watchdog.LevelInfo, "watchdog.start", map[string]any{
		"version": version,
		"dev":     devMode,
	})

	// Read agent state file for PID.
	statePath := state.PathInDir(config.ConfigDir())
	agentState, _ := state.Read(statePath)

	pid := agentPID
	if pid == 0 && agentState != nil {
		pid = agentState.PID
	}

	// Create watchdog state machine.
	wd := watchdog.NewWatchdog(wdCfg)

	// IPC message channel.
	ipcMessages := make(chan *ipc.Envelope, 64)
	onMessage := func(env *ipc.Envelope) {
		select {
		case ipcMessages <- env:
		default:
			// Drop if full — non-blocking.
		}
	}

	// Create IPC client.
	socketPath := ipc.DefaultSocketPath()
	if cfg.IPCSocketPath != "" {
		socketPath = cfg.IPCSocketPath
	}
	ipcClient := watchdog.NewIPCClient(socketPath, onMessage)

	// Create health checker with the IPC client as the prober.
	processChecker := &watchdog.OSProcessChecker{}
	healthChecker := watchdog.NewHealthChecker(processChecker, ipcClient, wdCfg.HeartbeatStaleThreshold)

	// Create recovery manager.
	recovery := watchdog.NewRecoveryManager(wdCfg.MaxRecoveryAttempts, wdCfg.RecoveryCooldown)

	// Wrap auth token for failover client.
	var secureToken *secmem.SecureString
	if cfg.AuthToken != "" {
		secureToken = secmem.NewSecureString(cfg.AuthToken)
		cfg.AuthToken = "" // Clear from config struct.
	}

	// Try initial IPC connection.
	if err := ipcClient.Connect(); err != nil {
		journal.Log(watchdog.LevelWarn, "ipc.connect_failed", map[string]any{
			"error": err.Error(),
		})
		// Check if agent process exists.
		if pid > 0 && processChecker.IsAlive(pid) {
			// Agent is running but IPC failed — will retry on tick.
			fmt.Printf("Agent process %d found but IPC connection failed, will retry\n", pid)
		} else {
			wd.HandleEvent(watchdog.EventAgentNotFound)
			journal.Log(watchdog.LevelWarn, "agent.not_found", map[string]any{
				"pid": pid,
			})
		}
	} else {
		wd.HandleEvent(watchdog.EventIPCConnected)
		journal.Log(watchdog.LevelInfo, "ipc.connected", nil)
		healthChecker.ResetIPCFails()
	}

	fmt.Printf("Watchdog v%s started (state=%s, pid=%d)\n", version, wd.State(), pid)

	// Signal handling.
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)

	// Create tickers for the three check intervals.
	processTicker := time.NewTicker(wdCfg.ProcessCheckInterval)
	defer processTicker.Stop()
	ipcTicker := time.NewTicker(wdCfg.IPCProbeInterval)
	defer ipcTicker.Stop()
	heartbeatTicker := time.NewTicker(wdCfg.HeartbeatStaleThreshold)
	defer heartbeatTicker.Stop()

	// Failover poll ticker — only used in FAILOVER state.
	failoverTicker := time.NewTicker(wdCfg.FailoverPollInterval)
	defer failoverTicker.Stop()

	var failoverClient *watchdog.FailoverClient

	for {
		select {
		case <-sigChan:
			journal.Log(watchdog.LevelInfo, "watchdog.shutdown", nil)
			fmt.Println("Watchdog shutting down")
			ipcClient.Close()
			return

		case <-processTicker.C:
			// Re-read state file for fresh PID.
			if s, err := state.Read(statePath); err == nil && s != nil {
				pid = s.PID
				agentState = s
			}

			if pid > 0 {
				result := healthChecker.CheckProcess(pid)
				if result == watchdog.CheckProcessGone {
					journal.Log(watchdog.LevelWarn, "check.process_gone", map[string]any{"pid": pid})
					wd.HandleEvent(watchdog.EventAgentUnhealthy)
				}
			}

		case <-ipcTicker.C:
			if ipcClient.IsConnected() {
				result := healthChecker.CheckIPC()
				switch result {
				case watchdog.CheckIPCFailed:
					journal.Log(watchdog.LevelError, "check.ipc_failed", map[string]any{
						"consecutive_failures": healthChecker.IPCFailCount(),
					})
					wd.HandleEvent(watchdog.EventAgentUnhealthy)
				case watchdog.CheckIPCDegraded:
					journal.Log(watchdog.LevelWarn, "check.ipc_degraded", map[string]any{
						"consecutive_failures": healthChecker.IPCFailCount(),
					})
				}
			} else {
				// Try to reconnect.
				if err := ipcClient.Connect(); err == nil {
					wd.HandleEvent(watchdog.EventIPCConnected)
					healthChecker.ResetIPCFails()
					journal.Log(watchdog.LevelInfo, "ipc.reconnected", nil)
				}
			}

		case <-heartbeatTicker.C:
			// Re-read state file for heartbeat staleness.
			if s, err := state.Read(statePath); err == nil {
				agentState = s
			}
			result := healthChecker.CheckHeartbeatStaleness(agentState)
			if result == watchdog.CheckHeartbeatStale {
				journal.Log(watchdog.LevelWarn, "check.heartbeat_stale", nil)
				wd.HandleEvent(watchdog.EventAgentUnhealthy)
			}

		case env := <-ipcMessages:
			handleIPCMessage(env, wd, journal, cfg, secureToken)

		case <-failoverTicker.C:
			// Only poll in FAILOVER state.
			if wd.State() != watchdog.StateFailover || failoverClient == nil {
				continue
			}
			handleFailoverPoll(failoverClient, wd, journal, cfg, secureToken, recovery)
		}

		// State-driven actions after each tick.
		switch wd.State() {
		case watchdog.StateRecovering:
			if recovery.CanAttempt() {
				journal.Log(watchdog.LevelInfo, "recovery.attempt", map[string]any{
					"attempt": recovery.Attempts() + 1,
					"pid":     pid,
				})
				ok, err := recovery.Attempt(pid)
				if ok {
					journal.Log(watchdog.LevelInfo, "recovery.success", nil)
					wd.HandleEvent(watchdog.EventAgentRecovered)
				} else {
					journal.Log(watchdog.LevelError, "recovery.failed", map[string]any{
						"error": errStr(err),
					})
				}
			} else {
				journal.Log(watchdog.LevelError, "recovery.exhausted", map[string]any{
					"attempts": recovery.Attempts(),
				})
				wd.HandleEvent(watchdog.EventRecoveryExhausted)
			}

		case watchdog.StateFailover:
			if failoverClient == nil && secureToken != nil {
				failoverClient = watchdog.NewFailoverClient(
					cfg.ServerURL, cfg.AgentID, secureToken.Reveal(), nil,
				)
				journal.Log(watchdog.LevelInfo, "failover.start", nil)

				// Send initial failover heartbeat.
				resp, err := failoverClient.SendHeartbeat(version, wd.State(), journal.Recent(10))
				if err != nil {
					journal.Log(watchdog.LevelError, "failover.heartbeat_failed", map[string]any{
						"error": err.Error(),
					})
				} else {
					processHeartbeatResponse(resp, wd, journal, cfg, secureToken, recovery)
				}
			}

		case watchdog.StateStandby:
			// Check standby timeout.
			if time.Since(wd.LastTransitionTime()) > wdCfg.StandbyTimeout {
				journal.Log(watchdog.LevelWarn, "standby.timeout", nil)
				wd.HandleEvent(watchdog.EventStandbyTimeout)
			}

		case watchdog.StateMonitoring:
			// Reset recovery counter when healthy.
			recovery.Reset()
			if failoverClient != nil {
				failoverClient = nil
			}
		}
	}
}

// handleIPCMessage dispatches IPC envelope messages from the agent.
func handleIPCMessage(env *ipc.Envelope, wd *watchdog.Watchdog, journal *watchdog.Journal, cfg *config.Config, token *secmem.SecureString) {
	switch env.Type {
	case ipc.TypeShutdownIntent:
		var intent ipc.ShutdownIntent
		if err := json.Unmarshal(env.Payload, &intent); err != nil {
			journal.Log(watchdog.LevelError, "ipc.bad_shutdown_intent", map[string]any{
				"error": err.Error(),
			})
			return
		}
		journal.Log(watchdog.LevelInfo, "agent.shutdown_intent", map[string]any{
			"reason":   intent.Reason,
			"duration": intent.ExpectedDuration,
		})
		wd.HandleEvent(watchdog.EventShutdownIntent)

	case ipc.TypeTokenUpdate:
		var update ipc.TokenUpdate
		if err := json.Unmarshal(env.Payload, &update); err != nil {
			journal.Log(watchdog.LevelError, "ipc.bad_token_update", map[string]any{
				"error": err.Error(),
			})
			return
		}
		journal.Log(watchdog.LevelInfo, "token.updated", nil)
		if token != nil {
			token.Zero()
		}
		// Persist the new token. We store it via config.SetAndPersist so
		// that the next Load() picks it up automatically.
		if err := config.SetAndPersist("auth_token", update.Token); err != nil {
			journal.Log(watchdog.LevelError, "token.persist_failed", map[string]any{
				"error": err.Error(),
			})
		}

	case ipc.TypeStateSync:
		var sync ipc.StateSync
		if err := json.Unmarshal(env.Payload, &sync); err != nil {
			return
		}
		journal.Log(watchdog.LevelInfo, "agent.state_sync", map[string]any{
			"agentVersion":  sync.AgentVersion,
			"connected":     sync.Connected,
			"lastHeartbeat": sync.LastHeartbeat,
		})

	case ipc.TypeWatchdogPong:
		// Pong received — IPC is healthy. Already tracked by health checker.
		journal.Log(watchdog.LevelInfo, "ipc.pong", nil)

	default:
		journal.Log(watchdog.LevelWarn, "ipc.unknown_type", map[string]any{
			"type": env.Type,
		})
	}
}

// handleFailoverPoll sends a heartbeat and polls for commands during failover.
func handleFailoverPoll(
	fc *watchdog.FailoverClient,
	wd *watchdog.Watchdog,
	journal *watchdog.Journal,
	cfg *config.Config,
	token *secmem.SecureString,
	recovery *watchdog.RecoveryManager,
) {
	// Send failover heartbeat.
	resp, err := fc.SendHeartbeat(version, wd.State(), journal.Recent(10))
	if err != nil {
		journal.Log(watchdog.LevelError, "failover.heartbeat_failed", map[string]any{
			"error": err.Error(),
		})
		return
	}
	processHeartbeatResponse(resp, wd, journal, cfg, token, recovery)

	// Poll for commands.
	commands, err := fc.PollCommands()
	if err != nil {
		journal.Log(watchdog.LevelError, "failover.poll_failed", map[string]any{
			"error": err.Error(),
		})
		return
	}

	for _, cmd := range commands {
		handleFailoverCommand(fc, cmd, wd, journal, cfg, token, recovery)
	}
}

// processHeartbeatResponse handles upgrade directives from the API.
func processHeartbeatResponse(
	resp *watchdog.HeartbeatResponse,
	wd *watchdog.Watchdog,
	journal *watchdog.Journal,
	cfg *config.Config,
	token *secmem.SecureString,
	recovery *watchdog.RecoveryManager,
) {
	if resp == nil {
		return
	}
	if resp.UpgradeTo != "" {
		journal.Log(watchdog.LevelInfo, "failover.upgrade_agent", map[string]any{
			"version": resp.UpgradeTo,
		})
		doUpdateAgent(resp.UpgradeTo, cfg, token, journal)
	}
	if resp.WatchdogUpgradeTo != "" {
		journal.Log(watchdog.LevelInfo, "failover.upgrade_watchdog", map[string]any{
			"version": resp.WatchdogUpgradeTo,
		})
		doUpdateWatchdog(resp.WatchdogUpgradeTo, cfg, token, journal)
	}
}

// handleFailoverCommand executes a single command from the API.
func handleFailoverCommand(
	fc *watchdog.FailoverClient,
	cmd watchdog.FailoverCommand,
	wd *watchdog.Watchdog,
	journal *watchdog.Journal,
	cfg *config.Config,
	token *secmem.SecureString,
	recovery *watchdog.RecoveryManager,
) {
	journal.Log(watchdog.LevelInfo, "failover.command", map[string]any{
		"id":   cmd.ID,
		"type": cmd.Type,
	})

	var resultStatus string
	var result any
	var errMsg string

	switch cmd.Type {
	case "restart_agent":
		recovery.Reset()
		wd.HandleEvent(watchdog.EventStartAgent)
		ok, err := recovery.Attempt(0)
		if ok {
			resultStatus = "completed"
			result = map[string]string{"action": "restart_agent"}
		} else {
			resultStatus = "failed"
			errMsg = errStr(err)
		}

	case "start_agent":
		wd.HandleEvent(watchdog.EventStartAgent)
		ok, err := recovery.Attempt(0)
		if ok {
			resultStatus = "completed"
			result = map[string]string{"action": "start_agent"}
		} else {
			resultStatus = "failed"
			errMsg = errStr(err)
		}

	case "collect_diagnostics":
		entries, err := journal.ReadFromDisk()
		if err != nil {
			resultStatus = "failed"
			errMsg = err.Error()
		} else {
			resultStatus = "completed"
			result = map[string]any{
				"journal_entries": len(entries),
				"state":           wd.State(),
				"history":         wd.StateHistory(),
			}
			// Ship full journal entries.
			if shipErr := fc.ShipLogs(entries); shipErr != nil {
				journal.Log(watchdog.LevelWarn, "failover.ship_logs_failed", map[string]any{
					"error": shipErr.Error(),
				})
			}
		}

	case "update_agent":
		targetVersion, _ := cmd.Payload["version"].(string)
		if targetVersion == "" {
			resultStatus = "failed"
			errMsg = "missing version in payload"
		} else {
			err := doUpdateAgent(targetVersion, cfg, token, journal)
			if err != nil {
				resultStatus = "failed"
				errMsg = err.Error()
			} else {
				resultStatus = "completed"
				result = map[string]string{"updated_to": targetVersion}
			}
		}

	case "update_watchdog":
		targetVersion, _ := cmd.Payload["version"].(string)
		if targetVersion == "" {
			resultStatus = "failed"
			errMsg = "missing version in payload"
		} else {
			err := doUpdateWatchdog(targetVersion, cfg, token, journal)
			if err != nil {
				resultStatus = "failed"
				errMsg = err.Error()
			} else {
				resultStatus = "completed"
				result = map[string]string{"updated_to": targetVersion}
			}
		}

	default:
		resultStatus = "failed"
		errMsg = fmt.Sprintf("unknown command type: %s", cmd.Type)
	}

	if err := fc.SubmitCommandResult(cmd.ID, resultStatus, result, errMsg); err != nil {
		journal.Log(watchdog.LevelError, "failover.submit_result_failed", map[string]any{
			"command_id": cmd.ID,
			"error":      err.Error(),
		})
	}
}

// doUpdateAgent creates an updater and downloads the target version for the agent binary.
func doUpdateAgent(targetVersion string, cfg *config.Config, token *secmem.SecureString, journal *watchdog.Journal) error {
	if token == nil {
		return fmt.Errorf("no auth token available")
	}
	binaryPath := agentBinaryPath()
	u := updater.New(&updater.Config{
		ServerURL:      cfg.ServerURL,
		AuthToken:      token,
		CurrentVersion: "", // Not tracking agent version from watchdog.
		BinaryPath:     binaryPath,
		BackupPath:     binaryPath + ".bak",
	})
	if err := u.UpdateTo(targetVersion); err != nil {
		journal.Log(watchdog.LevelError, "update.agent_failed", map[string]any{
			"version": targetVersion,
			"error":   err.Error(),
		})
		return err
	}
	journal.Log(watchdog.LevelInfo, "update.agent_success", map[string]any{
		"version": targetVersion,
	})
	return nil
}

// doUpdateWatchdog updates the watchdog binary and restarts the service.
func doUpdateWatchdog(targetVersion string, cfg *config.Config, token *secmem.SecureString, journal *watchdog.Journal) error {
	if token == nil {
		return fmt.Errorf("no auth token available")
	}
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to determine executable path: %w", err)
	}
	u := updater.New(&updater.Config{
		ServerURL:      cfg.ServerURL,
		AuthToken:      token,
		CurrentVersion: version,
		BinaryPath:     exePath,
		BackupPath:     exePath + ".bak",
	})
	if err := u.UpdateTo(targetVersion); err != nil {
		journal.Log(watchdog.LevelError, "update.watchdog_failed", map[string]any{
			"version": targetVersion,
			"error":   err.Error(),
		})
		return err
	}
	journal.Log(watchdog.LevelInfo, "update.watchdog_success", map[string]any{
		"version": targetVersion,
	})
	// Restart the watchdog service so the new binary takes effect.
	if err := restartWatchdogService(); err != nil {
		journal.Log(watchdog.LevelWarn, "update.watchdog_restart_failed", map[string]any{
			"error": err.Error(),
		})
	}
	return nil
}

// printStatus prints watchdog version, agent state file info, and IPC socket status.
func printStatus() {
	fmt.Printf("Watchdog Version: %s\n", version)

	statePath := state.PathInDir(config.ConfigDir())
	agentState, err := state.Read(statePath)
	if err != nil {
		fmt.Printf("Agent State: error reading (%v)\n", err)
	} else if agentState == nil {
		fmt.Println("Agent State: no state file found")
	} else {
		fmt.Printf("Agent State: %s (PID=%d, version=%s)\n", agentState.Status, agentState.PID, agentState.Version)
		if !agentState.LastHeartbeat.IsZero() {
			fmt.Printf("Last Heartbeat: %s (%s ago)\n",
				agentState.LastHeartbeat.Format(time.RFC3339),
				time.Since(agentState.LastHeartbeat).Truncate(time.Second),
			)
		}
		fmt.Printf("State Timestamp: %s\n", agentState.Timestamp.Format(time.RFC3339))
	}

	socketPath := ipc.DefaultSocketPath()
	if _, err := os.Stat(socketPath); err == nil {
		fmt.Printf("IPC Socket: %s (exists)\n", socketPath)
	} else {
		fmt.Printf("IPC Socket: %s (not found)\n", socketPath)
	}
}

// readHealthJournal reads the journal from disk and prints recent entries.
func readHealthJournal() {
	journal, err := watchdog.NewJournal(config.LogDir(), 10, 3)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to open journal: %v\n", err)
		os.Exit(1)
	}
	defer journal.Close()

	entries, err := journal.ReadFromDisk()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to read journal: %v\n", err)
		os.Exit(1)
	}

	if len(entries) == 0 {
		fmt.Println("No journal entries found.")
		return
	}

	// Trim to the requested count.
	if journalCount > 0 && journalCount < len(entries) {
		entries = entries[len(entries)-journalCount:]
	}

	for _, e := range entries {
		dataStr := ""
		if e.Data != nil {
			if b, err := json.Marshal(e.Data); err == nil {
				dataStr = " " + string(b)
			}
		}
		fmt.Printf("%s [%s] %s%s\n",
			e.Time.Format(time.RFC3339),
			e.Level,
			e.Event,
			dataStr,
		)
	}
}

// errStr returns the error string or empty string for nil errors.
func errStr(err error) string {
	if err != nil {
		return err.Error()
	}
	return ""
}
