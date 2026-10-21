package desktop

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// #9182: the agent answered 500 ms after its first candidate and never sent
// another, so a TURN relay candidate allocated after the answer was dropped.
// These tests pin the trickle state machine that now carries those late
// candidates to the viewer.

func testHostCandidate(port uint16) *webrtc.ICECandidate {
	return &webrtc.ICECandidate{
		Foundation: "1",
		Priority:   2130706431,
		Address:    "192.0.2.10",
		Protocol:   webrtc.ICEProtocolUDP,
		Port:       port,
		Typ:        webrtc.ICECandidateTypeHost,
		Component:  1,
	}
}

func testRelayCandidate(port uint16) *webrtc.ICECandidate {
	return &webrtc.ICECandidate{
		Foundation:     "9",
		Priority:       16777215,
		Address:        "198.51.100.7",
		Protocol:       webrtc.ICEProtocolUDP,
		Port:           port,
		Typ:            webrtc.ICECandidateTypeRelay,
		Component:      1,
		RelatedAddress: "203.0.113.5",
		RelatedPort:    50000,
	}
}

type trickleRecorder struct {
	mu  sync.Mutex
	got []LocalICECandidate
}

func (r *trickleRecorder) emit(c LocalICECandidate) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got = append(r.got, c)
}

func (r *trickleRecorder) snapshot() []LocalICECandidate {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]LocalICECandidate(nil), r.got...)
}

func sdpDesc(sdp string) func() *webrtc.SessionDescription {
	return func() *webrtc.SessionDescription {
		return &webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}
	}
}

func TestICETrickle_CandidatesBeforeTheAnswerAreNotTrickled(t *testing.T) {
	tr := newICETrickle()
	tr.observe(testHostCandidate(1000)) // in the answer SDP already
	tr.snapshot(sdpDesc("v=0\r\n"))
	rec := &trickleRecorder{}
	if !tr.begin(rec.emit) {
		t.Fatal("begin after snapshot must start trickling")
	}
	if got := rec.snapshot(); len(got) != 0 {
		t.Fatalf("a candidate gathered before the answer snapshot is already in the SDP; trickled %d", len(got))
	}
}

func TestICETrickle_CandidateGatheredAfterTheAnswerIsTrickled(t *testing.T) {
	tr := newICETrickle()
	tr.observe(testHostCandidate(1000))
	tr.snapshot(sdpDesc("v=0\r\n"))

	// Gathered after the answer was taken but before the transport owner has
	// delivered it: queued, not lost.
	tr.observe(testRelayCandidate(3478))

	rec := &trickleRecorder{}
	tr.begin(rec.emit)
	// Gathered after trickling began: emitted live.
	tr.observe(testRelayCandidate(3479))
	tr.observe(nil) // end of gathering

	got := rec.snapshot()
	if len(got) != 3 {
		t.Fatalf("want 2 relay candidates + completion, got %d: %#v", len(got), got)
	}
	for i, c := range got {
		if c.Seq != i {
			t.Fatalf("entry %d has seq %d; sequence numbers must be contiguous from 0", i, c.Seq)
		}
	}
	if got[0].Candidate == nil || !strings.Contains(got[0].Candidate.Candidate, "3478") || !strings.Contains(got[0].Candidate.Candidate, "typ relay") {
		t.Fatalf("first trickled entry should be the queued relay candidate, got %#v", got[0].Candidate)
	}
	if got[1].Candidate == nil || !strings.Contains(got[1].Candidate.Candidate, "3479") {
		t.Fatalf("second trickled entry should be the live relay candidate, got %#v", got[1].Candidate)
	}
	if !got[2].Complete || got[2].Candidate != nil {
		t.Fatalf("last entry must be the completion marker, got %#v", got[2])
	}
}

func TestICETrickle_NothingIsEmittedUntilBegin(t *testing.T) {
	tr := newICETrickle()
	tr.snapshot(sdpDesc("v=0\r\n"))
	tr.observe(testRelayCandidate(3478))
	// The helper only starts trickling once the service has recorded it as
	// the session owner; before that every entry stays queued.
	if tr.begin(nil) {
		t.Fatal("begin with a nil emitter must refuse")
	}
	rec := &trickleRecorder{}
	if !tr.begin(rec.emit) {
		t.Fatal("begin must succeed once")
	}
	if tr.begin(rec.emit) {
		t.Fatal("a second begin must be a no-op")
	}
	if got := rec.snapshot(); len(got) != 1 {
		t.Fatalf("queued candidate flushed %d times, want exactly once", len(got))
	}
}

func TestICETrickle_BeginBeforeSnapshotIsRefused(t *testing.T) {
	tr := newICETrickle()
	rec := &trickleRecorder{}
	if tr.begin(rec.emit) {
		t.Fatal("begin before the answer exists must refuse")
	}
}

func TestICETrickle_GatheringCompleteBeforeTheAnswerSendsNoMarker(t *testing.T) {
	tr := newICETrickle()
	tr.observe(testHostCandidate(1000))
	tr.observe(nil)
	// pion writes a=end-of-candidates into a snapshot taken after gathering
	// completed, so the viewer already knows there is nothing more.
	tr.snapshot(sdpDesc("v=0\r\na=end-of-candidates\r\n"))
	rec := &trickleRecorder{}
	tr.begin(rec.emit)
	if got := rec.snapshot(); len(got) != 0 {
		t.Fatalf("no trickle expected when the answer already ends the candidates, got %#v", got)
	}
}

func TestICETrickle_GatheringCompleteButSnapshotWithoutMarkerStillSignalsCompletion(t *testing.T) {
	tr := newICETrickle()
	tr.observe(nil)
	tr.snapshot(sdpDesc("v=0\r\n"))
	rec := &trickleRecorder{}
	tr.begin(rec.emit)
	got := rec.snapshot()
	if len(got) != 1 || !got[0].Complete {
		t.Fatalf("a viewer told nothing must still learn gathering is over, got %#v", got)
	}
}

func TestICETrickle_GatheringCompletingBetweenSnapshotAndBeginIsSignalled(t *testing.T) {
	tr := newICETrickle()
	tr.snapshot(sdpDesc("v=0\r\n"))
	tr.observe(nil)
	rec := &trickleRecorder{}
	tr.begin(rec.emit)
	got := rec.snapshot()
	if len(got) != 1 || !got[0].Complete {
		t.Fatalf("completion between the snapshot and begin must be queued, got %#v", got)
	}
}

// An older service never sends begin, so the queue can fill; the completion
// marker must still fit, or a viewer that later gets the queue waits out its
// whole window.
func TestICETrickle_CompletionMarkerSurvivesAFullQueue(t *testing.T) {
	tr := newICETrickle()
	tr.snapshot(sdpDesc("v=0\r\n"))
	for i := 0; i < maxQueuedTrickleEntries+5; i++ {
		tr.observe(testHostCandidate(uint16(2000 + i)))
	}
	tr.observe(nil)
	rec := &trickleRecorder{}
	tr.begin(rec.emit)
	got := rec.snapshot()
	if len(got) == 0 || !got[len(got)-1].Complete {
		t.Fatalf("completion marker dropped by a full queue; got %d entries", len(got))
	}
	for i, c := range got {
		if c.Seq != i {
			t.Fatalf("entry %d has seq %d; a dropped candidate must not leave a seq gap", i, c.Seq)
		}
	}
}

func TestICETrickle_QueueIsBounded(t *testing.T) {
	tr := newICETrickle()
	tr.snapshot(sdpDesc("v=0\r\n"))
	for i := 0; i < maxQueuedTrickleEntries+10; i++ {
		tr.observe(testHostCandidate(uint16(2000 + i)))
	}
	rec := &trickleRecorder{}
	tr.begin(rec.emit)
	if got := rec.snapshot(); len(got) != maxQueuedTrickleEntries {
		t.Fatalf("queue must cap at %d entries, flushed %d", maxQueuedTrickleEntries, len(got))
	}
}

func TestICETrickle_StopReleasesTheEmitter(t *testing.T) {
	tr := newICETrickle()
	tr.snapshot(sdpDesc("v=0\r\n"))
	rec := &trickleRecorder{}
	tr.begin(rec.emit)
	tr.stop()
	tr.observe(testRelayCandidate(3478))
	if got := rec.snapshot(); len(got) != 0 {
		t.Fatalf("a stopped session must not trickle, got %#v", got)
	}
}

// A real pion answerer: the answer is snapshotted the instant SetLocalDescription
// returns, so every host candidate is gathered AFTER the answer — exactly the
// late-candidate case. They must all reach the emitter, followed by a
// completion marker.
func TestICETrickle_RealPeerConnectionTricklesLateCandidates(t *testing.T) {
	offerer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = offerer.Close() }()
	if _, err := offerer.CreateDataChannel("probe", nil); err != nil {
		t.Fatal(err)
	}
	offer, err := offerer.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := offerer.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}

	answerer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = answerer.Close() }()

	tr := newICETrickle()
	answerer.OnICECandidate(tr.observe)
	if err := answerer.SetRemoteDescription(offer); err != nil {
		t.Fatal(err)
	}
	answer, err := answerer.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := answerer.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	desc := tr.snapshot(answerer.LocalDescription)
	if desc == nil {
		t.Fatal("snapshot returned no description")
	}

	rec := &trickleRecorder{}
	tr.begin(rec.emit)

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		got := rec.snapshot()
		if n := len(got); n > 0 && got[n-1].Complete {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	got := rec.snapshot()
	if len(got) == 0 || !got[len(got)-1].Complete {
		if strings.Contains(desc.SDP, "a=end-of-candidates") {
			t.Skip("gathering finished before the snapshot on this host; nothing was late")
		}
		t.Fatalf("expected trickled candidates ending in a completion marker, got %#v", got)
	}
	// Every trickled candidate must be accepted by a real remote peer.
	if err := offerer.SetRemoteDescription(*desc); err != nil {
		t.Fatal(err)
	}
	for _, c := range got[:len(got)-1] {
		if c.Candidate == nil {
			t.Fatalf("non-final entry without a candidate: %#v", c)
		}
		if err := offerer.AddICECandidate(*c.Candidate); err != nil {
			t.Fatalf("remote peer rejected trickled candidate %q: %v", c.Candidate.Candidate, err)
		}
	}
}

func TestSessionManager_AddRemoteICECandidateAfterAnswer(t *testing.T) {
	offerer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = offerer.Close() }()
	if _, err := offerer.CreateDataChannel("probe", nil); err != nil {
		t.Fatal(err)
	}
	offer, err := offerer.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := offerer.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}

	answerer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = answerer.Close() }()
	s := &Session{id: "sess-9182", peerConn: answerer, done: make(chan struct{}), trickle: newICETrickle()}
	answerer.OnICECandidate(s.trickle.observe)
	if err := answerer.SetRemoteDescription(offer); err != nil {
		t.Fatal(err)
	}
	answer, err := answerer.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	// Take the answer snapshot BEFORE SetLocalDescription starts gathering, so
	// every candidate is provably "late". Snapshotting after it raced pion's
	// gather goroutine: on a slow runner gathering finished first, the SDP
	// carried a=end-of-candidates, nothing trickled, and the wait below timed
	// out (#9367).
	s.trickle.snapshot(answerer.LocalDescription)
	if err := answerer.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}

	m := NewSessionManager()
	m.mu.Lock()
	m.sessions[s.id] = s
	m.mu.Unlock()

	var gens []string
	complete := make(chan struct{})
	m.OnLocalICECandidate = func(sessionID, generation string, c LocalICECandidate) {
		m.mu.Lock()
		defer m.mu.Unlock()
		gens = append(gens, generation)
		if c.Complete {
			close(complete)
		}
	}
	if !m.BeginICETrickle("sess-9182", "7") {
		t.Fatal("BeginICETrickle refused a live session")
	}

	late := webrtc.ICECandidateInit{Candidate: "candidate:9 1 udp 16777215 198.51.100.7 3478 typ relay raddr 203.0.113.5 rport 50000"}
	if err := m.AddRemoteICECandidate("sess-9182", "7", late); err != nil {
		t.Fatalf("a viewer candidate arriving after the answer must be applied: %v", err)
	}
	if err := m.AddRemoteICECandidate("sess-9182", "6", late); !errors.Is(err, ErrStaleICEGeneration) {
		t.Fatalf("a candidate for a superseded start must be refused, got %v", err)
	}
	if err := m.AddRemoteICECandidate("nope", "7", late); !errors.Is(err, ErrNoICESession) {
		t.Fatalf("a candidate for an unknown session must be refused, got %v", err)
	}
	// The answerer's host candidates were gathered after the snapshot above,
	// so they (and the completion marker) trickle under the bound generation.
	select {
	case <-complete:
	case <-time.After(30 * time.Second): // failure backstop only; the event normally lands in milliseconds
		t.Fatal("gathering never reported completion after BeginICETrickle")
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	if len(gens) == 0 {
		t.Fatal("nothing trickled after BeginICETrickle; the generation check below would be vacuous")
	}
	for _, g := range gens {
		if g != "7" {
			t.Fatalf("trickled candidates must carry the generation bound at begin, got %q", g)
		}
	}
}
