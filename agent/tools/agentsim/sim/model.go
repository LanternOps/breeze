package sim

import "time"

func perMinuteOf(d time.Duration) float64 {
	if d <= 0 {
		return 0
	}
	return float64(time.Minute) / float64(d)
}

// ExpectedPerAgentMinute is the steady-state request rate per route that c
// implies for one agent. Streams gated on the heartbeat tick fire when
// `now.Sub(last) > period` with `now` read after the heartbeat returns, so a
// period that is a whole number of ticks fires on tick n or n+1 about equally
// often: mean interval period + tick/2. crawlConfigAbsent is true when the
// stack 404s crawl-config (workspace module not loaded), after which the
// agent stops polling for six hours.
func ExpectedPerAgentMinute(c Cadence, crawlConfigAbsent bool) map[string]float64 {
	gated := func(p time.Duration) float64 {
		if p <= 0 || c.Heartbeat <= 0 {
			return 0
		}
		return perMinuteOf(p + c.Heartbeat/2)
	}
	m := map[string]float64{
		RouteHeartbeat:     perMinuteOf(c.Heartbeat),
		RouteUnifi:         perMinuteOf(c.UnifiPoll),
		RouteProcessSample: perMinuteOf(c.ProcessSample),
		RouteSecurity:      gated(c.Security),
		RouteSessions:      gated(c.Sessions),
		RoutePosture:       gated(c.Posture),
		RouteEventLogs:     gated(c.EventLogs),
		RouteCrawlConfig:   0,
	}
	for _, r := range InventoryBatchRoutes {
		m[r] = gated(c.Inventory)
	}
	if !crawlConfigAbsent {
		m[RouteCrawlConfig] = perMinuteOf(c.CrawlConfig)
	}
	return m
}
