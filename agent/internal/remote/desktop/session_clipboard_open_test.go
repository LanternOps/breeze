package desktop

import "testing"

type fakeClipboardOpener struct{ status, watch int }

func (f *fakeClipboardOpener) SendStatus() error { f.status++; return nil }
func (f *fakeClipboardOpener) Watch()            { f.watch++ }

func TestClipboardOpenAnnouncesStatusAndWatchesOnlyWhenAllowed(t *testing.T) {
	allowed := &fakeClipboardOpener{}
	onClipboardChannelOpen(allowed, true)
	if allowed.status != 1 || allowed.watch != 1 {
		t.Fatalf("host→viewer allowed: status=%d watch=%d", allowed.status, allowed.watch)
	}

	blocked := &fakeClipboardOpener{}
	onClipboardChannelOpen(blocked, false)
	if blocked.status != 1 || blocked.watch != 0 {
		t.Fatalf("host→viewer blocked: status=%d watch=%d (status must still be sent)", blocked.status, blocked.watch)
	}
}
