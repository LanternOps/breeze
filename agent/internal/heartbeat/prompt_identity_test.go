package heartbeat

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/inbox"
	"github.com/breeze-rmm/agent/internal/promptidentity"
	"github.com/breeze-rmm/agent/internal/tunnel"
)

const (
	hbScopeA = "bad7313391508e4129c338752b2cc809"
	hbScopeB = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
	// The 1x1 PNG of fixtures/prompt-host/branding_sync.set.json.
	hbLogoSha = "c96253573225f1fa2044af43896a96056903b359eed7af9fad90bd626127ba99"
	hbLogoB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQj18LAAHMASx1OSTTAAAAAElFTkSuQmCC"
)

func TestCapabilityAdvertised(t *testing.T) {
	caps := compiledSecurityCapabilities()
	if caps.PromptIdentityProtocolVersion != 1 {
		t.Fatalf("PromptIdentityProtocolVersion = %d, want 1", caps.PromptIdentityProtocolVersion)
	}
	raw, _ := json.Marshal(caps)
	if !bytes.Contains(raw, []byte(`"promptIdentityProtocolVersion":1`)) {
		t.Fatalf("capability not on the wire: %s", raw)
	}
}

// identityHeartbeat is a heartbeat with an identity cache, a prompt list
// and a server that serves the fixture logo.
func identityHeartbeat(t *testing.T, logo func(w http.ResponseWriter, r *http.Request)) (*Heartbeat, string, *atomic.Int32) {
	t.Helper()
	var logoCalls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/", func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/prompt-identity/logo") {
			http.NotFound(w, r)
			return
		}
		logoCalls.Add(1)
		logo(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	h, _ := newRotationTestHeartbeat(t, srv.URL)
	h.tunnelMgr = &tunnel.Manager{}
	dir := t.TempDir()
	st, err := inbox.Open(filepath.Join(dir, promptInboxFile), inbox.PromptOptions())
	if err != nil {
		t.Fatal(err)
	}
	h.promptListStore = st
	h.initPromptIdentity(dir)
	orig := startPromptLogoFetch
	startPromptLogoFetch = func(f func()) { f() }
	t.Cleanup(func() { startPromptLogoFetch = orig })
	return h, dir, &logoCalls
}

func fixtureLogoHandler(t *testing.T) func(w http.ResponseWriter, r *http.Request) {
	png, err := base64.StdEncoding.DecodeString(hbLogoB64)
	if err != nil {
		t.Fatal(err)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("sha256") != hbLogoSha || r.Header.Get("Authorization") == "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	}
}

func identityBlock(scope string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"state":"set","scopeId":%q,"partnerName":"Example IT Services","primaryColor":"#1F5FAD","logo":{"sha256":%q,"mime":"image/png","bytes":69}}`, scope, hbLogoSha))
}

func putPromptEntry(t *testing.T, st *inbox.Store, id, scope string) {
	t.Helper()
	if err := st.Put(inbox.Entry{ID: id, Source: inbox.SourcePrompt, OwnerKey: "win:S-1-5-21-1001", ScopeID: scope, ExpiresAt: time.Now().Add(time.Hour), Payload: json.RawMessage(`{}`)}, time.Now()); err != nil {
		t.Fatal(err)
	}
}

// snapshotRollback observes, from a step that runs later in
// processHeartbeatResponse, what the identity and the list looked like.
type snapshotRollback struct {
	fakeRollbackController
	h       *Heartbeat
	scope   string
	entries int
}

func (s *snapshotRollback) Acknowledge(id string) error {
	if cur, ok := s.h.promptIdentity.Current(); ok {
		s.scope = cur.ScopeID
	}
	s.entries = len(s.h.promptListStore.Pending("win:S-1-5-21-1001", time.Now()))
	return s.fakeRollbackController.Acknowledge(id)
}

func TestScopeChangePurgesPromptEntriesFirst(t *testing.T) {
	h, _, _ := identityHeartbeat(t, fixtureLogoHandler(t))
	h.processHeartbeatResponse(&HeartbeatResponse{PromptIdentity: identityBlock(hbScopeA)})
	putPromptEntry(t, h.promptListStore, "old-1#win:S-1-5-21-1001", hbScopeA)
	putPromptEntry(t, h.promptListStore, "old-2#win:S-1-5-21-1001", hbScopeA)
	putPromptEntry(t, h.promptListStore, "generic#win:S-1-5-21-1001", "")

	snap := &snapshotRollback{h: h}
	h.rollbackController = snap
	h.processHeartbeatResponse(&HeartbeatResponse{
		PromptIdentity:                    identityBlock(hbScopeB),
		AcknowledgedRollbackObservationID: "obs-1",
	})
	if snap.acknowledged != "obs-1" {
		t.Fatal("the later response step did not run")
	}
	if snap.scope != hbScopeB || snap.entries != 1 {
		t.Fatalf("when the rest of the response ran: scope=%s entries=%d; want the new scope and the old entries purged", snap.scope, snap.entries)
	}
	left := h.promptListStore.Pending("win:S-1-5-21-1001", time.Now())
	if len(left) != 1 || left[0].ScopeID != "" {
		t.Fatalf("entries left = %+v", left)
	}
}

func TestHeartbeatIdentityAbsentMalformedAndLogo(t *testing.T) {
	h, dir, calls := identityHeartbeat(t, fixtureLogoHandler(t))

	// A set block stores the identity and fetches the logo.
	h.processHeartbeatResponse(&HeartbeatResponse{PromptIdentity: identityBlock(hbScopeA)})
	cur, ok := h.promptIdentity.Current()
	if !ok || cur.ScopeID != hbScopeA || cur.PartnerName != "Example IT Services" {
		t.Fatalf("identity = %+v %v", cur, ok)
	}
	if cur.Logo == nil || cur.Logo.Sha256 != hbLogoSha || calls.Load() != 1 {
		t.Fatalf("logo = %+v after %d fetches", cur.Logo, calls.Load())
	}
	if _, err := os.Stat(filepath.Join(dir, promptidentity.DirName, promptidentity.LogoFile)); err != nil {
		t.Fatalf("logo.bin: %v", err)
	}
	// The same logo is not fetched again.
	h.processHeartbeatResponse(&HeartbeatResponse{PromptIdentity: identityBlock(hbScopeA)})
	if calls.Load() != 1 {
		t.Fatalf("logo fetched %d times", calls.Load())
	}

	// A malformed block does not break the response, and keeps the identity.
	var resp HeartbeatResponse
	raw := []byte(`{"commands":[],"promptIdentity":{"state":5},"promptHost":{"enabledKinds":["notice.info"]}}`)
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("a malformed promptIdentity failed the whole response: %v", err)
	}
	if got := enabledPromptKinds(&resp); len(got) != 1 {
		t.Fatalf("rest of the response lost: %v", got)
	}
	h.processHeartbeatResponse(&resp)
	h.processHeartbeatResponse(&HeartbeatResponse{PromptIdentity: json.RawMessage(`{"state":"set","scopeId":"NOT-HEX"}`)})
	if cur, ok := h.promptIdentity.Current(); !ok || cur.ScopeID != hbScopeA {
		t.Fatalf("malformed block clobbered the identity: %+v %v", cur, ok)
	}

	// Absent keeps.
	h.processHeartbeatResponse(&HeartbeatResponse{})
	if _, ok := h.promptIdentity.Current(); !ok {
		t.Fatal("absent block dropped the identity")
	}
	// cleared deletes.
	h.processHeartbeatResponse(&HeartbeatResponse{PromptIdentity: json.RawMessage(`{"state":"cleared"}`)})
	if _, ok := h.promptIdentity.Current(); ok {
		t.Fatal("cleared kept the identity")
	}
}

func TestHeartbeatLogoFailureKeepsLastKnownAndBacksOff(t *testing.T) {
	serveBad := atomic.Bool{}
	good := fixtureLogoHandler(t)
	h, _, calls := identityHeartbeat(t, func(w http.ResponseWriter, r *http.Request) {
		if serveBad.Load() {
			_, _ = w.Write([]byte("\x89PNG\r\n\x1a\nnot the announced logo"))
			return
		}
		good(w, r)
	})
	h.processHeartbeatResponse(&HeartbeatResponse{PromptIdentity: identityBlock(hbScopeA)})

	// A new sha is announced; the server's bytes do not match it.
	serveBad.Store(true)
	newSha := strings.Repeat("ab", 32)
	block := json.RawMessage(fmt.Sprintf(`{"state":"set","scopeId":%q,"partnerName":"Example IT Services","logo":{"sha256":%q,"mime":"image/png","bytes":20}}`, hbScopeA, newSha))
	before := calls.Load()
	h.processHeartbeatResponse(&HeartbeatResponse{PromptIdentity: block})
	if calls.Load() != before+1 {
		t.Fatal("new logo sha was not fetched")
	}
	cur, _ := h.promptIdentity.Current()
	if cur.Logo == nil || cur.Logo.Sha256 != hbLogoSha {
		t.Fatalf("last-known logo lost: %+v", cur.Logo)
	}
	// The next heartbeat does not hammer the server for the same bad sha.
	h.processHeartbeatResponse(&HeartbeatResponse{PromptIdentity: block})
	if calls.Load() != before+1 {
		t.Fatalf("bad logo refetched immediately (%d fetches)", calls.Load()-before)
	}
}
