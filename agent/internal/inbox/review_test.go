package inbox

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/prompthost"
)

func TestPromptInboxAdapterRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prompt_inbox.json")
	st := openPrompts(t, path)
	in := &PromptInbox{Store: st, Now: func() time.Time { return now0 }}
	show := ipc.PromptShow{PromptID: "notice:x:1", Rev: 2, Kind: "notice.info", KindVersion: 1, State: ipc.PromptStateApproved, Copy: ipc.PromptCopy{Title: "Done"}, Actions: []ipc.PromptAction{}}
	e := prompthost.ListEntry{ID: "notice:x:1#win:S-A", PromptID: "notice:x:1", OwnerKey: "win:S-A", ScopeID: "scope-a", ExpiresAt: now0.Add(time.Hour), Show: show}
	if err := in.PutPrompt(e); err != nil {
		t.Fatal(err)
	}
	if err := in.TombstonePrompt("restart:42"); err != nil {
		t.Fatal(err)
	}
	reopened := &PromptInbox{Store: openPrompts(t, path), Now: func() time.Time { return now0 }}
	got := reopened.PromptEntries("win:S-A")
	if len(got) != 1 || got[0].ScopeID != "scope-a" || !got[0].ExpiresAt.Equal(e.ExpiresAt) || got[0].Show.PromptID != "notice:x:1" || got[0].Show.Copy.Title != "Done" {
		t.Fatalf("entries after reopen = %+v", got)
	}
	if !reopened.PromptTombstoned("restart:42") {
		t.Fatal("prompt tombstone not persisted through the adapter")
	}
	for _, other := range reopened.Store.Pending("", now0) {
		if other.ID == tombstoneKey("restart:42") {
			t.Fatal("a tombstone leaked into the entry list")
		}
	}
	if got := reopened.PromptEntries("win:S-B"); len(got) != 0 {
		t.Fatalf("another owner sees %+v", got)
	}
	if got := reopened.PromptEntries(""); got != nil {
		t.Fatalf("an empty owner must see nothing, got %+v", got)
	}
	if err := reopened.RetractPrompt(e.ID); err != nil {
		t.Fatal(err)
	}
	if got := reopened.PromptEntries("win:S-A"); len(got) != 0 {
		t.Fatal("retracted entry still listed")
	}
}

func TestPromptInboxDropsAnUnreadableEntry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prompt_inbox.json")
	raw := fmt.Sprintf(`{"bad#win:S-A":{"show":"not-an-object","expiresAt":%q,"owner":"win:S-A"}}`, now0.Add(time.Hour).Format(time.RFC3339))
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	in := &PromptInbox{Store: openPrompts(t, path), Now: func() time.Time { return now0 }}
	if got := in.PromptEntries("win:S-A"); len(got) != 0 {
		t.Fatalf("an unreadable entry was replayed: %+v", got)
	}
	if _, ok := in.Store.Get("bad#win:S-A"); ok {
		t.Fatal("the unreadable entry stayed in the store")
	}
}

func TestPutRollbackRestoresReplacedAndEvictedEntries(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permissions do not block writes on Windows")
	}
	dir := t.TempDir()
	s := openPrompts(t, filepath.Join(dir, "p.json"))
	for i := 0; i < 50; i++ {
		if err := s.Put(Entry{ID: fmt.Sprintf("e%02d", i), OwnerKey: "win:S-A", ExpiresAt: now0.Add(time.Duration(i+1) * time.Minute), Payload: json.RawMessage(`{"v":1}`)}, now0); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	// A 51st entry would evict e00; the save fails, so nothing may change.
	if err := s.Put(Entry{ID: "new", OwnerKey: "win:S-A", ExpiresAt: now0.Add(time.Hour), Payload: json.RawMessage(`{}`)}, now0); err == nil {
		t.Skip("the directory is still writable (running as root?)")
	}
	got := s.Pending("win:S-A", now0)
	if len(got) != 50 || got[0].ID != "e00" {
		t.Fatalf("after a failed save: %d entries, first %q; the evicted entry must be restored", len(got), got[0].ID)
	}
	for _, e := range got {
		if e.ID == "new" {
			t.Fatal("the unsaved entry stayed in memory")
		}
	}
	// Replacing an entry and failing to save keeps the old payload.
	if err := s.Put(Entry{ID: "e05", OwnerKey: "win:S-A", ExpiresAt: now0.Add(time.Hour), Payload: json.RawMessage(`{"v":2}`)}, now0); err == nil {
		t.Fatal("replace succeeded although the file cannot be written")
	}
	if e, ok := s.Get("e05"); !ok || string(e.Payload) != `{"v":1}` {
		t.Fatalf("e05 after a failed replace = %+v, want the old payload", e)
	}
}
