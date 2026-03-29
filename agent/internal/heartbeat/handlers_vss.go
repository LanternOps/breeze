//go:build windows

package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/vss"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdVSSStatus] = handleVSSStatus
	handlerRegistry[tools.CmdVSSWriterList] = handleVSSWriterList
}

func handleVSSStatus(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	if h.backupMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("backup not configured on this device"), time.Since(start).Milliseconds())
	}

	provider := vss.NewProvider(vss.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	writers, err := provider.ListWriters(ctx)
	if err != nil {
		slog.Warn("vss status check failed", "error", err.Error())
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	result := map[string]any{
		"writers": writers,
		"healthy": allWritersStable(writers),
		"count":   len(writers),
	}

	data, _ := json.Marshal(result)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}

func handleVSSWriterList(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	if h.backupMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("backup not configured on this device"), time.Since(start).Milliseconds())
	}

	provider := vss.NewProvider(vss.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	writers, err := provider.ListWriters(ctx)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	data, _ := json.Marshal(writers)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}

func allWritersStable(writers []vss.WriterStatus) bool {
	for _, w := range writers {
		if w.State != "stable" {
			return false
		}
	}
	return true
}
