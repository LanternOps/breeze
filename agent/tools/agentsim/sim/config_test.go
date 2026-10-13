package sim

import (
	"strings"
	"testing"
	"time"
)

func validConfig() Config {
	c := DefaultConfig()
	c.ServerURL = "http://localhost:8080"
	return c
}

func TestDefaultCadenceMirrorsTheAgent(t *testing.T) {
	c := DefaultCadence()
	for name, tc := range map[string]struct{ got, want time.Duration }{
		"heartbeat":      {c.Heartbeat, 60 * time.Second},
		"unifi":          {c.UnifiPoll, 30 * time.Second},
		"process-sample": {c.ProcessSample, 180 * time.Second},
		"security":       {c.Security, 5 * time.Minute},
		"inventory":      {c.Inventory, 15 * time.Minute},
		"ws-ping":        {c.WSPing, 54 * time.Second},
	} {
		if tc.got != tc.want {
			t.Errorf("%s cadence = %s, want %s", name, tc.got, tc.want)
		}
	}
}

func TestParseCadenceOverrides(t *testing.T) {
	c := DefaultCadence()
	if err := ParseCadenceOverrides("heartbeat=30s, inventory=0", &c); err != nil {
		t.Fatal(err)
	}
	if c.Heartbeat != 30*time.Second || c.Inventory != 0 {
		t.Fatalf("overrides not applied: %+v", c)
	}
	for spec, want := range map[string]string{
		"nope=1s":       "unknown cadence",
		"heartbeat":     "want name=duration",
		"heartbeat=abc": "invalid duration",
		"security=-1s":  "negative",
	} {
		err := ParseCadenceOverrides(spec, &c)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("ParseCadenceOverrides(%q) = %v, want error containing %q", spec, err, want)
		}
	}
}

func TestValidateAcceptsTheDefaultsWithAServer(t *testing.T) {
	if err := validConfig().Validate(); err != nil {
		t.Fatalf("default config with a server URL must be valid: %v", err)
	}
}

func TestValidateRejectsBadInput(t *testing.T) {
	for name, tc := range map[string]struct {
		mutate func(*Config)
		want   string
	}{
		"no server":        {func(c *Config) { c.ServerURL = "" }, "--server"},
		"server with path": {func(c *Config) { c.ServerURL = "http://x/api" }, "without a path"},
		"zero agents":      {func(c *Config) { c.Agents = 0 }, "--agents"},
		"zero ramp":        {func(c *Config) { c.RampPerSecond = 0 }, "--ramp"},
		"bad os":           {func(c *Config) { c.OSType = "beos" }, "--os"},
		"bad start":        {func(c *Config) { c.StartMode = "lukewarm" }, "--start"},
		"bad prefix":       {func(c *Config) { c.HostnamePrefix = "Sim_01" }, "--hostname-prefix"},
		"no heartbeat":     {func(c *Config) { c.Cadence.Heartbeat = 0 }, "heartbeat cadence"},
		"commander no creds": {func(c *Config) {
			c.Commander.PerMinute = 10
			c.Commander.Email = ""
		}, "--admin-email"},
	} {
		c := validConfig()
		tc.mutate(&c)
		err := c.Validate()
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: Validate() = %v, want error containing %q", name, err, tc.want)
		}
	}
}

func TestValidateRejectsAStormThatOverrunsTheWindow(t *testing.T) {
	c := validConfig()
	c.Duration, c.Warmup = 5*time.Minute, 0
	c.Storm = &Scenario{Name: "x", Events: []Event{{Name: "e", At: Duration{3 * time.Minute}, Recovery: Duration{3 * time.Minute},
		Start: []Action{{Internal: ActionDropSockets}}}}}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "storm") {
		t.Fatalf("want a storm-fit error, got %v", err)
	}
}

func TestValidateStormAndScrapeFields(t *testing.T) {
	for name, tc := range map[string]struct {
		mutate func(*Config)
		want   string
	}{
		"legacy fraction":  {func(c *Config) { c.LegacyRetryFraction = 1.5 }, "--legacy-retry-fraction"},
		"scrape interval":  {func(c *Config) { c.ScrapeToken, c.ScrapeInterval = "tok", 100 * ms }, "--scrape-interval"},
		"timeline step":    {func(c *Config) { c.Timeline, c.TimelineStep = true, 0 }, "timeline step"},
		"negative gate":    {func(c *Config) { c.Gates.LostPct = -1 }, "--gate-lost-pct"},
		"scrape url shape": {func(c *Config) { c.ScrapeToken, c.ScrapeURL = "tok", "ftp://x" }, "--scrape-url"},
	} {
		c := validConfig()
		tc.mutate(&c)
		err := c.Validate()
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: Validate() = %v, want error containing %q", name, err, tc.want)
		}
	}
}

func TestValidateRejectsDurationInsideRampAndWarmup(t *testing.T) {
	c := validConfig()
	c.Agents, c.RampPerSecond, c.Warmup = 600, 5, 90*time.Second // ramp 120 s + warmup 90 s
	c.Duration = 200 * time.Second
	err := c.Validate()
	if err == nil || !strings.Contains(err.Error(), "steady window") {
		t.Fatalf("Validate() = %v, want a steady-window error", err)
	}
	open, closeAt := c.SteadyWindow()
	if open != 210*time.Second || closeAt != 200*time.Second {
		t.Fatalf("SteadyWindow() = %s, %s", open, closeAt)
	}
}
