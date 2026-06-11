// Package observability wires the Breeze agent to Sentry for unattended
// error reporting. All exported functions are safe to call when
// BREEZE_SENTRY_DSN is unset — they degrade to no-ops so self-hosted
// deployments without a DSN run unchanged.
//
// Critical invariants:
//   - Init MUST never panic and MUST never return a fatal error to the
//     caller. Sentry is best-effort: if it can't initialize, we log and
//     proceed.
//   - Recoverer MUST swallow the panic it recovers. Callers add it as the
//     first deferred statement in a goroutine so a panic in any wrapped
//     loop becomes a Sentry event + slog line instead of a process crash.
//   - Secrets (Bearer tokens, brz_-prefixed agent tokens, common
//     credential header names) MUST be scrubbed in BeforeSend +
//     BeforeBreadcrumb before any event leaves the process.
package observability

import (
	"errors"
	"log/slog"
	"os"
	"runtime/debug"
	"strings"
	"time"

	"github.com/getsentry/sentry-go"
)

// Init initializes Sentry if BREEZE_SENTRY_DSN is set. When unset, all
// observability functions become no-ops — the agent runs unchanged.
//
// The version argument should be the agent's compiled version string
// (typically populated by ldflags from the build).
//
// Returns an error only if BREEZE_SENTRY_DSN is set AND sentry.Init
// fails. Callers should log and continue rather than exit.
func Init(version string) error {
	dsn := strings.TrimSpace(os.Getenv("BREEZE_SENTRY_DSN"))
	if dsn == "" {
		slog.Info("sentry disabled (no DSN set)")
		return nil
	}
	return sentry.Init(sentry.ClientOptions{
		Dsn:              dsn,
		Release:          version,
		Environment:      os.Getenv("BREEZE_ENV"),
		TracesSampleRate: 0.05,
		BeforeSend: func(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
			scrubEvent(event)
			return event
		},
		BeforeBreadcrumb: func(bc *sentry.Breadcrumb, _ *sentry.BreadcrumbHint) *sentry.Breadcrumb {
			scrubBreadcrumb(bc)
			return bc
		},
	})
}

// Flush waits up to the given duration for Sentry to send queued events.
// Call from main as `defer observability.Flush(2 * time.Second)`. Safe
// to call when Init was a no-op.
func Flush(timeout time.Duration) {
	sentry.Flush(timeout)
}

// CaptureException reports an error to Sentry. No-op when err is nil or
// when Sentry is disabled.
func CaptureException(err error) {
	if err == nil {
		return
	}
	sentry.CaptureException(err)
}

// Recoverer is a goroutine-safe panic-recover wrapper that reports
// panics to Sentry with the stack + context, then logs via slog. It
// swallows the panic so the goroutine exits cleanly instead of crashing
// the process.
//
// Usage:
//
//	go func() {
//	  defer observability.Recoverer("desktop.encoder")
//	  // ... work ...
//	}()
func Recoverer(where string) {
	if r := recover(); r != nil {
		var err error
		switch v := r.(type) {
		case error:
			err = v
		case string:
			err = errors.New(v)
		default:
			err = errors.New("panic in " + where)
		}
		stack := string(debug.Stack())
		sentry.WithScope(func(scope *sentry.Scope) {
			scope.SetTag("where", where)
			// SetContext is the v0.46+ replacement for the removed SetExtra.
			scope.SetContext("panic", sentry.Context{"stack": stack})
			sentry.CaptureException(err)
		})
		slog.Error("recovered panic", "where", where, "err", err.Error())
	}
}

// scrubEvent redacts secrets from event fields before transmission.
func scrubEvent(event *sentry.Event) {
	if event.Request != nil {
		event.Request.Headers = scrubHeaders(event.Request.Headers)
	}
	if event.Message != "" {
		event.Message = redactSecrets(event.Message)
	}
	// In sentry-go v0.46+ the legacy Extra map was removed in favor of
	// Contexts. Walk the context blocks and scrub any string values that
	// may have captured a token or auth header inadvertently.
	for _, ctx := range event.Contexts {
		for k, v := range ctx {
			if s, ok := v.(string); ok {
				ctx[k] = redactSecrets(s)
			}
			_ = k
		}
	}
}

func scrubBreadcrumb(bc *sentry.Breadcrumb) {
	for k, v := range bc.Data {
		switch strings.ToLower(k) {
		case "authorization", "cookie", "x-agent-token", "token", "password":
			bc.Data[k] = "[REDACTED]"
		default:
			if s, ok := v.(string); ok {
				bc.Data[k] = redactSecrets(s)
			}
		}
	}
	if bc.Message != "" {
		bc.Message = redactSecrets(bc.Message)
	}
}

func scrubHeaders(headers map[string]string) map[string]string {
	if headers == nil {
		return nil
	}
	out := make(map[string]string, len(headers))
	for k, v := range headers {
		switch strings.ToLower(k) {
		case "authorization", "cookie", "x-agent-token":
			out[k] = "[REDACTED]"
		default:
			out[k] = v
		}
	}
	return out
}

// redactSecrets attempts to redact bearer tokens and brz_-prefixed agent
// tokens from a string. Defense-in-depth — primary scrubbing happens at
// the header/breadcrumb-data layer.
func redactSecrets(s string) string {
	lower := strings.ToLower(s)
	if idx := strings.Index(lower, "bearer "); idx >= 0 {
		head := s[:idx+len("bearer ")]
		rest := s[idx+len("bearer "):]
		end := strings.IndexAny(rest, " \t\n\r,")
		if end < 0 {
			return head + "[REDACTED]"
		}
		return head + "[REDACTED]" + rest[end:]
	}
	if i := strings.Index(s, "brz_"); i >= 0 {
		end := i + 4
		for end < len(s) && isTokenChar(s[end]) {
			end++
		}
		return s[:i] + "brz_[REDACTED]" + s[end:]
	}
	return s
}

func isTokenChar(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '-' || b == '_'
}
