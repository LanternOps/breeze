package parked

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNilStateIsNeverParked(t *testing.T) {
	var s *State
	if s.Parked() {
		t.Fatal("nil state reads as parked")
	}
	if s.Changed() != nil {
		t.Fatal("nil state returned a non-nil channel")
	}
	if ev := s.ObserveBeat(true); ev.Transition != None {
		t.Fatalf("nil ObserveBeat = %v", ev.Transition)
	}
	if ev := s.NoteRefusal(); ev.Transition != None {
		t.Fatalf("nil NoteRefusal = %v", ev.Transition)
	}
	s.SetObserver(func(Event) {})
}

func TestBeatEntersAndLeaves(t *testing.T) {
	s := New()
	var events []Event
	s.SetObserver(func(ev Event) { events = append(events, ev) })

	ch := s.Changed()
	if ev := s.ObserveBeat(true); ev.Transition != Entered || ev.Source != SourceHeartbeat {
		t.Fatalf("first parked beat = %+v, want entered via heartbeat", ev)
	}
	if !s.Parked() {
		t.Fatal("not parked after a parked beat")
	}
	select {
	case <-ch:
	default:
		t.Fatal("Changed channel not closed on entering")
	}
	if ev := s.ObserveBeat(true); ev.Transition != None {
		t.Fatalf("repeat parked beat = %v, want none", ev.Transition)
	}

	ch = s.Changed()
	ev := s.ObserveBeat(false)
	if ev.Transition != Left || ev.Source != SourceHeartbeat || ev.RefusalMuted {
		t.Fatalf("full beat = %+v, want left (heartbeat source, not muted)", ev)
	}
	if s.Parked() {
		t.Fatal("still parked after a full beat")
	}
	select {
	case <-ch:
	default:
		t.Fatal("Changed channel not closed on leaving")
	}
	if len(events) != 2 || events[0].Transition != Entered || events[1].Transition != Left {
		t.Fatalf("observer events = %+v, want entered then left", events)
	}
}

// A server that predates the field: every beat lacks it, and nothing ever
// enters the state from a beat.
func TestOldServerBeatsNeverPark(t *testing.T) {
	s := New()
	for i := 0; i < 5; i++ {
		if ev := s.ObserveBeat(false); ev.Transition != None {
			t.Fatalf("beat %d = %v, want none", i, ev.Transition)
		}
	}
	if s.Parked() {
		t.Fatal("parked without any signal")
	}
}

func TestRefusalEntersAndBeatConfirms(t *testing.T) {
	s := New()
	if ev := s.NoteRefusal(); ev.Transition != Entered || ev.Source != SourceRefusal {
		t.Fatalf("refusal = %+v, want entered via refusal", ev)
	}
	if ev := s.NoteRefusal(); ev.Transition != None {
		t.Fatalf("second refusal = %v, want none", ev.Transition)
	}
	if ev := s.ObserveBeat(true); ev.Transition != None {
		t.Fatalf("confirming beat = %v, want none (already parked)", ev.Transition)
	}
	ev := s.ObserveBeat(false)
	if ev.Transition != Left || ev.Source != SourceHeartbeat || ev.RefusalMuted {
		t.Fatalf("full beat = %+v, want left via heartbeat, not muted", ev)
	}
	// The server speaks the field: a later refusal still enters.
	if ev := s.NoteRefusal(); ev.Transition != Entered {
		t.Fatalf("refusal after a confirmed episode = %v, want entered", ev.Transition)
	}
}

// Old server: a refusal enters, the next beat (no field) leaves and mutes the
// refusal signal, so the agent does not flap on every beat.
func TestRefusalContradictedByOldServerMutes(t *testing.T) {
	s := New()
	s.NoteRefusal()
	ev := s.ObserveBeat(false)
	if ev.Transition != Left || !ev.RefusalMuted {
		t.Fatalf("contradicting beat = %+v, want left and muted", ev)
	}
	if ev := s.NoteRefusal(); ev.Transition != None || s.Parked() {
		t.Fatalf("muted refusal = %v (parked=%v), want none", ev.Transition, s.Parked())
	}
	// A beat that does carry the field unmutes it.
	s.ObserveBeat(true)
	s.ObserveBeat(false)
	if ev := s.NoteRefusal(); ev.Transition != Entered {
		t.Fatalf("refusal after the field was seen = %v, want entered", ev.Transition)
	}
}

func TestParkedForIsReported(t *testing.T) {
	s := New()
	now := time.Unix(1000, 0)
	s.now = func() time.Time { return now }
	s.ObserveBeat(true)
	now = now.Add(90 * time.Second)
	if ev := s.ObserveBeat(false); ev.ParkedFor != 90*time.Second {
		t.Fatalf("ParkedFor = %v, want 90s", ev.ParkedFor)
	}
}

func TestObserverSeesTransitionsInOrder(t *testing.T) {
	s := New()
	var mu sync.Mutex
	var seq []Transition
	s.SetObserver(func(ev Event) {
		mu.Lock()
		seq = append(seq, ev.Transition)
		mu.Unlock()
	})
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func() { defer wg.Done(); s.ObserveBeat(true) }()
		go func() { defer wg.Done(); s.ObserveBeat(false) }()
	}
	wg.Wait()
	for i := 1; i < len(seq); i++ {
		if seq[i] == seq[i-1] {
			t.Fatalf("observer saw %v twice in a row at %d: %v", seq[i], i, seq)
		}
	}
}

func TestIsRefusalBody(t *testing.T) {
	cases := map[string]bool{
		`{"error":"device_pending_assignment"}`:           true,
		`{"error":"device_pending_assignment","extra":1}`: true,
		`{"error":"tenant_offboarding"}`:                  false,
		`{"error":"Unauthorized"}`:                        false,
		`{"message":"device_pending_assignment"}`:         false,
		`device_pending_assignment`:                       false,
		``:                                                false,
		`{"error":"device_uninstall_draining","x":"device_pending_assignment"}`: false,
	}
	for body, want := range cases {
		if got := IsRefusalBody([]byte(body)); got != want {
			t.Errorf("IsRefusalBody(%q) = %v, want %v", body, got, want)
		}
	}
}

// The WebSocket upgrade refusal has no body: the header alone is the signal,
// and only on a 403 with exactly RefusalCode.
func TestIsRefusalReadsTheHeader(t *testing.T) {
	mk := func(status int, value string) *http.Response {
		h := http.Header{}
		if value != "" {
			h.Set(RefusalHeader, value)
		}
		return &http.Response{StatusCode: status, Header: h, Body: http.NoBody}
	}
	if !IsRefusal(mk(http.StatusForbidden, RefusalCode)) {
		t.Fatal("IsRefusal = false for a 403 with the refusal header and no body")
	}
	if IsRefusal(mk(http.StatusUnauthorized, RefusalCode)) {
		t.Fatal("a 401 with the header counted as the parked refusal")
	}
	if IsRefusal(mk(http.StatusForbidden, "something_else")) {
		t.Fatal("another header value counted as the parked refusal")
	}
	if IsRefusal(mk(http.StatusForbidden, "")) {
		t.Fatal("a bare 403 counted as the parked refusal")
	}
}

func TestIsRefusalKeepsTheBodyReadable(t *testing.T) {
	body := `{"error":"device_pending_assignment"}`
	resp := &http.Response{StatusCode: http.StatusForbidden, Body: io.NopCloser(strings.NewReader(body))}
	if !IsRefusal(resp) {
		t.Fatal("IsRefusal = false for the parked refusal")
	}
	got, _ := io.ReadAll(resp.Body)
	if string(got) != body {
		t.Fatalf("body after IsRefusal = %q, want %q", got, body)
	}

	other := &http.Response{StatusCode: http.StatusUnauthorized, Body: io.NopCloser(strings.NewReader(body))}
	if IsRefusal(other) {
		t.Fatal("a 401 counted as the parked refusal")
	}
}

func TestTransportNotesRefusals(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/parked" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"error":"device_pending_assignment"}`)
			return
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":"tenant_offboarding"}`)
	}))
	defer srv.Close()

	s := New()
	c := WrapClient(srv.Client(), s)

	resp, err := c.Get(srv.URL + "/other")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if s.Parked() {
		t.Fatal("an unrelated 403 parked the device")
	}

	resp, err = c.Get(srv.URL + "/parked")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !s.Parked() {
		t.Fatal("the parked refusal did not park the device")
	}
	if !strings.Contains(string(got), RefusalCode) {
		t.Fatalf("caller lost the body: %q", got)
	}

	if WrapClient(srv.Client(), nil) != srv.Client() || WrapClient(nil, s) != nil {
		t.Fatal("WrapClient with nil arguments must be a no-op")
	}
}
