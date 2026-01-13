package heartbeat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/pkg/models"
	"go.uber.org/zap"
)

// CommandHandler defines the interface for processing commands
type CommandHandler interface {
	// QueueCommand adds a command to the processing queue
	QueueCommand(cmd models.Command)
	// ProcessCommands starts processing queued commands
	ProcessCommands(ctx context.Context)
	// Stop gracefully stops command processing
	Stop()
}

// CommandExecutor defines the interface for executing specific command types
type CommandExecutor interface {
	// Execute runs the command and returns the result
	Execute(ctx context.Context, cmd models.Command) (*CommandResult, error)
	// CanHandle returns true if this executor can handle the command type
	CanHandle(cmdType string) bool
}

// CommandResult represents the result of a command execution
type CommandResult struct {
	CommandID   string                 `json:"commandId"`
	Success     bool                   `json:"success"`
	Output      map[string]interface{} `json:"output,omitempty"`
	Error       string                 `json:"error,omitempty"`
	StartedAt   time.Time              `json:"startedAt"`
	CompletedAt time.Time              `json:"completedAt"`
}

// CommandProcessor implements CommandHandler for processing server commands
type CommandProcessor struct {
	config    *config.Config
	client    *http.Client
	logger    *zap.Logger
	executors []CommandExecutor

	queue   []models.Command
	queueMu sync.Mutex

	stopCh chan struct{}
	doneCh chan struct{}
	wg     sync.WaitGroup
}

// NewCommandProcessor creates a new command processor
func NewCommandProcessor(cfg *config.Config, client *http.Client, logger *zap.Logger) *CommandProcessor {
	return &CommandProcessor{
		config:    cfg,
		client:    client,
		logger:    logger.Named("commands"),
		queue:     make([]models.Command, 0),
		executors: make([]CommandExecutor, 0),
		stopCh:    make(chan struct{}),
		doneCh:    make(chan struct{}),
	}
}

// RegisterExecutor adds a command executor
func (p *CommandProcessor) RegisterExecutor(executor CommandExecutor) {
	p.executors = append(p.executors, executor)
}

// QueueCommand adds a command to the processing queue, sorted by priority
func (p *CommandProcessor) QueueCommand(cmd models.Command) {
	p.queueMu.Lock()
	defer p.queueMu.Unlock()

	p.queue = append(p.queue, cmd)

	// Sort by priority (higher priority first)
	sort.Slice(p.queue, func(i, j int) bool {
		return p.queue[i].Priority > p.queue[j].Priority
	})

	p.logger.Debug("command queued",
		zap.String("id", cmd.ID),
		zap.String("type", cmd.Type),
		zap.Int("priority", cmd.Priority),
		zap.Int("queue_size", len(p.queue)),
	)
}

// ProcessCommands starts processing queued commands
func (p *CommandProcessor) ProcessCommands(ctx context.Context) {
	p.logger.Info("starting command processor")

	go p.run(ctx)
}

// Stop gracefully stops command processing
func (p *CommandProcessor) Stop() {
	p.logger.Info("stopping command processor")
	close(p.stopCh)
	p.wg.Wait()
	close(p.doneCh)
	p.logger.Info("command processor stopped")
}

// run is the main processing loop
func (p *CommandProcessor) run(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-p.stopCh:
			return
		case <-ticker.C:
			p.processNextCommand(ctx)
		}
	}
}

// processNextCommand dequeues and processes the highest priority command
func (p *CommandProcessor) processNextCommand(ctx context.Context) {
	cmd, ok := p.dequeueCommand()
	if !ok {
		return
	}

	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		p.executeCommand(ctx, cmd)
	}()
}

// dequeueCommand removes and returns the highest priority command from the queue
func (p *CommandProcessor) dequeueCommand() (models.Command, bool) {
	p.queueMu.Lock()
	defer p.queueMu.Unlock()

	if len(p.queue) == 0 {
		return models.Command{}, false
	}

	cmd := p.queue[0]
	p.queue = p.queue[1:]
	return cmd, true
}

// executeCommand executes a single command and reports the result
func (p *CommandProcessor) executeCommand(ctx context.Context, cmd models.Command) {
	p.logger.Info("executing command",
		zap.String("id", cmd.ID),
		zap.String("type", cmd.Type),
	)

	result := &CommandResult{
		CommandID: cmd.ID,
		StartedAt: time.Now(),
	}

	// Find an executor that can handle this command type
	var executor CommandExecutor
	for _, e := range p.executors {
		if e.CanHandle(cmd.Type) {
			executor = e
			break
		}
	}

	if executor == nil {
		result.Success = false
		result.Error = fmt.Sprintf("no executor found for command type: %s", cmd.Type)
		result.CompletedAt = time.Now()
		p.reportResult(ctx, result)
		return
	}

	// Execute the command with a timeout
	execCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	execResult, err := executor.Execute(execCtx, cmd)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		result.CompletedAt = time.Now()
	} else {
		result = execResult
	}

	p.logger.Info("command completed",
		zap.String("id", cmd.ID),
		zap.Bool("success", result.Success),
		zap.Duration("duration", result.CompletedAt.Sub(result.StartedAt)),
	)

	p.reportResult(ctx, result)
}

// reportResult sends the command result back to the server
func (p *CommandProcessor) reportResult(ctx context.Context, result *CommandResult) {
	body, err := json.Marshal(result)
	if err != nil {
		p.logger.Error("failed to marshal command result", zap.Error(err))
		return
	}

	url := fmt.Sprintf("%s/api/agents/commands/%s/result", p.config.ServerURL, result.CommandID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		p.logger.Error("failed to create result request", zap.Error(err))
		return
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Device-ID", p.config.DeviceID)
	if p.config.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.config.APIKey)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		p.logger.Error("failed to report command result",
			zap.Error(err),
			zap.String("command_id", result.CommandID),
		)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		p.logger.Error("command result report returned error",
			zap.Int("status", resp.StatusCode),
			zap.String("command_id", result.CommandID),
		)
		return
	}

	p.logger.Debug("command result reported",
		zap.String("command_id", result.CommandID),
	)
}

// GetQueueLength returns the current number of queued commands
func (p *CommandProcessor) GetQueueLength() int {
	p.queueMu.Lock()
	defer p.queueMu.Unlock()
	return len(p.queue)
}

// ClearQueue removes all commands from the queue
func (p *CommandProcessor) ClearQueue() {
	p.queueMu.Lock()
	defer p.queueMu.Unlock()
	p.queue = make([]models.Command, 0)
	p.logger.Info("command queue cleared")
}

// PeekQueue returns a copy of the current queue without modifying it
func (p *CommandProcessor) PeekQueue() []models.Command {
	p.queueMu.Lock()
	defer p.queueMu.Unlock()

	result := make([]models.Command, len(p.queue))
	copy(result, p.queue)
	return result
}
