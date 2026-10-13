package sim

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"time"
)

// Duration is a time.Duration that reads and writes as a Go duration string
// ("3m", "5s") in scenario files.
type Duration struct{ D time.Duration }

func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("duration must be a quoted string like \"3m\": %w", err)
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return err
	}
	if v < 0 {
		return fmt.Errorf("duration %q is negative", s)
	}
	d.D = v
	return nil
}

func (d Duration) MarshalJSON() ([]byte, error) { return json.Marshal(d.D.String()) }

// ActionDropSockets is the internal action that closes every simulated agent
// socket at once (sockethub.go).
const ActionDropSockets = "drop-sockets"

var internalActions = map[string]bool{ActionDropSockets: true}

// preWindow is the baseline window before each event's start: the reconnect
// curve's baseline is the mean live-socket count over it.
const preWindow = 60 * time.Second

// defaultRecovery applies when an event omits recovery.
const defaultRecovery = 3 * time.Minute

// stormVarRe is the only shape of ${VAR} a scenario may expand.
var stormVarRe = regexp.MustCompile(`^STORM_[A-Z0-9_]+$`)

// Action is one step of an event: a docker argv (never a shell) or a named
// internal action.
type Action struct {
	Exec     []string `json:"exec,omitempty"`
	Internal string   `json:"internal,omitempty"`
}

// Event is one fault: start actions at At (from the steady-window open), end
// actions Hold later, then a Recovery window that is still measured.
type Event struct {
	Name     string   `json:"name"`
	At       Duration `json:"at"`
	Hold     Duration `json:"hold"`
	Recovery Duration `json:"recovery"`
	Start    []Action `json:"start"`
	End      []Action `json:"end,omitempty"`
}

// Scenario is one committed storm file (load-tests/agentsim/storms/*.json).
type Scenario struct {
	Name        string  `json:"name"`
	Description string  `json:"description,omitempty"`
	Events      []Event `json:"events"`
}

// LoadScenario reads, expands and validates a scenario file. lookup is
// os.LookupEnv in production. Only ${STORM_*} names expand, and an unset or
// empty one is an error: a bare "docker kill" with no container must be
// impossible.
func LoadScenario(path string, lookup func(string) (string, bool)) (Scenario, error) {
	var sc Scenario
	f, err := os.Open(path)
	if err != nil {
		return sc, err
	}
	defer func() { _ = f.Close() }()
	dec := json.NewDecoder(f)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&sc); err != nil {
		return sc, fmt.Errorf("%s: %w", path, err)
	}
	if err := sc.expand(lookup); err != nil {
		return sc, fmt.Errorf("%s: %w", path, err)
	}
	if err := sc.validate(preWindow); err != nil {
		return sc, fmt.Errorf("%s: %w", path, err)
	}
	return sc, nil
}

func (sc *Scenario) expand(lookup func(string) (string, bool)) error {
	var errs []error
	for ei := range sc.Events {
		ev := &sc.Events[ei]
		for _, list := range [][]Action{ev.Start, ev.End} {
			for ai := range list {
				for i, arg := range list[ai].Exec {
					list[ai].Exec[i] = os.Expand(arg, func(name string) string {
						if !stormVarRe.MatchString(name) {
							errs = append(errs, fmt.Errorf("event %q: ${%s} is not allowed: only STORM_* variables expand", ev.Name, name))
							return ""
						}
						v, ok := lookup(name)
						if !ok || v == "" {
							errs = append(errs, fmt.Errorf("event %q: ${%s} is unset or empty", ev.Name, name))
							return ""
						}
						return v
					})
				}
			}
		}
	}
	return errors.Join(errs...)
}

func validateAction(ev string, a Action) error {
	switch {
	case len(a.Exec) > 0 && a.Internal != "":
		return fmt.Errorf("event %q: an action is either exec or internal, not both", ev)
	case a.Internal != "":
		if !internalActions[a.Internal] {
			return fmt.Errorf("event %q: unknown internal action %q", ev, a.Internal)
		}
	case len(a.Exec) == 0:
		return fmt.Errorf("event %q: an action needs exec or internal", ev)
	case a.Exec[0] != "docker":
		return fmt.Errorf("event %q: exec must run docker, got %q", ev, a.Exec[0])
	}
	return nil
}

// validate applies the default recovery, sorts events by At and checks that
// every event's pre window starts after the previous event's recovery ends.
func (sc *Scenario) validate(pre time.Duration) error {
	var errs []error
	if sc.Name == "" {
		errs = append(errs, errors.New("scenario needs a name"))
	}
	if len(sc.Events) == 0 {
		errs = append(errs, errors.New("scenario needs at least one event"))
	}
	names := map[string]bool{}
	for i := range sc.Events {
		ev := &sc.Events[i]
		if names[ev.Name] {
			errs = append(errs, fmt.Errorf("event name %q is used twice: each event's phases are reported by name", ev.Name))
		}
		names[ev.Name] = true
		if ev.Recovery.D == 0 {
			ev.Recovery.D = defaultRecovery
		}
		if ev.Name == "" {
			errs = append(errs, fmt.Errorf("event %d needs a name", i))
		}
		if len(ev.Start) == 0 {
			errs = append(errs, fmt.Errorf("event %q needs at least one start action", ev.Name))
		}
		for _, list := range [][]Action{ev.Start, ev.End} {
			for _, a := range list {
				if err := validateAction(ev.Name, a); err != nil {
					errs = append(errs, err)
				}
			}
		}
	}
	sort.SliceStable(sc.Events, func(i, j int) bool { return sc.Events[i].At.D < sc.Events[j].At.D })
	for i, ev := range sc.Events {
		if i == 0 {
			if ev.At.D < pre {
				errs = append(errs, fmt.Errorf("event %q at %s: its %s pre window would start before the steady window opens", ev.Name, ev.At.D, pre))
			}
			continue
		}
		prev := sc.Events[i-1]
		if prevEnd := prev.At.D + prev.Hold.D + prev.Recovery.D; ev.At.D-pre < prevEnd {
			errs = append(errs, fmt.Errorf("event %q at %s: its %s pre window overlaps %q, whose recovery ends at %s",
				ev.Name, ev.At.D, pre, prev.Name, prevEnd))
		}
	}
	return errors.Join(errs...)
}

// End is when the last event's recovery ends, from the steady-window open.
func (sc Scenario) End() time.Duration {
	var end time.Duration
	for _, ev := range sc.Events {
		if e := ev.At.D + ev.Hold.D + ev.Recovery.D; e > end {
			end = e
		}
	}
	return end
}

// FitsWindow reports whether the last recovery ends inside a steady window
// of the given length.
func (sc Scenario) FitsWindow(window time.Duration) error {
	if end := sc.End(); end > window {
		return fmt.Errorf("scenario %q needs %s of steady window (last event + hold + recovery), the run has %s", sc.Name, end, window)
	}
	return nil
}
