package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/collector"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/enrollment"
	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/heartbeat"
	"github.com/breeze-rmm/agent/pkg/models"
	"github.com/spf13/cobra"
	"go.uber.org/zap"
)

var (
	version   = "dev"
	commit    = "none"
	buildDate = "unknown"
)

var rootCmd = &cobra.Command{
	Use:   "breeze-agent",
	Short: "Breeze RMM Agent",
	Long:  `Breeze RMM Agent - Remote monitoring and management agent for endpoints.`,
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print version information",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("Breeze Agent %s\n", version)
		fmt.Printf("Commit: %s\n", commit)
		fmt.Printf("Built: %s\n", buildDate)
	},
}

var runCmd = &cobra.Command{
	Use:   "run",
	Short: "Run the agent",
	Long:  `Start the Breeze agent and begin monitoring this endpoint.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := config.Load()
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		return runAgent(cfg)
	},
}

var enrollCmd = &cobra.Command{
	Use:   "enroll [enrollment-key]",
	Short: "Enroll this agent with Breeze server",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		enrollmentKey := args[0]
		serverURL, _ := cmd.Flags().GetString("server")

		cfg, err := config.Load()
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		if serverURL != "" {
			cfg.ServerURL = serverURL
		}

		return enrollAgent(cfg, enrollmentKey)
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(runCmd)
	rootCmd.AddCommand(enrollCmd)

	enrollCmd.Flags().StringP("server", "s", "", "Breeze server URL")

	rootCmd.PersistentFlags().StringP("config", "c", "", "Config file path")
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runAgent(cfg *config.Config) error {
	if cfg.DeviceID == "" || cfg.APIKey == "" {
		return fmt.Errorf("agent not enrolled; run `breeze-agent enroll <key>` first")
	}

	fmt.Println("Starting Breeze Agent...")
	fmt.Printf("Server: %s\n", cfg.ServerURL)
	fmt.Printf("Device ID: %s\n", cfg.DeviceID)

	logger, err := zap.NewProduction()
	if err != nil {
		return fmt.Errorf("failed to init logger: %w", err)
	}
	defer func() {
		_ = logger.Sync()
	}()

	metricsCollector := collector.NewMetricsCollector(logger)
	metricsProvider := &metricsAdapter{
		collector: metricsCollector,
		logger:    logger,
	}

	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: cfg.InsecureSkipVerify,
			},
		},
		Timeout: 30 * time.Second,
	}

	commandProcessor := heartbeat.NewCommandProcessor(cfg, client, logger)
	commandProcessor.RegisterExecutor(newScriptCommandExecutor(cfg, logger))

	heartbeatManager := heartbeat.New(cfg, metricsProvider, logger)
	heartbeatManager.SetCommandHandler(commandProcessor)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	commandProcessor.ProcessCommands(ctx)
	if err := heartbeatManager.Start(); err != nil {
		return fmt.Errorf("failed to start heartbeat: %w", err)
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	<-sigChan
	logger.Info("shutdown signal received")
	cancel()
	heartbeatManager.Stop()
	commandProcessor.Stop()
	return nil
}

func enrollAgent(cfg *config.Config, enrollmentKey string) error {
	fmt.Printf("Enrolling with key: %s\n", enrollmentKey)
	fmt.Printf("Server: %s\n", cfg.ServerURL)
	if cfg.ServerURL == "" {
		return fmt.Errorf("server URL required for enrollment")
	}

	logger, err := zap.NewProduction()
	if err != nil {
		return fmt.Errorf("failed to init logger: %w", err)
	}
	defer func() {
		_ = logger.Sync()
	}()

	hardwareCollector := collector.NewHardwareCollector(logger)
	manager := enrollment.New(cfg, hardwareCollector, logger)

	response, err := manager.Enroll(enrollmentKey)
	if err != nil {
		return err
	}

	fmt.Printf("Enrollment successful. Device ID: %s\n", response.DeviceID)
	return nil
}

type metricsAdapter struct {
	collector *collector.MetricsCollector
	logger    *zap.Logger
}

func (m *metricsAdapter) Collect() (*models.Metrics, error) {
	data, err := m.collector.Collect()
	if err != nil {
		m.logger.Warn("metrics collection error", zap.Error(err))
	}

	metrics, ok := data.(models.Metrics)
	if !ok {
		return nil, fmt.Errorf("unexpected metrics type: %T", data)
	}

	return &metrics, nil
}

type scriptCommandExecutor struct {
	executor *executor.Executor
	logger   *zap.Logger
}

func newScriptCommandExecutor(cfg *config.Config, logger *zap.Logger) *scriptCommandExecutor {
	return &scriptCommandExecutor{
		executor: executor.NewWithLogger(cfg, logger),
		logger:   logger.Named("script_executor"),
	}
}

func (s *scriptCommandExecutor) CanHandle(cmdType string) bool {
	return cmdType == "script"
}

func (s *scriptCommandExecutor) Execute(ctx context.Context, cmd models.Command) (*heartbeat.CommandResult, error) {
	startedAt := time.Now()

	if err := ctx.Err(); err != nil {
		return &heartbeat.CommandResult{
			CommandID:   cmd.ID,
			Success:     false,
			Error:       err.Error(),
			StartedAt:   startedAt,
			CompletedAt: time.Now(),
		}, nil
	}

	execution, err := buildScriptExecution(cmd)
	if err != nil {
		return &heartbeat.CommandResult{
			CommandID:   cmd.ID,
			Success:     false,
			Error:       err.Error(),
			StartedAt:   startedAt,
			CompletedAt: time.Now(),
		}, nil
	}

	result, execErr := s.executor.Execute(execution)
	completedAt := time.Now()

	if result == nil {
		result = &models.ScriptResult{
			ExecutionID: execution.ID,
			ExitCode:    -1,
		}
	}

	output := map[string]interface{}{
		"executionId": result.ExecutionID,
		"exitCode":    result.ExitCode,
		"stdout":      result.Stdout,
		"stderr":      result.Stderr,
	}

	if result.Error != "" {
		output["error"] = result.Error
	}

	success := execErr == nil && result.ExitCode == 0 && result.Error == ""
	cmdResult := &heartbeat.CommandResult{
		CommandID:   cmd.ID,
		Success:     success,
		Output:      output,
		StartedAt:   startedAt,
		CompletedAt: completedAt,
	}

	if execErr != nil {
		cmdResult.Error = execErr.Error()
		s.logger.Warn("script execution failed", zap.String("command_id", cmd.ID), zap.Error(execErr))
	}

	return cmdResult, nil
}

func buildScriptExecution(cmd models.Command) (models.ScriptExecution, error) {
	payload := cmd.Payload
	if payload == nil {
		return models.ScriptExecution{}, fmt.Errorf("command payload missing")
	}

	scriptID := getPayloadString(payload, "scriptId")
	executionID := getPayloadString(payload, "executionId")
	if executionID == "" {
		executionID = cmd.ID
	}

	scriptType := getPayloadString(payload, "language")
	if scriptType == "" {
		scriptType = getPayloadString(payload, "scriptType")
	}

	script := getPayloadString(payload, "content")
	if script == "" {
		script = getPayloadString(payload, "script")
	}

	if script == "" || scriptType == "" {
		return models.ScriptExecution{}, fmt.Errorf("script content or type missing in payload")
	}

	timeout := getPayloadInt(payload, "timeoutSeconds")
	if timeout == 0 {
		timeout = getPayloadInt(payload, "timeout")
	}

	parameters := getPayloadStringMap(payload, "parameters")
	runAs := getPayloadString(payload, "runAs")

	return models.ScriptExecution{
		ID:         executionID,
		ScriptID:   scriptID,
		Script:     script,
		ScriptType: scriptType,
		Parameters: parameters,
		Timeout:    timeout,
		RunAs:      runAs,
	}, nil
}

func getPayloadString(payload map[string]interface{}, key string) string {
	value, ok := payload[key]
	if !ok || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return typed
	case []byte:
		return string(typed)
	default:
		return fmt.Sprintf("%v", typed)
	}
}

func getPayloadInt(payload map[string]interface{}, key string) int {
	value, ok := payload[key]
	if !ok || value == nil {
		return 0
	}

	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case float32:
		return int(typed)
	case string:
		parsed, err := strconv.Atoi(typed)
		if err == nil {
			return parsed
		}
	}

	return 0
}

func getPayloadStringMap(payload map[string]interface{}, key string) map[string]string {
	value, ok := payload[key]
	if !ok || value == nil {
		return nil
	}

	switch typed := value.(type) {
	case map[string]string:
		return typed
	case map[string]interface{}:
		result := make(map[string]string, len(typed))
		for k, v := range typed {
			result[k] = fmt.Sprintf("%v", v)
		}
		return result
	default:
		return nil
	}
}
