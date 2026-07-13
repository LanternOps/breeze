package workspaceindex

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"math/rand/v2"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/audit"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/observability"
)

const moduleAbsentBackoff = 6 * time.Hour

// indexingScopeSignature reduces the announced source set to a comparable
// string so the consent signal re-fires when the server changes WHAT is
// indexed, not only when it toggles indexing on. sources must already be
// ordered deterministically (by source ID).
//
// excludeGlobs is part of the signature: DROPPING an exclusion (e.g. removing
// `Finance/**`) widens what gets enumerated and uploaded just as surely as
// adding a source, and must re-announce. cadenceMinutes is deliberately NOT
// part of it — it changes how often the same scope is walked, not its extent.
func indexingScopeSignature(sources []SourceConfig) string {
	if len(sources) == 0 {
		return ""
	}
	parts := make([]string, 0, len(sources))
	for _, src := range sources {
		globs := slices.Clone(src.ExcludeGlobs)
		slices.Sort(globs)
		parts = append(parts, fmt.Sprintf("%s|%s|%s|%t|%s",
			src.ID, src.Kind, src.RootPath, src.Watch, strings.Join(globs, ",")))
	}
	return strings.Join(parts, ";")
}

// AuditLogger records device-audit events for privacy-significant module
// transitions. *audit.Logger satisfies it and is nil-receiver safe.
type AuditLogger interface {
	Log(eventType string, commandID string, details map[string]any)
}

// Deps contains orchestration dependencies and the timing seams used by tests.
type Deps struct {
	Client    *Client
	Log       *slog.Logger
	Enumerate func() []ProfileRoot
	DialSMB   func(context.Context, string, *Credential) (SourceFS, io.Closer, error)
	Now       func() time.Time

	// Audit, when set, receives a device-audit event each time server
	// configuration activates filesystem indexing on this device. Enablement
	// is server-driven (no local opt-in), so activation must at least leave a
	// prominent local log + tamper-evident audit trace (#2425).
	Audit AuditLogger

	TickInterval  time.Duration
	WatchDebounce time.Duration
	WatchDirCap   int
}

func (d Deps) withDefaults() Deps {
	if d.Log == nil {
		d.Log = logging.L("workspaceindex")
	}
	if d.DialSMB == nil {
		d.DialSMB = DialSMB
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.TickInterval <= 0 {
		d.TickInterval = time.Minute
	}
	if d.WatchDebounce <= 0 {
		d.WatchDebounce = 5 * time.Second
	}
	if d.WatchDirCap <= 0 {
		d.WatchDirCap = 4096
	}
	return d
}

type crawlRequest struct {
	src    SourceConfig
	limits ConfigLimits
}

type crawlResult struct {
	sourceID string
	err      error
}

type activeCrawl struct {
	sourceID string
	cancel   context.CancelFunc
}

type watchRegistration struct {
	src  SourceConfig
	stop func()
}

// StartLoop starts the workspace-index scheduler and returns a channel closed
// after all crawls and watchers have torn down.
func StartLoop(ctx context.Context, deps Deps) <-chan struct{} {
	done := make(chan struct{})
	deps = deps.withDefaults()

	go func() {
		defer close(done)
		defer observability.Recoverer("workspaceindex.loop")

		ticker := time.NewTicker(deps.TickInterval)
		defer ticker.Stop()

		resultCh := make(chan crawlResult, 1)
		queue := make([]crawlRequest, 0)
		queued := make(map[string]bool)
		activeSources := make(map[string]SourceConfig)
		watchers := make(map[string]watchRegistration)
		var running *activeCrawl
		var nextFetch time.Time
		// auditedScope is the signature of the source set last announced by the
		// consent signal (prominent log + device-audit event, #2425). Tracking
		// the SCOPE rather than a mere on/off bool means a server that widens
		// indexing while it is already active — adding an SMB share, repointing
		// a rootPath — re-announces instead of riding the first activation's
		// trace silently. Empty means indexing is not active.
		auditedScope := ""

		markIndexingInactive := func(reason string) {
			if auditedScope == "" {
				return
			}
			auditedScope = ""
			// Deactivation is half of the "when was this device indexed?"
			// question, so it ships (Warn: the log shipper's MinLevel) and
			// leaves its own audit entry — an activation trace with no
			// closing bracket cannot bound the indexing window (#2425).
			deps.Log.Warn("workspace indexing DEACTIVATED", "reason", reason)
			if deps.Audit != nil {
				deps.Audit.Log(audit.EventWorkspaceIndexDeactivated, "", map[string]any{
					"reason": reason,
				})
			}
		}
		markIndexingActive := func(sources map[string]SourceConfig) {
			ordered := make([]SourceConfig, 0, len(sources))
			for _, id := range slices.Sorted(maps.Keys(sources)) {
				ordered = append(ordered, sources[id])
			}
			scope := indexingScopeSignature(ordered)
			if scope == auditedScope {
				return
			}
			summaries := make([]map[string]any, 0, len(ordered))
			ids := make([]string, 0, len(ordered))
			for _, src := range ordered {
				summaries = append(summaries, map[string]any{
					"id":             src.ID,
					"kind":           src.Kind,
					"rootPath":       src.RootPath,
					"cadenceMinutes": src.CadenceMinutes,
					"watch":          src.Watch,
					"excludeGlobs":   src.ExcludeGlobs,
				})
				ids = append(ids, src.ID)
			}
			widened := auditedScope != ""
			auditedScope = scope

			// Enablement is a pure server-side flip with no local opt-in, so
			// activation must be loud: Warn reaches the shipped agent logs and
			// the audit entry leaves a local tamper-evident trace (#2425).
			message := "workspace indexing ACTIVATED by server configuration — filesystem metadata will be enumerated and uploaded"
			if widened {
				message = "workspace indexing SCOPE CHANGED by server configuration — a different set of filesystem locations will be enumerated and uploaded"
			}
			deps.Log.Warn(message, "sourceCount", len(sources), "sourceIds", ids)
			if deps.Audit != nil {
				deps.Audit.Log(audit.EventWorkspaceIndexActivated, "", map[string]any{
					"sources":     summaries,
					"scopeChange": widened,
				})
			}
		}

		stopWatches := func() {
			for id, watcher := range watchers {
				watcher.stop()
				delete(watchers, id)
			}
		}
		cancelActivity := func() {
			if running != nil {
				running.cancel()
			}
			stopWatches()
			queue = queue[:0]
			clear(queued)
			clear(activeSources)
		}

		startNext := func() {
			if running != nil {
				return
			}
			for len(queue) > 0 {
				req := queue[0]
				queue = queue[1:]
				delete(queued, req.src.ID)
				if _, exists := activeSources[req.src.ID]; !exists {
					continue
				}

				crawlCtx, cancel := context.WithCancel(ctx)
				running = &activeCrawl{sourceID: req.src.ID, cancel: cancel}
				go func() {
					var crawlErr error
					defer func() { resultCh <- crawlResult{sourceID: req.src.ID, err: crawlErr} }()
					defer observability.Recoverer("workspaceindex.crawl")
					crawlErr = runCrawl(crawlCtx, deps, req.src, req.limits)
				}()
				return
			}
		}

		reconcile := func(config *CrawlConfig, now time.Time) {
			if !config.Enabled {
				markIndexingInactive("disabled by server configuration")
				cancelActivity()
				return
			}

			desired := make(map[string]SourceConfig, len(config.Sources))
			for _, src := range config.Sources {
				if src.CadenceMinutes > 0 {
					desired[src.ID] = src
				}
			}
			if len(desired) > 0 {
				markIndexingActive(desired)
			} else {
				markIndexingInactive("no active sources")
			}

			if running != nil {
				if _, exists := desired[running.sourceID]; !exists {
					running.cancel()
				}
			}

			filtered := queue[:0]
			for _, req := range queue {
				if src, exists := desired[req.src.ID]; exists {
					req.src = src
					req.limits = config.Limits
					filtered = append(filtered, req)
				} else {
					delete(queued, req.src.ID)
				}
			}
			queue = filtered

			for id, watcher := range watchers {
				src, exists := desired[id]
				if !exists || src.Kind != "local_profile" || !src.Watch || !reflect.DeepEqual(src, watcher.src) {
					watcher.stop()
					delete(watchers, id)
				}
			}
			for id, src := range desired {
				if src.Kind == "local_profile" && src.Watch {
					if _, exists := watchers[id]; !exists {
						watchers[id] = watchRegistration{src: src, stop: startWatch(ctx, deps, src)}
					}
				}
			}

			activeSources = desired
			for _, src := range config.Sources {
				if _, active := desired[src.ID]; !active || !isSourceDue(now, src) {
					continue
				}
				if queued[src.ID] || (running != nil && running.sourceID == src.ID) {
					continue
				}
				queue = append(queue, crawlRequest{src: src, limits: config.Limits})
				queued[src.ID] = true
			}
			startNext()
		}

		fetch := func() {
			now := deps.Now()
			if !nextFetch.IsZero() && now.Before(nextFetch) {
				return
			}
			config, err := deps.Client.FetchConfig(ctx)
			if err != nil {
				if errors.Is(err, ErrModuleAbsent) {
					markIndexingInactive("workspace module absent on server")
					cancelActivity()
					nextFetch = now.Add(moduleAbsentBackoff)
					return
				}
				deps.Log.Warn("fetch workspace index config", "err", err)
				nextFetch = now.Add(deps.TickInterval)
				return
			}
			reconcile(config, now)
			nextFetch = now.Add(jitterPollInterval(config.PollIntervalSeconds))
		}

		if deps.Client == nil {
			deps.Log.Error("workspace index loop requires a client")
			return
		}
		fetch()
		for {
			select {
			case <-ctx.Done():
				cancelActivity()
				if running != nil {
					<-resultCh
				}
				return
			case result := <-resultCh:
				if running != nil && running.sourceID == result.sourceID {
					running.cancel()
					running = nil
				}
				if result.err != nil && ctx.Err() == nil {
					deps.Log.Warn("workspace index crawl failed", "sourceId", result.sourceID, "err", result.err)
				}
				startNext()
			case <-ticker.C:
				fetch()
			}
		}
	}()
	return done
}

func isSourceDue(now time.Time, src SourceConfig) bool {
	if src.CadenceMinutes <= 0 {
		return false
	}
	if src.LastCompleteRunAt == nil {
		return true
	}
	return now.Sub(*src.LastCompleteRunAt) >= time.Duration(src.CadenceMinutes)*time.Minute
}

func jitterPollInterval(seconds int) time.Duration {
	if seconds <= 0 {
		seconds = 60
	}
	base := time.Duration(seconds) * time.Second
	span := base / 10
	if span <= 0 {
		return base
	}
	return base - span + time.Duration(rand.Int64N(int64(2*span)+1))
}
