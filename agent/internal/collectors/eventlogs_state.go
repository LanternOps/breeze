package collectors

import "log/slog"

// eventLogStateTransition warns only on entering an unhealthy state; callers
// retain the active state under c.mu and log repeats and recoveries at Info.
func eventLogStateTransition(previous, active bool) (warn, recovered bool) {
	return !previous && active, previous && !active
}

// updateEventLogStreamState must be called under c.mu.
func updateEventLogStreamState(states *map[string]bool, key string, active bool) (warn, recovered bool) {
	warn, recovered = eventLogStateTransition((*states)[key], active)
	if active {
		if *states == nil {
			*states = make(map[string]bool)
		}
		(*states)[key] = true
	} else {
		delete(*states, key)
	}
	return warn, recovered
}

func (c *EventLogCollector) logWindowsQueryResultLocked(key string, err error) {
	warn, recovered := updateEventLogStreamState(&c.failing, key, err != nil)
	if err != nil {
		logFailure := slog.Info
		if warn {
			logFailure = slog.Warn
		}
		logFailure("event log query failed; bookmark not advanced", "collector", c.name, "stream", key, "error", err)
	} else if recovered {
		slog.Info("event log query recovered", "collector", c.name, "stream", key)
	}
}
