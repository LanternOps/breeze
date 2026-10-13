// Command agentsim drives N simulated Breeze agents against a real stack and
// writes a breeze.agentsim.report/v1 run report. It lives in the agent module
// because it reuses the agent's internal wire structs. Operator guide:
// load-tests/agentsim/README.md.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/tools/agentsim/sim"
)

// parseArgs parses the command line; dryRun is set by --storm-dry-run.
func parseArgs(args []string, getenv func(string) string, dryRun *bool) (sim.Config, error) {
	cfg := sim.DefaultConfig()
	fs := flag.NewFlagSet("agentsim", flag.ContinueOnError)
	var cadence, start string
	fs.StringVar(&cfg.ServerURL, "server", getenv("AGENTSIM_SERVER"), "stack base URL (baseUrl in .breeze-stack.json); env AGENTSIM_SERVER")
	fs.StringVar(&cfg.EnrollmentKey, "enrollment-key", getenv("AGENTSIM_ENROLLMENT_KEY"), "raw enrollment key, needed only for agents missing from --store; env AGENTSIM_ENROLLMENT_KEY")
	fs.StringVar(&cfg.EnrollmentSecret, "enrollment-secret", getenv("BREEZE_AGENT_ENROLLMENT_SECRET"), "enrollment secret; env BREEZE_AGENT_ENROLLMENT_SECRET (same as the real agent)")
	fs.IntVar(&cfg.Agents, "agents", cfg.Agents, "number of simulated agents")
	fs.Float64Var(&cfg.RampPerSecond, "ramp", cfg.RampPerSecond, "agents started per second")
	fs.IntVar(&cfg.EnrollConcurrency, "enroll-concurrency", cfg.EnrollConcurrency, "concurrent enrollments")
	fs.DurationVar(&cfg.Duration, "duration", cfg.Duration, "whole run, from the first agent start")
	fs.DurationVar(&cfg.Warmup, "warmup", cfg.Warmup, "wait after the ramp before the steady window opens")
	fs.StringVar(&cfg.StorePath, "store", cfg.StorePath, "token store (0600; reused across runs)")
	fs.StringVar(&cfg.ReportPath, "report", cfg.ReportPath, "run report output path")
	fs.StringVar(&cfg.HostnamePrefix, "hostname-prefix", cfg.HostnamePrefix, "hostname prefix for a new store")
	fs.StringVar(&cfg.AgentVersion, "agent-version", cfg.AgentVersion, "agentVersion to report (dev-* is never offered an upgrade)")
	fs.StringVar(&cfg.OSType, "os", cfg.OSType, "linux, windows or macos")
	fs.StringVar(&start, "start", string(cfg.StartMode), "warm (steady-state phases) or cold (startup fan-out)")
	fs.BoolVar(&cfg.WSEnabled, "ws", cfg.WSEnabled, "hold an agent WebSocket per agent")
	fs.StringVar(&cadence, "cadence", "", "overrides, e.g. heartbeat=30s,inventory=0 (names: "+strings.Join(sim.CadenceNames(), ", ")+")")
	fs.IntVar(&cfg.Retry.MaxRetries, "retries", cfg.Retry.MaxRetries, "httputil retries per request (agent default 3)")
	fs.DurationVar(&cfg.CommandDelay, "command-delay", cfg.CommandDelay, "simulated command execution time")
	fs.Float64Var(&cfg.Commander.PerMinute, "commands-per-minute", 0, "queue this many commands per minute through the admin API (0 = off)")
	fs.StringVar(&cfg.Commander.Email, "admin-email", getenv("AGENTSIM_ADMIN_EMAIL"), "admin login for --commands-per-minute; env AGENTSIM_ADMIN_EMAIL")
	fs.StringVar(&cfg.Commander.Password, "admin-password", getenv("AGENTSIM_ADMIN_PASSWORD"), "prefer env AGENTSIM_ADMIN_PASSWORD (flags show in ps)")
	fs.StringVar(&cfg.Commander.CommandType, "command-type", cfg.Commander.CommandType, "command type the commander queues")
	fs.StringVar(&cfg.StormPath, "storm", "", "storm scenario file (load-tests/agentsim/storms/*.json); ${STORM_*} expand from the environment")
	fs.BoolVar(dryRun, "storm-dry-run", false, "load --storm, print each expanded command with its offset, and exit without running")
	fs.BoolVar(&cfg.Timeline, "timeline", false, "record the per-second timeline without a storm")
	fs.StringVar(&cfg.ScrapeURL, "scrape-url", "", "pool sampler URL (default <server>/metrics/scrape); token from env METRICS_SCRAPE_TOKEN only")
	fs.DurationVar(&cfg.ScrapeInterval, "scrape-interval", cfg.ScrapeInterval, "pool sampler interval")
	fs.DurationVar(&cfg.Gates.HeartbeatP95, "gate-heartbeat-p95", 0, "fail when the storm/recovery heartbeat p95 exceeds this (off when 0)")
	fs.Float64Var(&cfg.Gates.PoolMinRatio, "gate-pool-min-ratio", 0, "fail when effective/permits drops below this during an event (off when 0)")
	fs.DurationVar(&cfg.Gates.PoolRecovery, "gate-pool-recovery", 0, "fail when the pool is not back to max this long after an event ends (off when 0)")
	fs.DurationVar(&cfg.Gates.MaxGap, "gate-max-gap", 0, "fail when any agent goes this long without a successful heartbeat (off when 0)")
	fs.Float64Var(&cfg.Gates.LostPct, "gate-lost-pct", 0, "fail when more than this percent of requests are lost after retries (off when 0)")
	fs.Float64Var(&cfg.LegacyRetryFraction, "legacy-retry-fraction", 0, "fraction of agents that ignore Retry-After (agents older than v0.64.3)")
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	cfg.StartMode = sim.StartMode(start)
	cfg.ScrapeToken = getenv("METRICS_SCRAPE_TOKEN")
	if err := sim.ParseCadenceOverrides(cadence, &cfg.Cadence); err != nil {
		return cfg, err
	}
	if *dryRun && cfg.StormPath == "" {
		return cfg, errors.New("--storm-dry-run needs --storm")
	}
	if cfg.StormPath != "" {
		lookup := func(k string) (string, bool) { v := getenv(k); return v, v != "" }
		sc, err := sim.LoadScenario(cfg.StormPath, lookup)
		if err != nil {
			return cfg, err
		}
		cfg.Storm = &sc
	}
	if *dryRun {
		return cfg, nil // a dry run never starts agents: no server or window needed
	}
	return cfg, cfg.Validate()
}

func parseFlags(args []string, getenv func(string) string) (sim.Config, error) {
	var dry bool
	return parseArgs(args, getenv, &dry)
}

// exitCode: 1 on a run error, 3 when a storm gate failed, else 0 (2 is a
// config error, from main).
func exitCode(r sim.Report, err error) int {
	switch {
	case err != nil:
		return 1
	case r.Storm != nil && !r.Storm.Pass:
		return 3
	}
	return 0
}

// printDryRun prints each action with its offset from the steady-window open.
func printDryRun(w io.Writer, sc sim.Scenario) {
	_, _ = fmt.Fprintf(w, "storm %s (offsets from the steady-window open)\n", sc.Name)
	for _, ev := range sc.Events {
		for _, a := range ev.Start {
			_, _ = fmt.Fprintf(w, "  +%s  %s start: %s\n", ev.At.D, ev.Name, actionString(a))
		}
		for _, a := range ev.End {
			_, _ = fmt.Fprintf(w, "  +%s  %s end:   %s\n", ev.At.D+ev.Hold.D, ev.Name, actionString(a))
		}
		_, _ = fmt.Fprintf(w, "  +%s  %s recovery ends\n", ev.At.D+ev.Hold.D+ev.Recovery.D, ev.Name)
	}
}

func actionString(a sim.Action) string {
	if a.Internal != "" {
		return "(internal) " + a.Internal
	}
	return strings.Join(a.Exec, " ")
}

func secs(v *float64) string {
	if v == nil {
		return "never"
	}
	return fmt.Sprintf("%.1fs", *v)
}

func printStorm(w io.Writer, s *sim.StormReport) {
	if s.StepsFailed > 0 {
		_, _ = fmt.Fprintf(w, "  WARNING: %d storm step(s) failed; see storm.steps in the report\n", s.StepsFailed)
	}
	if len(s.Events) < s.EventsPlanned {
		_, _ = fmt.Fprintf(w, "  WARNING: %d of %d storm events ran (the run ended first)\n", len(s.Events), s.EventsPlanned)
	}
	for _, e := range s.Events {
		pool := "pool not sampled"
		if e.Pool.OKSamples > 0 {
			pool = fmt.Sprintf("pool min %.2f recovered %s", e.Pool.MinEffectiveRatio, secs(e.Pool.RecoveryS))
		}
		_, _ = fmt.Fprintf(w, "  storm %s: t90 %s, trough %d/%d, hb p95 storm/recovery %.0f/%.0f ms, lost %.2f%%, %s\n",
			e.Name, secs(e.Reconnect.T90S), e.Reconnect.Trough, e.Reconnect.Baseline,
			e.Heartbeat.Storm.P95, e.Heartbeat.Recovery.P95, e.Errors.LostPct, pool)
	}
	if len(s.Gates) == 0 {
		return
	}
	for _, g := range s.Gates {
		verdict := "pass"
		if !g.Pass {
			verdict = "FAIL"
		}
		_, _ = fmt.Fprintf(w, "  gate %s %s: %s (threshold %g)\n", g.Event, g.Gate, verdict, g.Threshold)
	}
	if s.Pass {
		_, _ = fmt.Fprintln(w, "  GATES PASS")
	} else {
		_, _ = fmt.Fprintln(w, "  GATES FAIL")
	}
}

func printSummary(w io.Writer, path string, r sim.Report) {
	_, _ = fmt.Fprintf(w, "agentsim %s: %d/%d agents started, %.1f agent-minutes in the steady window\n",
		r.RunID, r.Agents.Started, r.Agents.Configured, r.Window.AgentMinutes)
	_, _ = fmt.Fprintf(w, "  requests/agent-min %.2f (model %.2f, %+.1f%%), non-2xx %d, transport errors %d\n",
		r.Totals.RequestsPerAgentMinute, r.Totals.ExpectedRequestsPerAgentMinute, r.Totals.DeviationPct,
		r.Totals.Non2xx, r.Totals.TransportErrors)
	_, _ = fmt.Fprintf(w, "  ws connects %d (reconnects %d, failures %d); commands dispatched %d, results %v\n",
		r.WS.Connects, r.WS.Reconnects, r.WS.ConnectFailures, r.Commands.Dispatched, r.Commands.ResultsSent)
	if r.Storm != nil {
		printStorm(w, r.Storm)
	}
	_, _ = fmt.Fprintf(w, "  report: %s\n", path)
}

func main() {
	var dryRun bool
	cfg, err := parseArgs(os.Args[1:], os.Getenv, &dryRun)
	if err != nil {
		fmt.Fprintln(os.Stderr, "agentsim:", err)
		os.Exit(2)
	}
	if dryRun {
		printDryRun(os.Stdout, *cfg.Storm)
		return
	}
	logging.Init("text", "error", os.Stderr) // the agent packages log per retry; keep 2,000 agents quiet
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	report, err := sim.Run(ctx, cfg)
	if report.Schema != "" {
		printSummary(os.Stdout, cfg.ReportPath, report)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "agentsim:", err)
	}
	if code := exitCode(report, err); code != 0 {
		os.Exit(code)
	}
}
