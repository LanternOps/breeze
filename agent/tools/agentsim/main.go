// Command agentsim drives N simulated Breeze agents against a real stack and
// writes a breeze.agentsim.report/v1 run report. It lives in the agent module
// because it reuses the agent's internal wire structs. Operator guide:
// load-tests/agentsim/README.md.
package main

import (
	"context"
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

func parseFlags(args []string, getenv func(string) string) (sim.Config, error) {
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
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	cfg.StartMode = sim.StartMode(start)
	if err := sim.ParseCadenceOverrides(cadence, &cfg.Cadence); err != nil {
		return cfg, err
	}
	return cfg, cfg.Validate()
}

func printSummary(w io.Writer, path string, r sim.Report) {
	fmt.Fprintf(w, "agentsim %s: %d/%d agents started, %.1f agent-minutes in the steady window\n",
		r.RunID, r.Agents.Started, r.Agents.Configured, r.Window.AgentMinutes)
	fmt.Fprintf(w, "  requests/agent-min %.2f (model %.2f, %+.1f%%), non-2xx %d, transport errors %d\n",
		r.Totals.RequestsPerAgentMinute, r.Totals.ExpectedRequestsPerAgentMinute, r.Totals.DeviationPct,
		r.Totals.Non2xx, r.Totals.TransportErrors)
	fmt.Fprintf(w, "  ws connects %d (reconnects %d, failures %d); commands dispatched %d, results %v\n",
		r.WS.Connects, r.WS.Reconnects, r.WS.ConnectFailures, r.Commands.Dispatched, r.Commands.ResultsSent)
	fmt.Fprintf(w, "  report: %s\n", path)
}

func main() {
	cfg, err := parseFlags(os.Args[1:], os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "agentsim:", err)
		os.Exit(2)
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
		os.Exit(1)
	}
}
