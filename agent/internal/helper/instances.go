package helper

import (
	"sort"
	"time"
)

// helperInstance is one running Breeze Assist (breeze-helper) process found by
// scanning the OS process table, independent of anything this agent process
// remembers about what it spawned.
type helperInstance struct {
	PID        int
	SessionKey string
	Created    time.Time
}

// listHelperInstancesFunc enumerates every running process whose image is the
// installed helper binary (full-path match, not just the file name), with the
// session it runs in. Swappable for tests. On platforms without an
// implementation it returns (nil, nil), which turns every caller into a no-op.
var listHelperInstancesFunc = listHelperInstances

// helperInstancesInSession returns the running helper processes in the given
// session. It never matches session "0"/"" — Assist never legitimately runs in
// the services session, and an empty key would otherwise mean "every session".
// An enumeration failure is logged and reported as "none found" so callers
// degrade to their pre-sweep, PID-only behaviour rather than failing.
func (m *Manager) helperInstancesInSession(sessionKey string) []helperInstance {
	if sessionKey == "" || sessionKey == "0" {
		return nil
	}
	all, err := listHelperInstancesFunc(m.binaryPath)
	if err != nil {
		log.Warn("failed to enumerate breeze assist processes", "session", sessionKey, "error", err.Error())
		return nil
	}
	var out []helperInstance
	for _, inst := range all {
		if inst.PID > 0 && inst.SessionKey == sessionKey {
			out = append(out, inst)
		}
	}
	return out
}

// pickHelperKeeper chooses which of several helper instances in one session
// survives a duplicate sweep. Preference order:
//  1. the PID the helper itself last wrote to helper_status.yaml (the instance
//     that owns the status file, and so the one whose chat state the agent
//     reads before restarting or updating),
//  2. the PID this agent process spawned directly,
//  3. otherwise the oldest instance (lowest PID breaks ties), so repeated
//     sweeps converge on the same survivor instead of churning.
func pickHelperKeeper(instances []helperInstance, statusPID, spawnedPID int) helperInstance {
	for _, preferred := range []int{statusPID, spawnedPID} {
		if preferred <= 0 {
			continue
		}
		for _, inst := range instances {
			if inst.PID == preferred {
				return inst
			}
		}
	}
	sorted := append([]helperInstance(nil), instances...)
	sort.Slice(sorted, func(i, j int) bool {
		if !sorted[i].Created.Equal(sorted[j].Created) {
			return sorted[i].Created.Before(sorted[j].Created)
		}
		return sorted[i].PID < sorted[j].PID
	})
	return sorted[0]
}

// reapDuplicateHelpersLocked enforces "at most one Breeze Assist per managed
// session" (#6251). Every spawn path checks for a running helper before
// launching one, but nothing ever removed extras once they existed — so any
// instance that slipped past that check (a spawn racing a slow start, an MSI
// Restart Manager relaunch, a helper started outside the agent) survived for
// the life of the login session and accumulated across agent restarts.
//
// Deferred while a chat is active so a sweep can never kill the window the
// user is typing in; the next idle tick finishes the job. Returns the number
// of instances terminated.
//
// Must be called with m.mu held.
func (m *Manager) reapDuplicateHelpersLocked(state *sessionState) int {
	instances := m.helperInstancesInSession(state.key)
	if len(instances) <= 1 {
		return 0
	}
	if !IsIdle(state.configPath) {
		log.Debug("deferring duplicate breeze assist sweep until idle; chat active",
			"session", state.key, "instances", len(instances))
		return 0
	}

	keeper := pickHelperKeeper(instances, state.pid, state.spawnedPID)
	var reaped []int
	for _, inst := range instances {
		if inst.PID == keeper.PID {
			continue
		}
		// stopIfOursFunc re-verifies the image path on the same handle it
		// terminates with, so a PID recycled since the scan is never killed.
		killed, err := m.stopIfOursFunc(inst.PID, m.binaryPath)
		if err != nil {
			log.Warn("failed to terminate duplicate breeze assist",
				"session", state.key, "pid", inst.PID, "error", err.Error())
			continue
		}
		if killed {
			reaped = append(reaped, inst.PID)
			if state.spawnedPID == inst.PID {
				state.spawnedPID = 0
			}
			if state.pid == inst.PID {
				state.pid = 0
			}
		}
	}
	if len(reaped) > 0 {
		log.Warn("terminated duplicate breeze assist instances",
			"session", state.key,
			"keptPid", keeper.PID,
			"reapedPids", reaped,
			"found", len(instances),
		)
	}
	return len(reaped)
}
