// Package parked tracks whether this device is parked in its partner's
// holding area: enrolled (typically with an image deploy key) but not yet
// assigned to a customer organization (#8318 wave D-1a).
//
// While parked the server confines the agent to a short allow-list
// (heartbeat, command poll and result, token rotation, uninstall intent,
// rebind, TPM attestation) and answers everything else with HTTP 403
// {"error":"device_pending_assignment"}; the WebSocket upgrade is refused too.
// The loops that cannot succeed read this state and suspend themselves
// instead of being refused on their own cadence. Leaving the state wakes them
// at once.
//
// Signals, in order of authority:
//
//   - The heartbeat. The parked (minimal) beat carries `parked: true`; the
//     full beat never carries it, so a successful beat without the field
//     means the device is assigned. This is the only way out of the state.
//   - A refusal: a 403 whose body names device_pending_assignment, on any
//     route. It enters the state at once, so nothing waits for the next beat.
//
// A server older than the field never says `parked: true`, and its parked
// beat looks like a full one. A state entered by a refusal and contradicted
// by the very next beat, from a server that has not sent the field in this
// process, therefore mutes the refusal signal until the field is seen: against
// such a server the agent behaves as it did before parked mode existed
// instead of flapping in and out of it on every beat.
//
// This package imports only the standard library, so the logging, websocket,
// unifi and workspace packages can read it without an import cycle. It never
// logs: the owner of the transitions (the heartbeat) logs one line on each.
package parked

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"
)

// RefusalCode is the error the server returns, with HTTP 403, for any route a
// parked device may not call (apps/api/src/middleware/agentAuthParked.ts,
// PARKED_DEVICE_REFUSAL), including the WebSocket upgrade.
const RefusalCode = "device_pending_assignment"

// RefusalHeader names the same refusal on an answer that cannot carry a body:
// a refused WebSocket upgrade, which the server writes as a bare status line
// (Content-Length: 0) with this header set to RefusalCode.
const RefusalHeader = "X-Breeze-Refusal"

// Source names the signal that entered the parked state.
type Source string

const (
	// SourceHeartbeat: a heartbeat response carried `parked: true`.
	SourceHeartbeat Source = "heartbeat"
	// SourceRefusal: a request was refused with RefusalCode.
	SourceRefusal Source = "refusal"
)

// Transition is the change an observation caused.
type Transition int

const (
	// None: the observation changed nothing.
	None Transition = iota
	// Entered: the device is now parked.
	Entered
	// Left: the device is no longer parked (it was assigned).
	Left
)

func (t Transition) String() string {
	switch t {
	case Entered:
		return "entered"
	case Left:
		return "left"
	default:
		return "none"
	}
}

// Event describes one observation's effect.
type Event struct {
	Transition Transition
	// Source is what entered the state (Entered), or what had entered it
	// (Left).
	Source Source
	// ParkedFor is how long the state lasted; set on Left only.
	ParkedFor time.Duration
	// RefusalMuted reports, on Left, that the refusal signal is now muted:
	// the state was entered by a refusal and the server's beat does not
	// carry the field.
	RefusalMuted bool
}

// State is the process-wide parked flag. The zero value is not usable; call
// New. Every method is safe on a nil *State, which reads as never parked and
// ignores observations, so a component wired without one behaves as before.
type State struct {
	// transitionMu serialises observations together with their observer
	// call, so the observer sees transitions in the order they happened.
	transitionMu sync.Mutex

	mu      sync.Mutex
	parked  bool
	source  Source
	since   time.Time
	changed chan struct{}
	// beatConfirmed: some heartbeat in this process carried `parked: true`,
	// so this server speaks the field and its absence means assigned.
	beatConfirmed bool
	// refusalMuted: see the package comment. Cleared when a beat carries the
	// field.
	refusalMuted bool

	observer func(Event)
	now      func() time.Time
}

// New returns a State that is not parked.
func New() *State {
	return &State{changed: make(chan struct{}), now: time.Now}
}

// SetObserver installs fn, called once per transition (never for None),
// synchronously, from the goroutine that made the observation. It must not
// block and must not call ObserveBeat or NoteRefusal. Install it before the
// state is shared.
func (s *State) SetObserver(fn func(Event)) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.observer = fn
	s.mu.Unlock()
}

// Parked reports whether the device is parked now.
func (s *State) Parked() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.parked
}

// Changed returns a channel that is closed at the next transition (either
// way). Take it before reading Parked, then wait on it: a transition in
// between closes the channel already taken, so no change is missed. A nil
// State returns nil, which blocks forever in a select.
func (s *State) Changed() <-chan struct{} {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.changed
}

// ObserveBeat records a successful heartbeat response and whether it carried
// `parked: true`.
func (s *State) ObserveBeat(parked bool) Event {
	if s == nil {
		return Event{}
	}
	s.transitionMu.Lock()
	defer s.transitionMu.Unlock()

	s.mu.Lock()
	var ev Event
	if parked {
		s.beatConfirmed = true
		s.refusalMuted = false
		if s.parked {
			// A refusal got here first; the beat now vouches for it.
			s.source = SourceHeartbeat
		} else {
			ev = s.enterLocked(SourceHeartbeat)
		}
	} else if s.parked {
		ev = s.leaveLocked()
		if ev.Source == SourceRefusal && !s.beatConfirmed {
			s.refusalMuted = true
			ev.RefusalMuted = true
		}
	}
	observer := s.observer
	s.mu.Unlock()

	if ev.Transition != None && observer != nil {
		observer(ev)
	}
	return ev
}

// NoteRefusal records that a request was refused with RefusalCode.
func (s *State) NoteRefusal() Event {
	if s == nil {
		return Event{}
	}
	s.transitionMu.Lock()
	defer s.transitionMu.Unlock()

	s.mu.Lock()
	var ev Event
	if !s.parked && !s.refusalMuted {
		ev = s.enterLocked(SourceRefusal)
	}
	observer := s.observer
	s.mu.Unlock()

	if ev.Transition != None && observer != nil {
		observer(ev)
	}
	return ev
}

func (s *State) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *State) enterLocked(src Source) Event {
	s.parked = true
	s.source = src
	s.since = s.clock()
	s.signalLocked()
	return Event{Transition: Entered, Source: src}
}

func (s *State) leaveLocked() Event {
	ev := Event{Transition: Left, Source: s.source, ParkedFor: s.clock().Sub(s.since)}
	s.parked = false
	s.source = ""
	s.since = time.Time{}
	s.signalLocked()
	return ev
}

func (s *State) signalLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

// maxRefusalBody bounds how much of a 403 body is read to classify it. The
// refusal body is a few dozen bytes.
const maxRefusalBody = 1024

// IsRefusalBody reports whether body is the parked refusal
// {"error":"device_pending_assignment"} (other keys are tolerated).
func IsRefusalBody(body []byte) bool {
	if !bytes.Contains(body, []byte(RefusalCode)) {
		return false
	}
	var parsed struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &parsed) != nil {
		return false
	}
	return parsed.Error == RefusalCode
}

// IsRefusal reports whether resp is a 403 carrying the parked refusal, either
// as RefusalHeader (the WebSocket upgrade) or as the JSON body (every REST
// route). It reads at most 1 KiB of the body and puts it back, so the caller
// can still read the whole body afterwards.
func IsRefusal(resp *http.Response) bool {
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		return false
	}
	if resp.Header.Get(RefusalHeader) == RefusalCode {
		return true
	}
	if resp.Body == nil {
		return false
	}
	peeked, err := io.ReadAll(io.LimitReader(resp.Body, maxRefusalBody))
	resp.Body = replayBody{Reader: io.MultiReader(bytes.NewReader(peeked), resp.Body), Closer: resp.Body}
	if err != nil {
		return false
	}
	return IsRefusalBody(peeked)
}

type replayBody struct {
	io.Reader
	io.Closer
}

// Transport notes a parked refusal on any response that passes through it.
// It changes nothing else about the request or the response.
type Transport struct {
	Base  http.RoundTripper
	State *State
}

// RoundTrip implements http.RoundTripper.
func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	resp, err := base.RoundTrip(req)
	if err == nil && t.State != nil && IsRefusal(resp) {
		t.State.NoteRefusal()
	}
	return resp, err
}

// WrapClient returns a copy of c whose transport notes parked refusals into
// st. A nil st returns c unchanged.
func WrapClient(c *http.Client, st *State) *http.Client {
	if c == nil || st == nil {
		return c
	}
	wrapped := *c
	wrapped.Transport = &Transport{Base: c.Transport, State: st}
	return &wrapped
}
