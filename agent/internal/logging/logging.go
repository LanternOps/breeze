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

	// KeyShipAlways marks a record that must reach the log shipper regardless
	// of the configured log_shipping_level. The marker is stripped before the
	// entry is shipped. See ShipAlways.
	KeyShipAlways = "_shipAlways"
)

// ShipAlways returns an attribute that lifts the record above the shipper's
// minimum level. It exists for the few periodic diagnostics that are the
// only evidence we have for a live remote-desktop session ("Viewer WebRTC
// stats", "Desktop WebRTC metrics"): they are Info-level, but the
// desktop-helper ships at log_shipping_level=warn by default, so without this
// they never reached Agent Logs (#5929). The override is session-scoped by
// construction — only records emitted while a session is live carry it.
//
// It overrides log_shipping_level only, not log_level: slog checks
// Enabled() before Handle() ever runs, so a record below the LOCAL level is
// dropped before the marker can be seen and neither logs nor ships. The
// desktop-helper hardcodes the local level to info, so it is unaffected; an
// agent running direct-mode sessions with log_level=warn would still not
// ship these lines.
func ShipAlways() slog.Attr {
	return slog.Bool(KeyShipAlways, true)
}

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
	shipper := globalShipper
	globalShipper = nil
	shipperMu.Unlock()

	// A flush can outlive the agent's shutdown deadline. Keep logging usable
	// while it drains: the timeout warning also passes through shippingHandler
	// and must not wait on the same lock as the stalled flush.
	if shipper != nil {
		shipper.Stop()
	}
}

// SetShipperLevel dynamically adjusts minimum log level for shipping.
// Returns true if the shipper was active and the level was changed,
// false if no shipper is initialized.
func SetShipperLevel(level string) bool {
	shipperMu.RLock()
	defer shipperMu.RUnlock()

	if globalShipper != nil {
		globalShipper.SetMinLevel(level)
		return true
	}
	return false
}

// DroppedLogCount returns the number of log entries dropped since the last
// commit. The counter is NOT reset; call CommitDroppedLogCount after a
// successful heartbeat to clear it.
func DroppedLogCount() int64 {
	shipperMu.RLock()
	defer shipperMu.RUnlock()

	if globalShipper != nil {
		return globalShipper.DroppedLogCount()
	}
	return 0
}

// CommitDroppedLogCount resets the dropped log counter to zero. Call this
// after the heartbeat POST succeeds so that the count is preserved for retry
// if the heartbeat fails. No-op if the shipper is not initialized.
func CommitDroppedLogCount() {
	shipperMu.RLock()
	defer shipperMu.RUnlock()

	if globalShipper != nil {
		globalShipper.CommitDroppedLogCount()
	}
}

// shippingHandler wraps a base slog.Handler to also ship logs remotely.
type shippingHandler struct {
	base   slog.Handler
	attrs  []slog.Attr
	groups []string
}

func (h *shippingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.base.Enabled(ctx, level)
}

func (h *shippingHandler) Handle(ctx context.Context, record slog.Record) error {
	// Ship to remote
	shipperMu.RLock()
	shipper := globalShipper
	shipperMu.RUnlock()

	if shipper != nil && (shipper.ShouldShip(record.Level) || h.shipAlways(record)) {
		fields := make(map[string]any)
		for _, attr := range h.attrs {
			if attr.Key != KeyShipAlways {
				addField(fields, h.groups, attr)
			}
		}
		record.Attrs(func(a slog.Attr) bool {
			if a.Key != KeyShipAlways {
				addField(fields, h.groups, a)
			}
			return true
		})

		entry := LogEntry{
			Timestamp:    record.Time,
			Level:        strings.ToLower(record.Level.String()),
			Component:    extractComponent(fields),
			Message:      record.Message,
			Fields:       fields,
			AgentVersion: shipper.agentVersion,
		}

		shipper.Enqueue(entry)
	}

	// Still write to local handler, without the shipping marker.
	return h.base.Handle(ctx, stripShipAlways(record))
}

// shipAlways reports whether the record, or the logger it came from, carries
// the ShipAlways marker.
func (h *shippingHandler) shipAlways(record slog.Record) bool {
	for _, attr := range h.attrs {
		if attr.Key == KeyShipAlways {
			return true
		}
	}
	found := false
	record.Attrs(func(a slog.Attr) bool {
		if a.Key == KeyShipAlways {
			found = true
			return false
		}
		return true
	})
	return found
}

func (h *shippingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	merged := make([]slog.Attr, 0, len(h.attrs)+len(attrs))
	merged = append(merged, h.attrs...)
	merged = append(merged, attrs...)

	groups := make([]string, len(h.groups))
	copy(groups, h.groups)

	return &shippingHandler{
		base:   h.base.WithAttrs(withoutShipAlways(attrs)),
		attrs:  merged,
		groups: groups,
	}
}

// withoutShipAlways drops the ShipAlways marker so it never reaches the
// local handler's output. Returns the input slice untouched when absent.
func withoutShipAlways(attrs []slog.Attr) []slog.Attr {
	for i, a := range attrs {
		if a.Key == KeyShipAlways {
			out := make([]slog.Attr, 0, len(attrs)-1)
			out = append(out, attrs[:i]...)
			for _, b := range attrs[i+1:] {
				if b.Key != KeyShipAlways {
					out = append(out, b)
				}
			}
			return out
		}
	}
	return attrs
}

// stripShipAlways returns a copy of the record without the ShipAlways marker,
// or the record itself when it carries none.
func stripShipAlways(record slog.Record) slog.Record {
	found := false
	record.Attrs(func(a slog.Attr) bool {
		if a.Key == KeyShipAlways {
			found = true
			return false
		}
		return true
	})
	if !found {
		return record
	}
	out := slog.NewRecord(record.Time, record.Level, record.Message, record.PC)
	record.Attrs(func(a slog.Attr) bool {
		if a.Key != KeyShipAlways {
			out.AddAttrs(a)
		}
		return true
	})
	return out
}

func (h *shippingHandler) WithGroup(name string) slog.Handler {
	attrs := make([]slog.Attr, len(h.attrs))
	copy(attrs, h.attrs)

	groups := make([]string, 0, len(h.groups)+1)
	groups = append(groups, h.groups...)
	groups = append(groups, name)

	return &shippingHandler{
		base:   h.base.WithGroup(name),
		attrs:  attrs,
		groups: groups,
	}
}

func addField(fields map[string]any, groups []string, attr slog.Attr) {
	keyParts := make([]string, 0, len(groups)+1)
	keyParts = append(keyParts, groups...)
	if attr.Key != "" {
		keyParts = append(keyParts, attr.Key)
	}

	value := attr.Value.Resolve()
	if value.Kind() == slog.KindGroup {
		for _, nested := range value.Group() {
			addField(fields, keyParts, nested)
		}
		return
	}

	if len(keyParts) == 0 {
		return
	}
	fields[strings.Join(keyParts, ".")] = shippableValue(value.Any())
}

// shippableValue converts values that encoding/json cannot represent into their
// text. An error value (errors.New, fmt.Errorf, errors.Join, ...) has no exported
// fields, so it marshals as {} and the message is lost from the shipped row.
func shippableValue(v any) any {
	if err, ok := v.(error); ok {
		return errorText(err)
	}
	return v
}

// errorText returns err.Error(), tolerating a typed-nil error whose Error method
// dereferences its nil receiver.
func errorText(err error) (text string) {
	defer func() {
		if recover() != nil {
			text = "<nil>"
		}
	}()
	return err.Error()
}

func extractComponent(fields map[string]any) string {
	if c, ok := fields[KeyComponent].(string); ok && c != "" {
		return c
	}
	suffix := "." + KeyComponent
	for key, value := range fields {
		if strings.HasSuffix(key, suffix) {
			if c, ok := value.(string); ok && c != "" {
				return c
			}
		}
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
