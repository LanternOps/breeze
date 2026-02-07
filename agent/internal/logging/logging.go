package logging

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
)

// Key constants for structured log fields.
const (
	KeyCommandID   = "commandId"
	KeyCommandType = "commandType"
	KeyAgentID     = "agentId"
	KeyComponent   = "component"
	KeyDurationMs  = "durationMs"
	KeyError       = "error"
)

type contextKey struct{}

var defaultLogger = slog.Default()

// Init initializes the global logger. Call once after config is loaded.
// format: "json" or "text" (default "text")
// level: "debug", "info", "warn", "error" (default "info")
// output: writer to log to (nil = os.Stdout)
func Init(format, level string, output io.Writer) {
	if output == nil {
		output = os.Stdout
	}

	lvl := parseLevel(level)

	opts := &slog.HandlerOptions{
		Level: lvl,
	}

	var handler slog.Handler
	if strings.EqualFold(format, "json") {
		handler = slog.NewJSONHandler(output, opts)
	} else {
		handler = slog.NewTextHandler(output, opts)
	}

	defaultLogger = slog.New(handler)
	slog.SetDefault(defaultLogger)
}

// L returns a logger tagged with the given component name.
func L(component string) *slog.Logger {
	return defaultLogger.With(slog.String(KeyComponent, component))
}

// WithCommand returns a child logger with command correlation fields attached.
func WithCommand(logger *slog.Logger, cmdID, cmdType string) *slog.Logger {
	return logger.With(
		slog.String(KeyCommandID, cmdID),
		slog.String(KeyCommandType, cmdType),
	)
}

// NewContext returns a new context carrying the given logger.
func NewContext(ctx context.Context, logger *slog.Logger) context.Context {
	return context.WithValue(ctx, contextKey{}, logger)
}

// FromContext extracts the logger from context, falling back to the default.
func FromContext(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(contextKey{}).(*slog.Logger); ok {
		return l
	}
	return defaultLogger
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
