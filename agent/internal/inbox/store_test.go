package inbox

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var now0 = time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)

func payload(id string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"messageId":%q,"title":"t"}`, id))
}

func messageID(raw json.RawMessage) string {
	var v struct {
		MessageID string `json:"messageId"`
	}
	_ = json.Unmarshal(raw, &v)
	return v.MessageID
}

func openMessages(t *testing.T, path string) *Store {
	t.Helper()
	s, err := Open(path, MessageOptions(messageID))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func openPrompts(t *testing.T, path string) *Store {
	t.Helper()
	s, err := Open(path, PromptOptions())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

// preW02Record is the exact record type the endpoint-message store wrote
// before W02 (heartbeat.storedMessage); a rolled-back agent reads this shape.
type preW02Record struct {
	Show      json.RawMessage `json:"show"`
	ExpiresAt time.Time       `json:"expiresAt"`
}

func TestLegacyMessageFileLoadsUnchanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "endpoint_messages.json")
	legacy := map[string]preW02Record{
		"m1": {Show: json.RawMessage(`{"messageId":"m1","batchId":"b1","title":"Phones <down>","body":"x","severity":"warning","requiresAck":true,"expiresAt":"2026-10-27T12:00:00Z","branding":{"companyName":"Example IT"}}`), ExpiresAt: now0.Add(24 * time.Hour)},
		"m2": {Show: json.RawMessage(`{"messageId":"m2","batchId":"b2","title":"t","body":"","severity":"info","requiresAck":false,"expiresAt":"2026-10-26T13:30:00+02:00","branding":{}}`), ExpiresAt: time.Date(2026, 10, 26, 17, 30, 0, 0, time.FixedZone("", 2*3600))},
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	original := map[string]map[string]json.RawMessage{}
	_ = json.Unmarshal(raw, &original)

	s := openMessages(t, path)
	got := s.Pending("win:S-1-5-21-1001", now0) // binds the unowned records
	if len(got) != 2 {
		t.Fatalf("loaded %d legacy entries, want 2", len(got))
	}
	for _, e := range got {
		if e.OwnerKey != "win:S-1-5-21-1001" || e.Source != SourceMessage {
			t.Fatalf("entry %s owner %q source %q", e.ID, e.OwnerKey, e.Source)
		}
	}

	resaved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	after := map[string]map[string]json.RawMessage{}
	if err := json.Unmarshal(resaved, &after); err != nil {
		t.Fatal(err)
	}
	for id, rec := range original {
		for _, field := range []string{"show", "expiresAt"} {
			if !bytes.Equal(rec[field], after[id][field]) {
				t.Fatalf("%s.%s changed on re-save:\n was %s\n now %s", id, field, rec[field], after[id][field])
			}
		}
		if string(after[id]["owner"]) != `"win:S-1-5-21-1001"` {
			t.Fatalf("%s owner = %s", id, after[id]["owner"])
		}
		for key := range after[id] {
			if key != "show" && key != "expiresAt" && key != "owner" {
				t.Fatalf("%s gained an unexpected key %q", id, key)
			}
		}
	}

	// A rolled-back (pre-W02) agent still reads the re-saved file.
	var rolledBack map[string]preW02Record
	if err := json.Unmarshal(resaved, &rolledBack); err != nil || len(rolledBack) != 2 || messageID(rolledBack["m1"].Show) != "m1" {
		t.Fatalf("pre-W02 reader: %v %+v", err, rolledBack)
	}
}

func TestMessageTombstonesStay168h(t *testing.T) {
	s := openMessages(t, filepath.Join(t.TempDir(), "m.json"))
	if err := s.Tombstone("gone", now0); err != nil {
		t.Fatal(err)
	}
	if !s.Tombstoned("gone", now0.Add(167*time.Hour)) {
		t.Fatal("message tombstone expired before 168 h")
	}
	if s.Tombstoned("gone", now0.Add(168*time.Hour)) {
		t.Fatal("message tombstone outlived 168 h")
	}
	if err := s.Put(Entry{ID: "gone", ExpiresAt: now0.Add(time.Hour), Payload: payload("gone")}, now0.Add(time.Minute)); err != ErrTombstoned {
		t.Fatalf("Put of a tombstoned id = %v", err)
	}
}

func TestPromptTombstones24h(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prompt_inbox.json")
	s := openPrompts(t, path)
	if err := s.Tombstone("restart:42", now0); err != nil {
		t.Fatal(err)
	}
	// Prompt tombstones persist: a restarted agent still refuses the id.
	reopened := openPrompts(t, path)
	if !reopened.Tombstoned("restart:42", now0.Add(23*time.Hour)) {
		t.Fatal("prompt tombstone not persisted or expired before 24 h")
	}
	if reopened.Tombstoned("restart:42", now0.Add(24*time.Hour)) {
		t.Fatal("prompt tombstone outlived 24 h")
	}
}

func TestEntriesNeverCrossOwners(t *testing.T) {
	s := openPrompts(t, filepath.Join(t.TempDir(), "p.json"))
	for _, e := range []Entry{
		{ID: "a#1", OwnerKey: "win:S-A", ExpiresAt: now0.Add(time.Hour), Payload: json.RawMessage(`{}`)},
		{ID: "b#1", OwnerKey: "win:S-B", ExpiresAt: now0.Add(time.Hour), Payload: json.RawMessage(`{}`)},
	} {
		if err := s.Put(e, now0); err != nil {
			t.Fatal(err)
		}
	}
	a := s.Pending("win:S-A", now0)
	if len(a) != 1 || a[0].ID != "a#1" {
		t.Fatalf("owner A sees %+v", a)
	}
	if b := s.Pending("win:S-B", now0); len(b) != 1 || b[0].ID != "b#1" {
		t.Fatalf("owner B sees %+v", b)
	}
	if c := s.Pending("win:S-C", now0); len(c) != 0 {
		t.Fatalf("a third owner sees %+v", c)
	}
}

func TestUnownedLegacyEntryBindsToFirstOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "m.json")
	s := openMessages(t, path)
	if err := s.Put(Entry{ID: "m1", ExpiresAt: now0.Add(time.Hour), Payload: payload("m1")}, now0); err != nil {
		t.Fatal(err)
	}
	if got := s.Pending("win:S-A", now0); len(got) != 1 {
		t.Fatalf("first owner did not get the unowned entry: %+v", got)
	}
	if got := s.Pending("win:S-B", now0); len(got) != 0 {
		t.Fatalf("the entry was replayed to a second principal: %+v", got)
	}
	// The binding is persisted.
	if got := openMessages(t, path).Pending("win:S-B", now0); len(got) != 0 {
		t.Fatalf("binding lost across restart: %+v", got)
	}
	// The unscoped legacy view still lists every entry (pre-W02 behaviour).
	if got := s.Pending("", now0); len(got) != 1 {
		t.Fatalf("Pending(\"\") = %d entries", len(got))
	}
}

func TestPurgeScopeRemovesOnlyThatScope(t *testing.T) {
	s := openPrompts(t, filepath.Join(t.TempDir(), "p.json"))
	for i, scope := range []string{"scope-a", "scope-a", "scope-b", ""} {
		if err := s.Put(Entry{ID: fmt.Sprintf("e%d", i), OwnerKey: "win:S-A", ScopeID: scope, ExpiresAt: now0.Add(time.Hour), Payload: json.RawMessage(`{}`)}, now0); err != nil {
			t.Fatal(err)
		}
	}
	if n := s.PurgeScope("scope-a"); n != 2 {
		t.Fatalf("purged %d, want 2", n)
	}
	left := s.Pending("win:S-A", now0)
	if len(left) != 2 {
		t.Fatalf("left %d entries, want 2", len(left))
	}
	for _, e := range left {
		if e.ScopeID == "scope-a" {
			t.Fatal("a scope-a entry survived")
		}
	}
	if n := s.PurgeScope(""); n != 0 {
		t.Fatal("PurgeScope(\"\") must purge nothing")
	}
}

func TestCapIs50PerOwner(t *testing.T) {
	s := openPrompts(t, filepath.Join(t.TempDir(), "p.json"))
	for i := 0; i < 60; i++ {
		for _, owner := range []string{"win:S-A", "win:S-B"} {
			e := Entry{ID: fmt.Sprintf("%s-%d", owner, i), OwnerKey: owner, ExpiresAt: now0.Add(time.Duration(i+1) * time.Minute), Payload: json.RawMessage(`{}`)}
			if err := s.Put(e, now0); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, owner := range []string{"win:S-A", "win:S-B"} {
		got := s.Pending(owner, now0)
		if len(got) != 50 {
			t.Fatalf("%s holds %d entries, want 50", owner, len(got))
		}
		if got[0].ID != owner+"-10" {
			t.Fatalf("%s kept %s first; the soonest-expiring must be dropped", owner, got[0].ID)
		}
	}
}

func TestPromptEntryLifetimeCappedAt7Days(t *testing.T) {
	s := openPrompts(t, filepath.Join(t.TempDir(), "p.json"))
	if err := s.Put(Entry{ID: "x", OwnerKey: "win:S-A", ExpiresAt: now0.Add(30 * 24 * time.Hour), Payload: json.RawMessage(`{}`)}, now0); err != nil {
		t.Fatal(err)
	}
	if got := s.Pending("win:S-A", now0.Add(7*24*time.Hour)); len(got) != 0 {
		t.Fatalf("an entry outlived the 7-day list cap: %+v", got)
	}
}

func TestStoreRefusesExpiredAndRollsBackFailedSave(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, _ := Open(filepath.Join(blocker, "p.json"), PromptOptions()) // unreadable path: usable empty store
	if err := s.Put(Entry{ID: "x", ExpiresAt: now0.Add(time.Hour), Payload: json.RawMessage(`{}`)}, now0); err == nil {
		t.Fatal("Put succeeded although the file cannot be written")
	}
	if got := s.Pending("", now0); len(got) != 0 {
		t.Fatalf("an unsaved entry stayed in memory: %+v", got)
	}
	ok := openPrompts(t, filepath.Join(t.TempDir(), "p.json"))
	if err := ok.Put(Entry{ID: "old", ExpiresAt: now0.Add(-time.Second), Payload: json.RawMessage(`{}`)}, now0); err == nil {
		t.Fatal("an already expired entry was stored")
	}
}

func TestInboxListForMergesBothStores(t *testing.T) {
	dir := t.TempDir()
	in := Inbox{Messages: openMessages(t, filepath.Join(dir, "m.json")), Prompts: openPrompts(t, filepath.Join(dir, "p.json"))}
	_ = in.Messages.Put(Entry{ID: "m1", OwnerKey: "win:S-A", ExpiresAt: now0.Add(2 * time.Hour), Payload: payload("m1")}, now0)
	_ = in.Prompts.Put(Entry{ID: "p1#win:S-A", OwnerKey: "win:S-A", ExpiresAt: now0.Add(time.Hour), Payload: json.RawMessage(`{}`)}, now0)
	_ = in.Prompts.Put(Entry{ID: "p2#win:S-B", OwnerKey: "win:S-B", ExpiresAt: now0.Add(time.Hour), Payload: json.RawMessage(`{}`)}, now0)
	got := in.ListFor("win:S-A", now0)
	if len(got) != 2 || got[0].ID != "p1#win:S-A" || got[0].Source != SourcePrompt || got[1].Source != SourceMessage {
		t.Fatalf("ListFor = %+v", got)
	}
}

func TestCorruptFileStartsEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "p.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path, PromptOptions())
	if s == nil {
		t.Fatal("Open must return a usable empty store on a corrupt file")
	}
	if err == nil {
		t.Fatal("a corrupt file must be reported")
	}
	if err := s.Put(Entry{ID: "x", ExpiresAt: now0.Add(time.Hour), Payload: json.RawMessage(`{}`)}, now0); err != nil {
		t.Fatalf("Put after a corrupt load: %v", err)
	}
}
