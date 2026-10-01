package config

import (
	"context"
	"log/slog"
	"sync"

	"github.com/breeze-rmm/agent/internal/logging"
)

// The agent runs FixConfigPermissions (the agent.yaml scrub and permission
// repair) before it sets up its log file, because opening the log file creates
// files under the config directory and should not happen before that
// directory's permissions are repaired. Records this package logs in that
// window would otherwise go to the default stdout handler, which a service
// discards. HoldStartupLogs keeps them in memory instead, and
// FlushStartupLogs writes them through the logger once it is initialized.
//
// The hold is limited to this package's logger and to a bounded number of
// records, so it cannot change where any other component logs or grow
// without limit.
const maxHeldStartupLogs = 256

type heldRecord struct {
	handler slog.Handler
	record  slog.Record
}

type startupLogHold struct {
	mu      sync.Mutex
	active  bool
	records []heldRecord
	dropped int
}

var startupLogs startupLogHold

// HoldStartupLogs starts holding this package's log records in memory until
// FlushStartupLogs.
func HoldStartupLogs() {
	startupLogs.mu.Lock()
	startupLogs.active = true
	startupLogs.mu.Unlock()
}

// FlushStartupLogs stops holding and writes the held records through the
// handler each was logged on, which by now routes to the initialized logger.
// Safe to call when nothing is held.
func FlushStartupLogs() {
	startupLogs.mu.Lock()
	records, dropped := startupLogs.records, startupLogs.dropped
	startupLogs.active, startupLogs.records, startupLogs.dropped = false, nil, 0
	startupLogs.mu.Unlock()

	ctx := context.Background()
	for _, held := range records {
		if held.handler.Enabled(ctx, held.record.Level) {
			_ = held.handler.Handle(ctx, held.record)
		}
	}
	if dropped > 0 {
		log.Warn("dropped config startup log records held before logging was initialized", "dropped", dropped)
	}
}

// holdingHandler wraps the package logger's handler. While a hold is active it
// keeps records (with the handler they were logged on, so attributes added
// with With are kept); otherwise it passes them straight through.
type holdingHandler struct {
	next slog.Handler
}

func (h holdingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h holdingHandler) Handle(ctx context.Context, r slog.Record) error {
	startupLogs.mu.Lock()
	if startupLogs.active {
		if len(startupLogs.records) < maxHeldStartupLogs {
			startupLogs.records = append(startupLogs.records, heldRecord{handler: h.next, record: r.Clone()})
		} else {
			startupLogs.dropped++
		}
		startupLogs.mu.Unlock()
		return nil
	}
	startupLogs.mu.Unlock()
	return h.next.Handle(ctx, r)
}

func (h holdingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return holdingHandler{next: h.next.WithAttrs(attrs)}
}

func (h holdingHandler) WithGroup(name string) slog.Handler {
	return holdingHandler{next: h.next.WithGroup(name)}
}

func newConfigLogger() *slog.Logger {
	return slog.New(holdingHandler{next: logging.L("config").Handler()})
}
