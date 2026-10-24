package desktop

import (
	"errors"
	"log/slog"
	"strings"
	"sync"

	"github.com/pion/webrtc/v4"
)

// Trickle ICE for the agent's answer (#9182).
//
// StartSession returns its SDP answer a short window after the first local
// candidate so a LAN session connects fast. Anything gathered after that —
// above all a TURN relay candidate, whose Allocate round trip routinely takes
// longer than the window — used to be dropped, which is exactly the off-LAN
// case TURN exists for. iceTrickle carries those late candidates out instead:
//
//   - before the answer snapshot, candidates are part of the SDP and nothing
//     is trickled;
//   - after the snapshot, candidates (and the end-of-gathering marker) are
//     queued until the transport owner calls BeginICETrickle — the heartbeat
//     right after StartSession returns, or for a helper-hosted session the
//     service once it has recorded the helper as the session's owner;
//   - after begin, entries are emitted live, in order, each with a
//     contiguous sequence number so the viewer can tell a gap from the end.

// LocalICECandidate is one outbound trickle entry. Exactly one of Candidate
// and Complete is set.
type LocalICECandidate struct {
	// Seq numbers a session's trickle entries 0, 1, 2, … in emission order.
	// Receivers apply candidates in any order but only treat gathering as
	// over once every entry below the completion marker's Seq has arrived.
	Seq       int
	Candidate *webrtc.ICECandidateInit
	// Complete marks the end of gathering.
	Complete bool
}

// maxQueuedTrickleEntries bounds the queue held between the answer snapshot
// and BeginICETrickle. A session whose begin never comes (an older service
// driving a newer helper) must not grow it without limit. Real sessions
// queue a handful: one srflx/relay per interface and server.
const maxQueuedTrickleEntries = 32

var (
	// ErrNoICESession is returned for a remote candidate naming a session
	// this manager does not host.
	ErrNoICESession = errors.New("no desktop session for ICE candidate")
	// ErrStaleICEGeneration is returned for a remote candidate addressed to a
	// start the session has since been superseded by.
	ErrStaleICEGeneration = errors.New("ICE candidate is for a superseded desktop start")
)

type trickleState int

const (
	trickleInSDP   trickleState = iota // answer not taken yet: candidates ride the SDP
	trickleQueued                      // answer taken: queue until begin
	trickleLive                        // begun: emit as gathered
	trickleStopped                     // session gone
)

type iceTrickle struct {
	mu         sync.Mutex
	state      trickleState
	gatherDone bool
	queue      []LocalICECandidate
	nextSeq    int
	dropped    int
	emit       func(LocalICECandidate)
	generation string
}

func newICETrickle() *iceTrickle {
	return &iceTrickle{}
}

// observe is the pion OnICECandidate hook. nil means gathering is complete.
func (t *iceTrickle) observe(c *webrtc.ICECandidate) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if c == nil {
		if t.gatherDone {
			return
		}
		t.gatherDone = true
		if t.state == trickleInSDP {
			// The snapshot will carry a=end-of-candidates; see snapshot.
			return
		}
		t.enqueueLocked(LocalICECandidate{Complete: true})
		return
	}
	if t.state == trickleInSDP || t.state == trickleStopped {
		return
	}
	init := c.ToJSON()
	t.enqueueLocked(LocalICECandidate{Candidate: &init})
}

// snapshot reads the local description and moves the trickle past the answer
// in one step, so a candidate is either in the returned SDP or queued — never
// neither. (pion folds every candidate it has gathered into LocalDescription,
// so a candidate whose callback races the snapshot can at worst be both,
// which a receiver ignores.)
func (t *iceTrickle) snapshot(read func() *webrtc.SessionDescription) *webrtc.SessionDescription {
	t.mu.Lock()
	defer t.mu.Unlock()
	desc := read()
	if t.state != trickleInSDP {
		return desc
	}
	t.state = trickleQueued
	if t.gatherDone && (desc == nil || !strings.Contains(desc.SDP, "a=end-of-candidates")) {
		// Gathering finished before the snapshot but the SDP does not say so:
		// tell the receiver explicitly rather than leave it waiting.
		t.enqueueLocked(LocalICECandidate{Complete: true})
	}
	return desc
}

// begin starts emitting: the queue is flushed in order, then entries go out
// as gathered. Returns false when there is nothing to begin — before the
// snapshot, after a previous begin, after stop, or with a nil emitter.
func (t *iceTrickle) begin(emit func(LocalICECandidate)) bool {
	if emit == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state != trickleQueued {
		return false
	}
	t.state = trickleLive
	t.emit = emit
	queued := t.queue
	t.queue = nil
	if t.dropped > 0 {
		slog.Warn("ICE trickle began after dropping late candidates",
			"dropped", t.dropped, "sending", len(queued))
	}
	// Emitting under the lock keeps the flush ahead of any live entry. Both
	// emitters (a non-blocking WebSocket send, an IPC write) are short, and
	// the only other contender is pion's serial candidate callback.
	for _, entry := range queued {
		emit(entry)
	}
	return true
}

// bind records the start generation this session trickles for. Remote
// candidates naming another generation are refused.
func (t *iceTrickle) bind(generation string) {
	t.mu.Lock()
	t.generation = generation
	t.mu.Unlock()
}

func (t *iceTrickle) boundGeneration() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.generation
}

// stop discards the queue and releases the emitter.
func (t *iceTrickle) stop() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state == trickleQueued && len(t.queue) > 0 {
		// Never begun: these candidates were gathered and never sent.
		slog.Info("desktop session ended before its late ICE candidates were sent",
			"unsent", len(t.queue), "dropped", t.dropped)
	}
	t.state = trickleStopped
	t.queue = nil
	t.emit = nil
}

func (t *iceTrickle) enqueueLocked(entry LocalICECandidate) {
	if t.state == trickleLive && t.emit != nil {
		entry.Seq = t.nextSeq
		t.nextSeq++
		t.emit(entry)
		return
	}
	// The completion marker always fits: without it a receiver that gets
	// this queue waits out its whole window. Dropped candidates take no seq,
	// so the sequence stays contiguous.
	if !entry.Complete && len(t.queue) >= maxQueuedTrickleEntries {
		t.dropped++
		if t.dropped == 1 {
			slog.Warn("ICE trickle queue full before the answer was delivered; dropping late candidates",
				"limit", maxQueuedTrickleEntries)
		}
		return
	}
	entry.Seq = t.nextSeq
	t.nextSeq++
	t.queue = append(t.queue, entry)
}

// BeginICETrickle starts sending the session's late local candidates to
// OnLocalICECandidate, tagged with startGeneration. Call it once the answer
// has been handed to its transport. Returns false when the session is
// unknown, has no answer yet, already began, or no emitter is registered.
func (m *SessionManager) BeginICETrickle(sessionID, startGeneration string) bool {
	emit := m.OnLocalICECandidate
	if emit == nil {
		return false
	}
	m.mu.RLock()
	s := m.sessions[sessionID]
	m.mu.RUnlock()
	if s == nil || s.trickle == nil {
		return false
	}
	s.trickle.bind(startGeneration)
	return s.trickle.begin(func(c LocalICECandidate) {
		emit(sessionID, startGeneration, c)
	})
}

// AddRemoteICECandidate applies a viewer candidate that arrived after the
// offer (#9182). A non-empty startGeneration must match the generation the
// session began trickling under; a mismatch is a candidate for a start this
// session has replaced.
func (m *SessionManager) AddRemoteICECandidate(sessionID, startGeneration string, c webrtc.ICECandidateInit) error {
	m.mu.RLock()
	s := m.sessions[sessionID]
	m.mu.RUnlock()
	if s == nil || s.peerConn == nil {
		return ErrNoICESession
	}
	if startGeneration != "" && s.trickle != nil {
		if bound := s.trickle.boundGeneration(); bound != "" && bound != startGeneration {
			return ErrStaleICEGeneration
		}
	}
	return s.peerConn.AddICECandidate(c)
}
