// Package sim drives N simulated Breeze agents against a real stack. See
// load-tests/agentsim/README.md.
package sim

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
)

// StartMode selects how a simulated agent begins.
type StartMode string

const (
	// StartWarm models an agent that has been running for hours: no startup
	// inventory fan-out, and every periodic stream starts at a random phase.
	StartWarm StartMode = "warm"
	// StartCold replays a fresh service start: the inventory batch fires after
	// the first heartbeat and the zero-stamped gates fire on the first tick, as
	// heartbeat.go Start() does.
	StartCold StartMode = "cold"
)

// Cadence is every periodic interval the simulator drives. Zero disables a
// stream (except Heartbeat, which drives the tick loop).
type Cadence struct {
	Heartbeat     time.Duration
	UnifiPoll     time.Duration
	CrawlConfig   time.Duration
	ProcessSample time.Duration
	Security      time.Duration
	Sessions      time.Duration
	Inventory     time.Duration
	Posture       time.Duration
	EventLogs     time.Duration
	WSPing        time.Duration
}

// DefaultCadence mirrors the real agent at this commit.
func DefaultCadence() Cadence {
	return Cadence{
		Heartbeat:     time.Duration(config.DefaultHeartbeatIntervalSeconds) * time.Second,
		UnifiPoll:     30 * time.Second, // internal/unifi/collector.go StartCollectorLoop ticker
		CrawlConfig:   60 * time.Second, // internal/workspaceindex/loop.go default poll, ±10 %
		ProcessSample: time.Duration(config.Default().ProcessSampleIntervalSeconds) * time.Second,
		Security:      5 * time.Minute,  // heartbeat.go Start(): shouldSendSecurity
		Sessions:      5 * time.Minute,  // shouldSendSessions
		Inventory:     15 * time.Minute, // shouldSendInventory -> sendInventory()
		Posture:       15 * time.Minute, // shouldSendPosture
		EventLogs:     15 * time.Minute, // collectors/eventlogs.go intervalMinutes default
		WSPing:        54 * time.Second, // internal/websocket/client.go pingPeriod
	}
}

// CadenceNames lists the names --cadence accepts, in report order.
func CadenceNames() []string {
	return []string{"heartbeat", "unifi", "crawl-config", "process-sample", "security",
		"sessions", "inventory", "posture", "eventlogs", "ws-ping"}
}

func (c *Cadence) field(name string) *time.Duration {
	switch name {
	case "heartbeat":
		return &c.Heartbeat
	case "unifi":
		return &c.UnifiPoll
	case "crawl-config":
		return &c.CrawlConfig
	case "process-sample":
		return &c.ProcessSample
	case "security":
		return &c.Security
	case "sessions":
		return &c.Sessions
	case "inventory":
		return &c.Inventory
	case "posture":
		return &c.Posture
	case "eventlogs":
		return &c.EventLogs
	case "ws-ping":
		return &c.WSPing
	}
	return nil
}

// Set overrides one named cadence.
func (c *Cadence) Set(name string, d time.Duration) error {
	f := c.field(name)
	if f == nil {
		return fmt.Errorf("unknown cadence %q (known: %s)", name, strings.Join(CadenceNames(), ", "))
	}
	*f = d
	return nil
}

// Seconds renders the cadence for the run report.
func (c Cadence) Seconds() map[string]float64 {
	out := make(map[string]float64, len(CadenceNames()))
	for _, n := range CadenceNames() {
		out[n] = c.field(n).Seconds()
	}
	return out
}

// ParseCadenceOverrides applies "name=duration,name=duration".
func ParseCadenceOverrides(spec string, c *Cadence) error {
	if strings.TrimSpace(spec) == "" {
		return nil
	}
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		name, value, ok := strings.Cut(part, "=")
		if !ok {
			return fmt.Errorf("cadence override %q: want name=duration", part)
		}
		d, err := time.ParseDuration(strings.TrimSpace(value))
		if err != nil {
			return fmt.Errorf("cadence override %q: %w", part, err)
		}
		if d < 0 {
			return fmt.Errorf("cadence override %q: negative duration", part)
		}
		if err := c.Set(strings.TrimSpace(name), d); err != nil {
			return err
		}
	}
	return nil
}

// CommanderConfig drives the optional admin-side command dispatcher.
type CommanderConfig struct {
	PerMinute   float64
	Email       string
	Password    string
	CommandType string
}

// Config is one simulator run.
type Config struct {
	ServerURL         string // stack base URL; the simulator appends /api/v1
	EnrollmentKey     string
	EnrollmentSecret  string
	Agents            int
	RampPerSecond     float64
	EnrollConcurrency int
	Duration          time.Duration // whole run, from the first agent start
	Warmup            time.Duration // after the ramp, before the steady window opens
	StorePath         string
	ReportPath        string
	HostnamePrefix    string
	AgentVersion      string
	OSType            string
	StartMode         StartMode
	WSEnabled         bool
	Cadence           Cadence
	Retry             httputil.RetryConfig
	RequestTimeout    time.Duration
	CommandDelay      time.Duration
	Commander         CommanderConfig
}

// DefaultConfig is the smoke-test shape: 20 agents for 3 minutes.
func DefaultConfig() Config {
	return Config{
		Agents:            20,
		RampPerSecond:     5,
		EnrollConcurrency: 8,
		Duration:          3 * time.Minute,
		Warmup:            90 * time.Second,
		StorePath:         ".agentsim/tokens.json",
		ReportPath:        ".agentsim/report.json",
		HostnamePrefix:    "agentsim",
		AgentVersion:      "dev-agentsim", // the API never offers dev-* versions an upgrade
		OSType:            "linux",
		StartMode:         StartWarm,
		WSEnabled:         true,
		Cadence:           DefaultCadence(),
		Retry:             httputil.DefaultRetryConfig(),
		RequestTimeout:    30 * time.Second, // heartbeat.go newHeartbeatHTTPClient
		CommandDelay:      250 * time.Millisecond,
		Commander:         CommanderConfig{CommandType: "refresh_inventory"},
	}
}

var hostnamePrefixRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

// SteadyWindow is when the measured window opens and closes, from run start.
func (c Config) SteadyWindow() (open, closeAt time.Duration) {
	ramp := time.Duration(float64(c.Agents) / c.RampPerSecond * float64(time.Second))
	return ramp + c.Warmup, c.Duration
}

// Validate reports every invalid field at once.
func (c Config) Validate() error {
	var errs []error
	u, err := url.Parse(c.ServerURL)
	switch {
	case err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "":
		errs = append(errs, fmt.Errorf("--server must be an http(s) URL, got %q", c.ServerURL))
	case u.Path != "" && u.Path != "/":
		errs = append(errs, fmt.Errorf("--server is the stack base URL without a path (the simulator appends /api/v1), got %q", c.ServerURL))
	}
	if c.Agents < 1 {
		errs = append(errs, errors.New("--agents must be at least 1"))
	}
	if c.RampPerSecond <= 0 {
		errs = append(errs, errors.New("--ramp must be above 0 agents per second"))
	}
	if c.EnrollConcurrency < 1 {
		errs = append(errs, errors.New("--enroll-concurrency must be at least 1"))
	}
	if c.Duration <= 0 || c.Warmup < 0 {
		errs = append(errs, errors.New("--duration must be positive and --warmup not negative"))
	}
	if c.StorePath == "" || c.ReportPath == "" {
		errs = append(errs, errors.New("--store and --report are required"))
	}
	if c.OSType != "linux" && c.OSType != "windows" && c.OSType != "macos" {
		errs = append(errs, fmt.Errorf("--os must be linux, windows or macos, got %q", c.OSType))
	}
	if c.StartMode != StartWarm && c.StartMode != StartCold {
		errs = append(errs, fmt.Errorf("--start must be warm or cold, got %q", c.StartMode))
	}
	if !hostnamePrefixRe.MatchString(c.HostnamePrefix) {
		errs = append(errs, fmt.Errorf("--hostname-prefix must match %s, got %q", hostnamePrefixRe, c.HostnamePrefix))
	}
	if c.Cadence.Heartbeat <= 0 {
		errs = append(errs, errors.New("the heartbeat cadence cannot be disabled: it drives the tick loop every gated stream hangs off"))
	}
	if c.Commander.PerMinute < 0 {
		errs = append(errs, errors.New("--commands-per-minute cannot be negative"))
	}
	if c.Commander.PerMinute > 0 && (c.Commander.Email == "" || c.Commander.Password == "") {
		errs = append(errs, errors.New("--commands-per-minute needs --admin-email and --admin-password (or AGENTSIM_ADMIN_EMAIL / AGENTSIM_ADMIN_PASSWORD)"))
	}
	if c.RampPerSecond > 0 && c.Duration > 0 {
		if open, closeAt := c.SteadyWindow(); open >= closeAt {
			errs = append(errs, fmt.Errorf("--duration %s leaves no steady window: the ramp plus --warmup takes %s", closeAt, open))
		}
	}
	return errors.Join(errs...)
}
