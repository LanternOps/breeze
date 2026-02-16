package logging

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
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

// switchableHandler lets package-level loggers created before Init()
// dynamically pick up the configured handler once Init runs.
type switchableHandler struct {
	state  *switchableState
	attrs  []slog.Attr
	groups []string
}

type switchableState struct {
	current atomic.Value // stores slog.Handler
}

func newSwitchableHandler(h slog.Handler) *switchableHandler {
	state := &switchableState{}
	state.current.Store(h)
	return &switchableHandler{state: state}
}

func (h *switchableHandler) set(handler slog.Handler) {
	h.state.current.Store(handler)
}

func (h *switchableHandler) base() slog.Handler {
	return h.state.current.Load().(slog.Handler)
}

func (h *switchableHandler) materialize() slog.Handler {
	handler := h.base()
	for _, group := range h.groups {
		handler = handler.WithGroup(group)
	}
	if len(h.attrs) > 0 {
		handler = handler.WithAttrs(h.attrs)
	}
	return handler
}

func (h *switchableHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.materialize().Enabled(ctx, level)
}

func (h *switchableHandler) Handle(ctx context.Context, record slog.Record) error {
	return h.materialize().Handle(ctx, record)
}

func (h *switchableHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	merged := make([]slog.Attr, 0, len(h.attrs)+len(attrs))
	merged = append(merged, h.attrs...)
	merged = append(merged, attrs...)

	groups := make([]string, len(h.groups))
	copy(groups, h.groups)

	return &switchableHandler{
		state:  h.state,
		attrs:  merged,
		groups: groups,
	}
}

func (h *switchableHandler) WithGroup(name string) slog.Handler {
	attrs := make([]slog.Attr, len(h.attrs))
	copy(attrs, h.attrs)

	groups := make([]string, 0, len(h.groups)+1)
	groups = append(groups, h.groups...)
	groups = append(groups, name)

	return &switchableHandler{
		state:  h.state,
		attrs:  attrs,
		groups: groups,
	}
}

var (
	rootHandler   = newSwitchableHandler(&shippingHandler{base: slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})})
	defaultLogger = slog.New(rootHandler)
	globalShipper *Shipper
	shipperMu     sync.RWMutex
)

func init() {
	slog.SetDefault(defaultLogger)
}

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

	// Wrap with shipping handler to forward logs to remote
	handler = &shippingHandler{base: handler}

	rootHandler.set(handler)
	defaultLogger = slog.New(rootHandler)
	slog.SetDefault(defaultLogger)
}

// InitShipper initializes the log shipper (call after enrollment).
func InitShipper(cfg ShipperConfig) {
	shipperMu.Lock()
	defer shipperMu.Unlock()

	if globalShipper != nil {
		globalShipper.Stop()
	}

	globalShipper = NewShipper(cfg)
	globalShipper.Start()
}

// StopShipper gracefully stops the log shipper.
func StopShipper() {
	shipperMu.Lock()
	defer shipperMu.Unlock()

	if globalShipper != nil {
		globalShipper.Stop()
		globalShipper = nil
	}
}

// SetShipperLevel dynamically adjusts minimum log level for shipping.
func SetShipperLevel(level string) {
	shipperMu.RLock()
	defer shipperMu.RUnlock()

	if globalShipper != nil {
		globalShipper.SetMinLevel(level)
	}
}

// shippingHandler wraps a base slog.Handler to also ship logs remotely.
type shippingHandler struct {
	base slog.Handler
}

func (h *shippingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.base.Enabled(ctx, level)
}

func (h *shippingHandler) Handle(ctx context.Context, record slog.Record) error {
	// Ship to remote
	shipperMu.RLock()
	shipper := globalShipper
	shipperMu.RUnlock()

	if shipper != nil && shipper.ShouldShip(record.Level) {
		fields := make(map[string]any)
		record.Attrs(func(a slog.Attr) bool {
			fields[a.Key] = a.Value.Any()
			return true
		})

		entry := LogEntry{
			Timestamp:    record.Time,
			Level:        record.Level.String(),
			Component:    extractComponent(fields),
			Message:      record.Message,
			Fields:       fields,
			AgentVersion: shipper.agentVersion,
		}

		shipper.Enqueue(entry)
	}

	// Still write to local handler
	return h.base.Handle(ctx, record)
}

func (h *shippingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &shippingHandler{base: h.base.WithAttrs(attrs)}
}

func (h *shippingHandler) WithGroup(name string) slog.Handler {
	return &shippingHandler{base: h.base.WithGroup(name)}
}

func extractComponent(fields map[string]any) string {
	if c, ok := fields[KeyComponent].(string); ok {
		return c
	}
	return "unknown"
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
