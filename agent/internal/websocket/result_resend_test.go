package websocket

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// processingFailedFrame is the frame the server sends instead of an ack when
// it received a command result but could not record it (#3530), as built by
// buildResultProcessingFailedFrame in apps/api/src/routes/agentWs.ts.
func processingFailedFrame(commandID string) []byte {
	b, _ := json.Marshal(map[string]any{
		"type":        "error",
		"code":        "RESULT_PROCESSING_FAILED",
		"message":     "Command result received but could not be recorded",
		"messageType": "command_result",
		"commandId":   commandID,
	})
	return b
}

func ackFrame(commandID string) []byte {
	b, _ := json.Marshal(map[string]any{"type": "ack", "commandId": commandID})
	return b
}

// resultServer is a fake API WebSocket endpoint that records every
// command_result it receives and answers each one with whatever reply(n)
// returns for the nth arrival (1-based) of that command id. A nil reply sends
// nothing.
type resultServer struct {
	mu       sync.Mutex
	received map[string]int
	reply    func(commandID string, n int) []byte
	// push, if set, receives frames to send unprompted.
	push chan []byte
}

func (s *resultServer) count(commandID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.received[commandID]
}

func (s *resultServer) handle(conn *websocket.Conn) {
	var writeMu sync.Mutex
	if s.push != nil {
		go func() {
			for frame := range s.push {
				writeMu.Lock()
				_ = conn.WriteMessage(websocket.TextMessage, frame)
				writeMu.Unlock()
			}
		}()
	}
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg struct {
			Type      string `json:"type"`
			CommandID string `json:"commandId"`
		}
		if json.Unmarshal(raw, &msg) != nil || msg.Type != "command_result" {
			continue
		}
		s.mu.Lock()
		s.received[msg.CommandID]++
		n := s.received[msg.CommandID]
		s.mu.Unlock()
		if s.reply == nil {
			continue
		}
		if frame := s.reply(msg.CommandID, n); frame != nil {
			writeMu.Lock()
			_ = conn.WriteMessage(websocket.TextMessage, frame)
			writeMu.Unlock()
		}
	}
}

// startResendClient connects a client to srv with both pumps running and the
// resend backoff shrunk to a few milliseconds. The returned stop func tears
// everything down.
func startResendClient(t *testing.T, s *resultServer) (*Client, func()) {
	t.Helper()
	srv := newTestServer(t, s.handle)
	c := newTestClient(srv.URL, noopHandler)
	c.resends.delay = func(int) time.Duration { return 5 * time.Millisecond }
	if err := c.connect(); err != nil {
		srv.Close()
		t.Fatalf("connect: %v", err)
	}
	pumpDone := make(chan struct{})
	writerDone := make(chan struct{})
	readerDone := make(chan struct{})
	go c.writePump(pumpDone, writerDone)
	go func() {
		defer close(readerDone)
		c.readPump()
	}()
	return c, func() {
		close(pumpDone)
		<-writerDone
		c.closeCurrentConn(false)
		<-readerDone
		srv.Close()
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// settle gives any (wrongly) scheduled resend time to fire before asserting
// that nothing more arrived. Resend delays are 5ms in these tests.
func settle() { time.Sleep(150 * time.Millisecond) }

func TestResultResend_ProcessingFailedFrameResendsUntilAcked(t *testing.T) {
	s := &resultServer{received: map[string]int{}, reply: func(id string, n int) []byte {
		if n == 1 {
			return processingFailedFrame(id)
		}
		return ackFrame(id)
	}}
	c, stop := startResendClient(t, s)
	defer stop()

	if err := c.SendResult(CommandResult{Type: "command_result", CommandID: "cmd-1", Status: "completed", Stdout: "hello"}); err != nil {
		t.Fatalf("SendResult: %v", err)
	}

	waitFor(t, "the resend of cmd-1", func() bool { return s.count("cmd-1") == 2 })
	waitFor(t, "the ack to clear cmd-1", func() bool { return !c.resends.tracked("cmd-1") })
	settle()
	if got := s.count("cmd-1"); got != 2 {
		t.Fatalf("server received cmd-1 %d times, want 2 (original + one resend, then acked)", got)
	}
}

func TestResultResend_ResentFrameCarriesTheOriginalResult(t *testing.T) {
	var mu sync.Mutex
	var bodies []string
	srv := newTestServer(t, func(conn *websocket.Conn) {
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if !strings.Contains(string(raw), `"command_result"`) {
				continue
			}
			mu.Lock()
			bodies = append(bodies, string(raw))
			n := len(bodies)
			mu.Unlock()
			if n == 1 {
				_ = conn.WriteMessage(websocket.TextMessage, processingFailedFrame("cmd-body"))
			} else {
				_ = conn.WriteMessage(websocket.TextMessage, ackFrame("cmd-body"))
			}
		}
	})
	defer srv.Close()
	c := newTestClient(srv.URL, noopHandler)
	c.resends.delay = func(int) time.Duration { return 5 * time.Millisecond }
	if err := c.connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	pumpDone, writerDone := make(chan struct{}), make(chan struct{})
	go c.writePump(pumpDone, writerDone)
	go c.readPump()
	defer func() { close(pumpDone); <-writerDone; c.closeCurrentConn(false) }()

	orig := CommandResult{Type: "command_result", CommandID: "cmd-body", Status: "failed", ExitCode: 3, Stdout: "out", Stderr: "err", Error: "boom"}
	if err := c.SendResult(orig); err != nil {
		t.Fatalf("SendResult: %v", err)
	}
	waitFor(t, "two deliveries", func() bool { mu.Lock(); defer mu.Unlock(); return len(bodies) == 2 })
	mu.Lock()
	defer mu.Unlock()
	if bodies[0] != bodies[1] {
		t.Fatalf("resent frame differs from the original:\n first: %s\nresent: %s", bodies[0], bodies[1])
	}
}

func TestResultResend_GivesUpAfterAttemptCap(t *testing.T) {
	s := &resultServer{received: map[string]int{}, reply: func(id string, _ int) []byte {
		return processingFailedFrame(id)
	}}
	c, stop := startResendClient(t, s)
	defer stop()

	if err := c.SendResult(CommandResult{Type: "command_result", CommandID: "cmd-cap", Status: "completed"}); err != nil {
		t.Fatalf("SendResult: %v", err)
	}

	want := 1 + resultResendMaxAttempts
	waitFor(t, "every allowed resend", func() bool { return s.count("cmd-cap") >= want })
	waitFor(t, "the tracker to give up on cmd-cap", func() bool { return !c.resends.tracked("cmd-cap") })
	settle()
	if got := s.count("cmd-cap"); got != want {
		t.Fatalf("server received cmd-cap %d times, want exactly %d (1 send + %d resends)", got, want, resultResendMaxAttempts)
	}
}

func TestResultResend_AckClearsTheRecord(t *testing.T) {
	push := make(chan []byte, 4)
	s := &resultServer{received: map[string]int{}, push: push, reply: func(id string, _ int) []byte {
		return ackFrame(id)
	}}
	c, stop := startResendClient(t, s)
	defer func() { close(push); stop() }()

	if err := c.SendResult(CommandResult{Type: "command_result", CommandID: "cmd-ack", Status: "completed"}); err != nil {
		t.Fatalf("SendResult: %v", err)
	}
	waitFor(t, "the ack to clear cmd-ack", func() bool { return s.count("cmd-ack") == 1 && !c.resends.tracked("cmd-ack") })

	// A stray processing-failed frame after the ack must not resurrect it: the
	// agent no longer holds the result, and the server already recorded it.
	push <- processingFailedFrame("cmd-ack")
	settle()
	if got := s.count("cmd-ack"); got != 1 {
		t.Fatalf("server received cmd-ack %d times after the ack, want 1", got)
	}
}

func TestResultResend_UnknownCommandIDIsIgnored(t *testing.T) {
	push := make(chan []byte, 4)
	s := &resultServer{received: map[string]int{}, push: push}
	c, stop := startResendClient(t, s)
	defer func() { close(push); stop() }()

	var preserved []CommandResult
	var mu sync.Mutex
	c.OnResultWriteFailed = func(r CommandResult) { mu.Lock(); preserved = append(preserved, r); mu.Unlock() }

	push <- processingFailedFrame("cmd-never-sent")
	settle()

	s.mu.Lock()
	total := 0
	for _, n := range s.received {
		total += n
	}
	s.mu.Unlock()
	if total != 0 {
		t.Fatalf("agent sent %d command_result frames for an id it never sent, want 0", total)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(preserved) != 0 {
		t.Fatalf("agent outboxed %d results for an id it never sent, want 0", len(preserved))
	}
}

func TestResultResend_OtherRejectionForgetsWithoutResending(t *testing.T) {
	s := &resultServer{received: map[string]int{}, reply: func(id string, _ int) []byte {
		b, _ := json.Marshal(map[string]any{
			"type": "error", "code": "INVALID_MESSAGE", "messageType": "command_result", "commandId": id,
		})
		return b
	}}
	c, stop := startResendClient(t, s)
	defer stop()

	if err := c.SendResult(CommandResult{Type: "command_result", CommandID: "cmd-invalid", Status: "completed"}); err != nil {
		t.Fatalf("SendResult: %v", err)
	}
	waitFor(t, "the rejection to clear cmd-invalid", func() bool { return s.count("cmd-invalid") == 1 && !c.resends.tracked("cmd-invalid") })
	settle()
	if got := s.count("cmd-invalid"); got != 1 {
		t.Fatalf("a schema rejection was resent: server received %d frames, want 1", got)
	}
}

// newUnconnectedResendClient returns a client whose resend delay is long
// enough that a scheduled resend is still pending when the test inspects it.
func newUnconnectedResendClient(delay time.Duration) *Client {
	c := newTestClient("http://localhost", noopHandler)
	c.resends.delay = func(int) time.Duration { return delay }
	return c
}

func drainResults(c *Client) int {
	n := 0
	for {
		select {
		case <-c.resultChan:
			n++
		default:
			return n
		}
	}
}

// A transient drop (rate budget) of a resend must not cancel the resend or
// forget the result — only INVALID_MESSAGE is definitive.
func TestResultResend_RateBudgetRejectionKeepsTheRecord(t *testing.T) {
	c := newUnconnectedResendClient(20 * time.Millisecond)
	if err := c.SendResult(CommandResult{CommandID: "cmd-rate"}); err != nil {
		t.Fatalf("SendResult: %v", err)
	}
	drainResults(c)
	c.handleServerErrorFrame(processingFailedFrame("cmd-rate"))
	c.handleServerErrorFrame([]byte(`{"type":"error","code":"MESSAGE_RATE_BUDGET_EXCEEDED","messageType":"command_result","commandId":"cmd-rate"}`))
	if !c.resends.tracked("cmd-rate") {
		t.Fatal("a rate-budget drop forgot the result")
	}
	waitFor(t, "the scheduled resend", func() bool { return len(c.resultChan) == 1 })
}

// An ack arriving while a resend is scheduled cancels it: the server recorded
// the result (e.g. via an outbox-flushed copy).
func TestResultResend_AckCancelsAPendingResend(t *testing.T) {
	c := newUnconnectedResendClient(30 * time.Millisecond)
	if err := c.SendResult(CommandResult{CommandID: "cmd-pending"}); err != nil {
		t.Fatalf("SendResult: %v", err)
	}
	drainResults(c)
	c.handleServerErrorFrame(processingFailedFrame("cmd-pending"))
	c.handleAckFrame(ackFrame("cmd-pending"))
	settle()
	if n := drainResults(c); n != 0 {
		t.Fatalf("%d resend(s) went out after the ack cancelled them, want 0", n)
	}
}

// Two error frames for one result (the same result also went out via an
// outbox flush) produce one resend and spend one attempt.
func TestResultResend_DuplicateErrorFramesScheduleOneResend(t *testing.T) {
	c := newUnconnectedResendClient(30 * time.Millisecond)
	if err := c.SendResult(CommandResult{CommandID: "cmd-dup"}); err != nil {
		t.Fatalf("SendResult: %v", err)
	}
	drainResults(c)
	c.handleServerErrorFrame(processingFailedFrame("cmd-dup"))
	c.handleServerErrorFrame(processingFailedFrame("cmd-dup"))
	settle()
	if n := drainResults(c); n != 1 {
		t.Fatalf("%d resends went out for two error frames on one pending resend, want 1", n)
	}
	c.resends.mu.Lock()
	resends := c.resends.entries["cmd-dup"].resends
	c.resends.mu.Unlock()
	if resends != 1 {
		t.Fatalf("attempts spent = %d, want 1", resends)
	}
}

// A resend that cannot be queued (client stopped, channel full) must reach the
// on-disk outbox via OnResultWriteFailed rather than vanish.
func TestResultResend_UnqueueableResendFallsBackToOutbox(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler) // never connected
	c.resends.delay = func(int) time.Duration { return 5 * time.Millisecond }
	preserved := make(chan CommandResult, 1)
	c.OnResultWriteFailed = func(r CommandResult) { preserved <- r }

	if err := c.SendResult(CommandResult{Type: "command_result", CommandID: "cmd-stop", Status: "completed"}); err != nil {
		t.Fatalf("SendResult: %v", err)
	}
	<-c.resultChan // the original frame "went out"
	c.Stop()

	c.handleServerErrorFrame(processingFailedFrame("cmd-stop"))
	select {
	case r := <-preserved:
		if r.CommandID != "cmd-stop" {
			t.Fatalf("outboxed %q, want cmd-stop", r.CommandID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a resend that could not be queued was not handed to OnResultWriteFailed")
	}
}

// ---------- tracker bounds ----------

func newBoundedTracker(maxEntries, maxBytes int, ttl time.Duration, now *time.Time) *sentResultTracker {
	tr := newSentResultTracker()
	tr.maxEntries = maxEntries
	tr.maxBytes = maxBytes
	tr.ttl = ttl
	tr.now = func() time.Time { return *now }
	return tr
}

func TestSentResultTracker_EntryCapEvictsOldest(t *testing.T) {
	now := time.Unix(1_000, 0)
	tr := newBoundedTracker(3, 1<<20, time.Hour, &now)
	for _, id := range []string{"a", "b", "c", "d"} {
		now = now.Add(time.Second)
		tr.record(CommandResult{CommandID: id}, 10)
	}
	if tr.tracked("a") {
		t.Fatal("oldest entry survived past the entry cap")
	}
	for _, id := range []string{"b", "c", "d"} {
		if !tr.tracked(id) {
			t.Fatalf("entry %q evicted, only the oldest should go", id)
		}
	}
}

func TestSentResultTracker_ByteCapEvictsOldest(t *testing.T) {
	now := time.Unix(1_000, 0)
	tr := newBoundedTracker(100, 250, time.Hour, &now)
	for _, id := range []string{"a", "b", "c"} {
		now = now.Add(time.Second)
		tr.record(CommandResult{CommandID: id}, 100)
	}
	if tr.tracked("a") {
		t.Fatal("oldest entry survived past the byte cap")
	}
	if !tr.tracked("b") || !tr.tracked("c") {
		t.Fatal("byte cap evicted more than needed")
	}
	if tr.totalBytes != 200 {
		t.Fatalf("totalBytes = %d, want 200", tr.totalBytes)
	}
}

func TestSentResultTracker_TTLExpiresUnackedEntries(t *testing.T) {
	now := time.Unix(1_000, 0)
	tr := newBoundedTracker(100, 1<<20, time.Minute, &now)
	tr.record(CommandResult{CommandID: "old"}, 10)
	now = now.Add(2 * time.Minute)
	tr.record(CommandResult{CommandID: "new"}, 10)
	if tr.tracked("old") {
		t.Fatal("an entry older than the TTL survived")
	}
	if !tr.tracked("new") {
		t.Fatal("fresh entry missing")
	}
	// An expired entry must not be resent even if the prune has not run yet.
	now = now.Add(2 * time.Minute)
	if tr.onProcessingFailed("new", func(CommandResult) { t.Fatal("resent an expired entry") }) {
		t.Fatal("onProcessingFailed reported an expired entry as known")
	}
}

func TestSentResultTracker_RerecordKeepsAttemptCount(t *testing.T) {
	now := time.Unix(1_000, 0)
	tr := newBoundedTracker(100, 1<<20, time.Hour, &now)
	fired := make(chan CommandResult, 8)
	tr.delay = func(int) time.Duration { return time.Millisecond }
	tr.record(CommandResult{CommandID: "x"}, 10)
	for i := 0; i < resultResendMaxAttempts; i++ {
		if !tr.onProcessingFailed("x", func(r CommandResult) { fired <- r }) {
			t.Fatalf("attempt %d: entry unknown", i+1)
		}
		r := <-fired
		tr.record(r, 10) // what SendResult does on the resend
	}
	if !tr.onProcessingFailed("x", func(CommandResult) { t.Fatal("resent past the attempt cap") }) {
		t.Fatal("entry at the cap reported as unknown")
	}
	if tr.tracked("x") {
		t.Fatal("entry kept after giving up")
	}
}

// TestResultResend_ServerContractPinned pins, against the TypeScript that emits
// them, the two frames the resend depends on. A rename on the server side would
// otherwise leave every behavioural test above green (they speak the agent's
// own idea of the protocol) while the resend silently never fires.
func TestResultResend_ServerContractPinned(t *testing.T) {
	data, err := os.ReadFile(filepath.Clean(serverRejectionSource))
	if err != nil {
		t.Fatalf("cannot read %s: %v", serverRejectionSource, err)
	}
	source := string(data)

	start := strings.Index(source, "export function buildResultProcessingFailedFrame")
	if start < 0 {
		t.Fatal("buildResultProcessingFailedFrame is gone from agentWs.ts; repoint this test")
	}
	fn := source[start:]
	if end := strings.Index(fn, "\n}\n"); end > 0 {
		fn = fn[:end]
	}
	for _, want := range []string{
		"type: 'error'",
		"code: '" + resultProcessingFailedCode + "'",
		"messageType: 'command_result'",
		"commandId:",
	} {
		if !strings.Contains(fn, want) {
			t.Errorf("buildResultProcessingFailedFrame no longer contains %q; the agent's resend (#7365) would never fire", want)
		}
	}
	if !strings.Contains(source, "{ type: 'ack', commandId: parsed.data.commandId }") {
		t.Error("the command_result ack no longer carries commandId in the expected shape; " +
			"the agent's resend record (#7365) would only ever clear by TTL")
	}
}

func TestSendResult_StoppedClientRefusesEvenWithBufferSpace(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	close(c.done)
	for i := 0; i < 50; i++ {
		if err := c.SendResult(CommandResult{CommandID: "cmd-after-stop"}); err == nil {
			t.Fatal("a stopped client accepted a result into a channel nothing will drain")
		}
	}
	if len(c.resultChan) != 0 {
		t.Fatalf("resultChan holds %d results after Stop, want 0", len(c.resultChan))
	}
	if c.resends.tracked("cmd-after-stop") {
		t.Fatal("a refused result was recorded for resend")
	}
}

// The record is written before the enqueue (so a fast error frame cannot
// outrun it); a result that is then refused must not linger in it, but a
// refused RE-send must keep the existing record and its attempt count.
func TestSendResult_ChannelFullRollsBackOnlyANewRecord(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	if err := c.SendResult(CommandResult{CommandID: "cmd-existing"}); err != nil {
		t.Fatalf("SendResult: %v", err)
	}
	for len(c.resultChan) < cap(c.resultChan) {
		c.resultChan <- outboundResult{data: []byte("filler")}
	}

	if err := c.SendResult(CommandResult{CommandID: "cmd-new"}); err == nil {
		t.Fatal("SendResult succeeded on a full channel")
	}
	if c.resends.tracked("cmd-new") {
		t.Fatal("a result refused on a full channel was left in the resend record")
	}
	if err := c.SendResult(CommandResult{CommandID: "cmd-existing"}); err == nil {
		t.Fatal("SendResult succeeded on a full channel")
	}
	if !c.resends.tracked("cmd-existing") {
		t.Fatal("a refused re-send erased the existing record")
	}
}

func TestResultResendDelay_BoundedAndGrowing(t *testing.T) {
	prevMax := time.Duration(0)
	for attempt := 1; attempt <= resultResendMaxAttempts; attempt++ {
		for i := 0; i < 50; i++ {
			d := resultResendDelay(attempt)
			nominal := resultResendNominalDelay(attempt)
			lo := time.Duration(float64(nominal) * (1 - resultResendJitter))
			hi := time.Duration(float64(nominal) * (1 + resultResendJitter))
			if d < lo || d > hi {
				t.Fatalf("attempt %d delay %v outside jitter band [%v, %v]", attempt, d, lo, hi)
			}
			if d > time.Duration(float64(resultResendMaxDelay)*(1+resultResendJitter)) {
				t.Fatalf("attempt %d delay %v exceeds the cap", attempt, d)
			}
		}
		if n := resultResendNominalDelay(attempt); n < prevMax {
			t.Fatalf("nominal delay shrank at attempt %d", attempt)
		} else {
			prevMax = n
		}
	}
}
